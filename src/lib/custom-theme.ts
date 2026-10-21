// src/lib/custom-theme.ts — 自訂配色（主題「自訂」）：使用者只挑六個顏色，
// 其餘 token（面板層次、邊框、次要文字、漲跌底色）由這六色推算，
// 以 inline CSS 變數蓋在起始底色（深色／淺色）的 theme class 上。

import type { Convention } from './theme-store';

export type CustomBase = 'dark' | 'light';

export interface CustomTheme {
    base: CustomBase;
    background: string;
    panel: string;
    foreground: string;
    accent: string;
    red: string;
    green: string;
}

export type CustomColorKey = Exclude<keyof CustomTheme, 'base'>;

export const CUSTOM_COLOR_FIELDS: { key: CustomColorKey; label: string }[] = [
    { key: 'background', label: '背景' },
    { key: 'panel', label: '面板' },
    { key: 'foreground', label: '文字' },
    { key: 'accent', label: '強調色' },
    { key: 'red', label: '紅（漲跌）' },
    { key: 'green', label: '綠（漲跌）' },
];

// 與 theme.css.ts 的深色／淺色色票一致
export const CUSTOM_BASES: Record<CustomBase, CustomTheme> = {
    dark: {
        base: 'dark',
        background: '#000000',
        panel: '#0a0c10',
        foreground: '#d5dbe8',
        accent: '#3d8bff',
        red: '#f23645',
        green: '#16b389',
    },
    light: {
        base: 'light',
        background: '#eef0f3',
        panel: '#ffffff',
        foreground: '#1c2433',
        accent: '#2962ff',
        red: '#d6213a',
        green: '#0a8a66',
    },
};

export const CUSTOM_PRESETS: { name: string; theme: CustomTheme }[] = [
    { name: '深海藍', theme: { base: 'dark', background: '#0b1628', panel: '#132238', foreground: '#dfe7f5', accent: '#4da3ff', red: '#ff4d5e', green: '#22c997' } },
    { name: '墨綠', theme: { base: 'dark', background: '#0d1411', panel: '#15201b', foreground: '#dde8e1', accent: '#3ecf8e', red: '#f2545b', green: '#2fbf71' } },
    { name: '暖灰', theme: { base: 'dark', background: '#161412', panel: '#201d1a', foreground: '#ece6df', accent: '#e0a43c', red: '#f0564a', green: '#3fb58a' } },
    { name: '黑紫', theme: { base: 'dark', background: '#1b1b1f', panel: '#26262c', foreground: '#e6e3f0', accent: '#b58cff', red: '#ff5c7a', green: '#35c79a' } },
];

const HEX = /^#[0-9a-f]{6}$/i;

export function isCustomTheme(v: unknown): v is CustomTheme {
    if (!v || typeof v !== 'object') return false;
    const t = v as Record<string, unknown>;
    return (
        (t.base === 'dark' || t.base === 'light') &&
        CUSTOM_COLOR_FIELDS.every(({ key }) => typeof t[key] === 'string' && HEX.test(t[key] as string))
    );
}

function rgb(hex: string): [number, number, number] {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** a→b 依 t（0–1）混色，回傳 #rrggbb */
export function mix(a: string, b: string, t: number): string {
    const [ar, ag, ab] = rgb(a);
    const [br, bg, bb] = rgb(b);
    const c = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
    return `#${c(ar, br)}${c(ag, bg)}${c(ab, bb)}`;
}

export function alpha(hex: string, a: number): string {
    const [r, g, b] = rgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** 六色推算出完整的 color token（鍵名同 theme.css.ts 的 vars.color） */
export function customTokens(t: CustomTheme, convention: Convention): Record<string, string> {
    const dark = t.base === 'dark';
    const fg = t.foreground;
    const up = convention === 'tw' ? t.red : t.green;
    const down = convention === 'tw' ? t.green : t.red;
    const dim = dark ? 0.13 : 0.1;
    const flash = dark ? 0.2 : 0.16;
    // 淺底時次要文字要更接近文字色，維持 4.5:1 以上的對比
    const mutedFg = mix(fg, t.panel, dark ? 0.42 : 0.3);
    return {
        background: t.background,
        panel: t.panel,
        panelRaised: mix(t.panel, fg, dark ? 0.04 : 0.02),
        inset: mix(t.background, t.panel, 0.4),
        foreground: fg,
        muted: mix(t.panel, fg, dark ? 0.07 : 0.06),
        mutedForeground: mutedFg,
        border: mix(t.panel, fg, dark ? 0.1 : 0.12),
        borderBright: mix(t.panel, fg, dark ? 0.18 : 0.22),
        accent: t.accent,
        accentDim: alpha(t.accent, dark ? 0.12 : 0.1),
        magenta: mutedFg,
        up,
        upDim: alpha(up, dim),
        upFlash: alpha(up, flash),
        down,
        downDim: alpha(down, dim),
        downFlash: alpha(down, flash),
        flat: mutedFg,
        success: t.green,
        successDim: alpha(t.green, dim),
        danger: t.red,
        dangerDim: alpha(t.red, dim),
    };
}
