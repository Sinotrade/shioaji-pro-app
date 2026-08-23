// src/lib/indicator-defs.ts — indicator registry, instances, persistence.
// Each definition declares its params, output series (with render hints)
// and a compute() over candles; candle-chart renders overlays on the main
// pane and gives every oscillator instance its own sub-pane.

import {
    atr,
    bias,
    bollinger,
    cci,
    dmi,
    donchian,
    ema,
    keltner,
    macd,
    mfi,
    obv,
    roc,
    rsi,
    sar,
    sma,
    stoch,
    stochRsi,
    supertrend,
    vwap,
    willr,
    wma,
    type IndicatorPoint,
} from './indicators';
import type { Candle } from './types/market';

export type OutputKind = 'line' | 'dashed' | 'histogram' | 'points' | 'band';

export interface ParamDef {
    key: string;
    label: string;
    def: number;
    min: number;
    max: number;
    step?: number;
}

export interface OutputDef {
    key: string;
    label: string;
    kind: OutputKind;
    color: string; // default color
    width?: 1 | 2;
    // histogram only: color positive/negative halves with up/down colors
    signed?: boolean;
    // band only: 上下緣線型（預設 solid）。band 輸出的下緣序列放在
    // compute 回傳的 `<key>_lo`，不另立 OutputDef。
    border?: 'solid' | 'dashed';
}

export interface IndicatorDef {
    type: string;
    label: string; // list label, e.g. "MA 移動平均"
    short: string; // legend label, e.g. "MA"
    desc: string; // one-line description shown in the picker
    aliases: string[]; // extra search keywords（中英文）
    category: 'overlay' | 'pane';
    params: ParamDef[];
    outputs: OutputDef[];
    // horizontal reference levels drawn in the sub-pane (e.g. RSI 30/70)
    levels?: number[];
    compute: (
        bars: Candle[],
        p: Record<string, number>,
    ) => Record<string, IndicatorPoint[]>;
}

export const INDICATOR_DEFS: IndicatorDef[] = [
    // ---- 主圖疊加 ----
    {
        type: 'sma',
        label: 'MA 移動平均',
        short: 'MA',
        desc: '簡單移動平均線，最常用的趨勢基準',
        aliases: ['ma', 'sma', 'moving average', '均線', '移動平均'],
        category: 'overlay',
        params: [{ key: 'period', label: '週期', def: 20, min: 1, max: 500 }],
        outputs: [{ key: 'line', label: 'MA', kind: 'line', color: '#e0a43c' }],
        compute: (b, p) => ({ line: sma(b, p.period!) }),
    },
    {
        type: 'ema',
        label: 'EMA 指數移動平均',
        short: 'EMA',
        desc: '加重近期價格的均線，反應比 MA 快',
        aliases: ['ema', 'exponential', '指數均線'],
        category: 'overlay',
        params: [{ key: 'period', label: '週期', def: 12, min: 1, max: 500 }],
        outputs: [{ key: 'line', label: 'EMA', kind: 'line', color: '#19b6c9' }],
        compute: (b, p) => ({ line: ema(b, p.period!) }),
    },
    {
        type: 'wma',
        label: 'WMA 加權移動平均',
        short: 'WMA',
        desc: '線性加權均線，越近的 K 棒權重越大',
        aliases: ['wma', 'weighted', '加權均線'],
        category: 'overlay',
        params: [{ key: 'period', label: '週期', def: 20, min: 1, max: 500 }],
        outputs: [{ key: 'line', label: 'WMA', kind: 'line', color: '#b06fff' }],
        compute: (b, p) => ({ line: wma(b, p.period!) }),
    },
    {
        type: 'boll',
        label: 'BOLL 布林通道',
        short: 'BOLL',
        desc: '均線 ± 標準差通道，衡量波動與乖離',
        aliases: ['boll', 'bollinger', 'bands', '布林', '保力加'],
        category: 'overlay',
        params: [
            { key: 'period', label: '週期', def: 20, min: 2, max: 200 },
            { key: 'mult', label: '標準差倍數', def: 2, min: 0.5, max: 5, step: 0.5 },
        ],
        outputs: [
            { key: 'mid', label: '中軌', kind: 'line', color: '#8b94a7' },
            { key: 'upper', label: '上軌', kind: 'line', color: '#5a89c9' },
            { key: 'lower', label: '下軌', kind: 'line', color: '#5a89c9' },
        ],
        compute: (b, p) => {
            const r = bollinger(b, p.period!, p.mult!);
            return { mid: r.mid, upper: r.upper, lower: r.lower };
        },
    },
    {
        type: 'vwap',
        label: 'VWAP 成交量加權均價',
        short: 'VWAP',
        desc: '當日成交量加權平均價，日內交易基準線',
        aliases: ['vwap', 'volume weighted', '均價線'],
        category: 'overlay',
        params: [],
        outputs: [
            { key: 'line', label: 'VWAP', kind: 'line', color: '#f5f7fa', width: 2 },
        ],
        compute: (b) => ({ line: vwap(b) }),
    },
    {
        type: 'sar',
        label: 'SAR 拋物線',
        short: 'SAR',
        desc: '拋物線停損轉向點，追蹤趨勢的移動停損',
        aliases: ['sar', 'parabolic', '拋物線', '停損點'],
        category: 'overlay',
        params: [
            { key: 'step', label: '加速因子', def: 0.02, min: 0.01, max: 0.1, step: 0.01 },
            { key: 'max', label: '上限', def: 0.2, min: 0.1, max: 0.5, step: 0.05 },
        ],
        outputs: [
            { key: 'line', label: 'SAR', kind: 'points', color: '#e0a43c' },
        ],
        compute: (b, p) => ({ line: sar(b, p.step!, p.max!) }),
    },
    {
        type: 'supertrend',
        label: 'SuperTrend 超級趨勢',
        short: 'ST',
        desc: 'ATR 通道趨勢線，多空翻轉一目了然',
        aliases: ['supertrend', 'st', '超級趨勢'],
        category: 'overlay',
        params: [
            { key: 'period', label: 'ATR 週期', def: 10, min: 1, max: 100 },
            { key: 'mult', label: '倍數', def: 3, min: 0.5, max: 10, step: 0.5 },
        ],
        outputs: [
            { key: 'up', label: '多頭', kind: 'line', color: '#1fd286', width: 2 },
            { key: 'down', label: '空頭', kind: 'line', color: '#ff4d6a', width: 2 },
        ],
        compute: (b, p) => {
            const r = supertrend(b, p.period!, p.mult!);
            return { up: r.up, down: r.down };
        },
    },
    {
        type: 'donchian',
        label: 'Donchian 唐奇安通道',
        short: 'DC',
        desc: 'N 期最高/最低價通道，突破策略經典',
        aliases: ['donchian', 'channel', '唐奇安', '海龜'],
        category: 'overlay',
        params: [{ key: 'period', label: '週期', def: 20, min: 2, max: 200 }],
        outputs: [
            { key: 'upper', label: '上軌', kind: 'line', color: '#5a89c9' },
            { key: 'mid', label: '中軌', kind: 'dashed', color: '#8b94a7' },
            { key: 'lower', label: '下軌', kind: 'line', color: '#5a89c9' },
        ],
        compute: (b, p) => {
            const r = donchian(b, p.period!);
            return { upper: r.upper, mid: r.mid, lower: r.lower };
        },
    },
    {
        type: 'keltner',
        label: 'Keltner 肯特納通道',
        short: 'KC',
        desc: 'EMA ± ATR 通道，比布林更平滑的波動帶',
        aliases: ['keltner', 'kc', '肯特納'],
        category: 'overlay',
        params: [
            { key: 'period', label: 'EMA 週期', def: 20, min: 2, max: 200 },
            { key: 'atrPeriod', label: 'ATR 週期', def: 10, min: 1, max: 100 },
            { key: 'mult', label: 'ATR 倍數', def: 2, min: 0.5, max: 5, step: 0.5 },
        ],
        outputs: [
            { key: 'mid', label: '中軌', kind: 'line', color: '#8b94a7' },
            { key: 'upper', label: '上軌', kind: 'line', color: '#c9a25a' },
            { key: 'lower', label: '下軌', kind: 'line', color: '#c9a25a' },
        ],
        compute: (b, p) => {
            const r = keltner(b, p.period!, p.atrPeriod!, p.mult!);
            return { mid: r.mid, upper: r.upper, lower: r.lower };
        },
    },
    {
        type: 'txowall',
        label: 'WALL TXO 牆',
        short: 'WALL',
        desc: '選擇權 OI 牆價位區域帶——履約價手動輸入，畫成橫式長方形',
        aliases: ['wall', 'txo', 'oi', '牆', '壓力', '支撐', '選擇權'],
        category: 'overlay',
        params: [
            { key: 'callWall', label: 'Call 壓力牆', def: 45500, min: 10000, max: 60000, step: 50 },
            { key: 'putWall', label: 'Put 支撐牆', def: 44500, min: 10000, max: 60000, step: 50 },
            { key: 'callWall2', label: 'Call 次牆（0 不畫）', def: 0, min: 0, max: 60000, step: 50 },
            { key: 'putWall2', label: 'Put 次牆（0 不畫）', def: 0, min: 0, max: 60000, step: 50 },
            { key: 'halfWidth', label: '區域半寬（點）', def: 25, min: 5, max: 200, step: 5 },
        ],
        outputs: [
            { key: 'call', label: 'Call牆', kind: 'band', color: '#8a2a1a', width: 2 },
            { key: 'put', label: 'Put牆', kind: 'band', color: '#5f5c26', width: 2 },
            { key: 'call2', label: 'Call次牆', kind: 'band', color: '#a03d2a', border: 'dashed' },
            { key: 'put2', label: 'Put次牆', kind: 'band', color: '#7a762f', border: 'dashed' },
        ],
        compute: (b, p) => {
            const out: Record<string, IndicatorPoint[]> = {};
            const constSer = (v: number): IndicatorPoint[] =>
                b.map((bar) => ({ time: bar.time, value: v }));
            const band = (key: string, wall: number) => {
                if (!(wall > 0)) return; // 0 = 不畫
                out[key] = constSer(wall + p.halfWidth!);
                out[`${key}_lo`] = constSer(wall - p.halfWidth!);
            };
            band('call', p.callWall!);
            band('put', p.putWall!);
            band('call2', p.callWall2!);
            band('put2', p.putWall2!);
            return out;
        },
    },
    // ---- 副圖震盪 ----
    {
        type: 'macd',
        label: 'MACD 指數平滑異同',
        short: 'MACD',
        desc: 'DIF/DEA 交叉與柱狀動能，最經典的趨勢動能指標',
        aliases: ['macd', 'dif', 'dea', '指數平滑'],
        category: 'pane',
        params: [
            { key: 'fast', label: '快線', def: 12, min: 1, max: 100 },
            { key: 'slow', label: '慢線', def: 26, min: 2, max: 200 },
            { key: 'signal', label: '訊號線', def: 9, min: 1, max: 100 },
        ],
        outputs: [
            { key: 'hist', label: '柱狀', kind: 'histogram', color: '#8b94a7', signed: true },
            { key: 'macd', label: 'DIF', kind: 'line', color: '#3d8bff' },
            { key: 'signal', label: 'DEA', kind: 'line', color: '#e0a43c' },
        ],
        levels: [0],
        compute: (b, p) => {
            const r = macd(b, p.fast!, p.slow!, p.signal!);
            return { macd: r.macd, signal: r.signal, hist: r.hist };
        },
    },
    {
        type: 'rsi',
        label: 'RSI 相對強弱',
        short: 'RSI',
        desc: '漲跌力道比值 0-100，30/70 超賣超買',
        aliases: ['rsi', 'relative strength', '相對強弱'],
        category: 'pane',
        params: [{ key: 'period', label: '週期', def: 14, min: 2, max: 100 }],
        outputs: [{ key: 'line', label: 'RSI', kind: 'line', color: '#b06fff' }],
        levels: [30, 70],
        compute: (b, p) => ({ line: rsi(b, p.period!) }),
    },
    {
        type: 'kd',
        label: 'KD 隨機指標',
        short: 'KD',
        desc: '台股慣用 (9,3,3)，K/D 交叉與 20/80 鈍化',
        aliases: ['kd', 'stochastic', 'stoch', '隨機', '威廉KD'],
        category: 'pane',
        params: [
            { key: 'period', label: 'RSV 週期', def: 9, min: 1, max: 100 },
            { key: 'k', label: 'K 平滑', def: 3, min: 1, max: 50 },
            { key: 'd', label: 'D 平滑', def: 3, min: 1, max: 50 },
        ],
        outputs: [
            { key: 'k', label: 'K', kind: 'line', color: '#3d8bff' },
            { key: 'd', label: 'D', kind: 'line', color: '#e0a43c' },
        ],
        levels: [20, 80],
        compute: (b, p) => {
            const r = stoch(b, p.period!, p.k!, p.d!);
            return { k: r.k, d: r.d };
        },
    },
    {
        type: 'stochrsi',
        label: 'StochRSI 隨機相對強弱',
        short: 'SRSI',
        desc: '對 RSI 再取隨機值，靈敏度更高的擺盪指標',
        aliases: ['stochrsi', 'srsi', '隨機rsi'],
        category: 'pane',
        params: [
            { key: 'rsiPeriod', label: 'RSI 週期', def: 14, min: 2, max: 100 },
            { key: 'stochPeriod', label: 'Stoch 週期', def: 14, min: 2, max: 100 },
            { key: 'k', label: 'K 平滑', def: 3, min: 1, max: 50 },
            { key: 'd', label: 'D 平滑', def: 3, min: 1, max: 50 },
        ],
        outputs: [
            { key: 'k', label: 'K', kind: 'line', color: '#3d8bff' },
            { key: 'd', label: 'D', kind: 'line', color: '#e0a43c' },
        ],
        levels: [20, 80],
        compute: (b, p) => {
            const r = stochRsi(b, p.rsiPeriod!, p.stochPeriod!, p.k!, p.d!);
            return { k: r.k, d: r.d };
        },
    },
    {
        type: 'cci',
        label: 'CCI 順勢指標',
        short: 'CCI',
        desc: '價格偏離統計均值的程度，±100 為超買賣區',
        aliases: ['cci', 'commodity channel', '順勢'],
        category: 'pane',
        params: [{ key: 'period', label: '週期', def: 20, min: 2, max: 200 }],
        outputs: [{ key: 'line', label: 'CCI', kind: 'line', color: '#19b6c9' }],
        levels: [-100, 100],
        compute: (b, p) => ({ line: cci(b, p.period!) }),
    },
    {
        type: 'atr',
        label: 'ATR 真實波幅',
        short: 'ATR',
        desc: '平均真實波動範圍，衡量波動大小與停損距離',
        aliases: ['atr', 'average true range', '波幅', '真實波動'],
        category: 'pane',
        params: [{ key: 'period', label: '週期', def: 14, min: 1, max: 100 }],
        outputs: [{ key: 'line', label: 'ATR', kind: 'line', color: '#e0a43c' }],
        compute: (b, p) => ({ line: atr(b, p.period!) }),
    },
    {
        type: 'obv',
        label: 'OBV 能量潮',
        short: 'OBV',
        desc: '成交量累積方向，量先價行的量能指標',
        aliases: ['obv', 'on balance volume', '能量潮', '量能'],
        category: 'pane',
        params: [],
        outputs: [{ key: 'line', label: 'OBV', kind: 'line', color: '#5a89c9' }],
        compute: (b) => ({ line: obv(b) }),
    },
    {
        type: 'mfi',
        label: 'MFI 資金流量',
        short: 'MFI',
        desc: '帶量的 RSI，衡量資金流入流出強度',
        aliases: ['mfi', 'money flow', '資金流'],
        category: 'pane',
        params: [{ key: 'period', label: '週期', def: 14, min: 2, max: 100 }],
        outputs: [{ key: 'line', label: 'MFI', kind: 'line', color: '#1fd286' }],
        levels: [20, 80],
        compute: (b, p) => ({ line: mfi(b, p.period!) }),
    },
    {
        type: 'willr',
        label: 'W%R 威廉指標',
        short: 'W%R',
        desc: '收盤價在 N 期高低區間的位置，-20/-80 超買賣',
        aliases: ['willr', 'williams', '威廉'],
        category: 'pane',
        params: [{ key: 'period', label: '週期', def: 14, min: 2, max: 100 }],
        outputs: [{ key: 'line', label: 'W%R', kind: 'line', color: '#ff8a3d' }],
        levels: [-80, -20],
        compute: (b, p) => ({ line: willr(b, p.period!) }),
    },
    {
        type: 'dmi',
        label: 'DMI/ADX 趨向指標',
        short: 'DMI',
        desc: '+DI/-DI 多空方向與 ADX 趨勢強度',
        aliases: ['dmi', 'adx', 'di', '趨向'],
        category: 'pane',
        params: [
            { key: 'period', label: 'DI 週期', def: 14, min: 2, max: 100 },
            { key: 'adx', label: 'ADX 平滑', def: 14, min: 2, max: 100 },
        ],
        outputs: [
            { key: 'plus', label: '+DI', kind: 'line', color: '#1fd286' },
            { key: 'minus', label: '-DI', kind: 'line', color: '#ff4d6a' },
            { key: 'adx', label: 'ADX', kind: 'line', color: '#f5f7fa', width: 2 },
        ],
        levels: [25],
        compute: (b, p) => {
            const r = dmi(b, p.period!, p.adx!);
            return { plus: r.plus, minus: r.minus, adx: r.adx };
        },
    },
    {
        type: 'roc',
        label: 'ROC 變動率',
        short: 'ROC',
        desc: 'N 期價格變動百分比，動能與背離觀察',
        aliases: ['roc', 'rate of change', '變動率', '動能'],
        category: 'pane',
        params: [{ key: 'period', label: '週期', def: 12, min: 1, max: 200 }],
        outputs: [{ key: 'line', label: 'ROC', kind: 'line', color: '#b06fff' }],
        levels: [0],
        compute: (b, p) => ({ line: roc(b, p.period!) }),
    },
    {
        type: 'bias',
        label: 'BIAS 乖離率',
        short: 'BIAS',
        desc: '價格偏離均線的百分比，台股常用的回歸指標',
        aliases: ['bias', '乖離', '乖離率'],
        category: 'pane',
        params: [{ key: 'period', label: 'MA 週期', def: 20, min: 1, max: 200 }],
        outputs: [{ key: 'line', label: 'BIAS', kind: 'line', color: '#19b6c9' }],
        levels: [0],
        compute: (b, p) => ({ line: bias(b, p.period!) }),
    },
];

export const DEF_BY_TYPE = new Map(INDICATOR_DEFS.map((d) => [d.type, d]));

// ---- instances ----

// how one output is drawn（TradingView plot styles → lightweight-charts）
export type PlotKind = 'line' | 'step' | 'area' | 'histogram' | 'circles';

export interface OutputStyle {
    color?: string;
    width?: 1 | 2 | 3 | 4;
    visible?: boolean;
    opacity?: number; // 0–100
    plot?: PlotKind;
}

export interface IndicatorInstance {
    id: string;
    type: string;
    params: Record<string, number>;
    // output key -> color override（legacy，讀取時遷移到 styles）
    colors: Record<string, string>;
    // output key -> style overrides
    styles?: Record<string, OutputStyle>;
    hidden?: boolean; // 眼睛暫時隱藏，不刪設定
    // 只在這些時框顯示（tf minutes）；undefined = 全部時框
    visibleTf?: number[];
    precision?: number; // 數值小數位數；undefined = 自動
    showLabels?: boolean; // 價格軸最新值標籤（預設 false）
    showValues?: boolean; // legend 顯示數值（預設 true）
}

// merged effective style for one output
export function outputStyle(
    inst: IndicatorInstance,
    def: IndicatorDef,
    key: string,
): Required<Omit<OutputStyle, 'plot'>> & { plot: PlotKind } {
    const out = def.outputs.find((o) => o.key === key);
    const s = inst.styles?.[key] ?? {};
    return {
        color: s.color ?? inst.colors[key] ?? out?.color ?? '#8b94a7',
        width: s.width ?? out?.width ?? 1,
        visible: s.visible ?? true,
        opacity: s.opacity ?? 100,
        plot:
            s.plot ??
            (out?.kind === 'histogram'
                ? 'histogram'
                : out?.kind === 'points'
                  ? 'circles'
                  : 'line'),
    };
}

// hex + 0-100 opacity → rgba()（100% 直接回傳 hex，保住主題原色）
export function colorWithOpacity(hex: string, opacity: number): string {
    if (opacity >= 100 || !/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${(opacity / 100).toFixed(2)})`;
}

export function instanceLabel(inst: IndicatorInstance): string {
    const def = DEF_BY_TYPE.get(inst.type);
    if (!def) return inst.type;
    const args = def.params.map((p) => inst.params[p.key] ?? p.def);
    return args.length > 0 ? `${def.short}(${args.join(',')})` : def.short;
}

export function newInstance(type: string): IndicatorInstance {
    const def = DEF_BY_TYPE.get(type);
    const params: Record<string, number> = {};
    for (const p of def?.params ?? []) params[p.key] = p.def;
    const saved = loadTypeDefaults()[type];
    return {
        id: `${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        type,
        params: { ...params, ...saved?.params },
        colors: {},
        ...(saved?.styles ? { styles: saved.styles } : {}),
        ...(saved?.precision !== undefined
            ? { precision: saved.precision }
            : {}),
        ...(saved?.showLabels !== undefined
            ? { showLabels: saved.showLabels }
            : {}),
        ...(saved?.showValues !== undefined
            ? { showValues: saved.showValues }
            : {}),
    };
}

export function duplicateInstance(inst: IndicatorInstance): IndicatorInstance {
    return {
        ...JSON.parse(JSON.stringify(inst)),
        id: `${inst.type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    };
}

// ---- per-type user defaults（設定視窗「存為我的預設」）----

export interface TypeDefaults {
    params?: Record<string, number>;
    styles?: Record<string, OutputStyle>;
    precision?: number;
    showLabels?: boolean;
    showValues?: boolean;
}

const DEFAULTS_KEY = 'sj-pro-ind-defaults-v1';

export function loadTypeDefaults(): Record<string, TypeDefaults> {
    try {
        const raw = localStorage.getItem(DEFAULTS_KEY);
        if (raw) return JSON.parse(raw) as Record<string, TypeDefaults>;
    } catch {
        // fresh
    }
    return {};
}

export function saveTypeDefault(inst: IndicatorInstance) {
    const all = loadTypeDefaults();
    all[inst.type] = {
        params: inst.params,
        ...(inst.styles ? { styles: inst.styles } : {}),
        ...(inst.precision !== undefined ? { precision: inst.precision } : {}),
        ...(inst.showLabels !== undefined
            ? { showLabels: inst.showLabels }
            : {}),
        ...(inst.showValues !== undefined
            ? { showValues: inst.showValues }
            : {}),
    };
    try {
        localStorage.setItem(DEFAULTS_KEY, JSON.stringify(all));
    } catch {
        // keep in-memory
    }
}

// factory-reset one instance（清掉自訂參數與樣式，回到內建預設）
export function factoryInstance(inst: IndicatorInstance): IndicatorInstance {
    const def = DEF_BY_TYPE.get(inst.type);
    const params: Record<string, number> = {};
    for (const p of def?.params ?? []) params[p.key] = p.def;
    return {
        id: inst.id,
        type: inst.type,
        params,
        colors: {},
        ...(inst.hidden ? { hidden: inst.hidden } : {}),
        ...(inst.visibleTf ? { visibleTf: inst.visibleTf } : {}),
    };
}

// ---- persistence（全域，跨圖表共用；v1 Set 格式自動遷移）----

const STORE_KEY = 'sj-pro-indicators-v2';
const LEGACY_KEY = 'sj-pro-indicators';

function migrateLegacy(): IndicatorInstance[] {
    try {
        const raw = localStorage.getItem(LEGACY_KEY);
        if (!raw) return [];
        const keys = JSON.parse(raw) as string[];
        const out: IndicatorInstance[] = [];
        for (const k of keys) {
            if (k.startsWith('ma')) {
                const inst = newInstance('sma');
                inst.params.period = Number(k.slice(2)) || 20;
                out.push(inst);
            } else if (k === 'ema12') {
                out.push(newInstance('ema'));
            } else if (k === 'bb') {
                out.push(newInstance('boll'));
            } else if (k === 'vwap') {
                out.push(newInstance('vwap'));
            }
        }
        localStorage.removeItem(LEGACY_KEY);
        return out;
    } catch {
        return [];
    }
}

export function loadInstances(): IndicatorInstance[] {
    try {
        const raw = localStorage.getItem(STORE_KEY);
        if (raw) {
            const list = JSON.parse(raw) as IndicatorInstance[];
            return list.filter((i) => DEF_BY_TYPE.has(i.type));
        }
    } catch {
        // fresh start below
    }
    const migrated = migrateLegacy();
    if (migrated.length > 0) saveInstances(migrated);
    return migrated;
}

// 指標實例變更通知（回測面板的 K 線與主圖共用同一份設定）
const instanceListeners = new Set<() => void>();
export function subscribeInstances(fn: () => void): () => void {
    instanceListeners.add(fn);
    return () => instanceListeners.delete(fn);
}

export function saveInstances(list: IndicatorInstance[]) {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(list));
    } catch {
        // storage full/unavailable — keep in-memory state
    }
    for (const l of instanceListeners) l();
}

// ---- favorites（指標選擇器的星號收藏）----

const FAV_KEY = 'sj-pro-ind-favs';

export function loadFavorites(): Set<string> {
    try {
        const raw = localStorage.getItem(FAV_KEY);
        if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch {
        // default empty
    }
    return new Set();
}

export function saveFavorites(favs: Set<string>) {
    try {
        localStorage.setItem(FAV_KEY, JSON.stringify([...favs]));
    } catch {
        // keep in-memory
    }
}
