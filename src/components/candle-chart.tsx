import { canTrade } from '../lib/account-tradable';
import { RefreshButton } from './refresh-button';
import { fetchChartHistory, nextChartHistoryRevision } from '../lib/chart-history';
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
    ChartCandlestick,
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
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
    inOrderLabelArea,
    orderLineMayTakePointer,
    useChartDrawings,
    type ChartDrawingsApi,
} from '../hooks/use-chart-drawings';
import {
    takeDrawingNotices,
    takeDrawingSaveErrorNotice,
    useDrawingNotices,
    useDrawingsSaveFailed,
} from '../lib/chart-drawings';
import { useQuote } from '../hooks/use-stream';
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
    daySessionLabel,
    filterDaySession,
    isDaySessionTick,
    parseChartSessionMode,
    type ChartSessionMode,
    supportsSessionSplit,
    type SessionContractLike,
} from '../lib/intraday-session';
import {
    IndicatorDialog,
    IndicatorSettingsModal,
} from './indicator-dialog';
// side-effect import順序：custom-indicators 在 module 載入時就把已存的
// 自訂指標註冊進 DEF_BY_TYPE，loadInstances() 的型別過濾才不會把它們丟掉
import { subscribeCustoms } from '../lib/custom-indicators';
import type { IndicatorPoint } from '../lib/indicators';
import { setHoverPickedPrice, setPickedPrice } from '../lib/price-sync';
import { cancelOrder, updateOrderPrice } from '../lib/shioaji';
import { canUpdateOrderPrice } from '../lib/odd-lot';
import { resetEscCancelArm } from '../lib/esc-cancel-arm';
import { baseMode, getChartColors, useThemeSettings, themeKey as themeKeyOf } from '../lib/theme-store';
import { notify, placeQuickOrder } from '../lib/trade';
import { ORDER_CONTEXT_CHANGED_MESSAGE, useOrderContext } from '../hooks/use-order-context';
import {
    chartModeHint,
    chartPlaceOptions,
    chartTriggerFields,
    loadChartOrderDefault,
    normalizeChartOrder,
    saveChartOrderDefault,
    type ChartOrderMarket,
    type ChartOrderPanelState,
    type ChartOrderSettings,
} from '../lib/chart-order-settings';
import { ensureAccounts, useAccounts } from '../lib/account-store';
import { loadOrderLotPreference, saveOrderLotPreference, QUICK_ORDER_LOTS } from '../lib/order-lot-preference';
import { accountMatches, resolveFlashAccount } from '../lib/flash-account';
import { flashAccountLabels } from '../lib/flash-display';
import { usePrivacyMode } from '../lib/privacy';
import type { Account } from '../lib/types/portfolio';
import { ChartOrderButton, type ChartOrderAccountView } from './chart-order-popover';
import { isCancelUnconfirmed } from '../lib/cancel-verification';
import { cancellationSummary } from '../lib/trade-mutations';
import {
    addTrigger,
    removeTrigger,
    useTriggers,
} from '../lib/trigger-engine';
import { currentProtectionEnv } from '../lib/protection-env';
import type { ContractBase } from '../lib/types/contract';
import type { Candle } from '../lib/types/market';
import type { Trade } from '../lib/types/order';
import { remainingWorkingOrderQuantity } from '../lib/working-order-quantity';
import { fmtPrice } from '../lib/utils/format';
import {
    aggregate,
    dateStrOffset,
    kbarsToCandles,
    wallClockToUtc
} from '../lib/utils/kbars';
import { roundToTick, tickDecimals, tickSizeFor } from '../lib/utils/ticksize';
import { createOhlcStore } from '../lib/ohlc-legend';
import { OhlcLegend } from './ohlc-legend';
import * as styles from './candle-chart.css';
import { ChartDrawingOverlays, ChartDrawingTools, ChartObjectList } from './chart-drawing-tools';
import { toolDef } from '../lib/chart-drawings';
import { AsyncStatus } from './async-status';
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

// 圖表一次只在一種模式：交易模式（頂端工具列武裝）或畫圖／瀏覽模式
// （左側工具列）。'observe' 不是頂端的按鈕，而是「沒有武裝交易工具」的
// 中性狀態 — 中性時圖表就歸左側工具列管。
type TradeMode = 'observe' | 'buy' | 'sell' | 'stop' | 'take' | 'alert';

const TRADE_MODES: { key: TradeMode; label: string }[] = [
    { key: 'buy', label: '點價買' },
    { key: 'sell', label: '點價賣' },
    { key: 'stop', label: '停損' },
    { key: 'take', label: '停利' },
    { key: 'alert', label: '警示' },
];

// keep paging until this floor — one page per fetch, spans widen with tf
const MAX_HISTORY_DAYS = 1095; // ~3 years

export type { ChartSessionMode };

export function CandleChart({
    panelId,
    contract,
    trades = [],
    onOrdersChanged,
    sessionMode: sessionModeProp,
    onSessionModeChange,
    orderSettings: orderSettingsProp,
    onOrderSettingsChange,
    showOhlc: showOhlcProp,
    onShowOhlcChange,
}: {
    panelId?: string;
    contract: ContractBase;
    trades?: Trade[];
    onOrdersChanged?: () => void;
    // 全盤 / 僅日盤。有 onSessionModeChange（主視窗 block）時是受控值
    // — 缺省 = 全盤，換版面沒帶欄位就回全盤；沒有時（彈出視窗）只當
    // 初始值，之後用元件內 state
    sessionMode?: ChartSessionMode;
    onSessionModeChange?: (mode: ChartSessionMode) => void;
    // 圖表下單設定（#204）：有 onOrderSettingsChange（主視窗 block）時跟版面
    // 一起存；沒有時（彈出視窗）只在元件內
    orderSettings?: ChartOrderPanelState;
    onOrderSettingsChange?: (next: ChartOrderPanelState) => void;
    // K 棒讀值列（開高低收，#240）：有 onShowOhlcChange（主視窗 block）時
    // 跟版面一起存；沒有時（彈出視窗）只在元件內。缺省 = 顯示
    showOhlc?: boolean;
    onShowOhlcChange?: (show: boolean) => void;
}) {
    const hostRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
    const volSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
    const lastBarRef = useRef<Candle | null>(null);
    const [tfIdx, setTfIdx] = useState(1); // default 5m
    // 僅日盤：aggregate 前濾掉夜盤 1 分 K、live 夜盤 tick 不入圖，指標
    // 也就只吃日盤 K 棒。只開給日盤 08:45–13:45 的期/選，其他商品一律全盤
    // 存檔值只認 all|day，其餘退回全盤
    const propMode = parseChartSessionMode(sessionModeProp);
    const [localSessionMode, setLocalSessionMode] =
        useState<ChartSessionMode>(propMode ?? 'all');
    const canDayOnly = supportsSessionSplit(contract as SessionContractLike);
    const dayOnly =
        canDayOnly &&
        (onSessionModeChange ? (propMode ?? 'all') : localSessionMode) ===
            'day';
    const pickSessionMode = (m: ChartSessionMode) => {
        setLocalSessionMode(m);
        onSessionModeChange?.(m);
    };
    const [localShowOhlc, setLocalShowOhlc] = useState(showOhlcProp ?? true);
    const showOhlc = onShowOhlcChange ? showOhlcProp !== false : localShowOhlc;
    const toggleOhlc = () => {
        setLocalShowOhlc(!showOhlc);
        onShowOhlcChange?.(!showOhlc);
    };
    // 讀值列自己訂閱這個 store：游標移動／tick 只重繪讀值列
    const ohlcStore = useMemo(createOhlcStore, []);
    const [hostWidth, setHostWidth] = useState(0);
    const [empty, setEmpty] = useState(false);
    const [loading, setLoading] = useState(false);
    const [historyError, setHistoryError] = useState(false);
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
    // 圖上目前畫的是哪一組（商品|週期|僅日盤）— 換組時同步清圖
    const drawnKeyRef = useRef('');
    const quote = useQuote(contract.code);
    const tf = TIMEFRAMES[tfIdx] ?? TIMEFRAMES[1];
    const themeSettings = useThemeSettings();
    const colors = getChartColors(themeSettings);
    const themeKey = themeKeyOf(themeSettings);
    const [mode, setMode] = useState<TradeMode>('observe');
    // 圖表下單設定（#204）：每張圖自己一組（每市場一份），缺省取「設為預設」
    const orderMarket: ChartOrderMarket | null =
        contract.security_type === 'STK' ? 'S'
            : contract.security_type === 'FUT' || contract.security_type === 'OPT' ? 'F' : null;
    const [localOrder, setLocalOrder] = useState<ChartOrderPanelState>(() => orderSettingsProp ?? {});
    const panelOrder = onOrderSettingsChange ? (orderSettingsProp ?? {}) : localOrder;
    // 沒有自訂過的市場用「設為預設」的值 — 圖表建立時就對股票與期貨兩種
    // 市場各取一份快照，之後別的圖按「設為預設」不會改到這張圖（包括它之後
    // 才切到的市場）；這張圖自己的「設為預設」才更新快照（#204）
    const defaultSnapshot = useRef<Record<ChartOrderMarket, ChartOrderSettings> | null>(null);
    defaultSnapshot.current ??= { S: loadChartOrderDefault('S'), F: loadChartOrderDefault('F') };
    const defaultFor = (m: ChartOrderMarket) => defaultSnapshot.current![m];
    const savedOrder = panelOrder[orderMarket ?? 'S'];
    const marketSettings: ChartOrderSettings = useMemo(() => {
        const m = orderMarket ?? 'S';
        return savedOrder ? normalizeChartOrder(savedOrder, m) : defaultFor(m);
        // defaultFor reads a per-chart snapshot, stable for the chart's lifetime
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [savedOrder, orderMarket]);
    const lotPreferences = useRef(new Map<string, ChartOrderSettings['lot']>());
    const stockSettingsFor = (initial: boolean, previous?: ChartOrderSettings) => {
        const lot = lotPreferences.current.get(contract.code) ?? loadOrderLotPreference(
            'chart', contract, QUICK_ORDER_LOTS, initial ? marketSettings.lot : defaultFor('S').lot,
        );
        // 換商品不沿用上一檔的單位；股數不能成為張數，零股換檔也歸 1。
        const reset = lot !== marketSettings.lot || (previous && (previous.lot !== lot || previous.lot === 'IntradayOdd'));
        return normalizeChartOrder({ ...marketSettings, lot, ...(reset ? { qty: 1 } : {}) }, 'S');
    };
    const [stockOrder, setStockOrder] = useState(() => ({
        code: contract.code, source: savedOrder,
        settings: orderMarket === 'S' ? stockSettingsFor(true) : marketSettings,
    }));
    // 在 render 中先套用新商品，確保行情訂閱與送單 ref 不會短暫使用舊單位。
    if (orderMarket === 'S' && stockOrder.code !== contract.code) {
        setStockOrder({ code: contract.code, source: savedOrder, settings: stockSettingsFor(false, stockOrder.settings) });
    } else if (orderMarket === 'S' && stockOrder.source !== savedOrder) {
        // 父元件更新帳戶／委託或重建設定物件時，仍以本商品單位解讀數量。
        const previousSource = normalizeChartOrder(stockOrder.source ?? defaultFor('S'), 'S');
        const lot = stockOrder.settings.lot;
        const qty = marketSettings.lot !== lot ? 1
            : marketSettings.qty === previousSource.qty ? stockOrder.settings.qty : marketSettings.qty;
        setStockOrder({ ...stockOrder, source: savedOrder, settings: normalizeChartOrder({ ...marketSettings, lot, qty }, 'S') });
    }
    const orderSettings = orderMarket === 'S' ? stockOrder.settings : marketSettings;
    const setOrderSettings = (next: ChartOrderSettings) => {
        if (!orderMarket) return;
        const settings = normalizeChartOrder({ ...next, ...(next.lot !== orderSettings.lot ? { qty: 1 } : {}) }, orderMarket);
        if (orderMarket === 'S') {
            lotPreferences.current.set(contract.code, settings.lot);
            saveOrderLotPreference('chart', contract, settings.lot);
            setStockOrder({ code: contract.code, source: savedOrder, settings });
        }
        const value = { ...panelOrder, [orderMarket]: settings };
        if (onOrderSettingsChange) onOrderSettingsChange(value);
        else setLocalOrder(value);
    };
    const orderSettingsRef = useRef(orderSettings);
    orderSettingsRef.current = orderSettings;
    const captureContext = useOrderContext(contract, orderSettings.lot);
    // 帳號：沒固定就跟隨主畫面；固定的帳號不可用時絕不改用別的帳號
    const accountState = useAccounts();
    const privacy = usePrivacyMode();
    useEffect(ensureAccounts, []);
    const orderAccountView: ChartOrderAccountView = useMemo(() => {
        const m = orderMarket ?? 'S';
        const eligible = accountState.accounts.filter(a => canTrade(a) && a.account_type === m);
        const global = m === 'S' ? accountState.selectedStock : accountState.selectedFutures;
        const resolved = resolveFlashAccount(accountState.accounts, m, orderSettings.accountKey, global, true);
        const labels = flashAccountLabels(eligible, privacy);
        return { eligible, active: resolved.account, following: resolved.following, missing: resolved.missing, ...labels };
    }, [accountState, orderMarket, orderSettings.accountKey, privacy]);
    const orderAccountRef = useRef(orderAccountView);
    orderAccountRef.current = orderAccountView;
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
    // 同一個 frame 內多次 crosshair 事件只處理最後一次（游標停下時讀值
    // 對準游標最後所在的 K 棒）
    const crosshairParamRef = useRef<MouseEventParams | null>(null);
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
    const armedDrawingSequenceRef = useRef<number | null>(null);
    const setTradeMode = (next: TradeMode) => {
        modeRef.current = next;
        armedDrawingSequenceRef.current = next === 'observe' ? null : drawingsRef.current?.interactionSequence() ?? null;
        setMode(next);
    };
    const contractRef = useRef(contract);
    contractRef.current = contract;
    const lastPriceRef = useRef<number | null>(null);
    // 零股停損停利：觸價引擎看零股成交價，建立時判斷在現價上方／下方也必須
    // 用零股成交價（#204），否則兩市場價格分處觸發價兩側時方向會判反
    const oddChartQuote = useQuote(
        orderMarket === 'S' && orderSettings.lot === 'IntradayOdd' ? contract.code : null,
        { oddLot: true },
    );
    const oddLastRef = useRef<number | null>(null);
    oddLastRef.current = oddChartQuote?.tick && Number(oddChartQuote.tick.close) > 0 ? Number(oddChartQuote.tick.close) : null;

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
            // 第二道防線：畫圖選取／草稿／拖曳／文字／量測均不能進入下單路徑。
            if (drawingsRef.current?.drawingBusy()) return;
            const m = modeRef.current;
            // 武裝以後只要發生畫圖互動，這次授權就失效；即使 mode 的更新
            // 尚未 render 或某入口未清模式，也不得進入 placeQuickOrder。
            if (m !== 'observe' && (armedDrawingSequenceRef.current === null ||
                armedDrawingSequenceRef.current !== drawingsRef.current?.interactionSequence())) return;
            if (!param.point) return;
            const raw = candles.coordinateToPrice(param.point.y);
            if (raw === null) return;
            const c = contractRef.current;
            const price = roundToTick(c, Number(raw));
            if (m === 'observe') {
                setPickedPrice(c.code, price); // sync to order tickets
                return;
            }
            const market: ChartOrderMarket = c.security_type === 'STK' ? 'S' : 'F';
            const settings = orderSettingsRef.current;
            const qty = settings.qty;
            const last = lastPriceRef.current;
            const oddLast = oddLastRef.current;
            const odd = market === 'S' && settings.lot === 'IntradayOdd';
            const view = orderAccountRef.current;
            const account: Account | undefined = view.active;
            modeRef.current = 'observe';
            armedDrawingSequenceRef.current = null;
            setMode('observe'); // one-shot
            if (m !== 'alert' && (view.missing || !account)) {
                notify({ kind: 'err', title: '圖表下單未送出', body: view.missing ? '圖表設定的固定帳號已不可用，請在下單設定重新選擇' : '沒有可用的下單帳號' });
                return;
            }
            // a pinned account must still be this chart's account when the
            // (optional) confirmation returns
            const isAccountCurrent = () => accountMatches(orderAccountRef.current.active, account);
            if (m === 'buy' || m === 'sell') {
                const action = m === 'buy' ? 'Buy' : 'Sell';
                const isContextCurrent = captureContext();
                placeQuickOrder(c, action, price, qty, { ...chartPlaceOptions(settings, market), account, isAccountCurrent, beforeSend: () => {
                    if (!isContextCurrent()) throw new Error(ORDER_CONTEXT_CHANGED_MESSAGE);
                    if (!isAccountCurrent()) throw new Error('帳戶已變更，已停止後續下單');
                } })
                    .then((trade) =>
                        notify({
                            kind: 'ok',
                            title: `📈 圖表${action === 'Buy' ? '買進' : '賣出'}已送出`,
                            body: `${c.code} ${qty}${odd ? ' 股（零股）' : ''} @ ${fmtPrice(price)} (${trade.status.status})`,
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
            // alerts stay on the round-lot price; odd-lot stops/takes decide
            // their side from the odd-lot trade price they will fire on
            const ref = m !== 'alert' && odd ? oddLast : last;
            if (ref === null) {
                notify({
                    kind: 'err',
                    title: '無法掛觸價單',
                    body: m !== 'alert' && odd ? '等待零股行情：尚未收到盤中零股成交價' : '尚未收到即時成交價',
                });
                return;
            }
            const below = price <= ref;
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
            const fields = chartTriggerFields(settings, market);
            const fixed = view.following ? undefined : { account };
            if (m === 'stop') {
                addTrigger({
                    code: c.code,
                    condition: below ? 'below' : 'above',
                    price,
                    action: below ? 'Sell' : 'Buy',
                    quantity: qty,
                    kind: 'stop',
                    ...fields,
                }, c, fixed);
            } else {
                addTrigger({
                    code: c.code,
                    condition: below ? 'below' : 'above',
                    price,
                    action: below ? 'Buy' : 'Sell',
                    quantity: qty,
                    kind: 'take',
                    ...fields,
                }, c, fixed);
            }
        });

        chart.subscribeCrosshairMove((param) => {
            // legend value readout follows the crosshair（rAF-throttled）
            crosshairParamRef.current = param;
            if (!legendRafRef.current) {
                legendRafRef.current = true;
                requestAnimationFrame(() => {
                    legendRafRef.current = false;
                    const p = crosshairParamRef.current;
                    const hovering = p?.point ? p : undefined;
                    updateLegendRef.current(hovering);
                    // K 棒讀值：游標所在 K 棒；離開圖表／不在 K 棒上 → 最新一根
                    ohlcStore.hover(
                        hovering && typeof hovering.time === 'number'
                            ? hovering.time
                            : null,
                    );
                });
            }
            if (!param.point) return;
            const raw = candles.coordinateToPrice(param.point.y);
            if (raw === null) return;
            const c = contractRef.current;
            // 游標移動帶價受設定控制（#58，預設關閉）；點擊帶價不受影響
            setHoverPickedPrice(c.code, roundToTick(c, Number(raw)));
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
    }, [themeKey]);

    // K 棒讀值：歷史載入／換商品／換週期後重算
    useEffect(() => {
        ohlcStore.bump();
    }, [dataVersion, ohlcStore]);

    // 圖表寬度 → 讀值列完整／縮短（窄面板不讓讀值擋住 K 棒）
    useEffect(() => {
        const host = hostRef.current;
        if (!host || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver((entries) => {
            const w = Math.round(entries[0]?.contentRect.width ?? 0);
            setHostWidth((prev) => (prev === w ? prev : w));
        });
        ro.observe(host);
        return () => ro.disconnect();
    }, []);
    // 讀值小數位依跳動價位；指數沒有跳動價位，固定兩位（與價格軸一致）
    const ohlcDecimals = useMemo(
        () => (price: number) =>
            contract.security_type === 'IND'
                ? 2
                : tickDecimals(tickSizeFor(contract, price)),
        [contract],
    );

    // load kbars on symbol/timeframe change; pages of older history are
    // pulled on demand by the visible-range subscription (loadMoreRef)
    useEffect(() => {
        let cancelled = false;
        const loadKey = `${contract.code}|${tf.minutes}|${dayOnly}`;
        loadedKeyRef.current = ''; // freeze tick updates while loading
        const toRaw = (k: Parameters<typeof kbarsToCandles>[0]) => {
            const raw = kbarsToCandles(k);
            return dayOnly
                ? filterDaySession(contract.security_type, raw)
                : raw;
        };
        lastBarRef.current = null;
        loadMoreRef.current = null;
        // 換商品/週期/全盤↔日盤：新歷史回來前立刻清掉前一組 K 棒 —
        // 請求還在路上（或卡住）時，不能在「日盤」亮著的狀態下繼續掛著
        // 日夜盤混合的舊 K 棒。同組重載（更新歷史/斷層補抓）不清，免閃
        if (drawnKeyRef.current !== loadKey) {
            drawnKeyRef.current = loadKey;
            candleSeriesRef.current?.setData([]);
            volSeriesRef.current?.setData([]);
            barsRef.current = [];
            rawRef.current = [];
            gapReloadAtRef.current = 0;
            setDataVersion((v) => v + 1); // 指標跟著清
        }
        setEmpty(false);
        setLoading(true);
        setHistoryError(false);
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
                    const older = toRaw(k).filter(
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

        fetchChartHistory(contract, dateStrOffset(tf.days), dateStrOffset(0), {
            revision: historySeq,
            timeoutMs: 30_000, // 大週期初載可達數十天，不能用 10s
        })
            .then((k) => {
                if (cancelled || !candleSeriesRef.current) return;
                const raw = toRaw(k);
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
                // 保留即時作畫；歷史查詢失敗後由使用者手動更新。
                clearSeries();
                setEmpty(true);
                setHistoryError(true);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [contract, tf, historySeq, dayOnly]);

    // Live trade/index quote -> update the current bar. Index products use
    // quote_idx rather than the regular tick stream in Shioaji 1.7.
    const liveQuote = quote?.tick ?? quote?.index;
    if (liveQuote && liveQuote.code === contract.code) {
        const p = Number(liveQuote.close);
        if (Number.isFinite(p)) lastPriceRef.current = p;
    }
    useEffect(() => {
        if (!liveQuote || liveQuote.code !== contract.code) return;
        // 試撮 (simtrade) 揭示價可以是漲跌停天地價 — 畫進 K 棒會把
        // Y 軸尺度撐爆（issue #5），一律排除
        if ('simtrade' in liveQuote && liveQuote.simtrade) return;
        // history for this (symbol, timeframe) not in place yet
        if (
            loadedKeyRef.current !== `${contract.code}|${tf.minutes}|${dayOnly}`
        ) {
            return;
        }
        const series = candleSeriesRef.current;
        if (!series) return;
        const price = Number(liveQuote.close);
        if (!Number.isFinite(price)) return;
        const tickTime = wallClockToUtc(
            `${liveQuote.date}T${liveQuote.time}`,
        );
        // 僅日盤：夜盤/盤外成交不入圖（與歷史濾法同一套 label 判斷）
        if (dayOnly && !isDaySessionTick(contract.security_type, tickTime)) {
            return;
        }
        const bucketSec = tf.minutes * 60;
        // close-label-right（與 aggregate/1 分 K 歷史同慣例）：成交 τ 屬
        // 於哪個「收盤 label」桶 — floor 會把 live 桶標早一格，1 分 K
        // 時甚至會併進前一分鐘的歷史 bar
        const bucket =
            tf.minutes >= 1440
                ? Math.floor(tickTime / 86400) * 86400
                : Math.floor(tickTime / bucketSec) * bucketSec + bucketSec;
        let bar = lastBarRef.current;
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
        ohlcStore.bump(); // K 棒讀值跟著最新成交
        // 歷史載入失敗後 live bar 已開始堆 — 圖上有東西就不該再掛
        // 「無 K 線資料」（同值 setState React 會 bail out）
        setEmpty(false);
        setHistoryError(false);
    }, [liveQuote, quote?.tick?.volume, contract.code, tf.minutes, dayOnly]);

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
        const bars = barsRef.current;
        if (bars.length === 0) {
            paneAssignRef.current = paneAssign; // no panes exist right now
            // 讀值也要清 — 序列移除了但 legend 讀 legendMetaRef，不清
            // 會殘留上一檔商品的指標數值（無 K 線資料卻顯示 MA 值）
            legendMetaRef.current = new Map();
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
                    panes[paneIdx]?.setHeight(
                        paneHeightsRef.current.get(instId) ?? 110,
                    );
                }
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
    }, [dataVersion, instancesKey, themeKey, tf.minutes, customVer]);

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
    }, [orderKey, themeKey, contract.code]);

    // 畫圖工具武裝中（下方 useChartDrawings 每次 render 更新）。委託線的
    // 拖曳 effect 宣告在畫圖 hook 之前，靠這個 ref 讀最新狀態
    const drawingArmedRef = useRef(false);
    const drawingsRef = useRef<ChartDrawingsApi | null>(null);
    const cancelOrderDragRef = useRef<() => boolean>(() => false);
    const orderDragContext = `${contract.security_type}:${contract.code}:${tf.minutes}:${dayOnly}:${historySeq}`;
    const orderDragContextRef = useRef(orderDragContext);
    orderDragContextRef.current = orderDragContext;
    // 舊委託線被重建前也要還原／解除拖曳；render 後、effect 前的事件由 context 核對阻擋。
    useLayoutEffect(() => { cancelOrderDragRef.current(); }, [orderDragContext, orderKey, themeKey]);

    // drag an order line to modify its price
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        let sequence = 0;
        let dragging: { trade: Trade; line: IPriceLine; price: number; originalPrice: number; sequence: number; drawingSequence: number; context: string } | null =
            null;
        // active document listeners — removed on unmount if a drag is live
        let activeMove: ((e: MouseEvent) => void) | null = null;
        let activeUp: (() => void) | null = null;

        const releasePointer = () => {
            if (activeMove) document.removeEventListener('mousemove', activeMove, true);
            if (activeUp) document.removeEventListener('mouseup', activeUp, true);
            activeMove = null;
            activeUp = null;
            window.removeEventListener('keydown', escape, true);
            chartRef.current?.applyOptions({ handleScroll: true, handleScale: true });
            if (host.style.cursor === 'ns-resize') host.style.cursor = '';
        };
        const cancel = () => {
            sequence++;
            const d = dragging;
            dragging = null;
            if (!d) return false;
            // cleanup 時圖表可能已移除；仍必須釋放 document listeners。
            try { d.line.applyOptions({ price: d.originalPrice }); } catch { /* series 已釋放 */ }
            releasePointer();
            return true;
        };
        cancelOrderDragRef.current = cancel;
        const current = (d: NonNullable<typeof dragging>) => dragging === d && d.sequence === sequence &&
            d.drawingSequence === drawingsRef.current?.interactionSequence() && d.context === orderDragContextRef.current;
        const escape = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || !dragging) return;
            drawingsRef.current?.onInteraction();
            cancel();
            e.preventDefault();
            resetEscCancelArm();
        };

        const yOf = (e: MouseEvent) =>
            e.clientY - host.getBoundingClientRect().top;

        const findNear = (y: number) => {
            const series = candleSeriesRef.current;
            if (!series) return null;
            for (const t of workingOrdersRef.current) {
                // 零股委託不能改價（#204）：委託線不可拖曳
                if (!canUpdateOrderPrice(t.order)) continue;
                const line = orderLinesRef.current.get(t.order.id);
                if (!line) continue;
                const coord = series.priceToCoordinate(line.options().price);
                if (coord !== null && Math.abs(coord - y) <= 6) {
                    return { trade: t, line, coord };
                }
            }
            return null;
        };

        // 畫圖的浮動工具列／文字框蓋在委託線上時，那一下屬於它們
        const onOverlay = (e: MouseEvent) =>
            !!(e.target as HTMLElement | null)?.closest?.('[data-drawing-overlay]');

        // 委託線能不能接手這一下（見 orderLineMayTakePointer）。右側把手
        // 區＝價格軸上委託線自己的價格標籤（不含繪圖區）
        const mayTake = (e: MouseEvent) => {
            const d = drawingsRef.current;
            const rect = host.getBoundingClientRect();
            const axis = chartRef.current?.priceScale('right').width() ?? 60;
            const onLabel = inOrderLabelArea(e.clientX - rect.left, rect.width, axis);
            return orderLineMayTakePointer({
                drawingLabelAtPointer: onLabel && (d?.drawingLabelAt(e.clientY) ?? false),
                drawingArmed: drawingArmedRef.current,
                defaultPrevented: e.defaultPrevented,
                // 價格軸上沒有畫圖物件（只畫在繪圖區）；線端的命中容差不算
                drawingHit: onLabel ? null : (d?.drawingAt(e) ?? null),
                drawingBusy: d?.drawingBusy() ?? false,
                inGrip: onLabel,
            });
        };

        const hover = (e: MouseEvent) => {
            if (dragging || onOverlay(e)) return;
            const near = findNear(yOf(e));
            // 武裝畫圖工具、或這個位置歸畫圖物件時委託線不接手，游標交給畫圖
            if (!near || !mayTake(e)) {
                if (host.style.cursor === 'ns-resize') host.style.cursor = '';
                return;
            }
            host.style.cursor = 'ns-resize';
        };

        const down = (e: MouseEvent) => {
            if (e.button !== 0 || onOverlay(e)) return;
            // 「委託線優先」只在瀏覽模式：武裝畫圖工具時這一下屬於畫圖，
            // 在委託價附近畫線不能變成改價；別的 handler 已經接手的一下
            // 也不能同時拖畫圖又送出改價
            const hit = findNear(yOf(e));
            if (!hit || !mayTake(e)) return;
            // 價格軸把手可接手，但不能與未結束的畫圖拖曳／文字／量測共存。
            drawingsRef.current?.prepareOrderDrag();
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
                originalPrice: hit.line.options().price,
                sequence: ++sequence,
                drawingSequence: drawingsRef.current?.interactionSequence() ?? -1,
                context: orderDragContextRef.current,
            };
            const session = dragging;

            const move = (ev: MouseEvent) => {
                const series = candleSeriesRef.current;
                if (!series || dragging !== session) return;
                if (!current(session)) { cancel(); return; }
                const raw = series.coordinateToPrice(yOf(ev));
                if (raw === null) return;
                const np = roundToTick(contractRef.current, Number(raw));
                dragging.price = np;
                dragging.line.applyOptions({ price: np });
            };
            const up = () => {
                // 遲到的舊 mouseup 不得接手新拖曳，更不能送出舊的改價。
                if (dragging !== session) return;
                if (!current(session)) { cancel(); return; }
                releasePointer();
                const d = dragging;
                dragging = null;
                sequence++;
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
            window.addEventListener('keydown', escape, true);
        };

        host.addEventListener('mousedown', down, true); // capture: beat chart pan
        host.addEventListener('mousemove', hover, true);
        return () => {
            cancel();
            cancelOrderDragRef.current = () => false;
            host.removeEventListener('mousedown', down, true);
            host.removeEventListener('mousemove', hover, true);
            window.removeEventListener('keydown', escape, true);
        };
    }, []);

    // 畫圖工具（issue #122 二／三）。宣告位置有兩個前提（同一個元件的
    // effect 依宣告順序執行）：
    // - 在建立圖表的 effect 之後 — 掛 primitive 時 candleSeriesRef 才有值
    // - 在委託線拖曳的 effect 之後 — host 上的 mousedown／mousemove 由
    //   委託線先處理：真實委託優先於畫圖物件，游標也由它先決定
    const barTimesRef = useRef<number[]>([]);
    useEffect(() => {
        barTimesRef.current = barsRef.current.map((b) => b.time);
    }, [dataVersion]);
    const drawings = useChartDrawings({
        contract,
        contextKey: `${tf.minutes}:${dayOnly}:${historySeq}`,
        hostRef,
        chartRef,
        seriesRef: candleSeriesRef,
        getTimes: () => barTimesRef.current,
        tradeArmed: mode !== 'observe',
        onInvalidateInteraction: () => cancelOrderDragRef.current(),
        onEnterDrawingMode: () => {
            modeRef.current = 'observe';
            setMode('observe');
        },
        themeMode: baseMode(themeSettings),
        getBars: () => barsRef.current,
        // 量測換算損益：期貨／選擇權＝口數 × 乘數；股票＝張數 × 1000 股
        // （零股＝股數）。不知道乘數時不顯示損益
        pnlPerPoint: drawingPnlPerPoint(contract, orderMarket, orderSettings),
        chartBackground: colors.labelBg,
    });
    drawingArmedRef.current = drawings.tool !== null;
    drawingsRef.current = drawings;

    // 畫圖存不進 localStorage（配額滿）— 畫面上的物件還在，但關掉就沒了。
    // 多張圖同時訂閱，notice 只由第一張拿到的圖發出
    const drawingsSaveFailed = useDrawingsSaveFailed();
    useEffect(() => {
        if (!drawingsSaveFailed || !takeDrawingSaveErrorNotice()) return;
        notify({
            kind: 'err',
            title: '畫圖未能儲存',
            body: '瀏覽器儲存空間已滿，新的畫圖只保留到關閉視窗為止。請刪除部分畫圖後再試。',
        });
    }, [drawingsSaveFailed]);

    // 物件上限、載入截斷、復原／重做衝突共用畫圖通知
    const drawingNotices = useDrawingNotices();
    useEffect(() => {
        if (!drawingNotices.length) return;
        for (const body of takeDrawingNotices()) notify({ kind: 'err', title: '畫圖工具', body });
    }, [drawingNotices]);

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
                        : `${t.kind === 'stop' ? '停損' : '停利'}${t.action === 'Buy' ? '買' : '賣'}${t.quantity}${t.orderLot === 'IntradayOdd' ? '股' : ''}`,
            }),
        );
        return () => {
            for (const line of lines) series.removePriceLine(line);
        };
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
        <div className={styles.wrap}
            onPointerDownCapture={() => { if (panelService && panelId) panelService.focus(panelId); }}
            onFocusCapture={() => { if (panelService && panelId) panelService.focus(panelId); }}>
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
                {canDayOnly && (
                    // 單一切換鈕（亮＝僅日盤）— 工具列寬度吃緊，不另開
                    // 「全盤」鈕與分隔線，窄面板才不會提早折行
                    <button
                        className={styles.tfBtn[dayOnly ? 'active' : 'normal']}
                        title={
                            dayOnly
                                ? `僅日盤（${daySessionLabel(contract.security_type)}），指標也只用日盤計算 — 點擊切回全盤`
                                : `全盤（日盤＋夜盤）— 點擊改為僅日盤 ${daySessionLabel(contract.security_type)}`
                        }
                        aria-pressed={dayOnly}
                        onClick={() => pickSessionMode(dayOnly ? 'all' : 'day')}
                    >
                        日盤
                    </button>
                )}
                <button
                    className={styles.iconBtn}
                    onClick={resetView}
                    title='重設視圖（自動縮放）'
                    aria-label='重設視圖'
                >
                    <Maximize2 size={12} />
                </button>
                <button
                    className={styles.iconBtnToggle[showOhlc ? 'on' : 'off']}
                    onClick={toggleOhlc}
                    title={showOhlc ? 'K 棒讀值（開高低收）：顯示中 — 點擊隱藏' : 'K 棒讀值（開高低收）：已隱藏 — 點擊顯示'}
                    aria-label='K 棒讀值'
                    aria-pressed={showOhlc}
                >
                    <ChartCandlestick size={12} />
                </button>
                <span className={styles.toolbarDivider} />
                {TRADE_MODES.filter(
                    // 組合商品只能用組合單下單 — 圖上僅保留警示，
                    // 點價買賣與觸價停損停利（flat code 會被 server 拒）
                    // 一律不給
                    (m) => !isCombo || m.key === 'alert',
                ).map((m) => (
                    <button
                        key={m.key}
                        className={styles.modeBtn[mode === m.key ? 'armed' : 'normal']}
                        title={`交易模式：${m.label}`}
                        // 再按一次退出交易模式。頂端不再有「游標」按鈕，
                        // 這是留在頂端的解除方式（另一個是點左側工具列）
                        onClick={() => setTradeMode(mode === m.key ? 'observe' : m.key)}
                    >
                        {m.label}
                    </button>
                ))}
                {orderMarket && !isCombo && (
                    <ChartOrderButton
                        market={orderMarket}
                        settings={orderSettings}
                        onChange={setOrderSettings}
                        onSaveDefault={() => {
                            saveChartOrderDefault(orderMarket, orderSettings);
                            defaultSnapshot.current![orderMarket] = orderSettings;
                            notify({ kind: 'info', title: '已設為圖表下單預設', body: `新開的${orderMarket === 'F' ? '期貨' : '股票'}圖表使用這組設定（不含帳號）；其他現有圖表維持原設定。` });
                        }}
                        account={orderAccountView}
                        contractLabel={`${contract.code}${(contract as { name?: string }).name ? ` ${(contract as { name?: string }).name}` : ''}`}
                    />
                )}
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
                <RefreshButton label="更新歷史" loading={loading} onClick={() => setHistorySeq(nextChartHistoryRevision())} />
            </div>
            <div className={styles.chartRow}>
            <ChartDrawingTools api={drawings} />
            <div ref={hostRef} className={styles.chartHost}>
                {loading && (
                    <div className={styles.emptyMsg}>
                        <AsyncStatus phase='loading' text={`載入 ${tf.label} K 線…`} className={panel.mono} />
                    </div>
                )}
                {empty && !loading && (
                    <div className={styles.emptyMsg}>
                        <AsyncStatus phase={historyError ? 'error' : 'empty'}
                            text={historyError ? 'K 線歷史無法取得，請更新歷史' : '無 K 線資料'}
                            className={panel.mono} />
                    </div>
                )}
                {mode !== 'observe' && (
                    <div className={styles.modeHint}>
                        交易模式 · {chartModeHint(mode, orderSettings, orderMarket ?? 'S')}
                    </div>
                )}
                {mode === 'observe' && drawings.tool && (
                    <div className={styles.drawHint}>
                        畫圖模式 · {toolDef(drawings.tool).label}：{DRAW_HINT[drawings.tool]}（Esc 取消）
                    </div>
                )}
                {(showOhlc ||
                    workingOrders.length > 0 ||
                    triggers.length > 0 ||
                    instances.length > 0) && (
                    <div className={styles.triggerList}>
                        {showOhlc && (
                            <OhlcLegend
                                store={ohlcStore}
                                getBars={() => barsRef.current}
                                decimalsFor={ohlcDecimals}
                                width={hostWidth}
                                colors={colors}
                            />
                        )}
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
                                                .then((trade) => {
                                                    // Cancelled, filled first, or a working-looking
                                                    // broker status whose cancel covers everything.
                                                    const summary = cancellationSummary([{ status: 'fulfilled', value: trade }]);
                                                    notify({
                                                        kind: summary.kind,
                                                        title: '刪單結果',
                                                        body: `${t.contract.code} @${fmtPrice(price)}：${summary.body}`,
                                                    });
                                                    onOrdersChangedRef.current?.();
                                                })
                                                .catch((e) =>
                                                    notify({
                                                        kind: 'err',
                                                        title: isCancelUnconfirmed(e) ? '刪單未確認' : '刪單失敗',
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
                                        ` ${t.action === 'Buy' ? '買' : '賣'}${t.quantity}${t.orderLot === 'IntradayOdd' ? '股' : ''}`}
                                    {t.suspended && (
                                        <span title={t.suspended}> 未啟用</span>
                                    )}
                                    {t.pending && (
                                        <span title='離線期間已穿價，未自動送出；請在待確認視窗選擇送出、保留或取消'>
                                            {' '}待確認
                                        </span>
                                    )}
                                    {t.awaitingRecross && (
                                        <span title='價格回到觸價另一側後，再次穿價才會觸發'>
                                            {' '}待重新穿價
                                        </span>
                                    )}
                                    {!t.suspended &&
                                        t.kind !== 'alert' &&
                                        t.env !== currentProtectionEnv() && (
                                            <span title='建立於其他伺服器或模擬／正式模式，目前不執行'>
                                                {' '}未在此環境
                                            </span>
                                        )}
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
                <ChartDrawingOverlays api={drawings} />
            </div>
            <ChartObjectList api={drawings} />
            </div>
        </div>
    );
}

const DRAW_HINT: Record<string, string> = {
    horizontal: '點擊價位放置水平線',
    vertical: '點擊時間放置垂直線',
    trend: '點兩下決定起點與終點',
    ray: '點兩下決定起點與方向',
    extended: '點兩下決定斜率',
    channel: '點兩下畫基準線，第三下決定通道寬度',
    box: '點兩下決定方框的兩個對角',
    fib: '點兩下：起點（1）到終點（0）',
    text: '點一下放置文字，輸入後按 Enter',
    measure: '點兩下量測價差、K 棒數與時間',
};

function drawingPnlPerPoint(
    contract: ContractBase,
    market: ChartOrderMarket | null | undefined,
    s: ChartOrderSettings,
): number | null {
    if (market === 'F') {
        const mult = (contract as { multiplier?: number }).multiplier;
        return mult && mult > 0 ? mult * s.qty : null;
    }
    if (market === 'S') return s.qty * (s.lot === 'IntradayOdd' ? 1 : 1000);
    return null;
}
