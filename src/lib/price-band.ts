// src/lib/price-band.ts — series primitive：在主圖畫「價格帶」
// （上下兩條價位序列之間的填色區域）。lightweight-charts v5 沒有內建
// box/fill-between，這裡用官方 plugin primitive 機制補上；attach 到一條
// 透明 anchor series（提供價格座標）即可。逐根繪製，所以等寬常數序列會
// 畫成橫式長方形（TXO 牆這類價位區域），而 Keltner/Bollinger 這類隨 K
// 變動的通道也能正確描出上下緣之間的區域。

import type {
    IChartApi,
    IPrimitivePaneRenderer,
    IPrimitivePaneView,
    ISeriesApi,
    ISeriesPrimitive,
    PrimitivePaneViewZOrder,
    SeriesAttachedParameter,
    SeriesType,
    Time,
} from 'lightweight-charts';

export interface PriceBandPoint {
    time: Time;
    top: number;
    bottom: number;
}

export interface PriceBandOptions {
    points: PriceBandPoint[]; // 逐根上下緣（已對齊、已去除缺值）
    fillColor: string; // 半透明填色（rgba）
    borderColor: string; // 上下緣線色（實色）
    borderStyle: 'solid' | 'dashed';
    borderWidth: number;
}

type DrawTarget = Parameters<IPrimitivePaneRenderer['draw']>[0];

// 連續區段：相鄰的時間點才連成同一塊填色，遇到缺值/座標落空就斷開，
// 避免把空窗期硬連成一片。
interface Segment {
    xs: number[];
    yTops: number[];
    yBots: number[];
}

class PriceBandRenderer implements IPrimitivePaneRenderer {
    constructor(
        private readonly _opts: PriceBandOptions,
        private readonly _series: ISeriesApi<SeriesType> | null,
        private readonly _chart: IChartApi | null,
    ) {}

    draw(target: DrawTarget): void {
        const series = this._series;
        const chart = this._chart;
        if (!series || !chart) return;
        const o = this._opts;
        if (o.points.length === 0) return;
        const ts = chart.timeScale();

        target.useBitmapCoordinateSpace((scope) => {
            const ctx = scope.context;
            const hr = scope.horizontalPixelRatio;
            const vr = scope.verticalPixelRatio;

            // 收集可見且座標有效的點，依斷點切成連續區段
            const segs: Segment[] = [];
            let cur: Segment | null = null;
            for (const pt of o.points) {
                const x = ts.timeToCoordinate(pt.time);
                const yT = series.priceToCoordinate(Math.max(pt.top, pt.bottom));
                const yB = series.priceToCoordinate(Math.min(pt.top, pt.bottom));
                if (x === null || yT === null || yB === null) {
                    cur = null; // 斷開
                    continue;
                }
                if (!cur) {
                    cur = { xs: [], yTops: [], yBots: [] };
                    segs.push(cur);
                }
                cur.xs.push(x * hr);
                cur.yTops.push(yT * vr);
                cur.yBots.push(yB * vr);
            }
            if (segs.length === 0) return;

            // 單點區段（常見於整條常數牆只落一根在可視範圍）給一點寬度，
            // 否則填色/描線會退化成看不見的 0 寬
            const minHalf = Math.max(hr, 1);

            // 填色
            ctx.fillStyle = o.fillColor;
            for (const s of segs) {
                ctx.beginPath();
                const n = s.xs.length;
                if (n === 1) {
                    const x0 = s.xs[0]! - minHalf;
                    const x1 = s.xs[0]! + minHalf;
                    ctx.moveTo(x0, s.yTops[0]!);
                    ctx.lineTo(x1, s.yTops[0]!);
                    ctx.lineTo(x1, s.yBots[0]!);
                    ctx.lineTo(x0, s.yBots[0]!);
                } else {
                    ctx.moveTo(s.xs[0]!, s.yTops[0]!);
                    for (let i = 1; i < n; i++) ctx.lineTo(s.xs[i]!, s.yTops[i]!);
                    for (let i = n - 1; i >= 0; i--)
                        ctx.lineTo(s.xs[i]!, s.yBots[i]!);
                }
                ctx.closePath();
                ctx.fill();
            }

            // 上下緣線
            ctx.strokeStyle = o.borderColor;
            ctx.lineWidth = o.borderWidth * hr;
            ctx.setLineDash(o.borderStyle === 'dashed' ? [4 * hr, 4 * hr] : []);
            for (const s of segs) {
                const n = s.xs.length;
                for (const ys of [s.yTops, s.yBots]) {
                    ctx.beginPath();
                    if (n === 1) {
                        ctx.moveTo(s.xs[0]! - minHalf, ys[0]!);
                        ctx.lineTo(s.xs[0]! + minHalf, ys[0]!);
                    } else {
                        ctx.moveTo(s.xs[0]!, ys[0]!);
                        for (let i = 1; i < n; i++) ctx.lineTo(s.xs[i]!, ys[i]!);
                    }
                    ctx.stroke();
                }
            }
            ctx.setLineDash([]);
        });
    }
}

class PriceBandView implements IPrimitivePaneView {
    constructor(private readonly _band: PriceBandPrimitive) {}
    zOrder(): PrimitivePaneViewZOrder {
        return 'bottom'; // 區域墊在 K 棒底下，不遮價格
    }
    renderer(): IPrimitivePaneRenderer {
        return new PriceBandRenderer(
            this._band.options,
            this._band.series,
            this._band.chart,
        );
    }
}

export class PriceBandPrimitive implements ISeriesPrimitive<Time> {
    series: ISeriesApi<SeriesType> | null = null;
    chart: IChartApi | null = null;
    private readonly _views: PriceBandView[];
    private _requestUpdate: (() => void) | null = null;

    constructor(public options: PriceBandOptions) {
        this._views = [new PriceBandView(this)];
    }

    attached(param: SeriesAttachedParameter<Time>): void {
        this.series = param.series;
        this.chart = param.chart;
        this._requestUpdate = param.requestUpdate;
    }

    detached(): void {
        this.series = null;
        this.chart = null;
        this._requestUpdate = null;
    }

    applyOptions(opts: Partial<PriceBandOptions>): void {
        this.options = { ...this.options, ...opts };
        this._requestUpdate?.();
    }

    paneViews(): readonly IPrimitivePaneView[] {
        return this._views;
    }
}
