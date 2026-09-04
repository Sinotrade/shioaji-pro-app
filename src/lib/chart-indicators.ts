// src/lib/chart-indicators.ts — 把使用者目前的指標設定（與主圖同一份
// sj-pro-indicators-v2）渲染到任意 lightweight-charts 實例上。
// 回測面板的進出場 K 線用它取得與主圖一致的指標畫面；呼叫端整個
// chart 重建時序列一起銷毀，不需要個別清理。

import {
    AreaSeries,
    HistogramSeries,
    LineSeries,
    LineStyle,
    LineType,
    type IChartApi,
    type ISeriesApi,
    type SeriesDataItemTypeMap,
    type UTCTimestamp,
} from 'lightweight-charts';
import {
    colorWithOpacity,
    DEF_BY_TYPE,
    instanceLabel,
    loadInstances,
    outputStyle,
} from './indicator-defs';
import type { IndicatorPoint } from './indicators';
import { PriceBandPrimitive } from './price-band';
import type { ChartColors } from './theme-store';
import type { Candle } from './types/market';

export interface IndicatorLegendItem {
    label: string; // e.g. "MA(20)"
    color: string;
    pane: number; // 0 = 主圖
}

// 依目前儲存的指標實例把序列加到 chart 上；回傳 legend 標籤清單
export function renderIndicatorSeries(
    chart: IChartApi,
    bars: Candle[],
    tfMinutes: number,
    colors: ChartColors,
): IndicatorLegendItem[] {
    const legend: IndicatorLegendItem[] = [];
    if (bars.length === 0) return legend;
    const toLineData = (pts: IndicatorPoint[]) =>
        pts.map((p) =>
            p.value === undefined
                ? { time: p.time as UTCTimestamp }
                : { time: p.time as UTCTimestamp, value: p.value },
        ) as SeriesDataItemTypeMap['Line'][];

    let paneIdx = 1;
    for (const inst of loadInstances()) {
        const def = DEF_BY_TYPE.get(inst.type);
        if (!def) continue;
        if (inst.hidden) continue;
        if (inst.visibleTf && !inst.visibleTf.includes(tfMinutes)) continue;
        const params: Record<string, number> = {};
        for (const p of def.params) {
            params[p.key] = inst.params[p.key] ?? p.def;
        }
        let out: Record<string, IndicatorPoint[]>;
        try {
            out = def.compute(bars, params);
        } catch {
            continue; // 壞參數/壞自訂碼不能拖垮圖表
        }
        const pane = def.category === 'pane' ? paneIdx++ : 0;
        let firstSeries: ISeriesApi<'Line' | 'Histogram' | 'Area'> | null =
            null;
        const priceFormatOpt =
            inst.precision !== undefined
                ? {
                      priceFormat: {
                          type: 'price' as const,
                          precision: inst.precision,
                          minMove: Math.pow(10, -inst.precision),
                      },
                  }
                : {};
        const quiet = { priceLineVisible: false, lastValueVisible: false };
        for (const o of def.outputs) {
            const pts = out[o.key];
            if (!pts) continue;
            const st = outputStyle(inst, def, o.key);
            if (!st.visible) continue;
            const color = colorWithOpacity(st.color, st.opacity);
            // 價格帶（同主圖：anchor series + PriceBandPrimitive）
            if (o.kind === 'band') {
                const lastDef = (arr: IndicatorPoint[]) => {
                    for (let i = arr.length - 1; i >= 0; i--) {
                        const v = arr[i]!.value;
                        if (v !== undefined) return v;
                    }
                    return undefined;
                };
                const top = lastDef(pts);
                const bottom = lastDef(out[`${o.key}_lo`] ?? []);
                if (top === undefined || bottom === undefined) continue;
                const anchor = chart.addSeries(
                    LineSeries,
                    {
                        color: 'rgba(0,0,0,0)',
                        lineVisible: false,
                        crosshairMarkerVisible: false,
                        autoscaleInfoProvider: () => null,
                        ...quiet,
                        ...priceFormatOpt,
                    },
                    pane,
                );
                anchor.setData(toLineData(pts));
                anchor.attachPrimitive(
                    new PriceBandPrimitive({
                        top,
                        bottom,
                        fillColor: colorWithOpacity(st.color, st.opacity),
                        borderColor: color,
                        borderStyle: o.border ?? 'solid',
                        borderWidth: st.width,
                    }),
                );
                firstSeries ??= anchor;
                continue;
            }
            let s: ISeriesApi<'Line' | 'Histogram' | 'Area'>;
            if (st.plot === 'histogram') {
                s = chart.addSeries(
                    HistogramSeries,
                    { color, ...quiet, ...priceFormatOpt },
                    pane,
                );
                s.setData(
                    pts
                        .filter((p) => p.value !== undefined)
                        .map((p) => ({
                            time: p.time as UTCTimestamp,
                            value: p.value!,
                            color: o.signed
                                ? p.value! >= 0
                                    ? colors.upVol
                                    : colors.downVol
                                : color,
                        })),
                );
            } else if (st.plot === 'area') {
                s = chart.addSeries(
                    AreaSeries,
                    {
                        lineColor: color,
                        lineWidth: st.width,
                        topColor: colorWithOpacity(
                            st.color,
                            Math.min(st.opacity, 28),
                        ),
                        bottomColor: 'rgba(0, 0, 0, 0)',
                        crosshairMarkerVisible: false,
                        ...quiet,
                        ...priceFormatOpt,
                    },
                    pane,
                );
                s.setData(toLineData(pts));
            } else {
                s = chart.addSeries(
                    LineSeries,
                    {
                        color,
                        lineWidth: st.width,
                        lineStyle:
                            o.kind === 'dashed'
                                ? LineStyle.Dashed
                                : LineStyle.Solid,
                        lineType:
                            st.plot === 'step'
                                ? LineType.WithSteps
                                : LineType.Simple,
                        crosshairMarkerVisible: false,
                        ...(st.plot === 'circles'
                            ? {
                                  lineVisible: false,
                                  pointMarkersVisible: true,
                                  pointMarkersRadius: 1.5,
                              }
                            : {}),
                        ...quiet,
                        ...priceFormatOpt,
                    },
                    pane,
                );
                s.setData(toLineData(pts));
            }
            firstSeries ??= s;
        }
        if (firstSeries) {
            legend.push({
                label: instanceLabel(inst),
                color: outputStyle(inst, def, def.outputs[0]!.key).color,
                pane,
            });
            if (pane > 0 && def.levels) {
                for (const lv of def.levels) {
                    firstSeries.createPriceLine({
                        price: lv,
                        color: colors.grid,
                        lineWidth: 1,
                        lineStyle: LineStyle.Dotted,
                        axisLabelVisible: false,
                        title: '',
                    });
                }
            }
            // 副圖 pane 給個合理的初始高度
            if (pane > 0) {
                try {
                    chart.panes()[pane]?.setHeight(70);
                } catch {
                    // pane API 差異不致命
                }
            }
        }
    }
    return legend;
}
