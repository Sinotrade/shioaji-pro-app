// src/lib/chart-drawing-fib.ts — 斐波那契回撤的選項、預設值與標籤（純函式）
//
// 照 TradingView 的呈現：相鄰兩條比例線之間是半透明的色帶、每條線有
// 自己的顏色（預設依 TradingView 的順序：灰、紅、橘、綠、青、藍、灰），
// 標籤放在回撤範圍外側（預設左側、線的上方），用線的顏色＋與圖表背景
// 同色的描邊，蓋在 K 棒上也讀得清楚。

export type FibThemeMode = 'dark' | 'light';

// 色盤名稱 → 深／淺主題的實際顏色。存的是名稱（token），不是色碼：
// 換主題時預設色跟著換；使用者自己挑的色碼才固定不變。
export type FibColorToken = 'grey' | 'red' | 'orange' | 'green' | 'teal' | 'blue';

export const FIB_TOKEN_COLORS: Record<FibThemeMode, Record<FibColorToken, string>> = {
    dark: {
        grey: '#8b94a7',
        red: '#f06a6a',
        orange: '#ff9f43',
        green: '#4cc38a',
        teal: '#38c7b5',
        blue: '#5b9dff',
    },
    light: {
        grey: '#6b7280',
        red: '#d9383a',
        orange: '#e8590c',
        green: '#2b8a3e',
        teal: '#0c8599',
        blue: '#1c64f2',
    },
};

const TOKEN_CYCLE: FibColorToken[] = ['grey', 'red', 'orange', 'green', 'teal', 'blue'];

export interface FibLevel {
    value: number; // 比例，0＝終點、1＝起點（反轉時相反）
    visible: boolean;
    // 使用者挑的色碼；沒挑過就用 token 依主題取色
    color?: string;
    token: FibColorToken;
}

export type FibLabelH = 'left' | 'right';
export type FibLabelV = 'top' | 'middle' | 'bottom';

export interface FibOptions {
    levels: FibLevel[];
    bandOpacity: number; // 相鄰比例線之間色帶的透明度 0–0.5
    singleColor: boolean; // 使用單一顏色（物件的線色）
    labelH: FibLabelH; // 標籤在回撤範圍的左側／右側（範圍外）
    labelV: FibLabelV; // 標籤在線的上方／正中／下方
    showLevel: boolean;
    levelFormat: 'value' | 'percent';
    showPrice: boolean;
    fontSize: number; // 9–16 px
    extendLeft: boolean; // 比例線延伸到圖表左緣
    extendRight: boolean; // 比例線延伸到圖表右緣
    reverse: boolean; // 反轉：0 在起點、1 在終點
    showTrend: boolean; // 起點到終點的斜虛線
}

export const DEFAULT_FIB_VALUES = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const DEFAULT_TOKENS: FibColorToken[] = ['grey', 'red', 'orange', 'green', 'teal', 'blue', 'grey'];

export const FIB_FONT_SIZES = [10, 11, 12, 14];
export const MAX_FIB_LEVELS = 16;

export function defaultFibLevels(): FibLevel[] {
    return DEFAULT_FIB_VALUES.map((value, i) => ({ value, visible: true, token: DEFAULT_TOKENS[i]! }));
}

export function defaultFibOptions(): FibOptions {
    return {
        levels: defaultFibLevels(),
        bandOpacity: 0.12,
        singleColor: false,
        labelH: 'left',
        labelV: 'top',
        showLevel: true,
        levelFormat: 'value',
        showPrice: true,
        fontSize: 11,
        extendLeft: false,
        extendRight: false,
        reverse: false,
        showTrend: true,
    };
}

// 新增的比例：預設值裡有的沿用那個顏色，其他依序輪色盤
export function tokenForValue(value: number, index: number): FibColorToken {
    const i = DEFAULT_FIB_VALUES.indexOf(value);
    return i >= 0 ? DEFAULT_TOKENS[i]! : TOKEN_CYCLE[index % TOKEN_CYCLE.length]!;
}

const HEX = /^#[0-9a-f]{6}$/i;
const isToken = (v: unknown): v is FibColorToken => typeof v === 'string' && (TOKEN_CYCLE as string[]).includes(v);

function sanitizeLevel(v: unknown, index: number): FibLevel | null {
    // 舊格式（#224 第一版）：純數字陣列
    const o = (typeof v === 'number' ? { value: v } : v && typeof v === 'object' ? v : null) as Record<string, unknown> | null;
    if (!o || typeof o.value !== 'number' || !Number.isFinite(o.value) || o.value < -5 || o.value > 5) return null;
    return {
        value: o.value,
        visible: o.visible !== false,
        token: isToken(o.token) ? o.token : tokenForValue(o.value, index),
        ...(typeof o.color === 'string' && HEX.test(o.color) ? { color: o.color } : {}),
    };
}

export function sanitizeFibLevels(v: unknown): FibLevel[] | null {
    if (!Array.isArray(v)) return null;
    const seen = new Set<number>();
    const out: FibLevel[] = [];
    v.forEach((item, i) => {
        const l = sanitizeLevel(item, i);
        if (!l || seen.has(l.value)) return;
        seen.add(l.value);
        out.push(l);
    });
    out.sort((a, b) => a.value - b.value);
    return out.length ? out.slice(0, MAX_FIB_LEVELS) : null;
}

// legacyLevels：#224 第一版存在 Drawing.levels 的數字陣列
export function sanitizeFibOptions(v: unknown, legacyLevels?: unknown): FibOptions {
    const d = defaultFibOptions();
    const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
    const bool = (x: unknown, dflt: boolean) => (typeof x === 'boolean' ? x : dflt);
    const num = (x: unknown, lo: number, hi: number, dflt: number) =>
        typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt;
    return {
        levels: sanitizeFibLevels(o.levels) ?? sanitizeFibLevels(legacyLevels) ?? d.levels,
        bandOpacity: num(o.bandOpacity, 0, 0.5, d.bandOpacity),
        singleColor: bool(o.singleColor, d.singleColor),
        labelH: o.labelH === 'right' ? 'right' : 'left',
        labelV: o.labelV === 'middle' || o.labelV === 'bottom' ? o.labelV : 'top',
        showLevel: bool(o.showLevel, d.showLevel),
        levelFormat: o.levelFormat === 'percent' ? 'percent' : 'value',
        showPrice: bool(o.showPrice, d.showPrice),
        fontSize: Math.round(num(o.fontSize, 9, 16, d.fontSize)),
        extendLeft: bool(o.extendLeft, d.extendLeft),
        extendRight: bool(o.extendRight, d.extendRight),
        reverse: bool(o.reverse, d.reverse),
        showTrend: bool(o.showTrend, d.showTrend),
    };
}

export function fibLevelColor(
    level: FibLevel,
    opts: Pick<FibOptions, 'singleColor'>,
    lineColor: string,
    mode: FibThemeMode,
): string {
    if (opts.singleColor) return lineColor;
    return level.color ?? FIB_TOKEN_COLORS[mode][level.token];
}

// 比例 → 價格。預設終點＝0、起點＝1；反轉時起點＝0、終點＝1
export function fibLevelPrice(start: number, end: number, value: number, reverse: boolean): number {
    return reverse ? start + (end - start) * value : end + (start - end) * value;
}

function fmtValue(v: number): string {
    return String(Number(v.toFixed(3)));
}

// 標籤文字：「0.618 (48,488)」「61.8% (48,488)」「0.618」「48,488」
export function fibLabel(
    value: number,
    price: number,
    opts: Pick<FibOptions, 'showLevel' | 'levelFormat' | 'showPrice'>,
    fmtPrice: (p: number) => string,
): string {
    const level = opts.showLevel
        ? opts.levelFormat === 'percent'
            ? `${Number((value * 100).toFixed(1))}%`
            : fmtValue(value)
        : '';
    const p = opts.showPrice ? fmtPrice(price) : '';
    if (level && p) return `${level} (${p})`;
    return level || p;
}

// 標籤的錨點與對齊：放在回撤範圍外側（剛過左／右錨點）；比例線延伸到
// 圖表邊緣時外側已經在畫面外，改貼在畫面內緣
export function fibLabelPlacement(
    anchorsX: { min: number; max: number },
    opts: Pick<FibOptions, 'labelH' | 'labelV' | 'extendLeft' | 'extendRight'>,
    paneWidth: number,
    y: number,
    fontSize: number,
): { x: number; y: number; align: 'left' | 'right'; baseline: 'bottom' | 'middle' | 'top' } {
    const gap = 4;
    let x: number;
    let align: 'left' | 'right';
    if (opts.labelH === 'left') {
        if (opts.extendLeft || anchorsX.min - gap < fontSize * 2) {
            x = Math.max(gap, opts.extendLeft ? gap : anchorsX.min + gap);
            align = 'left';
        } else {
            x = anchorsX.min - gap;
            align = 'right';
        }
    } else if (opts.extendRight || anchorsX.max + gap > paneWidth - fontSize * 2) {
        x = Math.min(paneWidth - gap, opts.extendRight ? paneWidth - gap : anchorsX.max - gap);
        align = 'right';
    } else {
        x = anchorsX.max + gap;
        align = 'left';
    }
    const ly = opts.labelV === 'top' ? y - 2 : opts.labelV === 'bottom' ? y + 2 : y;
    const baseline = opts.labelV === 'top' ? 'bottom' : opts.labelV === 'bottom' ? 'top' : 'middle';
    return { x, y: ly, align, baseline };
}
