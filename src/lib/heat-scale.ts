// src/lib/heat-scale.ts — 熱力圖連續色階（產業全景／下鑽磚牆／匯出 PNG 共用）
//
// 連續發散色階：k = min(|v|/domain, 1)^gamma（gamma<1 把小漲跌拉亮，±1%
// 就看得出顏色），在「低飽和起點 → 飽和終點」之間內插；|v| 小於中性帶時
// 用中性灰，無值用 null 色。端點由主題的紅／綠與面板底色推算 —
// 深色、淺色、自訂配色、紅漲綠跌／綠漲紅跌都自動對應，DOM 與 canvas 用
// 同一組實際色值。

import { customTokens } from './custom-theme';
import type { ThemeSettings } from './theme-store';

export const HEAT_GAMMA = 0.6;
export const HEAT_NEUTRAL_BAND = 0.05; // ±0.05% 以內視為平盤
export const STOCK_HEAT_DOMAIN = 10; // 個股：±10%（漲跌停）
export const SECTOR_HEAT_DOMAIN = 5; // 產業：±5%

type Rgb = [number, number, number];

export interface HeatPalette {
    upLo: Rgb;
    upHi: Rgb;
    downLo: Rgb;
    downHi: Rgb;
    neutral: Rgb;
    none: Rgb;
    /** 面板底色 — tile 之間的格線與匯出底色 */
    gap: Rgb;
    /** 產業標題列底色 */
    header: Rgb;
    /** 一般文字／次要文字／漲跌文字（canvas 匯出用的實際色值） */
    fg: Rgb;
    muted: Rgb;
    upText: Rgb;
    downText: Rgb;
    /** 深色文字（淺色底 tile 用）與淺色文字（深色底 tile 用） */
    inkDark: Rgb;
    inkLight: Rgb;
    mode: 'dark' | 'light';
}

function hexToRgb(hex: string): Rgb {
    const n = parseInt(hex.replace('#', '').slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
    return [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ];
}

export function rgbCss(c: Rgb): string {
    return `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])})`;
}

// 與 theme.css.ts 深色／淺色色票一致（canvas 匯出要實際色值）
const BASE = {
    dark: { panel: '#0a0c10', fg: '#d5dbe8', red: '#f23645', green: '#16b389' },
    light: { panel: '#ffffff', fg: '#1c2433', red: '#d6213a', green: '#0a8a66' },
} as const;

/**
 * 依主題推算色階端點。深色：低飽和暗紅／暗綠 → 收斂的飽和色（不刺眼）；
 * 淺色：淡粉／淡綠 → 中等飽和色。
 */
export function heatPalette(settings: Pick<ThemeSettings, 'mode' | 'convention' | 'custom'>): HeatPalette {
    let mode: 'dark' | 'light';
    let panel: Rgb;
    let fg: Rgb;
    let up: Rgb;
    let down: Rgb;
    if (settings.mode === 'custom' && settings.custom) {
        const t = customTokens(settings.custom, settings.convention);
        mode = settings.custom.base;
        panel = hexToRgb(t.panel ?? BASE[mode].panel);
        fg = hexToRgb(t.foreground ?? BASE[mode].fg);
        up = hexToRgb(t.up ?? BASE[mode].red);
        down = hexToRgb(t.down ?? BASE[mode].green);
    } else {
        mode = settings.mode === 'light' ? 'light' : 'dark';
        const b = BASE[mode];
        panel = hexToRgb(b.panel);
        fg = hexToRgb(b.fg);
        const red = hexToRgb(b.red);
        const green = hexToRgb(b.green);
        up = settings.convention === 'intl' ? green : red;
        down = settings.convention === 'intl' ? red : green;
    }
    const gray: Rgb = mix(panel, fg, 0.5);
    // 先把純色往灰拉一點降飽和，再與底色混出起訖點
    const mute = (c: Rgb) => mix(c, gray, mode === 'dark' ? 0.18 : 0.12);
    const [loT, hiT] = mode === 'dark' ? [0.2, 0.78] : [0.14, 0.82];
    return {
        upLo: mix(panel, mute(up), loT),
        upHi: mix(panel, mute(up), hiT),
        downLo: mix(panel, mute(down), loT),
        downHi: mix(panel, mute(down), hiT),
        neutral: mix(panel, fg, mode === 'dark' ? 0.13 : 0.09),
        none: mix(panel, fg, mode === 'dark' ? 0.06 : 0.04),
        gap: panel,
        header: mix(panel, fg, mode === 'dark' ? 0.08 : 0.06),
        fg,
        muted: mix(panel, fg, 0.6),
        upText: up,
        downText: down,
        inkDark: mode === 'dark' ? panel : fg,
        inkLight: [255, 255, 255],
        mode,
    };
}

/** 0..1 強度（含中性帶與 gamma）；null 表示無值 */
export function heatIntensity(
    value: number | null | undefined,
    domain: number,
    gamma = HEAT_GAMMA,
): number | null {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return null;
    }
    if (Math.abs(value) < HEAT_NEUTRAL_BAND) return 0;
    return Math.min(Math.abs(value) / domain, 1) ** gamma;
}

export function heatRgb(
    value: number | null | undefined,
    domain: number,
    palette: HeatPalette,
): Rgb {
    const k = heatIntensity(value, domain);
    if (k === null) return palette.none;
    if (k === 0) return palette.neutral;
    return value! > 0
        ? mix(palette.upLo, palette.upHi, k)
        : mix(palette.downLo, palette.downHi, k);
}

export function heatColor(
    value: number | null | undefined,
    domain: number,
    palette: HeatPalette,
): string {
    return rgbCss(heatRgb(value, domain, palette));
}

// WCAG 相對亮度
function luminance(c: Rgb): number {
    const ch = c.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

function contrast(a: Rgb, b: Rgb): number {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** tile 上的文字色 — 白字與深字取對比較高者 */
export function heatInk(background: Rgb, palette: HeatPalette): string {
    const light = palette.inkLight;
    const dark = palette.mode === 'light' ? palette.inkDark : ([20, 22, 28] as Rgb);
    return rgbCss(
        contrast(background, light) >= contrast(background, dark) ? light : dark,
    );
}

/** 圖例：7 格（-1, -.6, -.25, 0, .25, .6, 1）× domain */
export const LEGEND_STOPS = [-1, -0.6, -0.25, 0, 0.25, 0.6, 1] as const;

export function legendColors(domain: number, palette: HeatPalette): string[] {
    return LEGEND_STOPS.map((stop) => heatColor(stop * domain, domain, palette));
}
