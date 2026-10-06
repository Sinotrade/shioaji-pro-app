import { RefreshButton } from './refresh-button';
import { fetchChartHistory, nextChartHistoryRevision } from '../lib/chart-history';
// src/components/candle-chart.tsx — K-bar candlestick + volume chart
// (lightweight-charts v5), live-updated from the SSE tick stream.

import {
    AreaSeries,
    CandlestickSeries,
    ColorType,
    createSeriesMarkers,
    createChart,
    HistogramSeries,
    LineSeries,
    LineStyle,
    LineType,
    type IChartApi,
    type IPriceLine,
    type ISeriesMarkersPluginApi,
    type ISeriesApi,
    type MouseEventParams,
    type SeriesDataItemTypeMap,
    type Time,
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
import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuote, useStreamStatus } from '../hooks/use-stream';
import { useV9ResearchFlow } from '../hooks/use-v9-research-flow';
import { ResearchMarkerControls } from './research-marker-controls';
import { ResearchFibonacci } from './research-fibonacci';
import { applyResearchPaneLayout } from '../lib/research-chart-layout';
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
import { IndicatorInstanceContext } from '../lib/indicator-instance-context';
import {
    IndicatorDialog,
    IndicatorSettingsModal,
} from './indicator-dialog';
// side-effect import順序：custom-indicators 在 module 載入時就把已存的
// 自訂指標註冊進 DEF_BY_TYPE，loadInstances() 的型別過濾才不會把它們丟掉
import { subscribeCustoms } from '../lib/custom-indicators';
import type { IndicatorPoint } from '../lib/indicators';
import { v9AtrDefense } from '../lib/indicators';
import { defenseEvents, defenseSegments, researchOpening, RESEARCH_COLORS } from '../lib/research-visuals';
import { pivotLevels } from '../lib/pivot-levels';
import { ResearchTransitionPrimitive, type ResearchVerticalLine } from '../lib/research-transition-primitive';
import { setPickedPrice } from '../lib/price-sync';
import { cancelOrder, updateOrderPrice } from '../lib/shioaji';
import { getChartColors, useThemeSettings } from '../lib/theme-store';
import { notify, placeQuickOrder } from '../lib/trade';
import {
    addTrigger,
    removeTrigger,
    useTriggers,
} from '../lib/trigger-engine';
import type { ContractBase } from '../lib/types/contract';
import type { Candle } from '../lib/types/market';
import type { Trade } from '../lib/types/order';
import { remainingWorkingOrderQuantity } from '../lib/working-order-quantity';
import { fmtPrice } from '../lib/utils/format';
import {
    aggregate,
    dateStrOffset,
    kbarsToCandles,
    wallClockToUtc,
    nowWallClockUtc,
} from '../lib/utils/kbars';
import { researchLevels, toHeikinAshi, v9Resonance } from '../lib/utils/research-chart';
import {
    v9KbarMarkers, completedResearchBars, researchTickBucket, selectResearchMarkers,
    DEFAULT_MARKER_OPTIONS, EMPTY_FLOW, researchMarkerGap, mergeResearchMarkerLabels,
    supertrendTradeMarkers, supertrendShortTradeMarkers,
    entrySignalsToMarkers,
    shortSignalsToMarkers,
} from '../lib/utils/v9-chart-markers';
import { roundToTick } from '../lib/utils/ticksize';
import { V9_RESEARCH_MODE } from '../lib/workspace';
import { useMarketReplay } from '../hooks/use-market-replay';
import { useEntrySignals } from '../hooks/use-entry-signals';
import { useResearchBackground } from '../hooks/use-research-background';
import { researchBackgroundKey, researchBackgroundStore } from '../lib/research-background';
import type { ResearchEntryContext } from '../lib/research-entry';
import { researchSessionVwap, projectResearchVwap } from '../lib/research-vwap';
import { researchSetups } from '../lib/research-setups';
import { chartScopeKey, quoteChangePercent, researchDataStatus, scopedResearchSource } from '../lib/research-chart-state';

import { buildOrderFlow } from '../lib/order-flow';
import { ReplayControls } from './replay-controls';
import { ResearchOrderFlow } from './research-order-flow';
import * as styles from './candle-chart.css';
import { Orb } from './orb';
import * as panel from './panel.css';

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
type CandleStyle = 'standard' | 'heikinAshi';

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
    panelId,
    contract,
    trades = [],
    onOrdersChanged,
}: {
    panelId?: string;
    contract: ContractBase;
    trades?: Trade[];
    onOrdersChanged?: () => void;
}) {
    const hostRef = useRef<HTMLDivElement>(null);
    const fibCaptureRef = useRef(false);
    const chartRef = useRef<IChartApi | null>(null);
    const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
    const volSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
    const v9MarkersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
    const v9VolumeMarkersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
    // V9 多空底色：滿高的淡色 histogram（獨立 overlay 價格軸），繪製在 K 棒底層。
    const v9TintRef = useRef<ISeriesApi<'Histogram'> | null>(null);
    const lastBarRef = useRef<Candle | null>(null);
    const displayBarsRef = useRef<Candle[]>([]);
    const [tfIdx, setTfIdx] = useState(1); // default 5m
    const [candleStyle, setCandleStyle] = useState<CandleStyle>(
        V9_RESEARCH_MODE ? 'heikinAshi' : 'standard',
    );
    const [empty, setEmpty] = useState(false);
    const [loading, setLoading] = useState(false);
    // 歷史斷層自癒（issue #18）：開盤前抓的歷史可能缺少上游尚未發布的
    // 跨午夜夜盤段，live 進來出現大斷層時補抓一次
    const [historySeq, setHistorySeq] = useState(0);
    const gapReloadAtRef = useRef(0);
    // 覆蓋率自癒（issue #18 二報）：live 斷層觸發的那次補抓常常太早
    // （上游還沒發布），live bar 一堆積洞就變「內部洞」再也偵測不到 —
    // 載入後直接驗覆蓋率，有缺口就退避排程重抓直到上游補齊（封頂）
    // ticks must NOT touch the series until history for the current
    // (symbol, timeframe) is in place — updating a freshly-switched series
    // with a bucket older than its last point makes lightweight-charts
    // throw inside the effect, which unmounts the whole app (issue #1)
    const loadedKeyRef = useRef('');
    const quote = useQuote(contract.code);
    const streamStatus = useStreamStatus();
    const tf = TIMEFRAMES[tfIdx] ?? TIMEFRAMES[1];
    const chartScope = chartScopeKey(contract, tf.minutes);
    const flow = useV9ResearchFlow(contract.code, contract.security_type, tf.minutes, V9_RESEARCH_MODE, chartScopeKey(contract, 0));
    const [markerOptions, setMarkerOptions] = useState(DEFAULT_MARKER_OPTIONS);
    const [markerGap, setMarkerGap] = useState(5);
    // Local clock only: finish the last bar even if no further tick arrives.
    const replay = useMarketReplay(contract);
    const { long: longEntrySignals, short: shortEntrySignals } = useEntrySignals(contract);
    const [researchMinute, setResearchMinute] = useState(() => Math.floor(nowWallClockUtc() / 60));
    const [researchClock, setResearchClock] = useState(nowWallClockUtc);
    useEffect(() => {
        if (!V9_RESEARCH_MODE) return;
        const timer = setInterval(() => {
            const now = nowWallClockUtc();
            setResearchMinute(Math.floor(now / 60));
            setResearchClock(now);
        }, 5000);
        return () => clearInterval(timer);
    }, []);
    const themeSettings = useThemeSettings();
    const colors = getChartColors(themeSettings);
    const themeKey = `${themeSettings.mode}-${themeSettings.convention}`;
    const [mode, setMode] = useState<TradeMode>('observe');
    const [tradeQty, setTradeQty] = useState(1);
    // 組合商品（合成合約）只能用組合單下單 — 圖上禁用交易模式
    const isCombo = Boolean((contract as { combo?: unknown }).combo);
    // 在點價/停損/停利模式中切到組合商品 → 強制回觀察，殘留的交易
    // 模式不能對組合圖繼續吃點擊
    useEffect(() => {
        if (isCombo && mode !== 'observe' && mode !== 'alert') {
            setMode('observe');
        }
    }, [isCombo, mode]);
    const [legacyInstances, setInstances] =
        useState<IndicatorInstance[]>(loadInstances);
    const service = useContext(IndicatorInstanceContext);
    const panelService = panelId ? service : null;
    const panelState = useSyncExternalStore(
        panelService?.subscribe ?? (() => () => {}),
        () => panelService && panelId ? panelService.snapshot(panelId) : null,
    );
    useEffect(() => panelService && panelId ? panelService.registerPanel(panelId) : undefined, [panelService, panelId]);
    const savedInstances = panelState?.instances ?? legacyInstances;
    const [settingsDraft, setSettingsDraft] = useState<IndicatorInstance | null>(null);
    const settingsRevisionRef = useRef('');
    const settingsNewRef = useRef(false);
    const instances = settingsDraft
        ? savedInstances.some(i => i.id === settingsDraft.id)
            ? savedInstances.map(i => i.id === settingsDraft.id ? settingsDraft : i)
            : [...savedInstances, settingsDraft]
        : savedInstances;
    const [pickerOpen, setPickerOpen] = useState(false);
    const [settingsFor, setSettingsFor] = useState<string | null>(null);
    const [legendMenuFor, setLegendMenuFor] = useState<string | null>(null);
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
    // stretch factor 是比例值 — 用它保存/還原上下圖比例才不會像 px
    // 高度那樣每次重建累積捨入漂移；'__main' 鍵保存主圖那份
    const paneStretchRef = useRef(new Map<string, number>());
    const paneHeightsRef = useRef(new Map<string, number>());
    // 副圖 legend 定位：instId -> pane 在 chartHost 內的 top offset px
    const [paneTops, setPaneTops] = useState<Record<string, number>>({});
    const paneRoRef = useRef<ResizeObserver | null>(null);
    const [dataVersion, setDataVersion] = useState(0);
    const [fibOpen, setFibOpen] = useState(false);
    const barsRef = useRef<Candle[]>([]);
    // raw 1-min candles backing the current view — history pages merge here
    // and re-aggregate so buckets spanning a page seam stay correct
    const rawRef = useRef<Candle[]>([]);
    const liveMinuteChangesRef = useRef(new Map<number, { bar: Candle; revision: number }>());
    const background = useResearchBackground(contract, V9_RESEARCH_MODE);
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
                    remainingWorkingOrderQuantity(t) > 0,
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
        // V9 多空底色：先於 K 棒建立，淡色滿高柱畫在最底層；用獨立 overlay 軸
        // （v9bg，scaleMargins 0/0）撐滿整個圖區且不影響主價格座標，中性／暖機
        // 段不給點。純研究視覺、不下單。
        if (V9_RESEARCH_MODE) {
            const tint = chart.addSeries(HistogramSeries, {
                priceScaleId: 'v9bg',
                priceLineVisible: false,
                lastValueVisible: false,
                baseLineVisible: false,
                priceFormat: { type: 'price' },
            });
            chart.priceScale('v9bg').applyOptions({
                scaleMargins: { top: 0, bottom: 0 },
            });
            v9TintRef.current = tint;
        }
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
        if (V9_RESEARCH_MODE) {
            chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.12, bottom: 0.24 } });
        }
        chartRef.current = chart;
        candleSeriesRef.current = candles;
        volSeriesRef.current = vol;
        v9MarkersRef.current = createSeriesMarkers(candles, [], {
            autoScale: false,
            zOrder: 'top',
        });
        v9VolumeMarkersRef.current = createSeriesMarkers(vol, [], {
            autoScale: false,
            zOrder: 'top',
        });

        chart.subscribeClick((param) => {
            if (V9_RESEARCH_MODE && fibCaptureRef.current) return; // drawing must not pick an order price
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
        const updateMarkerGap = () => {
            const range = chart.timeScale().getVisibleLogicalRange();
            if (V9_RESEARCH_MODE && range) {
                setMarkerGap(researchMarkerGap(range.to - range.from, chart.timeScale().width()));
            }
        };
        const markerResize = new ResizeObserver(updateMarkerGap);
        markerResize.observe(hostRef.current!);
        chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
            updateMarkerGap();
            if (range && range.from < 30) loadMoreRef.current?.();
        });

        return () => {
            markerResize.disconnect();
            v9MarkersRef.current?.detach();
            v9MarkersRef.current = null;
            v9VolumeMarkersRef.current?.detach();
            v9VolumeMarkersRef.current = null;
            chart.remove();
            chartRef.current = null;
            candleSeriesRef.current = null;
            volSeriesRef.current = null;
            v9TintRef.current = null;
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
        const bars = V9_RESEARCH_MODE ? researchBars : barsRef.current;
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
        const loadKey = chartScope;
        loadedKeyRef.current = ''; // freeze tick updates while loading
        v9MarkersRef.current?.setMarkers([]);
        v9VolumeMarkersRef.current?.setMarkers([]);
        lastBarRef.current = null;
        loadMoreRef.current = null;
        setEmpty(false);
        setLoading(true);
        const clearSeries = (allowLive = true) => {
            // the series must never keep a stale timeframe's data — a later
            // tick bucketed for the new timeframe would be "older" than the
            // stale tail and crash the chart library
            candleSeriesRef.current?.setData([]);
            volSeriesRef.current?.setData([]);
            barsRef.current = [];
            displayBarsRef.current = [];
            rawRef.current = [];
            liveMinuteChangesRef.current.clear();
            lastPriceRef.current = null;
            legendMetaRef.current = new Map();
            setLegendValues({});
            setPaneTops({});
            v9TintRef.current?.setData([]);
            for (const series of indSeriesRef.current) series.setData([]);
            setDataVersion((v) => v + 1);
            loadedKeyRef.current = allowLive ? loadKey : ''; // no old-symbol values while loading
        };
        clearSeries(false);
        const applyBars = (bars: Candle[]) => {
            // History only populates the live cache. Drawing belongs to the
            // display effects below so a late response cannot reveal future
            // bars while a historical replay is paused.
            barsRef.current = bars;
            // Paging rebuilds independent candles: live updates must mutate
            // the newly installed tail rather than an orphan from the old page.
            lastBarRef.current = bars[bars.length - 1] ?? null;
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
            fetchChartHistory(
                contract,
                dateStrOffset(from),
                dateStrOffset(oldestDay + 1),
                // 長區間翻頁量大 — 放寬 timeout，timeout 誤計 dryPages
                // 會讓無限捲動提早罷工
                { timeoutMs: 30_000 },
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
                    const bars = aggregate(rawRef.current, tf.minutes, contract.security_type);
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

        fetchChartHistory(contract, dateStrOffset(tf.days), dateStrOffset(0), {
            revision: historySeq,
            timeoutMs: 30_000, // 大週期初載可達數十天，不能用 10s
        })
            .then((k) => {
                if (cancelled || !candleSeriesRef.current) return;
                const raw = kbarsToCandles(k);
                const bars = aggregate(raw, tf.minutes, contract.security_type);
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
                // 保留即時作畫；歷史查詢失敗後由使用者手動更新。
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
    }, [contract, tf, historySeq, chartScope]);

    // 平均 K 只轉換圖形。所有指標與研究水平線仍使用原始 OHLC，確保
    // VWAP、MACD、KDJ 與盤後覆盤不會因為顯示方式而改變。
    useEffect(() => {
        if (V9_RESEARCH_MODE && replay.enabled) return;
        const raw = barsRef.current;
        const display = candleStyle === 'heikinAshi' ? toHeikinAshi(raw) : raw;
        displayBarsRef.current = display;
        candleSeriesRef.current?.setData(
            display.map((bar) => ({
                time: bar.time as UTCTimestamp,
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
            })),
        );
        volSeriesRef.current?.setData(raw.map(bar => ({
            time: bar.time as UTCTimestamp, value: bar.volume,
            color: bar.close >= bar.open ? colors.upVol : colors.downVol,
        })));
    }, [dataVersion, candleStyle, replay.enabled, colors.upVol, colors.downVol]);

    // Cache K-bar calculations independently of 4 Hz live Tick batches.
    // Scope guards prevent old-symbol/timeframe markers reappearing during load.
    // Market Replay: official kbars (warm-up + day) aggregated to the chart tf,
    // cut to the replay virtual time; trades drive aggressor order flow.
    const replayAggBars = useMemo(() => replay.enabled && replay.hasData
        ? aggregate(replay.rawCandles, tf.minutes, contract.security_type) : [],
    [replay.enabled, replay.hasData, replay.rawCandles, tf.minutes, contract.security_type]);
    const replayReadyBars = useMemo(() => replay.enabled && replay.hasData
        ? completedResearchBars(replayAggBars, tf.minutes, replay.visibleTime, contract.security_type) : [],
    [replay.enabled, replay.hasData, replayAggBars, replay.visibleTime, tf.minutes, contract.security_type]);
    const replayFlow = useMemo(() => replay.enabled && replay.hasData
        ? buildOrderFlow(replay.trades, replayAggBars, replay.visibleTime) : [],
    [replay.enabled, replay.hasData, replay.trades, replayAggBars, replay.visibleTime]);
    // Display bars = replay day only; warm-up bars stay out of the visible chart,
    // while computeBars keep the warm-up so indicators stay continuous.
    const replayDayBars = useMemo(() => replay.enabled
        ? replayReadyBars.filter((b) => b.time >= replay.dayStart) : [],
    [replay.enabled, replayReadyBars, replay.dayStart]);
    const effectiveTime = replay.enabled ? replay.visibleTime : researchMinute * 60;
    const researchBars = useMemo(() => {
        if (!V9_RESEARCH_MODE) return [];
        if (replay.enabled) return replayDayBars;
        if (loadedKeyRef.current !== chartScope || loading) return [];
        return completedResearchBars(barsRef.current, tf.minutes, researchMinute * 60, contract.security_type);
    }, [dataVersion, chartScope, tf.minutes, researchMinute, loading, replay.enabled, replayDayBars]);
    const computeBars = replay.enabled ? replayReadyBars : researchBars;
    // This is a snapshot of bars already loaded for the active chart. It is
    // intentionally not a four-timeframe history downloader.
    const researchSource = useMemo(() => replay.enabled
        ? replay.hasData ? replay.rawCandles.filter(bar => bar.time <= replay.visibleTime) : []
        : scopedResearchSource(rawRef.current, loadedKeyRef.current, chartScope, loading),
    [dataVersion, chartScope, researchMinute, loading, replay.enabled, replay.hasData, replay.rawCandles, replay.visibleTime]);
    // Reuse the full same-contract background, not the selected chart window.
    // Replay minutes stay isolated; proven daily history is cut at virtual time.
    const resonanceSource = replay.enabled ? researchSource : background.minutes;
    useEffect(() => {
        if (!V9_RESEARCH_MODE || replay.enabled || loading || loadedKeyRef.current !== chartScope) return;
        // Publish ONLY minutes genuinely touched by live Tick, using their
        // original update revision. Re-loading an old history Promise must
        // not relabel its stale tail as fresh and overwrite the shared cache.
        for (const [time, update] of liveMinuteChangesRef.current) {
            if (time > effectiveTime) continue;
            researchBackgroundStore.mergeMinutes(researchBackgroundKey(contract), [update.bar], update.revision);
            liveMinuteChangesRef.current.delete(time);
        }
    }, [researchMinute, dataVersion, chartScope, loading, replay.enabled, effectiveTime]);
    const backgroundLoading = replay.enabled ? !replay.hasData : loading && !background.minutes.length;
    const dataStatus = useMemo(() => researchDataStatus(resonanceSource, contract.security_type,
        replay.enabled ? replay.visibleTime : researchClock,
        backgroundLoading,
        replay.enabled ? undefined : streamStatus),
    [resonanceSource, contract.security_type, backgroundLoading, researchClock, replay.enabled, replay.visibleTime, streamStatus]);
    const resonance = useMemo(() => V9_RESEARCH_MODE
        ? v9Resonance(resonanceSource, contract.security_type, effectiveTime, background.daily)
        : null,
    [resonanceSource, contract.security_type, effectiveTime, background.daily]);
    const entryContext = useMemo<ResearchEntryContext>(() => ({
        closedFiveMinuteBars: completedResearchBars(aggregate(resonanceSource.filter(bar => bar.time <= effectiveTime),
            5, contract.security_type), 5, effectiveTime, contract.security_type),
        securityType: contract.security_type,
        now: effectiveTime,
    }), [resonanceSource, contract.security_type, effectiveTime]);
    // Phase 1: one raw-minute session anchor shared by every chart timeframe.
    // These setups are shadow research, never part of researchEntry or orders.
    const vwapEvaluation = useMemo(() => researchSessionVwap(resonanceSource, contract.security_type, effectiveTime),
        [resonanceSource, contract.security_type, effectiveTime]);
    const setupEvaluation = useMemo(() => researchSetups(resonanceSource, contract.security_type, effectiveTime),
        [resonanceSource, contract.security_type, effectiveTime]);
    const researchVwapPoints = useMemo(() => tf.minutes >= 1440 ? []
        : projectResearchVwap(vwapEvaluation.points, computeBars, contract.security_type),
    [vwapEvaluation, computeBars, tf.minutes, contract.security_type]);
    const structureLevels = useMemo(() => V9_RESEARCH_MODE
        ? researchLevels(resonanceSource, 5, contract.security_type, effectiveTime) : [],
    [resonanceSource, contract.security_type, effectiveTime]);
    const opening = useMemo(() => researchOpening(resonanceSource.filter(bar => bar.time <= effectiveTime), contract.security_type),
        [resonanceSource, contract.security_type, effectiveTime]);
    const atrInstance = instances.find(instance => instance.type === 'atrdefense' && !instance.hidden
        && (!instance.visibleTf || instance.visibleTf.includes(tf.minutes)));
    const defense = useMemo(() => V9_RESEARCH_MODE && atrInstance
        ? v9AtrDefense(researchBars, atrInstance.params.period ?? 14, atrInstance.params.mult ?? 2, contract.security_type, tf.minutes)
        : { up: [], down: [] },
    [researchBars, atrInstance?.id, atrInstance?.params.period, atrInstance?.params.mult, contract.security_type, tf.minutes]);
    const defenseChanges = useMemo(() => defenseEvents(researchBars, defense, contract.security_type, tf.minutes),
        [researchBars, defense, contract.security_type, tf.minutes]);
    const activeDefense = defense.up.at(-1)?.value ?? defense.down.at(-1)?.value;
    const defenseLong = defense.up.at(-1)?.value !== undefined;
    const kbarMarkers = useMemo(() => v9KbarMarkers(researchBars), [researchBars]);
    // SuperTrend(10,3) 翻轉的研究用「買／平」（做多）與「賣／補」（放空）標記，
    // 與 V9 預設多空趨勢線同參數；同翻轉點兩側皆開時會合併成 平·賣／買·補。
    const trendMarkers = useMemo(() => supertrendTradeMarkers(researchBars), [researchBars]);
    const shortTrendMarkers = useMemo(() => supertrendShortTradeMarkers(researchBars), [researchBars]);
    const entryMarkers = useMemo(
        () => entrySignalsToMarkers(longEntrySignals, researchBars, tf.minutes, contract.security_type, effectiveTime),
        [longEntrySignals, researchBars, tf.minutes, contract.security_type, effectiveTime]);
    const shortEntryMarkers = useMemo(
        () => shortSignalsToMarkers(shortEntrySignals, researchBars, tf.minutes, contract.security_type, effectiveTime),
        [shortEntrySignals, researchBars, tf.minutes, contract.security_type, effectiveTime]);
    const researchMarkers = useMemo(() => {
        if (!V9_RESEARCH_MODE) return [];
        if (!replay.enabled && loadedKeyRef.current !== chartScope) return [];
        return selectResearchMarkers([...kbarMarkers, ...trendMarkers, ...shortTrendMarkers, ...entryMarkers, ...shortEntryMarkers, ...(replay.enabled ? [] : flow.markers)],
            (replay.enabled ? replayDayBars : barsRef.current).map(bar => bar.time), markerOptions, markerGap);
    }, [kbarMarkers, trendMarkers, shortTrendMarkers, entryMarkers, shortEntryMarkers, flow, markerOptions, markerGap, dataVersion, contract.code, tf.minutes, loading, replay.enabled, replayDayBars]);
    useEffect(() => {
        const ready = V9_RESEARCH_MODE && (replay.enabled ? replay.hasData : loadedKeyRef.current === chartScope && !loading);
        const markers = ready ? researchMarkers : [];
        v9MarkersRef.current?.setMarkers(mergeResearchMarkerLabels(markers.filter(marker => marker.group !== 'volume'))
                .map(marker => ({
                    ...marker,
                    time: marker.time as UTCTimestamp,
                    size: marker.group === 'flow' ? 1.2 : 1,
                })));
        v9VolumeMarkersRef.current?.setMarkers(markers.filter(marker => marker.group === 'volume')
                .map(marker => ({
                    ...marker, time: marker.time as UTCTimestamp,
                    // Keep the label above the volume bar so it isn't clipped
                    // below the chart; arrow shape still conveys attack direction.
                    position: 'aboveBar' as const, size: 0.8,
                })));
    }, [researchMarkers, chartScope, tf.minutes, loading, replay.enabled, replay.hasData]);

    // Live trade/index quote -> update the current bar. Index products use
    // quote_idx rather than the regular tick stream in Shioaji 1.7.
    const liveQuote = quote?.tick ?? quote?.index;
    if (liveQuote && liveQuote.code === contract.code) {
        const p = Number(liveQuote.close);
        if (Number.isFinite(p)) lastPriceRef.current = p;
    }
    useEffect(() => {
        if (replay.enabled) return;
        if (!liveQuote || liveQuote.code !== contract.code) return;
        // 試撮 (simtrade) 揭示價可以是漲跌停天地價 — 畫進 K 棒會把
        // Y 軸尺度撐爆（issue #5），一律排除
        if ('simtrade' in liveQuote && liveQuote.simtrade) return;
        // history for this (symbol, timeframe) not in place yet
        if (loadedKeyRef.current !== chartScope) return;
        const series = candleSeriesRef.current;
        if (!series) return;
        const price = Number(liveQuote.close);
        if (!Number.isFinite(price)) return;
        const tickTime = wallClockToUtc(
            `${liveQuote.date}T${liveQuote.time}`,
        );
        // Keep the shared one-minute source current regardless of the chart's
        // selected timeframe. Higher-timeframe cards then rebuild only from
        // this raw OHLCV stream plus the historical page cache.
        const minuteBucket = researchTickBucket(tickTime, 1, contract.security_type);
        if (!Number.isFinite(minuteBucket)) return;
        const minuteVolume = quote?.tick?.volume ?? 0;
        const rawTail = rawRef.current[rawRef.current.length - 1];
        if (!rawTail || minuteBucket > rawTail.time) {
            rawRef.current.push({
                time: minuteBucket, open: Number(liveQuote.close), high: Number(liveQuote.close),
                low: Number(liveQuote.close), close: Number(liveQuote.close), volume: minuteVolume,
            });
        } else if (minuteBucket === rawTail.time) {
            rawTail.high = Math.max(rawTail.high, Number(liveQuote.close));
            rawTail.low = Math.min(rawTail.low, Number(liveQuote.close));
            rawTail.close = Number(liveQuote.close);
            rawTail.volume += minuteVolume;
        }
        const updatedMinute = rawRef.current.at(-1);
        if (updatedMinute?.time === minuteBucket && V9_RESEARCH_MODE) {
            liveMinuteChangesRef.current.set(minuteBucket, { bar: { ...updatedMinute },
                revision: researchBackgroundStore.nextRevision() });
        }
        const bucketSec = tf.minutes * 60;
        // close-label-right（與 aggregate/1 分 K 歷史同慣例）：成交 τ 屬
        // 於哪個「收盤 label」桶 — floor 會把 live 桶標早一格，1 分 K
        // 時甚至會併進前一分鐘的歷史 bar
        const bucket = researchTickBucket(tickTime, tf.minutes, contract.security_type);
        let bar = lastBarRef.current;
        if (!Number.isFinite(bucket) || (bar && bucket < bar.time)) return;
        // live 桶與歷史尾端出現 3 個桶以上的斷層（換時段/上游資料晚發布）
        // → 排程一次歷史補抓把洞補起來；live 桶照常先畫，補抓完成後
        // 整段重建。120s 節流避免上游持續缺料時反覆打
        if (
            bar &&
            bucket - bar.time > bucketSec * 3 &&
            Date.now() - gapReloadAtRef.current > 120_000
        ) {
            gapReloadAtRef.current = Date.now();
            setHistorySeq(nextChartHistoryRevision());
        }
        if (!bar || bucket > bar.time) {
            bar = {
                time: bucket,
                open: price,
                high: price,
                low: price,
                close: price,
                volume: quote?.tick?.volume ?? 0,
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
            bar.volume += quote?.tick?.volume ?? 0;
        }
        lastBarRef.current = bar;
        const displayBar = (() => {
            if (candleStyle === 'standard') return bar!;
            const index = barsRef.current.length - 1;
            const previous = displayBarsRef.current[index - 1];
            const existing = displayBarsRef.current[index];
            const close = (bar!.open + bar!.high + bar!.low + bar!.close) / 4;
            const open = existing?.time === bar!.time
                ? existing.open
                : previous
                  ? (previous.open + previous.close) / 2
                  : (bar!.open + bar!.close) / 2;
            const next: Candle = {
                time: bar!.time,
                open,
                high: Math.max(bar!.high, open, close),
                low: Math.min(bar!.low, open, close),
                close,
                volume: bar!.volume,
            };
            displayBarsRef.current[index] = next;
            return next;
        })();
        try {
            series.update({
                time: displayBar.time as UTCTimestamp,
                open: displayBar.open,
                high: displayBar.high,
                low: displayBar.low,
                close: displayBar.close,
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
        // 歷史載入失敗後 live bar 已開始堆 — 圖上有東西就不該再掛
        // 「無 K 線資料」（同值 setState React 會 bail out）
        setEmpty(false);
    // Style-only switches are handled by the display-bar effect above. Replaying
    // the same quote here would add its volume again whenever 平均K is toggled.
    }, [liveQuote, quote?.tick?.volume, chartScope, tf.minutes, replay.enabled]);

    // 自訂指標增刪改 → 重算指標 effect；被刪掉的型別把殘留實例一併清掉
    const [customVer, setCustomVer] = useState(0);
    useEffect(
        () =>
            subscribeCustoms(() => {
                setCustomVer((v) => v + 1);
                if (!panelService) setInstances((cur) => {
                    const kept = cur.filter((i) => DEF_BY_TYPE.has(i.type));
                    if (kept.length === cur.length) return cur;
                    saveInstances(kept);
                    return kept;
                });
            }),
        [panelService],
    );

    // indicator instances → chart series: overlays on the main pane,
    // every oscillator instance in its own sub-pane (lightweight-charts v5)
    const instancesKey = JSON.stringify(instances);
    useEffect(() => {
        const chart = chartRef.current;
        if (!chart) return;
        // remember the user-dragged proportions of every pane BEFORE
        // teardown — rebuilds must not reset the 上下圖比例
        try {
            const panes = chart.panes();
            const mainSf = panes[0]?.getStretchFactor();
            if (mainSf) paneStretchRef.current.set('__main', mainSf);
            paneAssignRef.current.forEach((paneIdx, instId) => {
                const sf = panes[paneIdx]?.getStretchFactor();
                if (sf) paneStretchRef.current.set(instId, sf);
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
        const bars = V9_RESEARCH_MODE ? researchBars : barsRef.current;
        if (bars.length === 0) {
            paneAssignRef.current = paneAssign; // no panes exist right now
            // 讀值也要清 — 序列移除了但 legend 讀 legendMetaRef，不清
            // 會殘留上一檔商品的指標數值（無 K 線資料卻顯示 MA 值）
            legendMetaRef.current = new Map();
            setLegendValues({});
            setPaneTops({});
            return;
        }

        const toLineData = (pts: IndicatorPoint[]) =>
            pts.map((p) =>
                p.value === undefined
                    ? { time: p.time as UTCTimestamp }
                    : { time: p.time as UTCTimestamp, value: p.value, ...(p.color ? { color: p.color } : {}) },
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
                out = V9_RESEARCH_MODE && inst.type === 'vwap' ? { line: researchVwapPoints }
                    : def.compute(V9_RESEARCH_MODE ? computeBars : bars,
                        params, contract.security_type, tf.minutes);
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
                let pts = out[o.key];
                if (!pts) continue;
                if (V9_RESEARCH_MODE && replay.enabled) pts = pts.filter((pp) => pp.time >= replay.dayStart);
                const st = outputStyle(inst, def, o.key);
                if (!st.visible) continue;
                const color = colorWithOpacity(st.color, st.opacity);
                if (inst.type === 'atrdefense' || V9_RESEARCH_MODE && inst.type === 'vwap') {
                    let latest: ISeriesApi<'Line'> | undefined;
                    for (const segment of defenseSegments(pts)) {
                        const rail = chart.addSeries(LineSeries, { color, lineWidth: st.width,
                            lineType: inst.type === 'atrdefense' ? LineType.WithSteps : LineType.Simple, crosshairMarkerVisible: false,
                            pointMarkersVisible: segment.length === 1, pointMarkersRadius: 2,
                            ...labelOpts, lastValueVisible: false, ...priceFormatOpt }, pane);
                        rail.setData(toLineData(segment));
                        indSeriesRef.current.push(rail);
                        latest = rail;
                    }
                    if (latest) metas.push({ label: o.label, color: st.color, series: latest,
                        last: pts.at(-1)?.value, precision: inst.precision });
                    continue;
                }
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
                    last: V9_RESEARCH_MODE && inst.type === 'vwap' ? pts.at(-1)?.value : lastVal(pts),
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
                        color: inst.type === 'v8trend' ? (lv === 55 ? RESEARCH_COLORS.long : RESEARCH_COLORS.short) : colors.grid,
                        lineWidth: 1,
                        lineStyle: LineStyle.Dotted,
                        axisLabelVisible: false,
                        title: inst.type === 'v8trend' ? (lv === 55 ? '多55' : '空45') : '',
                    });
                }
            }
        }
        // restore the remembered proportions（stretch factor 精確還原，
        // 含主圖；px 只當第一次出現的 pane 的預設值用）
        try {
            const panes = chart.panes();
            const mainSf = paneStretchRef.current.get('__main');
            if (mainSf && panes[0]) panes[0].setStretchFactor(mainSf);
            paneAssign.forEach((paneIdx, instId) => {
                const sf = paneStretchRef.current.get(instId);
                if (sf) {
                    panes[paneIdx]?.setStretchFactor(sf);
                } else {
                    const instanceType = instances.find((instance) => instance.id === instId)?.type;
                    const v9ResearchHeight = V9_RESEARCH_MODE && panelId === 'chart-v9'
                        ? ({ v9macd: 105, v9kdj: 78, v8trend: 68 } as Record<string, number>)[instanceType ?? '']
                        : undefined;
                    panes[paneIdx]?.setHeight(
                        paneHeightsRef.current.get(instId) ?? v9ResearchHeight ?? 110,
                    );
                }
            });
            if (V9_RESEARCH_MODE && paneAssignRef.current.size === 0) {
                applyResearchPaneLayout(chart, [...paneAssign].map(([id, paneIndex]) => ({
                    paneIndex, type: instances.find(instance => instance.id === id)?.type ?? '',
                })));
            }
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
    }, [dataVersion, instancesKey, themeKey, tf.minutes, customVer, researchBars, researchVwapPoints]);

    const commitInstances = (list: IndicatorInstance[]) => {
        if (panelService && panelId && panelState) {
            try { panelService.replace(panelId, list, panelState.revision); }
            catch (e) { notify({ kind: 'err', title: '指標設定未儲存', body: e instanceof Error ? e.message : String(e) }); }
            return;
        }
        setInstances(list);
        saveInstances(list);
    };
    // 點選指標 → 先開設定（圖上即時預覽），確定才算加入、取消整個撤掉
    const addIndicator = (type: string) => {
        const inst = newInstance(type);
        settingsRevisionRef.current = panelState?.revision ?? '';
        settingsNewRef.current = true;
        setSettingsDraft(inst);
        setPickerOpen(false);
        setSettingsFor(inst.id);
    };
    const removeIndicator = (id: string) => {
        if (settingsFor === id) { setSettingsFor(null); setSettingsDraft(null); }
        commitInstances(savedInstances.filter((i) => i.id !== id));
    };
    const patchInstance = (id: string, patch: Partial<IndicatorInstance>) => {
        if (settingsDraft?.id === id) { setSettingsDraft({ ...settingsDraft, ...patch }); return; }
        commitInstances(
            instances.map((i) => (i.id === id ? { ...i, ...patch } : i)),
        );
    };
    const openSettings = (id: string) => {
        settingsRevisionRef.current = panelState?.revision ?? '';
        settingsNewRef.current = false;
        setSettingsDraft(structuredClone(savedInstances.find(i => i.id === id)!));
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
        setSettingsDraft(null);
        setSettingsFor(null);
    };
    const commitSettings = () => {
        if (!settingsDraft) return;
        const list = settingsNewRef.current ? [...savedInstances, settingsDraft]
            : savedInstances.map(i => i.id === settingsDraft.id ? settingsDraft : i);
        try {
            if (panelService && panelId) panelService.replace(panelId, list, settingsRevisionRef.current);
            else commitInstances(list);
            cancelSettings();
        } catch (e) {
            notify({ kind: 'err', title: '指標設定已變更，請重新開啟設定', body: e instanceof Error ? e.message : String(e) });
            cancelSettings();
        }
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
            remainingWorkingOrderQuantity(t),
        ]),
    );
    useEffect(() => {
        const series = candleSeriesRef.current;
        if (!series) return;
        const lines = new Map<string, IPriceLine>();
        for (const t of workingOrdersRef.current) {
            const price = t.status.modified_price || t.order.price;
            const remaining = remainingWorkingOrderQuantity(t);
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

    // V9 研究圖層：昨高、昨低、昨收、今日開盤與前五分鐘開盤區間。
    // 線只提供市場結構參考，沒有下單行為。
    useEffect(() => {
        const series = candleSeriesRef.current;
        if (!series) return;
        if (!V9_RESEARCH_MODE || !markerOptions.levels) return;
        const lines = structureLevels.filter(level => level.kind !== 'open').map((level) =>
            series.createPriceLine({
                price: level.price,
                color: level.kind === 'open'
                    ? '#e0a43c'
                    : level.kind === 'opening-range'
                      ? '#3d8bff'
                      : '#8b94a7',
                lineWidth: level.kind === 'open' ? 2 : 1,
                lineStyle: level.kind === 'previous'
                    ? LineStyle.Dashed
                    : LineStyle.Dotted,
                axisLabelVisible: true,
                title: level.title,
            }),
        );
        return () => {
            for (const line of lines) series.removePriceLine(line);
        };
    }, [structureLevels, markerOptions.levels, themeKey, contract.code, tf.minutes]);

    // V9 樞紐關卡：前一交易日 H/L/C 經黃金比例算強勢/中間/弱勢，只作價格參考、不送單。
    useEffect(() => {
        const series = candleSeriesRef.current;
        if (!series) return;
        if (!V9_RESEARCH_MODE || !markerOptions.pivot) return;
        const h = structureLevels.find(level => level.id === 'prev-high')?.price;
        const l = structureLevels.find(level => level.id === 'prev-low')?.price;
        const c = structureLevels.find(level => level.id === 'prev-close')?.price;
        if (h === undefined || l === undefined || c === undefined) return;
        const pv = pivotLevels(h, l, c);
        const defs = [
            { price: pv.strong, color: '#fb7185', line: LineStyle.Dotted, title: '強勢' },
            { price: pv.mid, color: '#94a3b8', line: LineStyle.Dashed, title: '中間' },
            { price: pv.weak, color: '#4ade80', line: LineStyle.Dotted, title: '弱勢' },
        ];
        const priceLines = defs.map(d => series.createPriceLine({
            price: d.price, color: d.color, lineWidth: 1, lineStyle: d.line,
            axisLabelVisible: true, title: d.title,
        }));
        return () => {
            for (const line of priceLines) series.removePriceLine(line);
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [structureLevels, markerOptions.pivot, themeKey, contract.code, tf.minutes]);

    // Market Replay: override main candles + volume with bars cut to the replay
    // virtual time so the chart and every indicator rebuild in lock-step.
    useEffect(() => {
        if (!V9_RESEARCH_MODE || !replay.enabled) return;
        const candles = candleSeriesRef.current;
        const vol = volSeriesRef.current;
        if (!candles) return;
        const base = replayDayBars;
        const display = candleStyle === 'heikinAshi' ? toHeikinAshi(base) : base;
        displayBarsRef.current = display;
        candles.setData(display.map((bar) => ({
            time: bar.time as UTCTimestamp, open: bar.open, high: bar.high,
            low: bar.low, close: bar.close,
        })));
        vol?.setData(base.map((bar) => ({
            time: bar.time as UTCTimestamp, value: bar.volume,
            color: bar.close >= bar.open ? colors.upVol : colors.downVol,
        })));
        if (replay.playing && base.length) {
            const n = base.length;
            requestAnimationFrame(() => chartRef.current?.timeScale().setVisibleLogicalRange({
                from: n - 26,
                to: n + 5,
            }));
        }
    }, [replay.enabled, replay.hasData, replay.playing, replayDayBars, dataVersion, candleStyle, colors.upVol, colors.downVol]);
    // V9 多空底色：方向與 ATR 防守線同源（v9AtrDefense 的 V8 確認 side），只染
    // 已收棒；多頭淡紅、空頭淡綠、中性／暖機不染。切商品／時框或關閉時清空。
    useEffect(() => {
        const series = v9TintRef.current;
        if (!series) return;
        if (!V9_RESEARCH_MODE || !markerOptions.tint) {
            series.setData([]);
            return;
        }
        series.setData(researchBars.map((bar, i) => ({ time: bar.time,
            side: defense.up[i]?.value !== undefined ? 1 : defense.down[i]?.value !== undefined ? -1 : 0 }))
            .filter(point => point.side !== 0)
            .map(point => ({
                time: point.time as UTCTimestamp,
                value: 1,
                color: point.side === 1 ? 'rgba(251,113,133,0.08)' : 'rgba(74,222,128,0.08)',
            })));
    }, [researchBars, defense, markerOptions.tint, dataVersion, contract.code, tf.minutes, contract.security_type]);

    useEffect(() => {
        const chart = chartRef.current;
        const candles = candleSeriesRef.current;
        if (!V9_RESEARCH_MODE || !chart || !candles) return;
        const verticals: ResearchVerticalLine[] = markerOptions.transitions
            ? defenseChanges.filter(event => event.kind !== 'invalidated').map(event => ({
                time: event.time, text: event.text, color: event.color })) : [];
        let openLine: ISeriesApi<'Line'> | undefined;
        if (markerOptions.opening && opening && tf.minutes < 1440) {
            const sessionBars = (replay.enabled ? replayDayBars : researchBars).filter(bar => bar.time > opening.start && bar.time <= opening.end);
            if (sessionBars.length) {
                openLine = chart.addSeries(LineSeries, { color: RESEARCH_COLORS.open,
                    lineWidth: 2, lineStyle: LineStyle.Dashed, priceLineVisible: false,
                    lastValueVisible: true, crosshairMarkerVisible: false, title: opening.title });
                openLine.setData(sessionBars.map(bar => ({ time: bar.time as UTCTimestamp, value: opening.price })));
                verticals.push({ time: sessionBars[0]!.time, text: opening.title, color: RESEARCH_COLORS.open, dashed: true });
            }
        }
        const primitive = new ResearchTransitionPrimitive(verticals.sort((a, b) => a.time - b.time));
        candles.attachPrimitive(primitive);
        return () => { candles.detachPrimitive(primitive); if (openLine) chart.removeSeries(openLine); };
    }, [opening, defenseChanges, markerOptions.opening, markerOptions.transitions, dataVersion, contract.code, tf.minutes, replay.enabled, replayDayBars, researchBars]);

    // 單列 legend（主圖堆疊與各副圖 pane 共用同一套列與控制）
    const renderLegendRow = (inst: IndicatorInstance) => {
        const def = DEF_BY_TYPE.get(inst.type);
        if (!def) return null;
        const idx = instances.findIndex((i) => i.id === inst.id);
        const legendReady = replay.enabled ? replay.hasData : loadedKeyRef.current === chartScope && !loading;
        const vals = legendReady ? legendValues[inst.id] ?? [] : [];
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
    const enlargeMainPane = () => {
        const chart = chartRef.current;
        if (!chart) return;
        applyResearchPaneLayout(chart, [...paneAssignRef.current].map(([id, paneIndex]) => ({
            paneIndex, type: instances.find(instance => instance.id === id)?.type ?? '',
        })));
        const panes = chart.panes();
        const mainPane = panes[0];
        if (mainPane) paneStretchRef.current.set('__main', mainPane.getStretchFactor());
        paneAssignRef.current.forEach((index, id) => {
            const pane = panes[index];
            if (!pane) return;
            paneStretchRef.current.set(id, pane.getStretchFactor());
            paneHeightsRef.current.set(id, pane.getHeight());
        });
    };
    const regimePrice = replay.enabled ? researchSource.at(-1)?.close : Number.isFinite(Number(liveQuote?.close))
        ? Number(liveQuote?.close)
        : researchSource.at(-1)?.close;
    const regimeTick = replay.enabled ? undefined : quote?.tick;
    const regimeIndex = replay.enabled ? undefined : quote?.index;
    const regimeChg = regimeTick && 'price_chg' in regimeTick && regimeTick.price_chg !== undefined && regimeTick.price_chg !== null
        ? Number(regimeTick.price_chg)
        : regimeIndex
          ? Number(regimeIndex.close) - Number(regimeIndex.reference)
          : undefined;
    const regimePct = quoteChangePercent(regimePrice, regimeChg, regimeIndex ? Number(regimeIndex.reference) : undefined);
    const displayedMacd = instances.find(instance => instance.type === 'v9macd' || instance.type === 'macd');
    const regimeReference = [
        opening
            ? { key: 'open', label: `開 ${fmtPrice(opening.price)}`, color: RESEARCH_COLORS.open }
            : { key: 'open', label: '開盤不足', color: RESEARCH_COLORS.neutral },
        activeDefense === undefined
            ? { key: 'atr', label: 'ATR 暖機', color: RESEARCH_COLORS.neutral }
            : { key: 'atr', label: `${defenseLong ? '多防' : '空防'} ${fmtPrice(activeDefense)}`,
                color: defenseLong ? RESEARCH_COLORS.long : RESEARCH_COLORS.short },
    ];
    const renderToolbarInner = () => <>
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
            className={styles.tfBtn[candleStyle === 'heikinAshi' ? 'active' : 'normal']}
            onClick={() => setCandleStyle((current) =>
                current === 'standard' ? 'heikinAshi' : 'standard')}
            title='切換一般 K 與平均 K；指標仍以原始 OHLC 計算'
        >
            {candleStyle === 'heikinAshi' ? '平均K' : '一般K'}
        </button>
        <button
            className={styles.iconBtn}
            onClick={resetView}
            title='重設視圖（自動縮放）'
            aria-label='重設視圖'
        >
            <Maximize2 size={12} />
        </button>
        {V9_RESEARCH_MODE && <button className={styles.tfBtn.normal} onClick={() => replay.enable()}
            title="歷史回放：真實 tick 逐日重播，K 棒與指標即時重算">回放</button>}
        {V9_RESEARCH_MODE && <button className={styles.tfBtn.normal} onClick={enlargeMainPane}
            title="恢復主圖優先比例；仍可拖曳副圖分隔線調整">主圖放大</button>}
        {!V9_RESEARCH_MODE && <>
            <span className={styles.toolbarDivider} />
            {TRADE_MODES.filter(
                (m) => !isCombo || m.key === 'observe' || m.key === 'alert',
            ).map((m) => (
                <button
                    key={m.key}
                    className={styles.modeBtn[
                        mode === m.key
                            ? m.key === 'observe'
                                ? 'active'
                                : 'armed'
                            : 'normal'
                    ]}
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
        </>}
        <button
            className={styles.indicatorBtn[instances.length > 0 ? 'active' : 'normal']}
            onClick={() => setPickerOpen(true)}
        >
            指標
        </button>
        <RefreshButton label="更新歷史" loading={loading} onClick={() => setHistorySeq(nextChartHistoryRevision())} />
    </>;
    return (
        <div className={styles.wrap}
            onPointerDownCapture={() => { if (panelService && panelId) panelService.focus(panelId); }}
            onFocusCapture={() => { if (panelService && panelId) panelService.focus(panelId); }}>
            {V9_RESEARCH_MODE
                ? <ResearchMarkerControls options={markerOptions}
                    onChange={setMarkerOptions} flow={replay.enabled ? EMPTY_FLOW : flow} markers={researchMarkers}
                    barCount={researchBars.filter(bar => bar.volume > 0).length} loading={loading}
                    resonance={resonance} levels={structureLevels}
                    currentPrice={regimePrice}
                    priceChange={regimeChg} pricePct={regimePct}
                    dataStatus={dataStatus} macdParams={displayedMacd ? [displayedMacd.params.fast ?? 45,
                        displayedMacd.params.slow ?? 117, displayedMacd.params.signal ?? 17] : undefined}
                    directionLoading={backgroundLoading} entryContext={entryContext}
                    setupEvaluation={setupEvaluation} vwapEvaluation={vwapEvaluation}
                    reference={regimeReference}
                    openingPrice={opening?.price}
                    fibOpen={fibOpen} onToggleFib={() => setFibOpen(value => !value)}
                    toolbar={renderToolbarInner()} />
                : <div className={styles.toolbar}>
                    {renderToolbarInner()}
                </div>}
            {pickerOpen && (
                <IndicatorDialog
                    instances={instances}
                    onAdd={addIndicator}
                    onClose={() => setPickerOpen(false)}
                    onSaveDefaults={panelService ? () => {
                        saveInstances(savedInstances);
                        notify({ kind: 'info', title: '已儲存指標預設', body: '新圖與回測圖表使用此設定；其他現有面板維持原設定。' });
                    } : undefined}
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
                    onCommit={commitSettings}
                    onCancel={cancelSettings}
                />
            )}
            {V9_RESEARCH_MODE && fibOpen && <ResearchFibonacci
                key={`${panelId}|${contract.security_type}|${contract.code}|${tf.minutes}`}
                storageKey={`v9-manual-fib-v1:${panelId ?? 'chart'}:${contract.security_type}:${contract.code}:${tf.minutes}`}
                chart={chartRef.current} series={candleSeriesRef.current} bars={researchBars} capture={fibCaptureRef}
                open={fibOpen} onOpenChange={(openValue) => setFibOpen(openValue)} />}
            {V9_RESEARCH_MODE && replay.enabled && <ReplayControls replay={replay} />}
            <div ref={hostRef} className={styles.chartHost}>
                {loading && (
                    <div className={styles.emptyMsg}>
                        <Orb size={12} style={{ marginRight: 6, verticalAlign: '-2px' }} />
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
                            const remaining = remainingWorkingOrderQuantity(t);
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
            {V9_RESEARCH_MODE && replay.enabled && replay.status === 'ready' && (
                <ResearchOrderFlow flow={replayFlow} dayStart={replay.dayStart}
                    dayEnd={replay.dayEnd} visibleTime={replay.visibleTime}
                    onSeek={replay.seek} />
            )}
        </div>
    );
}
