// src/components/intraday-chart.tsx — 當日走勢圖 (intraday time-price
// chart): baseline line vs 昨收參考價 with red/green fills, VWAP-style
// average line, volume strip, fixed full-session time axis. History from
// 1-min kbars, live-updated from the SSE tick stream. Sessions: stocks
// 09:00–13:30; futures/options day 08:45–13:45 or night 15:00–05:00,
// picked from where the data actually is (handles weekends/holidays and
// the night-session next-date filing quirk without wall-clock guessing).

import {
    BarSeries,
    BaselineSeries,
    ColorType,
    createChart,
    HistogramSeries,
    LineSeries,
    LineStyle,
    type AutoscaleInfo,
    type IChartApi,
    type IPriceLine,
    type ISeriesApi,
    type UTCTimestamp,
} from 'lightweight-charts';
import { Settings2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useQuote } from '../hooks/use-stream';
import { colorWithOpacity } from '../lib/indicator-defs';
import {
    sessionMinutes,
    sessionWindowFor,
    tickBucket,
    type SessionWindow,
} from '../lib/intraday-session';
import { fetchKbars } from '../lib/shioaji';
import { getChartColors, useThemeSettings } from '../lib/theme-store';
import type { ContractInfo } from '../lib/types/contract';
import type { KBars } from '../lib/types/market';
import { fmtPrice } from '../lib/utils/format';
import {
    dateStrOffset,
    nowWallClockUtc,
    wallClockToUtc,
} from '../lib/utils/kbars';
import { Orb } from './orb';
import * as styles from './intraday-chart.css';
import * as panel from './panel.css';

interface MinBar {
    time: number;
    open: number;
    close: number;
    high: number;
    low: number;
    vol: number;
    amt: number;
}

function kbarsToMinBars(k: KBars): MinBar[] {
    const out: MinBar[] = [];
    for (let i = 0; i < k.datetime.length; i++) {
        const dt = k.datetime[i];
        if (!dt) continue;
        out.push({
            time: wallClockToUtc(dt),
            open: k.Open[i] ?? 0,
            close: k.Close[i] ?? 0,
            high: k.High[i] ?? 0,
            low: k.Low[i] ?? 0,
            vol: k.Volume[i] ?? 0,
            amt: k.Amount?.[i] ?? 0,
        });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
}

// legend/live readout — kept in a ref, re-rendered via rAF-throttled bump
interface Readout {
    price: number;
    avg: number | null;
    high: number;
    low: number;
    total: number; // 張/口 — for IND, 成交金額 (yuan)
}

const fmtVol = (v: number) =>
    v.toLocaleString('en-US', { maximumFractionDigits: 0 });
const fmtAmtYi = (v: number) => `${(v / 1e8).toFixed(1)}億`;

// Y 軸縮放模式：auto=依資料對稱縮放（上限為停板）、band=固定漲跌停區間。
// 依商品記憶：個股習慣看漲跌停全幅、指數/台指期習慣自動縮放 — 分類給
// 預設值，使用者對單一商品的切換記在該檔，另可套用同類/全部或重設。
export type ScaleMode = 'auto' | 'band';
type ScaleCat = 'index' | 'equity';
const SCALE_MEM_KEY = 'sj-pro-intraday-scale-mem';

function scaleCatOf(c: ContractInfo): ScaleCat {
    if (c.security_type === 'STK' || c.security_type === 'WRT') {
        return 'equity';
    }
    // 個股期/個股選擇權 underlying_kind 'S'；指數期選為 'I'
    if (
        (c.security_type === 'FUT' || c.security_type === 'OPT') &&
        c.underlying_kind === 'S'
    ) {
        return 'equity';
    }
    return 'index';
}

interface ScaleMem {
    perCode: Record<string, { m: ScaleMode; c: ScaleCat }>;
    catDefault: Partial<Record<ScaleCat, ScaleMode>>;
}

function loadScaleMem(): ScaleMem {
    try {
        const raw = localStorage.getItem(SCALE_MEM_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<ScaleMem>;
            return {
                perCode: parsed.perCode ?? {},
                catDefault: parsed.catDefault ?? {},
            };
        }
    } catch {
        // fall through
    }
    return { perCode: {}, catDefault: {} };
}

function saveScaleMem(mem: ScaleMem) {
    try {
        localStorage.setItem(SCALE_MEM_KEY, JSON.stringify(mem));
    } catch {
        // session only
    }
}

export function resolveScaleMode(contract: ContractInfo): ScaleMode {
    const mem = loadScaleMem();
    const cat = scaleCatOf(contract);
    return (
        mem.perCode[contract.code]?.m ??
        mem.catDefault[cat] ??
        (cat === 'equity' ? 'band' : 'auto')
    );
}

// 圖形樣式：line=收盤分時線、bars=美國線（每分鐘 OHLC，高低不失真）
type ChartStyle = 'line' | 'bars';
const CHART_STYLE_KEY = 'sj-pro-intraday-style';

function loadChartStyle(): ChartStyle {
    try {
        return localStorage.getItem(CHART_STYLE_KEY) === 'bars'
            ? 'bars'
            : 'line';
    } catch {
        return 'line';
    }
}

// 量能顯示：overlay=疊在主圖下緣（無獨立軸）、pane=獨立分欄含 Y 軸
type VolMode = 'overlay' | 'pane';
const VOL_MODE_KEY = 'sj-pro-intraday-vol';

function loadVolMode(): VolMode {
    try {
        return localStorage.getItem(VOL_MODE_KEY) === 'overlay'
            ? 'overlay'
            : 'pane';
    } catch {
        return 'pane';
    }
}

// legend 顯示項目 — 窄面板時可關掉次要資訊，價格與漲跌恆顯示
interface LegendItems {
    avg: boolean;
    hilo: boolean;
    total: boolean;
}
const LEGEND_ITEMS_KEY = 'sj-pro-intraday-legend';

function loadLegendItems(): LegendItems {
    const def: LegendItems = { avg: true, hilo: true, total: true };
    try {
        const raw = localStorage.getItem(LEGEND_ITEMS_KEY);
        if (!raw) return def;
        const parsed = JSON.parse(raw) as Partial<LegendItems>;
        return {
            avg: parsed.avg !== false,
            hilo: parsed.hilo !== false,
            total: parsed.total !== false,
        };
    } catch {
        return def;
    }
}

// 0.5–4，步進 0.5。lightweight-charts 的 LineWidth 型別標成 1|2|3|4，
// 但 renderer 直通 canvas lineWidth，小數實測有效（0.5 = 髮絲線）
const LINE_WIDTH_MIN = 0.5;
const LINE_WIDTH_MAX = 4;
const LINE_WIDTH_KEY = 'sj-pro-intraday-linewidth';

function loadLineWidth(): number {
    try {
        const n = Number(localStorage.getItem(LINE_WIDTH_KEY));
        if (!Number.isFinite(n)) return 2;
        return Math.min(LINE_WIDTH_MAX, Math.max(LINE_WIDTH_MIN, n));
    } catch {
        return 2;
    }
}

// 收盤定盤可能印在收盤後幾分鐘（指數定盤 13:31–33）— 這段內的
// kbar/tick 都併進最後一根 label，軸仍固定收在 win.end
const CLOSE_GRACE = 240;

const fmtClock = (t: number) => {
    const d = new Date(t * 1000);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
};

export function IntradayChart({ contract }: { contract: ContractInfo }) {
    const hostRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const priceSeriesRef = useRef<ISeriesApi<'Baseline'> | null>(null);
    const barSeriesRef = useRef<ISeriesApi<'Bar'> | null>(null);
    const pctSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
    const avgSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
    const volSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
    const fillerSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
    const refLineRef = useRef<IPriceLine | null>(null);
    const limitLinesRef = useRef<IPriceLine[]>([]);

    const sessionRef = useRef<SessionWindow | null>(null);
    const refPriceRef = useRef(0);
    // 漲跌停界線；Y 軸縮放的硬上限（其他家常見的「軸飆出去」就是沒 cap）
    const limitsRef = useRef<{ up: number; down: number } | null>(null);
    const loadedKeyRef = useRef('');
    // live accumulation state
    const lastLabelRef = useRef(0);
    const minuteVolRef = useRef(0); // current-minute volume (IND: amount)
    // current-minute OHLC，美國線的即時 bar
    const minOhlcRef = useRef<{
        open: number;
        high: number;
        low: number;
        close: number;
    } | null>(null);
    const prevMinCloseRef = useRef(0); // previous bar close, for vol color
    const cumVRef = useRef(0);
    const cumPVRef = useRef(0);
    const liveRef = useRef<Readout | null>(null);
    // 試搓揭示（simtrade）— 不入圖，只在 legend 顯示「試搓 <價>」；
    // 第一筆真實成交進來即清除
    const simRef = useRef<{ price: number; chg?: number } | null>(null);
    const hoverRef = useRef<(Readout & { time: number }) | null>(null);
    const lastReloadRef = useRef(0);
    // 換時段重載的目標時段 — 試搓觸發切換時新時段還沒有 kbar，load
    // 不能又依最後一根 kbar 選回上一段（會空轉重載）
    const pendingWinRef = useRef<{ code: string; start: number } | null>(null);
    const drawnCodeRef = useRef('');
    const retryTimerRef = useRef(0);

    const [loading, setLoading] = useState(false);
    const [empty, setEmpty] = useState(false);
    const [reloadSeq, setReloadSeq] = useState(0);
    // 依商品解析 Y 軸模式 — 換商品時在 render 階段同步重解（避免
    // effect 慢半拍造成的雙重載入）
    const [scaleState, setScaleState] = useState(() => ({
        code: contract.code,
        mode: resolveScaleMode(contract),
    }));
    if (scaleState.code !== contract.code) {
        setScaleState({
            code: contract.code,
            mode: resolveScaleMode(contract),
        });
    }
    const scaleMode = scaleState.mode;
    const scaleModeRef = useRef(scaleMode);
    scaleModeRef.current = scaleMode;
    const pickScaleMode = (m: ScaleMode) => {
        setScaleState({ code: contract.code, mode: m });
        const mem = loadScaleMem();
        mem.perCode[contract.code] = { m, c: scaleCatOf(contract) };
        saveScaleMem(mem);
    };
    const applyScaleToCat = () => {
        const cat = scaleCatOf(contract);
        const mem = loadScaleMem();
        mem.catDefault[cat] = scaleMode;
        mem.perCode = Object.fromEntries(
            Object.entries(mem.perCode).filter(([, v]) => v.c !== cat),
        );
        saveScaleMem(mem);
    };
    const applyScaleToAll = () => {
        saveScaleMem({
            perCode: {},
            catDefault: { index: scaleMode, equity: scaleMode },
        });
    };
    const resetScaleMem = () => {
        try {
            localStorage.removeItem(SCALE_MEM_KEY);
        } catch {
            // ignore
        }
        setScaleState({
            code: contract.code,
            mode: resolveScaleMode(contract),
        });
    };
    const [chartStyle, setChartStyle] = useState<ChartStyle>(loadChartStyle);
    const pickChartStyle = (s: ChartStyle) => {
        setChartStyle(s);
        try {
            localStorage.setItem(CHART_STYLE_KEY, s);
        } catch {
            // session only
        }
    };
    const [volMode, setVolMode] = useState<VolMode>(loadVolMode);
    const pickVolMode = (m: VolMode) => {
        setVolMode(m);
        try {
            localStorage.setItem(VOL_MODE_KEY, m);
        } catch {
            // session only
        }
    };
    const [lineWidth, setLineWidth] = useState<number>(loadLineWidth);
    const pickLineWidth = (w: number) => {
        setLineWidth(w);
        try {
            localStorage.setItem(LINE_WIDTH_KEY, String(w));
        } catch {
            // session only
        }
    };
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [legendItems, setLegendItems] =
        useState<LegendItems>(loadLegendItems);
    const toggleLegendItem = (k: keyof LegendItems) => {
        setLegendItems((prev) => {
            const next = { ...prev, [k]: !prev[k] };
            try {
                localStorage.setItem(
                    LEGEND_ITEMS_KEY,
                    JSON.stringify(next),
                );
            } catch {
                // session only
            }
            return next;
        });
    };
    const [, setLegendSeq] = useState(0);
    const legendRafRef = useRef(false);
    const bumpLegend = () => {
        if (legendRafRef.current) return;
        legendRafRef.current = true;
        requestAnimationFrame(() => {
            legendRafRef.current = false;
            setLegendSeq((v) => v + 1);
        });
    };
    const bumpLegendRef = useRef(bumpLegend);
    bumpLegendRef.current = bumpLegend;

    const quote = useQuote(contract.code);
    const themeSettings = useThemeSettings();
    const colors = getChartColors(themeSettings);
    const themeKey = `${themeSettings.mode}-${themeSettings.convention}`;
    // 顯示設定的組合鍵 — load effect 與 live guard 必須用同一份。
    // 線寬不進 key：滑桿拖動連發，不能每步都整段重載
    const optsKey = `${themeKey}|${scaleMode}|${chartStyle}|${volMode}`;
    const isIndex = contract.security_type === 'IND';
    const avgColor = themeSettings.mode === 'light' ? '#b97f14' : '#e0a43c';

    // ---- chart lifecycle（theme 換色重建 — 便宜且罕見）----
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        const c = colors;
        const chart = createChart(host, {
            layout: {
                background: { type: ColorType.Solid, color: 'transparent' },
                textColor: c.text,
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 10,
                attributionLogo: false,
                panes: {
                    separatorColor: c.border,
                    separatorHoverColor: colorWithOpacity(c.crosshair, 15),
                    enableResize: true,
                },
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
            // 上下緣收緊讓停板線貼邊（量能已拆到獨立 pane）。
            // 左右兩軸 margins 必須相同，% 與價格刻度才會對齊
            rightPriceScale: {
                borderColor: c.border,
                scaleMargins: { top: 0.05, bottom: 0.05 },
            },
            leftPriceScale: {
                visible: true,
                borderColor: c.border,
                scaleMargins: { top: 0.05, bottom: 0.05 },
            },
            timeScale: {
                borderColor: c.border,
                timeVisible: true,
                secondsVisible: false,
                rightOffset: 0,
                lockVisibleTimeRangeOnResize: true,
                // 夜盤 14 小時 = 840 根 1 分 bar — 預設 minBarSpacing 0.5px
                // 會讓 fitContent 塞不進窄面板而截斷時段軸
                minBarSpacing: 0.01,
            },
            // 走勢圖是固定時間框 — 不捲動不縮放
            handleScroll: false,
            handleScale: false,
            autoSize: true,
        });

        // 以參考價上下對稱縮放，紅綠振幅視覺上可比（經典走勢圖比例）。
        // 範圍取自 session 真實高低（liveRef）而非序列資料 — 線圖模式
        // 只畫 close，若按序列資料縮放會把盤中高低截掉
        const symmetric = (
            original: () => AutoscaleInfo | null,
        ): AutoscaleInfo | null => {
            const lim = limitsRef.current;
            // 漲跌停模式：軸固定整段區間貼齊停板，行情多小都看得到全幅
            if (scaleModeRef.current === 'band' && lim) {
                return {
                    priceRange: {
                        minValue: lim.down,
                        maxValue: lim.up,
                    },
                };
            }
            const ref = refPriceRef.current;
            const live = liveRef.current;
            if (!ref || !live) return original();
            const span = Math.max(
                live.high - ref,
                ref - live.low,
                ref * 0.002,
            );
            let pad = span * 1.08;
            // 撐到漲跌停就到頂 — 鎖漲停時軸貼齊停板而不是繼續外擴
            if (lim) {
                pad = Math.min(
                    pad,
                    Math.max(lim.up - ref, ref - lim.down),
                );
            }
            return {
                priceRange: {
                    minValue: ref - pad,
                    maxValue: ref + pad,
                },
            };
        };

        const price = chart.addSeries(BaselineSeries, {
            baseValue: { type: 'price', price: refPriceRef.current },
            topLineColor: c.up,
            topFillColor1: colorWithOpacity(c.up, 20),
            topFillColor2: colorWithOpacity(c.up, 2),
            bottomLineColor: c.down,
            bottomFillColor1: colorWithOpacity(c.down, 2),
            bottomFillColor2: colorWithOpacity(c.down, 20),
            lineWidth: 2,
            priceLineVisible: false,
            autoscaleInfoProvider: symmetric,
        });
        // 美國線（每分鐘 OHLC）— 與分時線互斥顯示，資料同步餵兩邊
        const bars = chart.addSeries(BarSeries, {
            upColor: c.up,
            downColor: c.down,
            thinBars: false,
            openVisible: true,
            priceLineVisible: false,
            autoscaleInfoProvider: symmetric,
            visible: false,
        });
        // 左軸 ±% — 鏡射收盤值的隱形序列，帶自訂 % formatter
        const pct = chart.addSeries(LineSeries, {
            priceScaleId: 'left',
            color: 'transparent',
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            autoscaleInfoProvider: symmetric,
            priceFormat: {
                type: 'custom',
                minMove: 0.01,
                formatter: (p: number) => {
                    const ref = refPriceRef.current;
                    if (!ref) return '';
                    return `${(((p - ref) / ref) * 100).toFixed(2)}%`;
                },
            },
        });
        const avg = chart.addSeries(LineSeries, {
            color: avgColor,
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            // 均價恆在高低之間 — 不參與縮放，否則原生 autoscale 會跟
            // symmetric provider 的範圍做聯集，把軸撐歪
            autoscaleInfoProvider: () => null,
        });
        // 量能放獨立 pane — 右軸才有量的刻度，主圖 % 軸也不會
        // 延伸進量能區（priceFormat 依商品在 load 時套用）
        const vol = chart.addSeries(
            HistogramSeries,
            {
                priceFormat: { type: 'volume' },
                priceLineVisible: false,
                lastValueVisible: false,
            },
            1,
        );
        vol.priceScale().applyOptions({
            scaleMargins: { top: 0.15, bottom: 0 },
        });
        const panes = chart.panes();
        panes[0]?.setStretchFactor(78);
        panes[1]?.setStretchFactor(22);
        // 只負責把時間軸撐滿整個交易時段的 whitespace 序列
        const filler = chart.addSeries(LineSeries, {
            color: 'transparent',
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            autoscaleInfoProvider: () => null,
        });
        // 參考線/停板線掛在常駐的 filler 序列上 — 掛在 price/bars 上
        // 的話，切換樣式把序列隱藏時線也會跟著消失
        refLineRef.current = filler.createPriceLine({
            price: refPriceRef.current,
            color: c.text,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: false,
        });

        chart.subscribeCrosshairMove((param) => {
            if (!param.point || !param.time) {
                if (hoverRef.current) {
                    hoverRef.current = null;
                    bumpLegendRef.current();
                }
                return;
            }
            const lineDatum = param.seriesData.get(price) as
                | { value?: number }
                | undefined;
            const barDatum = param.seriesData.get(bars) as
                | { close?: number }
                | undefined;
            const p = { value: lineDatum?.value ?? barDatum?.close };
            if (typeof p.value !== 'number') {
                if (hoverRef.current) {
                    hoverRef.current = null;
                    bumpLegendRef.current();
                }
                return;
            }
            const a = param.seriesData.get(avg) as
                | { value?: number }
                | undefined;
            const v = param.seriesData.get(vol) as
                | { value?: number }
                | undefined;
            const live = liveRef.current;
            hoverRef.current = {
                time: param.time as number,
                price: p.value,
                avg: typeof a?.value === 'number' ? a.value : null,
                high: live?.high ?? p.value,
                low: live?.low ?? p.value,
                total: v?.value ?? 0,
            };
            bumpLegendRef.current();
        });

        chartRef.current = chart;
        priceSeriesRef.current = price;
        barSeriesRef.current = bars;
        pctSeriesRef.current = pct;
        avgSeriesRef.current = avg;
        volSeriesRef.current = vol;
        fillerSeriesRef.current = filler;
        return () => {
            chart.remove();
            chartRef.current = null;
            priceSeriesRef.current = null;
            barSeriesRef.current = null;
            pctSeriesRef.current = null;
            avgSeriesRef.current = null;
            volSeriesRef.current = null;
            fillerSeriesRef.current = null;
            refLineRef.current = null;
            // price lines die with the chart — drop the stale handles so
            // the next load doesn't try to remove them from a new series
            limitLinesRef.current = [];
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [themeKey]);

    const applyRefPrice = (ref: number) => {
        if (!Number.isFinite(ref) || ref <= 0) return;
        if (Math.abs(ref - refPriceRef.current) < 1e-9) return;
        refPriceRef.current = ref;
        priceSeriesRef.current?.applyOptions({
            baseValue: { type: 'price', price: ref },
        });
        refLineRef.current?.applyOptions({ price: ref });
    };

    // ---- history load: pick the last session present in the data ----
    useEffect(() => {
        const loadKey = `${contract.code}|${reloadSeq}|${optsKey}`;
        loadedKeyRef.current = '';
        sessionRef.current = null;
        liveRef.current = null;
        simRef.current = null;
        hoverRef.current = null;
        lastLabelRef.current = 0;
        minuteVolRef.current = 0;
        prevMinCloseRef.current = 0;
        cumVRef.current = 0;
        cumPVRef.current = 0;
        refPriceRef.current = 0;
        limitsRef.current = null;
        minOhlcRef.current = null;
        for (const line of limitLinesRef.current) {
            fillerSeriesRef.current?.removePriceLine(line);
        }
        limitLinesRef.current = [];
        // 換商品：清掉前一檔殘影 — 載入（或載入卡住）期間不能繼續
        // 掛著別檔的走勢；同商品的設定/主題重載不清，切換才不閃
        if (drawnCodeRef.current !== contract.code) {
            drawnCodeRef.current = contract.code;
            pendingWinRef.current = null;
            priceSeriesRef.current?.setData([]);
            barSeriesRef.current?.setData([]);
            pctSeriesRef.current?.setData([]);
            avgSeriesRef.current?.setData([]);
            volSeriesRef.current?.setData([]);
            fillerSeriesRef.current?.setData([]);
        }
        // 樣式切換：line=分時線；bars=美國線疊在透明漸層上（baseline
        // 線色轉透明、保留填色，讓美國線下方也有紅綠漸層）
        priceSeriesRef.current?.applyOptions({
            visible: true,
            topLineColor: chartStyle === 'line' ? colors.up : 'transparent',
            bottomLineColor:
                chartStyle === 'line' ? colors.down : 'transparent',
            lastValueVisible: chartStyle === 'line',
            crosshairMarkerVisible: chartStyle === 'line',
        });
        barSeriesRef.current?.applyOptions({
            visible: chartStyle === 'bars',
        });
        // 量能顯示：pane=獨立分欄含 Y 軸；overlay=疊回主圖下緣無獨立軸
        const vs = volSeriesRef.current;
        if (vs) {
            vs.moveToPane(volMode === 'pane' ? 1 : 0);
            vs.applyOptions({
                priceScaleId: volMode === 'pane' ? 'right' : 'vol',
            });
            if (volMode === 'pane') {
                vs.priceScale().applyOptions({
                    scaleMargins: { top: 0.15, bottom: 0 },
                });
                const panes = chartRef.current?.panes();
                panes?.[0]?.setStretchFactor(78);
                panes?.[1]?.setStretchFactor(22);
            } else {
                chartRef.current?.priceScale('vol').applyOptions({
                    scaleMargins: { top: 0.78, bottom: 0 },
                });
            }
        }
        // 上下 margins 永遠等距 — ±% 才對稱（疊圖量能一律畫在價格區
        // 下緣「內」，不另開空間打破比例）。左右兩軸 margins 必須同
        // 步，% 與價格刻度才對齊
        const smPad = scaleMode === 'band' ? 0.015 : 0.05;
        const sm = { top: smPad, bottom: smPad };
        chartRef.current?.priceScale('right').applyOptions({
            scaleMargins: sm,
        });
        chartRef.current?.priceScale('left').applyOptions({
            scaleMargins: sm,
        });
        // 量能軸刻度：股/期=口數張數（K/M 縮寫）、指數=成交額（億）
        volSeriesRef.current?.applyOptions({
            priceFormat: isIndex
                ? {
                      type: 'custom',
                      minMove: 1,
                      formatter: (v: number) =>
                          `${(v / 1e8).toFixed(v >= 1e9 ? 0 : v >= 1e8 ? 1 : 2)}億`,
                  }
                : { type: 'volume' },
        });
        setLoading(true);
        setEmpty(false);
        let cancelled = false;
        // 歷史拿不到（server 掛/上游未發布/冷門新掛牌）不能讓面板卡在
        // 空白＋spinner：直接把「空的時段框架」開好 — 參考價/停板/時段
        // 軸都來自 contract 與現在時間，並讓 loadedKey 成立，live tick
        // 立刻開始作畫；歷史由排程重試補回後整段覆蓋
        const scaffoldEmptyFrame = () => {
            if (!priceSeriesRef.current || !fillerSeriesRef.current) return;
            const ref = Number(contract.reference);
            if (!Number.isFinite(ref) || ref <= 0) return;
            const pend =
                pendingWinRef.current?.code === contract.code
                    ? pendingWinRef.current.start
                    : 0;
            const win = sessionWindowFor(
                contract.security_type,
                pend > 0 ? pend + 60 : nowWallClockUtc(),
            );
            applyRefPrice(ref);
            const minutes = sessionMinutes(win);
            fillerSeriesRef.current.setData(
                minutes.map((m, i) =>
                    i === 0 || i === minutes.length - 1
                        ? { time: m as UTCTimestamp, value: ref }
                        : { time: m as UTCTimestamp },
                ),
            );
            const lu = Number(contract.limit_up);
            const ld = Number(contract.limit_down);
            if (Number.isFinite(lu) && Number.isFinite(ld) && lu > ld && ld > 0) {
                limitsRef.current = { up: lu, down: ld };
                if (scaleMode === 'band') {
                    limitLinesRef.current = [
                        fillerSeriesRef.current.createPriceLine({
                            price: lu,
                            color: colors.up,
                            lineWidth: 1,
                            lineStyle: LineStyle.Dotted,
                            axisLabelVisible: true,
                        }),
                        fillerSeriesRef.current.createPriceLine({
                            price: ld,
                            color: colors.down,
                            lineWidth: 1,
                            lineStyle: LineStyle.Dotted,
                            axisLabelVisible: true,
                        }),
                    ];
                }
            }
            sessionRef.current = win;
            loadedKeyRef.current = loadKey;
            chartRef.current?.timeScale().fitContent();
        };
        // range covers weekends/holidays and夜盤掛次日檔期的怪癖
        fetchKbars(contract, dateStrOffset(4), dateStrOffset(-1))
            .then((k) => {
                if (cancelled || !priceSeriesRef.current) return;
                const all = kbarsToMinBars(k);
                const last = all[all.length - 1];
                const pend =
                    pendingWinRef.current?.code === contract.code
                        ? pendingWinRef.current.start
                        : 0;
                if (!last && !pend) {
                    // 零 kbars — 開空框架讓 live 直接畫，60s 後補歷史
                    scaffoldEmptyFrame();
                    setEmpty(true);
                    retryTimerRef.current = window.setTimeout(
                        () => setReloadSeq((v) => v + 1),
                        60_000,
                    );
                    return;
                }
                // 資料驅動選時段；但換時段重載帶著目標時段時（試搓/
                // 開盤，新時段 kbar 還沒出）目標較新就用目標 — 畫出
                // 空的新時段框架等第一筆成交
                let win = sessionWindowFor(
                    contract.security_type,
                    last ? last.time : pend + 60,
                );
                if (pend > win.start) {
                    win = sessionWindowFor(contract.security_type, pend + 60);
                }
                const bars = all.filter(
                    (b) =>
                        b.time > win.start &&
                        b.time <= win.end + CLOSE_GRACE,
                );
                for (let i = bars.length - 1; i >= 0; i--) {
                    const b = bars[i]!;
                    if (b.time <= win.end) break;
                    b.time = win.end;
                }
                for (let i = 1; i < bars.length; i++) {
                    const prev = bars[i - 1]!;
                    const b = bars[i]!;
                    if (b.time === prev.time) {
                        prev.close = b.close;
                        prev.high = Math.max(prev.high, b.high);
                        prev.low = Math.min(prev.low, b.low);
                        prev.vol += b.vol;
                        prev.amt += b.amt;
                        bars.splice(i, 1);
                        i--;
                    }
                }
                const ref =
                    Number(contract.reference) ||
                    bars[0]?.close ||
                    last?.close ||
                    0;
                if (!Number.isFinite(ref) || ref <= 0) {
                    // 沒參考價也沒任何 bar（極端）— 空狀態等下次重載
                    setEmpty(true);
                    return;
                }
                applyRefPrice(ref);

                let cumV = 0;
                let cumPV = 0;
                let hi = -Infinity;
                let lo = Infinity;
                let totAmt = 0;
                const lineData = [];
                const ohlcData = [];
                const avgData = [];
                const volData = [];
                let prevClose = ref;
                for (const b of bars) {
                    const size = isIndex ? b.amt || b.vol : b.vol;
                    cumV += b.vol;
                    cumPV += ((b.high + b.low + b.close) / 3) * b.vol;
                    totAmt += b.amt;
                    hi = Math.max(hi, b.high);
                    lo = Math.min(lo, b.low);
                    const t = b.time as UTCTimestamp;
                    lineData.push({ time: t, value: b.close });
                    ohlcData.push({
                        time: t,
                        open: b.open,
                        high: b.high,
                        low: b.low,
                        close: b.close,
                    });
                    if (!isIndex && cumV > 0) {
                        avgData.push({ time: t, value: cumPV / cumV });
                    }
                    volData.push({
                        time: t,
                        value: size,
                        color:
                            b.close >= prevClose
                                ? colors.upVol
                                : colors.downVol,
                    });
                    prevClose = b.close;
                }
                priceSeriesRef.current.setData(lineData);
                barSeriesRef.current?.setData(ohlcData);
                pctSeriesRef.current?.setData([...lineData]);
                avgSeriesRef.current?.setData(avgData);
                volSeriesRef.current?.setData(volData);
                // 純 whitespace 序列不會計入時間軸（v5 行為，實測 data()
                // 為空）— 首尾各放一個透明實值點，中間夾 whitespace，
                // 軸才會撐滿整個時段
                const minutes = sessionMinutes(win);
                fillerSeriesRef.current?.setData(
                    minutes.map((m, i) =>
                        i === 0 || i === minutes.length - 1
                            ? { time: m as UTCTimestamp, value: ref }
                            : { time: m as UTCTimestamp },
                    ),
                );
                // 漲跌停：Y 軸 cap 兩種模式都用；界線只在停板模式畫
                // （指數等無停板商品 limit 為 0 → 略過）
                const lu = Number(contract.limit_up);
                const ld = Number(contract.limit_down);
                if (Number.isFinite(lu) && Number.isFinite(ld) && lu > ld && ld > 0) {
                    limitsRef.current = { up: lu, down: ld };
                }
                const filler = fillerSeriesRef.current;
                if (limitsRef.current && scaleMode === 'band' && filler) {
                    limitLinesRef.current = [
                        filler.createPriceLine({
                            price: lu,
                            color: colors.up,
                            lineWidth: 1,
                            lineStyle: LineStyle.Dotted,
                            axisLabelVisible: true,
                        }),
                        filler.createPriceLine({
                            price: ld,
                            color: colors.down,
                            lineWidth: 1,
                            lineStyle: LineStyle.Dotted,
                            axisLabelVisible: true,
                        }),
                    ];
                }
                sessionRef.current = win;
                const lastBar = bars[bars.length - 1];
                if (lastBar) {
                    lastLabelRef.current = lastBar.time;
                    minuteVolRef.current = isIndex
                        ? lastBar.amt || lastBar.vol
                        : lastBar.vol;
                    minOhlcRef.current = {
                        open: lastBar.open,
                        high: lastBar.high,
                        low: lastBar.low,
                        close: lastBar.close,
                    };
                    prevMinCloseRef.current =
                        bars[bars.length - 2]?.close ?? ref;
                    liveRef.current = {
                        price: lastBar.close,
                        avg: !isIndex && cumV > 0 ? cumPV / cumV : null,
                        high: hi,
                        low: lo,
                        total: isIndex ? totAmt : cumV,
                    };
                } else {
                    setEmpty(true);
                }
                cumVRef.current = cumV;
                cumPVRef.current = cumPV;
                loadedKeyRef.current = loadKey;
                chartRef.current?.timeScale().fitContent();
                bumpLegendRef.current();
            })
            .catch(() => {
                if (cancelled) return;
                // kbars 連重試都失敗（server 掛/開盤壅塞）— 開空框架
                // 讓 live tick 從現在開始畫，歷史 15s 後重試補回
                scaffoldEmptyFrame();
                setEmpty(true);
                retryTimerRef.current = window.setTimeout(
                    () => setReloadSeq((v) => v + 1),
                    15_000,
                );
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
            window.clearTimeout(retryTimerRef.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [contract, reloadSeq, optsKey]);

    // 線寬即時套用 — 獨立於資料載入，滑桿拖動不觸發 refetch。
    // optsKey 在 deps 裡是為了主題重建 chart 後把寬度補回去
    useEffect(() => {
        priceSeriesRef.current?.applyOptions({
            lineWidth: lineWidth as unknown as 1 | 2 | 3 | 4,
        });
    }, [lineWidth, optsKey]);

    // ---- live tick / index quote -> extend the current minute ----
    const liveQuote = quote?.tick ?? quote?.index;
    useEffect(() => {
        if (!liveQuote || liveQuote.code !== contract.code) return;
        if (
            loadedKeyRef.current !==
            `${contract.code}|${reloadSeq}|${optsKey}`
        ) {
            return;
        }
        const win = sessionRef.current;
        const series = priceSeriesRef.current;
        if (!win || !series) return;
        const t = wallClockToUtc(`${liveQuote.date}T${liveQuote.time}`);
        const stale = lastLabelRef.current;
        const throttledReload = () => {
            if (Date.now() - lastReloadRef.current > 30_000) {
                lastReloadRef.current = Date.now();
                setReloadSeq((v) => v + 1);
            }
        };
        // 收盤 grace 之外的 tick：真的換時段（夜→日、日→夜、隔日開盤）
        // 才整段重載 — 試搓 tick 也算數：08:30 第一筆試搓就切到新時段
        // 框架，不必等正式開盤首筆成交。同時段的盤後零星成交（股票
        // 定盤 14:30）只丟棄，否則每筆都會白打一次 kbars
        if (t > win.end + CLOSE_GRACE) {
            const next = sessionWindowFor(contract.security_type, t);
            if (next.start !== win.start) {
                pendingWinRef.current = {
                    code: contract.code,
                    start: next.start,
                };
                throttledReload();
            }
            return;
        }
        // 試撮揭示價可以是天地價，畫進走勢會撐爆比例 — 只允許觸發
        // 上面的換時段與 legend 的「試搓」讀值，不入圖、不進 gap 判斷
        if ('simtrade' in liveQuote && liveQuote.simtrade) {
            const sp = Number(liveQuote.close);
            if (Number.isFinite(sp) && sp > 0) {
                const sc = Number(quote?.tick?.price_chg);
                simRef.current = {
                    price: sp,
                    chg: Number.isFinite(sc) ? sc : undefined,
                };
                bumpLegendRef.current();
            }
            return;
        }
        const p = Number(liveQuote.close);
        if (!Number.isFinite(p) || p <= 0) return;
        // 斷圖 >3 分鐘：僅在 total_volume 顯示真有漏量（睡醒/斷線補洞）
        // 時重載 — 冷門股每隔幾分鐘一筆成交是常態，不該筆筆重載
        if (stale > 0 && tickBucket(win, t) > stale + 180) {
            const missedVolume =
                !quote?.tick ||
                (quote.tick.total_volume ?? 0) >
                    cumVRef.current + (quote.tick.volume ?? 0);
            if (missedVolume) {
                throttledReload();
                return;
            }
        }
        if (t <= win.start) return;
        const label = tickBucket(win, t);
        if (label < lastLabelRef.current) return; // out-of-order tick
        if (simRef.current) simRef.current = null; // 開盤了 — 試搓讀值退場

        // tick 才帶 price_chg — 用它回推最新參考價（比合約快取新鮮）
        const chg = Number(quote?.tick?.price_chg);
        if (quote?.tick && Number.isFinite(chg)) {
            applyRefPrice(p - chg);
        } else if (quote?.index) {
            applyRefPrice(Number(quote.index.reference));
        }
        const ref = refPriceRef.current;

        const vol = quote?.tick?.volume ?? 0;
        const size = isIndex ? Number(quote?.index?.amount ?? 0) : vol;
        if (label > lastLabelRef.current) {
            prevMinCloseRef.current = liveRef.current?.price ?? ref;
            lastLabelRef.current = label;
            minuteVolRef.current = size;
            minOhlcRef.current = { open: p, high: p, low: p, close: p };
        } else {
            minuteVolRef.current += size;
            const m = minOhlcRef.current;
            if (m) {
                m.high = Math.max(m.high, p);
                m.low = Math.min(m.low, p);
                m.close = p;
            } else {
                minOhlcRef.current = {
                    open: p,
                    high: p,
                    low: p,
                    close: p,
                };
            }
        }
        cumVRef.current += vol;
        cumPVRef.current += p * vol;

        const tickAvg = Number(quote?.tick?.avg_price);
        const avg = isIndex
            ? null
            : Number.isFinite(tickAvg) && tickAvg > 0
              ? tickAvg
              : cumVRef.current > 0
                ? cumPVRef.current / cumVRef.current
                : null;
        const totalVol = Math.max(
            cumVRef.current,
            quote?.tick?.total_volume ?? 0,
        );
        const total = isIndex
            ? Number(quote?.index?.amount_sum ?? 0)
            : totalVol;
        const prev = liveRef.current;
        liveRef.current = {
            price: p,
            avg,
            high: Math.max(prev?.high ?? -Infinity, p),
            low: Math.min(prev?.low ?? Infinity, p),
            total: Math.max(prev?.total ?? 0, total),
        };

        const time = label as UTCTimestamp;
        try {
            series.update({ time, value: p });
            const ohlc = minOhlcRef.current;
            if (ohlc) {
                barSeriesRef.current?.update({ time, ...ohlc });
            }
            pctSeriesRef.current?.update({ time, value: p });
            if (avg !== null) {
                avgSeriesRef.current?.update({ time, value: avg });
            }
            volSeriesRef.current?.update({
                time,
                value: minuteVolRef.current,
                color:
                    p >= prevMinCloseRef.current
                        ? colors.upVol
                        : colors.downVol,
            });
        } catch {
            // series torn down mid-update (symbol/theme switch) — ignore
        }
        // 空時段框架（試搓切換後等開盤）收到第一筆成交 → 清空狀態
        // chip；同值 setState React 會 bail out，逐筆呼叫無代價
        setEmpty(false);
        bumpLegendRef.current();
        // NOTE: 依賴 liveQuote 物件本身而非 quote.seq — seq 在 bidask 更新
        // 也會跳，若當 dep 會把同一筆 tick 的量重複累加
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [liveQuote, contract.code]);

    // ---- legend ----
    const win = sessionRef.current;
    const live = liveRef.current;
    const hover = hoverRef.current;
    const refPrice = refPriceRef.current;
    const sim = simRef.current;
    const simPct =
        sim?.chg !== undefined && sim.price - sim.chg > 0
            ? (sim.chg / (sim.price - sim.chg)) * 100
            : undefined;
    const shownPrice = hover?.price ?? live?.price;
    const dir =
        shownPrice === undefined || !refPrice || shownPrice === refPrice
            ? 'flat'
            : shownPrice > refPrice
              ? 'up'
              : 'down';
    const chg = shownPrice !== undefined ? shownPrice - refPrice : undefined;
    const chgPct =
        chg !== undefined && refPrice ? (chg / refPrice) * 100 : undefined;
    const shownAvg = hover ? hover.avg : live?.avg;
    // 量欄位恆為累計總量 — hover 的該分鐘單量另外放在最前面的 chip
    const shownTotal = live?.total;
    const sessionLabel =
        win &&
        (contract.security_type === 'FUT' || contract.security_type === 'OPT')
            ? win.night
                ? '夜盤'
                : '日盤'
            : null;
    // 顯示的不是今天的時段（週末/收盤後看盤）→ 標日期提示。
    // 夜盤跨午夜：起訖任一落在今天都算「今天的時段」，否則週二凌晨
    // 正在交易的夜盤會被誤標成昨天的舊資料
    const taiwanNow = new Date(Date.now() + 8 * 3600 * 1000);
    const sameTwDay = (d: Date) =>
        d.getUTCFullYear() === taiwanNow.getUTCFullYear() &&
        d.getUTCMonth() === taiwanNow.getUTCMonth() &&
        d.getUTCDate() === taiwanNow.getUTCDate();
    const sessionDate = win
        ? new Date((win.night ? win.start : win.end) * 1000)
        : null;
    const staleDate =
        win &&
        sessionDate &&
        !sameTwDay(new Date(win.start * 1000)) &&
        !sameTwDay(new Date(win.end * 1000))
            ? `${String(sessionDate.getUTCMonth() + 1).padStart(2, '0')}/${String(
                  sessionDate.getUTCDate(),
              ).padStart(2, '0')}`
            : null;
    // 鎖漲停/跌停 → 現價亮燈（停板色底）
    const hasLimits =
        contract.limit_up > contract.limit_down && contract.limit_down > 0;
    const locked =
        shownPrice !== undefined && hasLimits
            ? shownPrice >= contract.limit_up
                ? ('up' as const)
                : shownPrice <= contract.limit_down
                  ? ('down' as const)
                  : null
            : null;

    return (
        <div className={styles.wrap}>
            <div className={styles.legend}>
                <span className={styles.stats}>
                {(sessionLabel || staleDate) && (
                    <span className={styles.sessionChip}>
                        {staleDate ? `${staleDate} ` : ''}
                        {sessionLabel ?? '日盤'}
                    </span>
                )}
                {sim && (
                    <span className={styles.simChip}>
                        試搓 {fmtPrice(sim.price)}
                        {simPct !== undefined
                            ? ` ${simPct > 0 ? '+' : ''}${simPct.toFixed(2)}%`
                            : ''}
                    </span>
                )}
                <span
                    className={
                        locked
                            ? styles.lockPrice[locked]
                            : `${styles.price} ${panel.dirText[dir]}`
                    }
                >
                    {shownPrice !== undefined ? fmtPrice(shownPrice) : '—'}
                </span>
                <span className={panel.dirText[dir]}>
                    {chg !== undefined
                        ? `${chg > 0 ? '+' : ''}${fmtPrice(chg)}`
                        : ''}
                    {chgPct !== undefined
                        ? ` (${chgPct > 0 ? '+' : ''}${chgPct.toFixed(2)}%)`
                        : ''}
                </span>
                {!isIndex && legendItems.avg && (
                    <span className={styles.kv}>
                        均{' '}
                        <span className={styles.avgVal}>
                            {shownAvg != null ? fmtPrice(shownAvg) : '—'}
                        </span>
                    </span>
                )}
                {legendItems.hilo && (
                    <span className={styles.kv}>
                        高{' '}
                        <span className={panel.dirText.up}>
                            {live ? fmtPrice(live.high) : '—'}
                        </span>{' '}
                        低{' '}
                        <span className={panel.dirText.down}>
                            {live ? fmtPrice(live.low) : '—'}
                        </span>
                    </span>
                )}
                {legendItems.total && (
                    <span className={styles.kv}>
                        {isIndex ? '額 ' : '量 '}
                        <span className={styles.kvVal}>
                            {shownTotal !== undefined
                                ? isIndex
                                    ? fmtAmtYi(shownTotal)
                                    : fmtVol(shownTotal)
                                : '—'}
                        </span>
                    </span>
                )}
                </span>
                <span className={styles.toggles}>
                    <span className={styles.settingsWrap}>
                        <button
                            className={styles.scaleBtn.normal}
                            style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                            }}
                            title='顯示設定（樣式/Y 軸/量能/線寬）'
                            onClick={() => setSettingsOpen((v) => !v)}
                        >
                            <Settings2 size={12} />
                        </button>
                        {settingsOpen && (
                            <>
                                <span
                                    className={styles.settingsBackdrop}
                                    onClick={() => setSettingsOpen(false)}
                                />
                                <span className={styles.settingsPop}>
                                    <span className={styles.settingsRow}>
                                        <span
                                            className={styles.settingsLabel}
                                        >
                                            樣式
                                        </span>
                                        <button
                                            className={
                                                styles.scaleBtn[
                                                    chartStyle === 'line'
                                                        ? 'active'
                                                        : 'normal'
                                                ]
                                            }
                                            title='收盤價分時線'
                                            onClick={() =>
                                                pickChartStyle('line')
                                            }
                                        >
                                            線圖
                                        </button>
                                        <button
                                            className={
                                                styles.scaleBtn[
                                                    chartStyle === 'bars'
                                                        ? 'active'
                                                        : 'normal'
                                                ]
                                            }
                                            title='美國線 — 每分鐘開高低收，高低點不失真'
                                            onClick={() =>
                                                pickChartStyle('bars')
                                            }
                                        >
                                            美國線
                                        </button>
                                    </span>
                                    {contract.limit_up >
                                        contract.limit_down &&
                                        contract.limit_down > 0 && (
                                            <span
                                                className={
                                                    styles.settingsRow
                                                }
                                            >
                                                <span
                                                    className={
                                                        styles.settingsLabel
                                                    }
                                                >
                                                    Y 軸
                                                </span>
                                                <button
                                                    className={
                                                        styles.scaleBtn[
                                                            scaleMode ===
                                                            'auto'
                                                                ? 'active'
                                                                : 'normal'
                                                        ]
                                                    }
                                                    title='Y 軸依當日行情自動縮放'
                                                    onClick={() =>
                                                        pickScaleMode('auto')
                                                    }
                                                >
                                                    自動
                                                </button>
                                                <button
                                                    className={
                                                        styles.scaleBtn[
                                                            scaleMode ===
                                                            'band'
                                                                ? 'active'
                                                                : 'normal'
                                                        ]
                                                    }
                                                    title='Y 軸固定為漲跌停整段區間並標出漲停/跌停線'
                                                    onClick={() =>
                                                        pickScaleMode('band')
                                                    }
                                                >
                                                    漲跌停
                                                </button>
                                            </span>
                                        )}
                                    <span className={styles.settingsRow}>
                                        <span
                                            className={styles.settingsLabel}
                                        >
                                            記憶
                                        </span>
                                        <button
                                            className={styles.scaleBtn.normal}
                                            title={`把目前 Y 軸模式套用到整個${scaleCatOf(contract) === 'equity' ? '個股' : '指數'}類（並清除同類的單檔記憶）`}
                                            onClick={applyScaleToCat}
                                        >
                                            套用同類
                                        </button>
                                        <button
                                            className={styles.scaleBtn.normal}
                                            title='把目前 Y 軸模式套用到所有商品（清除所有單檔記憶）'
                                            onClick={applyScaleToAll}
                                        >
                                            套用全部
                                        </button>
                                        <button
                                            className={styles.scaleBtn.normal}
                                            title='清空 Y 軸記憶，回到預設（指數=自動、個股=漲跌停）'
                                            onClick={resetScaleMem}
                                        >
                                            重設
                                        </button>
                                    </span>
                                    <span className={styles.settingsRow}>
                                        <span
                                            className={styles.settingsLabel}
                                        >
                                            量能
                                        </span>
                                        <button
                                            className={
                                                styles.scaleBtn[
                                                    volMode === 'overlay'
                                                        ? 'active'
                                                        : 'normal'
                                                ]
                                            }
                                            title='量能疊在主圖下緣，不佔獨立空間'
                                            onClick={() =>
                                                pickVolMode('overlay')
                                            }
                                        >
                                            疊圖
                                        </button>
                                        <button
                                            className={
                                                styles.scaleBtn[
                                                    volMode === 'pane'
                                                        ? 'active'
                                                        : 'normal'
                                                ]
                                            }
                                            title='量能獨立分欄，含自己的 Y 軸刻度'
                                            onClick={() =>
                                                pickVolMode('pane')
                                            }
                                        >
                                            分欄
                                        </button>
                                    </span>
                                    <span className={styles.settingsRow}>
                                        <span
                                            className={styles.settingsLabel}
                                        >
                                            顯示
                                        </span>
                                        {!isIndex && (
                                            <button
                                                className={
                                                    styles.scaleBtn[
                                                        legendItems.avg
                                                            ? 'active'
                                                            : 'normal'
                                                    ]
                                                }
                                                onClick={() =>
                                                    toggleLegendItem('avg')
                                                }
                                            >
                                                均價
                                            </button>
                                        )}
                                        <button
                                            className={
                                                styles.scaleBtn[
                                                    legendItems.hilo
                                                        ? 'active'
                                                        : 'normal'
                                                ]
                                            }
                                            onClick={() =>
                                                toggleLegendItem('hilo')
                                            }
                                        >
                                            高低
                                        </button>
                                        <button
                                            className={
                                                styles.scaleBtn[
                                                    legendItems.total
                                                        ? 'active'
                                                        : 'normal'
                                                ]
                                            }
                                            onClick={() =>
                                                toggleLegendItem('total')
                                            }
                                        >
                                            {isIndex ? '總額' : '總量'}
                                        </button>
                                    </span>
                                    <span className={styles.settingsRow}>
                                        <span
                                            className={styles.settingsLabel}
                                        >
                                            線寬
                                        </span>
                                        <input
                                            type='range'
                                            className={styles.slider}
                                            style={
                                                {
                                                    '--sj-fill': `${(((lineWidth - LINE_WIDTH_MIN) / (LINE_WIDTH_MAX - LINE_WIDTH_MIN)) * 100).toFixed(1)}%`,
                                                } as React.CSSProperties
                                            }
                                            min={LINE_WIDTH_MIN}
                                            max={LINE_WIDTH_MAX}
                                            step={0.5}
                                            value={lineWidth}
                                            onChange={(e) =>
                                                pickLineWidth(
                                                    Number(e.target.value),
                                                )
                                            }
                                        />
                                        <span
                                            className={styles.widthPreview}
                                            style={{
                                                height: `${lineWidth}px`,
                                            }}
                                        />
                                        <span className={styles.sliderVal}>
                                            {lineWidth.toFixed(1)}
                                        </span>
                                    </span>
                                </span>
                            </>
                        )}
                    </span>
                </span>
            </div>
            <div className={styles.chartHost}>
                <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
                {hover && (
                    <span className={styles.hoverFloat}>
                        {fmtClock(hover.time)}{' '}
                        {isIndex
                            ? fmtAmtYi(hover.total)
                            : `${fmtVol(hover.total)}${
                                  contract.security_type === 'FUT' ||
                                  contract.security_type === 'OPT'
                                      ? '口'
                                      : '張'
                              }`}
                    </span>
                )}
                {loading && (
                    <div className={styles.emptyMsg}>
                        <Orb
                            size={12}
                            style={{
                                marginRight: 6,
                                verticalAlign: '-2px',
                            }}
                        />
                        <span className={panel.mono}>載入走勢中…</span>
                    </div>
                )}
                {empty && !loading && (
                    <div className={styles.emptyMsg}>
                        <span className={panel.mono}>本時段尚無成交資料</span>
                    </div>
                )}
            </div>
        </div>
    );
}

// HMR 對 imperative 的 chart 生命週期清不乾淨 — 熱更新會疊出第二個
// chart（幽靈停板線/分隔線壓軸）。此模組一變更就強制整頁重載。
if (import.meta.hot) {
    import.meta.hot.accept(() => {
        import.meta.hot?.invalidate();
    });
}
