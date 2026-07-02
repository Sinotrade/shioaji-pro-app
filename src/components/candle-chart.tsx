// src/components/candle-chart.tsx — K-bar candlestick + volume chart
// (lightweight-charts v5), live-updated from the SSE tick stream.

import {
    AreaSeries,
    CandlestickSeries,
    ColorType,
    createChart,
    HistogramSeries,
    LineSeries,
    LineStyle,
    LineType,
    type IChartApi,
    type IPriceLine,
    type ISeriesApi,
    type MouseEventParams,
    type SeriesDataItemTypeMap,
    type UTCTimestamp,
} from 'lightweight-charts';
import {
    ArrowDown,
    ArrowUp,
    Bell,
    Copy,
    Crosshair,
    Eye,
    EyeOff,
    Maximize2,
    MoreHorizontal,
    OctagonX,
    Settings2,
    Star,
    X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuote } from '../hooks/use-stream';
import {
    IndicatorDialog,
    IndicatorSettingsModal,
} from './indicator-dialog';
import {
    colorWithOpacity,
    DEF_BY_TYPE,
    duplicateInstance,
    instanceLabel,
    loadFavorites,
    loadInstances,
    newInstance,
    outputStyle,
    saveFavorites,
    saveInstances,
    type IndicatorInstance,
} from '../lib/indicator-defs';
import type { IndicatorPoint } from '../lib/indicators';
import { cancelOrder, fetchKbars, updateOrderPrice } from '../lib/shioaji';
import { setPickedPrice } from '../lib/price-sync';
import { notify, placeQuickOrder } from '../lib/trade';
import {
    addTrigger,
    removeTrigger,
    useTriggers,
} from '../lib/trigger-engine';
import type { ContractBase } from '../lib/types/contract';
import type { Candle } from '../lib/types/market';
import { ACTIVE_ORDER_STATUSES, type Trade } from '../lib/types/order';
import { fmtPrice } from '../lib/utils/format';
import { roundToTick } from '../lib/utils/ticksize';
import { getChartColors, useThemeSettings } from '../lib/theme-store';
import {
    aggregate,
    dateStrOffset,
    kbarsToCandles,
    wallClockToUtc,
} from '../lib/utils/kbars';
import * as panel from './panel.css';
import * as styles from './candle-chart.css';

// NOTE: the kbars API only serves 1-minute bars, so 1D aggregates a huge
// payload (a year of TXF ≈ 280k bars / 18MB) — keep the range tight enough
// to load on slow machines without looking dead
const TIMEFRAMES = [
    { label: '1m', minutes: 1, days: 3 },
    { label: '5m', minutes: 5, days: 10 },
    { label: '15m', minutes: 15, days: 20 },
    { label: '60m', minutes: 60, days: 60 },
    { label: '1D', minutes: 1440, days: 240 },
] as const;

type TradeMode = 'observe' | 'buy' | 'sell' | 'stop' | 'take' | 'alert';

const TRADE_MODES: { key: TradeMode; label: string }[] = [
    { key: 'observe', label: '游標' },
    { key: 'buy', label: '點價買' },
    { key: 'sell', label: '點價賣' },
    { key: 'stop', label: '停損' },
    { key: 'take', label: '停利' },
    { key: 'alert', label: '警示' },
];

// keep paging until this floor — one page per fetch, spans widen with tf
const MAX_HISTORY_DAYS = 1095; // ~3 years

export function CandleChart({
    contract,
    trades = [],
    onOrdersChanged,
}: {
    contract: ContractBase;
    trades?: Trade[];
    onOrdersChanged?: () => void;
}) {
    const hostRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
    const volSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
    const lastBarRef = useRef<Candle | null>(null);
    const [tfIdx, setTfIdx] = useState(1); // default 5m
    const [empty, setEmpty] = useState(false);
    const [loading, setLoading] = useState(false);
    // ticks must NOT touch the series until history for the current
    // (symbol, timeframe) is in place — updating a freshly-switched series
    // with a bucket older than its last point makes lightweight-charts
    // throw inside the effect, which unmounts the whole app (issue #1)
    const loadedKeyRef = useRef('');
    const quote = useQuote(contract.code);
    const tf = TIMEFRAMES[tfIdx] ?? TIMEFRAMES[1];
    const themeSettings = useThemeSettings();
    const colors = getChartColors(themeSettings);
    const themeKey = `${themeSettings.mode}-${themeSettings.convention}`;
    const [mode, setMode] = useState<TradeMode>('observe');
    const [tradeQty, setTradeQty] = useState(1);
    const [instances, setInstances] =
        useState<IndicatorInstance[]>(loadInstances);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [settingsFor, setSettingsFor] = useState<string | null>(null);
    const [legendMenuFor, setLegendMenuFor] = useState<string | null>(null);
    // instances snapshot taken when settings opens — 取消 restores it
    const settingsSnapshotRef = useRef<string>('');
    // legend live values: instId -> per-output {label,text,color}
    const [legendValues, setLegendValues] = useState<
        Record<string, { label: string; text: string; color: string }[]>
    >({});
    const legendMetaRef = useRef(
        new Map<
            string,
            {
                label: string;
                color: string;
                series: ISeriesApi<'Line' | 'Histogram'>;
                last?: number;
                precision?: number;
            }[]
        >(),
    );
    const legendRafRef = useRef(false);
    // sub-pane layout memory: instId -> pane index（上次重建的配置）與
    // instId -> 高度 px（使用者拖出來的上下圖比例，重建時還原）
    const paneAssignRef = useRef(new Map<string, number>());
    const paneHeightsRef = useRef(new Map<string, number>());
    // 副圖 legend 定位：instId -> pane 在 chartHost 內的 top offset px
    const [paneTops, setPaneTops] = useState<Record<string, number>>({});
    const paneRoRef = useRef<ResizeObserver | null>(null);
    const [dataVersion, setDataVersion] = useState(0);
    const barsRef = useRef<Candle[]>([]);
    // raw 1-min candles backing the current view — history pages merge here
    // and re-aggregate so buckets spanning a page seam stay correct
    const rawRef = useRef<Candle[]>([]);
    const loadMoreRef = useRef<(() => void) | null>(null);
    const indSeriesRef = useRef<ISeriesApi<'Line' | 'Histogram'>[]>([]);
    const triggers = useTriggers().filter((t) => t.code === contract.code);
    const workingOrders = useMemo(
        () =>
            trades.filter(
                (t) =>
                    (t.contract.code === contract.code ||
                        (contract.target_code &&
                            t.contract.code === contract.target_code)) &&
                    ACTIVE_ORDER_STATUSES.has(t.status.status),
            ),
        [trades, contract],
    );
    const workingOrdersRef = useRef(workingOrders);
    workingOrdersRef.current = workingOrders;
    const orderLinesRef = useRef(new Map<string, IPriceLine>());
    const onOrdersChangedRef = useRef(onOrdersChanged);
    onOrdersChangedRef.current = onOrdersChanged;

    // refs so the chart click handler always sees current values
    const modeRef = useRef(mode);
    modeRef.current = mode;
    const qtyRef = useRef(tradeQty);
    qtyRef.current = tradeQty;
    const contractRef = useRef(contract);
    contractRef.current = contract;
    const lastPriceRef = useRef<number | null>(null);

    // legend readout — crosshair position when hovering, latest bar otherwise
    const fmtLegendVal = (v: number, precision?: number) =>
        precision !== undefined
            ? v.toFixed(precision)
            : Math.abs(v) >= 10000
              ? v.toLocaleString('en-US', { maximumFractionDigits: 0 })
              : Math.abs(v) >= 100
                ? v.toFixed(1)
                : v.toFixed(2);
    const updateLegend = (param?: MouseEventParams) => {
        const out: Record<
            string,
            { label: string; text: string; color: string }[]
        > = {};
        legendMetaRef.current.forEach((metas, instId) => {
            out[instId] = metas.map((m) => {
                let v = m.last;
                const d = param?.seriesData?.get(m.series) as
                    | { value?: number }
                    | undefined;
                if (d && typeof d.value === 'number') v = d.value;
                return {
                    label: m.label,
                    text:
                        v === undefined
                            ? '—'
                            : fmtLegendVal(v, m.precision),
                    color: m.color,
                };
            });
        });
        setLegendValues(out);
    };
    const updateLegendRef = useRef(updateLegend);
    updateLegendRef.current = updateLegend;

    // chart lifecycle
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        const c = getChartColors(themeSettingsRef.current);
        const chart = createChart(host, {
            layout: {
                background: { type: ColorType.Solid, color: 'transparent' },
                textColor: c.text,
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 10,
                attributionLogo: false,
            },
            grid: {
                vertLines: { color: c.grid },
                horzLines: { color: c.grid },
            },
            crosshair: {
                vertLine: {
                    color: c.crosshair,
                    labelBackgroundColor: c.labelBg,
                },
                horzLine: {
                    color: c.crosshair,
                    labelBackgroundColor: c.labelBg,
                },
            },
            rightPriceScale: { borderColor: c.border },
            timeScale: {
                borderColor: c.border,
                timeVisible: true,
                secondsVisible: false,
            },
            autoSize: true,
        });
        const candles = chart.addSeries(CandlestickSeries, {
            upColor: c.up,
            downColor: c.down,
            borderUpColor: c.up,
            borderDownColor: c.down,
            wickUpColor: c.up,
            wickDownColor: c.down,
        });
        const vol = chart.addSeries(HistogramSeries, {
            priceFormat: { type: 'volume' },
            priceScaleId: 'vol',
        });
        chart.priceScale('vol').applyOptions({
            scaleMargins: { top: 0.82, bottom: 0 },
        });
        chartRef.current = chart;
        candleSeriesRef.current = candles;
        volSeriesRef.current = vol;

        chart.subscribeClick((param) => {
            const m = modeRef.current;
            if (!param.point) return;
            const raw = candles.coordinateToPrice(param.point.y);
            if (raw === null) return;
            const c = contractRef.current;
            const price = roundToTick(c, Number(raw));
            if (m === 'observe') {
                setPickedPrice(c.code, price); // sync to order tickets
                return;
            }
            const qty = qtyRef.current;
            const last = lastPriceRef.current;
            setMode('observe'); // one-shot
            if (m === 'buy' || m === 'sell') {
                const action = m === 'buy' ? 'Buy' : 'Sell';
                placeQuickOrder(c, action, price, qty)
                    .then((trade) =>
                        notify({
                            kind: 'ok',
                            title: `📈 圖表${action === 'Buy' ? '買進' : '賣出'}已送出`,
                            body: `${c.code} ${qty} @ ${fmtPrice(price)} (${trade.status.status})`,
                        }),
                    )
                    .catch((e) =>
                        notify({
                            kind: 'err',
                            title: '圖表下單失敗',
                            body: e instanceof Error ? e.message : String(e),
                        }),
                    );
                return;
            }
            // stop / take triggers — direction inferred from click vs last
            if (last === null) {
                notify({
                    kind: 'err',
                    title: '無法掛觸價單',
                    body: '尚未收到即時成交價',
                });
                return;
            }
            const below = price <= last;
            if (m === 'alert') {
                addTrigger({
                    code: c.code,
                    condition: below ? 'below' : 'above',
                    price,
                    action: 'Sell', // unused for alerts
                    quantity: 0,
                    kind: 'alert',
                });
                return;
            }
            if (m === 'stop') {
                addTrigger({
                    code: c.code,
                    condition: below ? 'below' : 'above',
                    price,
                    action: below ? 'Sell' : 'Buy',
                    quantity: qty,
                    kind: 'stop',
                });
            } else {
                addTrigger({
                    code: c.code,
                    condition: below ? 'below' : 'above',
                    price,
                    action: below ? 'Buy' : 'Sell',
                    quantity: qty,
                    kind: 'take',
                });
            }
        });

        chart.subscribeCrosshairMove((param) => {
            // legend value readout follows the crosshair（rAF-throttled）
            if (!legendRafRef.current) {
                legendRafRef.current = true;
                requestAnimationFrame(() => {
                    legendRafRef.current = false;
                    updateLegendRef.current(
                        param.point ? param : undefined,
                    );
                });
            }
            if (!param.point) return;
            const raw = candles.coordinateToPrice(param.point.y);
            if (raw === null) return;
            const c = contractRef.current;
            setPickedPrice(c.code, roundToTick(c, Number(raw)));
        });

        // TradingView-style infinite history: panning near the left edge
        // pulls an older page of kbars (handler injected by the load effect)
        chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
            if (range && range.from < 30) loadMoreRef.current?.();
        });

        return () => {
            chart.remove();
            chartRef.current = null;
            candleSeriesRef.current = null;
            volSeriesRef.current = null;
        };
    }, []);

    // keep latest theme readable inside the chart-creation effect
    const themeSettingsRef = useRef(themeSettings);
    themeSettingsRef.current = themeSettings;

    // restyle chart on theme change
    useEffect(() => {
        const chart = chartRef.current;
        if (!chart) return;
        chart.applyOptions({
            layout: { textColor: colors.text },
            grid: {
                vertLines: { color: colors.grid },
                horzLines: { color: colors.grid },
            },
            crosshair: {
                vertLine: {
                    color: colors.crosshair,
                    labelBackgroundColor: colors.labelBg,
                },
                horzLine: {
                    color: colors.crosshair,
                    labelBackgroundColor: colors.labelBg,
                },
            },
            rightPriceScale: { borderColor: colors.border },
            timeScale: { borderColor: colors.border },
        });
        candleSeriesRef.current?.applyOptions({
            upColor: colors.up,
            downColor: colors.down,
            borderUpColor: colors.up,
            borderDownColor: colors.down,
            wickUpColor: colors.up,
            wickDownColor: colors.down,
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [themeKey]);

    // recolor volume bars from cached data on theme change — never refetch
    useEffect(() => {
        const bars = barsRef.current;
        if (bars.length === 0) return;
        volSeriesRef.current?.setData(
            bars.map((b) => ({
                time: b.time as UTCTimestamp,
                value: b.volume,
                color: b.close >= b.open ? colors.upVol : colors.downVol,
            })),
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [themeKey]);

    // load kbars on symbol/timeframe change; pages of older history are
    // pulled on demand by the visible-range subscription (loadMoreRef)
    useEffect(() => {
        let cancelled = false;
        const loadKey = `${contract.code}|${tf.minutes}`;
        loadedKeyRef.current = ''; // freeze tick updates while loading
        lastBarRef.current = null;
        loadMoreRef.current = null;
        setEmpty(false);
        setLoading(true);
        const clearSeries = () => {
            // the series must never keep a stale timeframe's data — a later
            // tick bucketed for the new timeframe would be "older" than the
            // stale tail and crash the chart library
            candleSeriesRef.current?.setData([]);
            volSeriesRef.current?.setData([]);
            barsRef.current = [];
            rawRef.current = [];
            setDataVersion((v) => v + 1);
            loadedKeyRef.current = loadKey; // live bars may build from here
        };
        const applyBars = (bars: Candle[]) => {
            candleSeriesRef.current?.setData(
                bars.map((b) => ({
                    time: b.time as UTCTimestamp,
                    open: b.open,
                    high: b.high,
                    low: b.low,
                    close: b.close,
                })),
            );
            volSeriesRef.current?.setData(
                bars.map((b) => ({
                    time: b.time as UTCTimestamp,
                    value: b.volume,
                    color: b.close >= b.open ? colors.upVol : colors.downVol,
                })),
            );
            barsRef.current = bars;
            setDataVersion((v) => v + 1);
        };

        // ---- older-history paging (TradingView-style infinite scroll) ----
        let oldestDay: number = tf.days; // days-ago covered so far
        let fetching = false;
        let dryPages = 0; // consecutive empty pages → assume exhausted
        const loadMore = () => {
            if (fetching || cancelled) return;
            if (loadedKeyRef.current !== loadKey) return;
            if (dryPages >= 3 || oldestDay >= MAX_HISTORY_DAYS) return;
            fetching = true;
            const from = Math.min(oldestDay + tf.days, MAX_HISTORY_DAYS);
            fetchKbars(
                contract,
                dateStrOffset(from),
                dateStrOffset(oldestDay + 1),
            )
                .then((k) => {
                    if (cancelled || loadedKeyRef.current !== loadKey) return;
                    oldestDay = from;
                    const boundary = rawRef.current[0]?.time ?? Infinity;
                    const older = kbarsToCandles(k).filter(
                        (b) => b.time < boundary,
                    );
                    if (older.length === 0) {
                        dryPages += 1;
                        return;
                    }
                    dryPages = 0;
                    rawRef.current = [...older, ...rawRef.current];
                    const bars = aggregate(rawRef.current, tf.minutes);
                    // re-attach the live tail built from ticks since load —
                    // raw history doesn't contain those bars
                    const existing = barsRef.current;
                    const lastAgg =
                        bars.length > 0
                            ? bars[bars.length - 1]!.time
                            : -Infinity;
                    for (const b of existing) {
                        if (b.time === lastAgg) bars[bars.length - 1] = b;
                        else if (b.time > lastAgg) bars.push(b);
                    }
                    applyBars(bars);
                })
                .catch(() => {
                    dryPages += 1;
                })
                .finally(() => {
                    fetching = false;
                });
        };

        fetchKbars(contract, dateStrOffset(tf.days), dateStrOffset(0))
            .then((k) => {
                if (cancelled || !candleSeriesRef.current) return;
                const raw = kbarsToCandles(k);
                const bars = aggregate(raw, tf.minutes);
                if (bars.length === 0) {
                    clearSeries();
                    setEmpty(true);
                    loadMoreRef.current = loadMore; // history may still exist
                    return;
                }
                rawRef.current = raw;
                applyBars(bars);
                lastBarRef.current = bars[bars.length - 1] ?? null;
                loadedKeyRef.current = loadKey;
                loadMoreRef.current = loadMore;
                chartRef.current?.timeScale().scrollToRealTime();
                // a manual price-axis drag disables autoScale and pins the
                // range; without re-enabling it the prior symbol's price band
                // sticks (e.g. a 1000元 stock leaves a 10元 stock off-screen,
                // issue #6) — restore auto-fit for every freshly loaded symbol
                candleSeriesRef.current
                    .priceScale()
                    .applyOptions({ autoScale: true });
            })
            .catch(() => {
                if (cancelled) return;
                clearSeries();
                setEmpty(true);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [contract, tf]);

    // live tick -> update current bar
    const tick = quote?.tick;
    if (tick && tick.code === contract.code) {
        const p = Number(tick.close);
        if (Number.isFinite(p)) lastPriceRef.current = p;
    }
    useEffect(() => {
        if (!tick || tick.code !== contract.code) return;
        // 試撮 (simtrade) 揭示價可以是漲跌停天地價 — 畫進 K 棒會把
        // Y 軸尺度撐爆（issue #5），一律排除
        if (tick.simtrade) return;
        // history for this (symbol, timeframe) not in place yet
        if (loadedKeyRef.current !== `${contract.code}|${tf.minutes}`) return;
        const series = candleSeriesRef.current;
        if (!series) return;
        const price = Number(tick.close);
        if (!Number.isFinite(price)) return;
        const tickTime = wallClockToUtc(`${tick.date}T${tick.time}`);
        const bucketSec = tf.minutes * 60;
        const bucket =
            tf.minutes >= 1440
                ? Math.floor(tickTime / 86400) * 86400
                : Math.floor(tickTime / bucketSec) * bucketSec;
        let bar = lastBarRef.current;
        if (!bar || bucket > bar.time) {
            bar = {
                time: bucket,
                open: price,
                high: price,
                low: price,
                close: price,
                volume: tick.volume,
            };
            // a fresh bucket = the previous bar closed — keep barsRef in
            // sync (history paging re-attaches this tail) and recompute
            // indicators once per bar close
            barsRef.current.push(bar);
            setDataVersion((v) => v + 1);
        } else {
            bar.high = Math.max(bar.high, price);
            bar.low = Math.min(bar.low, price);
            bar.close = price;
            bar.volume += tick.volume;
        }
        lastBarRef.current = bar;
        try {
            series.update({
                time: bar.time as UTCTimestamp,
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
            });
            volSeriesRef.current?.update({
                time: bar.time as UTCTimestamp,
                value: bar.volume,
                color: bar.close >= bar.open ? colors.upVol : colors.downVol,
            });
        } catch {
            // a rejected update (e.g. timestamp older than the series tail)
            // must never take the app down — history reload will resync
        }
    }, [tick, contract.code, tf.minutes]);

    // indicator instances → chart series: overlays on the main pane,
    // every oscillator instance in its own sub-pane (lightweight-charts v5)
    const instancesKey = JSON.stringify(instances);
    useEffect(() => {
        const chart = chartRef.current;
        if (!chart) return;
        // remember the user-dragged height of every existing sub-pane
        // BEFORE teardown — rebuilds must not reset the 上下圖比例
        try {
            const panes = chart.panes();
            paneAssignRef.current.forEach((paneIdx, instId) => {
                const h = panes[paneIdx]?.getHeight();
                if (h && h > 0) paneHeightsRef.current.set(instId, h);
            });
        } catch {
            // pane API differences must never take the chart down
        }
        for (const series of indSeriesRef.current) {
            try {
                chart.removeSeries(series);
            } catch {
                // already gone with chart teardown
            }
        }
        indSeriesRef.current = [];
        // drop the now-empty sub-panes (pane 0 = main chart)
        try {
            for (let i = chart.panes().length - 1; i >= 1; i--) {
                chart.removePane(i);
            }
        } catch {
            // pane API differences must never take the chart down
        }
        const paneAssign = new Map<string, number>();
        const bars = barsRef.current;
        if (bars.length === 0) {
            paneAssignRef.current = paneAssign; // no panes exist right now
            setPaneTops({});
            return;
        }

        const toLineData = (pts: IndicatorPoint[]) =>
            pts.map((p) =>
                p.value === undefined
                    ? { time: p.time as UTCTimestamp }
                    : { time: p.time as UTCTimestamp, value: p.value },
            ) as SeriesDataItemTypeMap['Line'][];

        let paneIdx = 1;
        legendMetaRef.current = new Map();
        for (const inst of instances) {
            const def = DEF_BY_TYPE.get(inst.type);
            if (!def) continue;
            if (inst.hidden) continue; // 眼睛關閉 — 保留設定不畫線
            // 時框顯示設定（TradingView Visibility on intervals）
            if (inst.visibleTf && !inst.visibleTf.includes(tf.minutes)) {
                continue;
            }
            const params: Record<string, number> = {};
            for (const p of def.params) {
                params[p.key] = inst.params[p.key] ?? p.def;
            }
            let out: Record<string, IndicatorPoint[]>;
            try {
                out = def.compute(bars, params);
            } catch {
                continue; // a bad param combination must not kill the chart
            }
            const pane = def.category === 'pane' ? paneIdx++ : 0;
            if (pane > 0) paneAssign.set(inst.id, pane);
            let firstSeries: ISeriesApi<'Line' | 'Histogram'> | null = null;
            const metas: {
                label: string;
                color: string;
                series: ISeriesApi<'Line' | 'Histogram'>;
                last?: number;
                precision?: number;
            }[] = [];
            const lastVal = (pts: IndicatorPoint[]) => {
                for (let i = pts.length - 1; i >= 0; i--) {
                    if (pts[i]!.value !== undefined) return pts[i]!.value;
                }
                return undefined;
            };
            // per-instance precision → axis/legend number formatting
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
            const labelOpts = {
                priceLineVisible: false,
                lastValueVisible: inst.showLabels ?? false,
            };
            for (const o of def.outputs) {
                const pts = out[o.key];
                if (!pts) continue;
                const st = outputStyle(inst, def, o.key);
                if (!st.visible) continue;
                const color = colorWithOpacity(st.color, st.opacity);
                let s: ISeriesApi<'Line' | 'Histogram' | 'Area'>;
                if (st.plot === 'histogram') {
                    s = chart.addSeries(
                        HistogramSeries,
                        { color, ...labelOpts, ...priceFormatOpt },
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
                            ...labelOpts,
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
                            ...labelOpts,
                            ...priceFormatOpt,
                        },
                        pane,
                    );
                    s.setData(toLineData(pts));
                }
                indSeriesRef.current.push(
                    s as ISeriesApi<'Line' | 'Histogram'>,
                );
                firstSeries ??= s as ISeriesApi<'Line' | 'Histogram'>;
                metas.push({
                    label: o.label,
                    color: st.color,
                    series: s as ISeriesApi<'Line' | 'Histogram'>,
                    last: lastVal(pts),
                    precision: inst.precision,
                });
            }
            // 圖上不顯示數值時 legend 只留名稱
            legendMetaRef.current.set(
                inst.id,
                (inst.showValues ?? true) ? metas : [],
            );
            // reference levels（RSI 30/70、KD 20/80…）in the sub-pane
            if (pane > 0 && firstSeries && def.levels) {
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
        }
        // restore each instance's remembered pane height（使用者拖過的
        // 上下圖比例在移除別的指標/改參數/收 K 棒重建後都要保住）；
        // 只有第一次出現的 pane 用預設 110px
        try {
            const panes = chart.panes();
            paneAssign.forEach((paneIdx, instId) => {
                panes[paneIdx]?.setHeight(
                    paneHeightsRef.current.get(instId) ?? 110,
                );
            });
        } catch {
            // pane API differences must never take the chart down
        }
        paneAssignRef.current = paneAssign;
        // 副圖 legend 跟著自己的 pane 走 — 量出每個 pane 在 host 內的
        // top offset，pane 被拖動改高度時 ResizeObserver 會重新量
        try {
            const host = hostRef.current;
            const panes = chart.panes();
            const measure = () => {
                const hostTop = host?.getBoundingClientRect().top ?? 0;
                const tops: Record<string, number> = {};
                paneAssign.forEach((paneIdx, instId) => {
                    const el = panes[paneIdx]?.getHTMLElement();
                    if (el) {
                        tops[instId] =
                            el.getBoundingClientRect().top - hostTop;
                    }
                });
                setPaneTops(tops);
            };
            const ro = new ResizeObserver(measure);
            paneAssign.forEach((paneIdx) => {
                const el = panes[paneIdx]?.getHTMLElement();
                if (el) ro.observe(el);
            });
            paneRoRef.current = ro;
            requestAnimationFrame(measure);
        } catch {
            setPaneTops({}); // pane API 不可用 → 副圖 legend 退回主圖堆疊
        }
        updateLegendRef.current(); // seed legend with latest values
        return () => {
            paneRoRef.current?.disconnect();
            paneRoRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataVersion, instancesKey, themeKey, tf.minutes]);

    const commitInstances = (list: IndicatorInstance[]) => {
        setInstances(list);
        saveInstances(list);
    };
    // 點選指標 → 先開設定（圖上即時預覽），確定才算加入、取消整個撤掉
    const addIndicator = (type: string) => {
        settingsSnapshotRef.current = JSON.stringify(instances); // 不含新實例
        const inst = newInstance(type);
        commitInstances([...instances, inst]);
        setPickerOpen(false);
        setSettingsFor(inst.id);
    };
    const removeIndicator = (id: string) => {
        if (settingsFor === id) setSettingsFor(null);
        commitInstances(instances.filter((i) => i.id !== id));
    };
    const patchInstance = (id: string, patch: Partial<IndicatorInstance>) => {
        commitInstances(
            instances.map((i) => (i.id === id ? { ...i, ...patch } : i)),
        );
    };
    const openSettings = (id: string) => {
        settingsSnapshotRef.current = JSON.stringify(instances);
        setLegendMenuFor(null);
        setSettingsFor(id);
    };
    const duplicateIndicator = (id: string) => {
        const idx = instances.findIndex((i) => i.id === id);
        if (idx < 0) return;
        const dup = duplicateInstance(instances[idx]!);
        const next = [...instances];
        next.splice(idx + 1, 0, dup);
        commitInstances(next);
    };
    // 視覺順序：陣列順序 = 疊圖 z-order 與副圖 pane 排序
    const moveIndicator = (id: string, dir: -1 | 1) => {
        const idx = instances.findIndex((i) => i.id === id);
        const to = idx + dir;
        if (idx < 0 || to < 0 || to >= instances.length) return;
        const next = [...instances];
        const [item] = next.splice(idx, 1);
        next.splice(to, 0, item!);
        commitInstances(next);
    };
    const toggleFavorite = (type: string) => {
        const favs = loadFavorites();
        if (favs.has(type)) favs.delete(type);
        else favs.add(type);
        saveFavorites(favs);
    };
    const cancelSettings = () => {
        try {
            const snap = JSON.parse(
                settingsSnapshotRef.current,
            ) as IndicatorInstance[];
            commitInstances(snap);
        } catch {
            // snapshot unreadable — keep current state
        }
        setSettingsFor(null);
    };
    const settingsInst = instances.find((i) => i.id === settingsFor) ?? null;

    // recalibrate the view — re-fit both axes after the user has panned or
    // dragged the price scale into a corner (issue #6: no reset control)
    const resetView = () => {
        const chart = chartRef.current;
        if (!chart) return;
        candleSeriesRef.current?.priceScale().applyOptions({ autoScale: true });
        chart.timeScale().fitContent();
    };

    // draw working-order price lines (buy=up color / sell=down color)
    const orderKey = JSON.stringify(
        workingOrders.map((t) => [
            t.order.id,
            t.status.modified_price || t.order.price,
            t.order.quantity - t.status.deal_quantity,
        ]),
    );
    useEffect(() => {
        const series = candleSeriesRef.current;
        if (!series) return;
        const lines = new Map<string, IPriceLine>();
        for (const t of workingOrdersRef.current) {
            const price = t.status.modified_price || t.order.price;
            const remaining = t.order.quantity - t.status.deal_quantity;
            lines.set(
                t.order.id,
                series.createPriceLine({
                    price,
                    color: t.order.action === 'Buy' ? colors.up : colors.down,
                    lineWidth: 2,
                    lineStyle: 0, // solid
                    axisLabelVisible: true,
                    title: `${t.order.action === 'Buy' ? '買' : '賣'}${remaining} ⠿`,
                }),
            );
        }
        orderLinesRef.current = lines;
        return () => {
            for (const line of lines.values()) series.removePriceLine(line);
            orderLinesRef.current = new Map();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [orderKey, themeKey, contract.code]);

    // drag an order line to modify its price
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        let dragging: { trade: Trade; line: IPriceLine; price: number } | null =
            null;
        // active document listeners — removed on unmount if a drag is live
        let activeMove: ((e: MouseEvent) => void) | null = null;
        let activeUp: (() => void) | null = null;

        const yOf = (e: MouseEvent) =>
            e.clientY - host.getBoundingClientRect().top;

        const findNear = (y: number) => {
            const series = candleSeriesRef.current;
            if (!series) return null;
            for (const t of workingOrdersRef.current) {
                const line = orderLinesRef.current.get(t.order.id);
                if (!line) continue;
                const coord = series.priceToCoordinate(line.options().price);
                if (coord !== null && Math.abs(coord - y) <= 6) {
                    return { trade: t, line };
                }
            }
            return null;
        };

        const hover = (e: MouseEvent) => {
            if (dragging) return;
            host.style.cursor = findNear(yOf(e)) ? 'ns-resize' : '';
        };

        const down = (e: MouseEvent) => {
            if (e.button !== 0) return;
            const hit = findNear(yOf(e));
            if (!hit) return;
            e.preventDefault();
            e.stopPropagation();
            chartRef.current?.applyOptions({
                handleScroll: false,
                handleScale: false,
            });
            dragging = {
                trade: hit.trade,
                line: hit.line,
                price: hit.line.options().price,
            };

            const move = (ev: MouseEvent) => {
                const series = candleSeriesRef.current;
                if (!series || !dragging) return;
                const raw = series.coordinateToPrice(yOf(ev));
                if (raw === null) return;
                const np = roundToTick(contractRef.current, Number(raw));
                dragging.price = np;
                dragging.line.applyOptions({ price: np });
            };
            const up = () => {
                document.removeEventListener('mousemove', move, true);
                document.removeEventListener('mouseup', up, true);
                activeMove = null;
                activeUp = null;
                chartRef.current?.applyOptions({
                    handleScroll: true,
                    handleScale: true,
                });
                const d = dragging;
                dragging = null;
                if (!d) return;
                const orig =
                    d.trade.status.modified_price || d.trade.order.price;
                if (d.price === orig) return;
                updateOrderPrice(d.trade.order.id, d.price)
                    .then(() => {
                        notify({
                            kind: 'ok',
                            title: '✏️ 改價已送出',
                            body: `${d.trade.contract.code} ${fmtPrice(orig)} → ${fmtPrice(d.price)}`,
                        });
                        onOrdersChangedRef.current?.();
                    })
                    .catch((err) => {
                        notify({
                            kind: 'err',
                            title: '改價失敗',
                            body:
                                err instanceof Error
                                    ? err.message
                                    : String(err),
                        });
                        onOrdersChangedRef.current?.();
                    });
            };
            document.addEventListener('mousemove', move, true);
            document.addEventListener('mouseup', up, true);
            activeMove = move;
            activeUp = up;
        };

        host.addEventListener('mousedown', down, true); // capture: beat chart pan
        host.addEventListener('mousemove', hover, true);
        return () => {
            host.removeEventListener('mousedown', down, true);
            host.removeEventListener('mousemove', hover, true);
            // unmounted mid-drag — drop the document listeners too
            if (activeMove) {
                document.removeEventListener('mousemove', activeMove, true);
            }
            if (activeUp) document.removeEventListener('mouseup', activeUp, true);
        };
    }, []);

    // draw trigger price lines on the candle series
    useEffect(() => {
        const series = candleSeriesRef.current;
        if (!series) return;
        const lines = triggers.map((t) =>
            series.createPriceLine({
                price: t.price,
                color:
                    t.kind === 'stop'
                        ? '#e0a43c'
                        : t.kind === 'alert'
                          ? '#8b94a7'
                          : colors.crosshair,
                lineWidth: 1,
                lineStyle: 2, // dashed
                axisLabelVisible: true,
                title:
                    t.kind === 'alert'
                        ? '警示'
                        : `${t.kind === 'stop' ? '停損' : '停利'}${t.action === 'Buy' ? '買' : '賣'}${t.quantity}`,
            }),
        );
        return () => {
            for (const line of lines) series.removePriceLine(line);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [JSON.stringify(triggers), themeKey, contract.code]);

    // 單列 legend（主圖堆疊與各副圖 pane 共用同一套列與控制）
    const renderLegendRow = (inst: IndicatorInstance) => {
        const def = DEF_BY_TYPE.get(inst.type);
        if (!def) return null;
        const idx = instances.findIndex((i) => i.id === inst.id);
        const vals = legendValues[inst.id] ?? [];
        const offTf =
            !!inst.visibleTf && !inst.visibleTf.includes(tf.minutes);
        const dimmed = inst.hidden || offTf;
        const nameColor = outputStyle(inst, def, def.outputs[0]!.key).color;
        return (
                                <div
                                    key={inst.id}
                                    className={
                                        styles.legendItem[
                                            dimmed ? 'hidden' : 'normal'
                                        ]
                                    }
                                >
                                    <button
                                        className={styles.legendLabel}
                                        style={{ color: nameColor }}
                                        title='開啟指標設定'
                                        onClick={() => openSettings(inst.id)}
                                    >
                                        {instanceLabel(inst)}
                                    </button>
                                    {offTf && (
                                        <span className={styles.legendNote}>
                                            此時框停用
                                        </span>
                                    )}
                                    {!dimmed && (
                                        <span className={styles.legendVals}>
                                            {vals.map((v, i) => (
                                                <span
                                                    key={i}
                                                    className={
                                                        styles.legendVal
                                                    }
                                                    style={{ color: v.color }}
                                                    title={v.label}
                                                >
                                                    {v.text}
                                                </span>
                                            ))}
                                        </span>
                                    )}
                                    <span className={styles.legendCtrls}>
                                        <button
                                            className={styles.legendCtrlBtn}
                                            title={
                                                inst.hidden ? '顯示' : '隱藏'
                                            }
                                            onClick={() =>
                                                patchInstance(inst.id, {
                                                    hidden: !inst.hidden,
                                                })
                                            }
                                        >
                                            {inst.hidden ? (
                                                <EyeOff size={11} />
                                            ) : (
                                                <Eye size={11} />
                                            )}
                                        </button>
                                        <button
                                            className={styles.legendCtrlBtn}
                                            title='設定'
                                            onClick={() =>
                                                openSettings(inst.id)
                                            }
                                        >
                                            <Settings2 size={11} />
                                        </button>
                                        <button
                                            className={styles.legendCtrlBtn}
                                            title='移除'
                                            onClick={() =>
                                                removeIndicator(inst.id)
                                            }
                                        >
                                            <X size={11} />
                                        </button>
                                        <button
                                            className={styles.legendCtrlBtn}
                                            title='更多'
                                            onClick={() =>
                                                setLegendMenuFor(
                                                    legendMenuFor === inst.id
                                                        ? null
                                                        : inst.id,
                                                )
                                            }
                                        >
                                            <MoreHorizontal size={11} />
                                        </button>
                                    </span>
                                    {legendMenuFor === inst.id && (
                                        <>
                                            <div
                                                className={
                                                    styles.legendMenuBackdrop
                                                }
                                                onClick={() =>
                                                    setLegendMenuFor(null)
                                                }
                                            />
                                            <div
                                                className={styles.legendMenu}
                                            >
                                                <button
                                                    className={
                                                        styles.legendMenuItem
                                                    }
                                                    onClick={() => {
                                                        toggleFavorite(
                                                            inst.type,
                                                        );
                                                        setLegendMenuFor(
                                                            null,
                                                        );
                                                    }}
                                                >
                                                    <Star size={11} />
                                                    加入 / 移除我的最愛
                                                </button>
                                                <button
                                                    className={
                                                        styles.legendMenuItem
                                                    }
                                                    onClick={() => {
                                                        duplicateIndicator(
                                                            inst.id,
                                                        );
                                                        setLegendMenuFor(
                                                            null,
                                                        );
                                                    }}
                                                >
                                                    <Copy size={11} />
                                                    複製指標
                                                </button>
                                                <button
                                                    className={
                                                        styles.legendMenuItem
                                                    }
                                                    disabled={idx === 0}
                                                    onClick={() =>
                                                        moveIndicator(
                                                            inst.id,
                                                            -1,
                                                        )
                                                    }
                                                >
                                                    <ArrowUp size={11} />
                                                    上移（視覺順序）
                                                </button>
                                                <button
                                                    className={
                                                        styles.legendMenuItem
                                                    }
                                                    disabled={
                                                        idx ===
                                                        instances.length - 1
                                                    }
                                                    onClick={() =>
                                                        moveIndicator(
                                                            inst.id,
                                                            1,
                                                        )
                                                    }
                                                >
                                                    <ArrowDown size={11} />
                                                    下移（視覺順序）
                                                </button>
                                                <button
                                                    className={
                                                        styles.legendMenuItem
                                                    }
                                                    onClick={() =>
                                                        openSettings(inst.id)
                                                    }
                                                >
                                                    <Settings2 size={11} />
                                                    設定…
                                                </button>
                                                <button
                                                    className={
                                                        styles.legendMenuItemDanger
                                                    }
                                                    onClick={() => {
                                                        removeIndicator(
                                                            inst.id,
                                                        );
                                                        setLegendMenuFor(
                                                            null,
                                                        );
                                                    }}
                                                >
                                                    <X size={11} />
                                                    移除
                                                </button>
                                            </div>
                                        </>
                                    )}
                                </div>
        );
    };
    // 主圖堆疊只放：主圖疊加類、被隱藏/此時框停用、或 pane 尚未量到位置的
    const mainLegendInsts = instances.filter((inst) => {
        const def = DEF_BY_TYPE.get(inst.type);
        if (!def) return false;
        const offTf =
            !!inst.visibleTf && !inst.visibleTf.includes(tf.minutes);
        return (
            def.category === 'overlay' ||
            !!inst.hidden ||
            offTf ||
            paneTops[inst.id] === undefined
        );
    });
    return (
        <div className={styles.wrap}>
            <div className={styles.toolbar}>
                {TIMEFRAMES.map((t, i) => (
                    <button
                        key={t.label}
                        className={styles.tfBtn[i === tfIdx ? 'active' : 'normal']}
                        onClick={() => setTfIdx(i)}
                    >
                        {t.label}
                    </button>
                ))}
                <button
                    className={styles.iconBtn}
                    onClick={resetView}
                    title='重設視圖（自動縮放）'
                    aria-label='重設視圖'
                >
                    <Maximize2 size={12} />
                </button>
                <span className={styles.toolbarDivider} />
                {TRADE_MODES.map((m) => (
                    <button
                        key={m.key}
                        className={
                            styles.modeBtn[
                                mode === m.key
                                    ? m.key === 'observe'
                                        ? 'active'
                                        : 'armed'
                                    : 'normal'
                            ]
                        }
                        onClick={() => setMode(m.key)}
                    >
                        {m.label}
                    </button>
                ))}
                <label
                    className={styles.qtyWrap}
                    title='圖表下單數量（點價買賣/停損/停利的口數或張數）'
                >
                    量
                    <input
                        className={styles.qtyInput}
                        value={tradeQty}
                        inputMode='numeric'
                        onChange={(e) => {
                            const v = Number(e.target.value);
                            if (Number.isInteger(v) && v >= 1) setTradeQty(v);
                        }}
                    />
                </label>
                <button
                    className={
                        styles.indicatorBtn[
                            instances.length > 0 ? 'active' : 'normal'
                        ]
                    }
                    onClick={() => setPickerOpen(true)}
                >
                    指標
                </button>
                {pickerOpen && (
                    <IndicatorDialog
                        instances={instances}
                        onAdd={addIndicator}
                        onClose={() => setPickerOpen(false)}
                    />
                )}
                {settingsInst && (
                    <IndicatorSettingsModal
                        inst={settingsInst}
                        timeframes={TIMEFRAMES.map((t) => ({
                            label: t.label,
                            minutes: t.minutes,
                        }))}
                        onPatch={(patch) =>
                            patchInstance(settingsInst.id, patch)
                        }
                        onRemove={() => removeIndicator(settingsInst.id)}
                        onCommit={() => setSettingsFor(null)}
                        onCancel={cancelSettings}
                    />
                )}
            </div>
            <div ref={hostRef} className={styles.chartHost}>
                {loading && (
                    <div className={styles.emptyMsg}>
                        <span className={panel.mono}>
                            載入 {tf.label} K 線…
                        </span>
                    </div>
                )}
                {empty && !loading && (
                    <div className={styles.emptyMsg}>
                        <span className={panel.mono}>無 K 線資料</span>
                    </div>
                )}
                {mode !== 'observe' && (
                    <div className={styles.modeHint}>
                        {mode === 'buy' && '點擊圖表價位 → 限價買進'}
                        {mode === 'sell' && '點擊圖表價位 → 限價賣出'}
                        {mode === 'stop' && '點擊價位掛停損（觸價市價單）'}
                        {mode === 'take' && '點擊價位掛停利（觸價市價單）'}
                        {mode === 'alert' && '點擊價位設定到價警示（只通知不下單）'}
                    </div>
                )}
                {(workingOrders.length > 0 ||
                    triggers.length > 0 ||
                    instances.length > 0) && (
                    <div className={styles.triggerList}>
                        {mainLegendInsts.map((inst) =>
                            renderLegendRow(inst),
                        )}
                        {workingOrders.map((t) => {
                            const price =
                                t.status.modified_price || t.order.price;
                            const remaining =
                                t.order.quantity - t.status.deal_quantity;
                            return (
                                <div
                                    key={t.order.id}
                                    className={styles.triggerRow}
                                >
                                    <span
                                        className={
                                            panel.dirText[
                                                t.order.action === 'Buy'
                                                    ? 'up'
                                                    : 'down'
                                            ]
                                        }
                                    >
                                        委{t.order.action === 'Buy' ? '買' : '賣'}
                                        {remaining} @{fmtPrice(price)}
                                    </span>
                                    <button
                                        className={styles.orderCancel}
                                        title='刪單'
                                        onClick={() =>
                                            cancelOrder(t.order.id)
                                                .then(() => {
                                                    notify({
                                                        kind: 'ok',
                                                        title: '🗑 刪單已送出',
                                                        body: `${t.contract.code} @${fmtPrice(price)}`,
                                                    });
                                                    onOrdersChangedRef.current?.();
                                                })
                                                .catch((e) =>
                                                    notify({
                                                        kind: 'err',
                                                        title: '刪單失敗',
                                                        body:
                                                            e instanceof Error
                                                                ? e.message
                                                                : String(e),
                                                    }),
                                                )
                                        }
                                    >
                                        CANCEL
                                    </button>
                                </div>
                            );
                        })}
                        {triggers.map((t) => (
                            <div key={t.id} className={styles.triggerRow}>
                                <span>
                                    {t.kind === 'stop' ? (
                                        <OctagonX size={10} />
                                    ) : t.kind === 'take' ? (
                                        <Crosshair size={10} />
                                    ) : (
                                        <Bell size={10} />
                                    )}{' '}
                                    {t.condition === 'below' ? '≤' : '≥'}
                                    {fmtPrice(t.price)}
                                    {t.kind !== 'alert' &&
                                        ` ${t.action === 'Buy' ? '買' : '賣'}${t.quantity}`}
                                </span>
                                <button
                                    className={styles.triggerRemove}
                                    onClick={() => removeTrigger(t.id)}
                                >
                                    <X size={10} />
                                </button>
                            </div>
                        ))}
                    </div>
                )}
                {/* 副圖指標的 legend 疊在自己的 pane 左上角，不混進主圖 */}
                {instances.map((inst) => {
                    const def = DEF_BY_TYPE.get(inst.type);
                    if (!def || def.category !== 'pane' || inst.hidden) {
                        return null;
                    }
                    if (
                        inst.visibleTf &&
                        !inst.visibleTf.includes(tf.minutes)
                    ) {
                        return null;
                    }
                    const top = paneTops[inst.id];
                    if (top === undefined) return null;
                    return (
                        <div
                            key={`pane-legend-${inst.id}`}
                            className={styles.paneLegend}
                            style={{ top: top + 4 }}
                        >
                            {renderLegendRow(inst)}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
