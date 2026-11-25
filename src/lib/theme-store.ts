// src/lib/theme-store.ts — theme settings (mode + price-color convention),
// persisted to localStorage and applied as a class on <html>. On desktop
// the native window chrome (titlebar appearance) follows the mode too.

import { useSyncExternalStore } from 'react';
import { isTauri } from './runtime';
import { themeClasses, vars } from '../theme.css';
import { CUSTOM_BASES, customTokens, isCustomTheme, type CustomTheme } from './custom-theme';

export type ThemeMode = 'dark' | 'light' | 'custom';
export type Convention = 'tw' | 'intl';
// 小／標準／大（2026-09-29 起整體放大一級，原本的 0.85 小拿掉）
export type FontScale = 1 | 1.15 | 1.3;

export interface ThemeSettings {
    mode: ThemeMode;
    convention: Convention;
    fontScale: FontScale;
    /** 自訂配色；mode 為 custom 時套用，切回深色／淺色時保留以便再切回來 */
    custom?: CustomTheme;
}

const STORAGE_KEY = 'sj-pro-theme';
const MODES: ThemeMode[] = ['dark', 'light', 'custom'];
const CONVENTIONS: Convention[] = ['tw', 'intl'];
const SCALES: FontScale[] = [1, 1.15, 1.3];
const DEFAULT_SCALE: FontScale = 1.15;

// 舊設定：純黑（midnight）即現在的深色；0.85 已移除，改為最小的 1
function migrateMode(mode: unknown): unknown {
    return mode === 'midnight' ? 'dark' : mode;
}
function migrateScale(scale: unknown): FontScale {
    if (scale === 0.85) return 1;
    return SCALES.includes(scale as FontScale) ? (scale as FontScale) : DEFAULT_SCALE;
}

function systemMode(): ThemeMode {
    try {
        return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } catch {
        return 'dark';
    }
}

function load(): ThemeSettings {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const s = JSON.parse(raw) as Partial<Record<keyof ThemeSettings, unknown>>;
            const mode = migrateMode(s.mode);
            if (
                MODES.includes(mode as ThemeMode) &&
                CONVENTIONS.includes(s.convention as Convention)
            ) {
                const custom = isCustomTheme(s.custom) ? s.custom : undefined;
                return {
                    // 自訂配色遺失時退回深色
                    mode: mode === 'custom' && !custom ? 'dark' : (mode as ThemeMode),
                    convention: s.convention as Convention,
                    fontScale: migrateScale(s.fontScale),
                    ...(custom ? { custom } : {}),
                };
            }
        }
    } catch {
        // corrupted settings — use defaults
    }
    // 第一次啟動（沒有存過設定）跟隨系統外觀；之後以使用者的選擇為準
    return { mode: systemMode(), convention: 'tw', fontScale: DEFAULT_SCALE };
}

let settings: ThemeSettings = load();
const listeners = new Set<() => void>();

/** 實際套用的起始底色：自訂配色以其 base 的 theme class 為底 */
export function baseMode(s: ThemeSettings): 'dark' | 'light' {
    return s.mode === 'custom' ? (s.custom?.base ?? 'dark') : s.mode;
}

/** 圖表等以 canvas 繪製的元件用來判斷是否需要重新套色 */
export function themeKey(s: ThemeSettings): string {
    const custom = activeCustom(s);
    return `${s.mode}-${s.convention}${custom ? `-${Object.values(custom).join(',')}` : ''}`;
}

/** 目前生效的自訂配色（mode 不是 custom 時為 undefined） */
export function activeCustom(s: ThemeSettings): CustomTheme | undefined {
    return s.mode === 'custom' ? (s.custom ?? CUSTOM_BASES.dark) : undefined;
}

const colorVars = vars.color as Record<string, string>;
// 'var(--color-accent__abc)' → '--color-accent__abc'
const cssVarName = (ref: string) => ref.slice(4, -1);

function applyClass() {
    const root = document.documentElement;
    for (const cls of Object.values(themeClasses)) {
        root.classList.remove(cls);
    }
    const base = baseMode(settings);
    const key = `${base}-${settings.convention}`;
    const cls = themeClasses[key] ?? themeClasses['dark-tw'];
    if (cls) root.classList.add(cls);
    // 自訂配色：六色推算的 token 以 inline 變數蓋在底色 class 上；
    // 切回深色／淺色時移除
    const custom = activeCustom(settings);
    const tokens = custom ? customTokens(custom, settings.convention) : {};
    for (const [name, ref] of Object.entries(colorVars)) {
        const value = tokens[name];
        if (value) root.style.setProperty(cssVarName(ref), value);
        else root.style.removeProperty(cssVarName(ref));
    }
    // light/dark <select>/scrollbar rendering follows this hint too
    root.style.colorScheme = base === 'light' ? 'light' : 'dark';
    // every style is rem-based, so scaling the root font-size scales the UI
    root.style.fontSize = `${16 * settings.fontScale}px`;
}

// sync the native window chrome (macOS appearance / Windows titlebar)
// with the in-app theme — dark → dark, light → light (custom follows its base)
async function applyNativeTheme() {
    if (!isTauri) return;
    try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().setTheme(baseMode(settings));
    } catch {
        // older runtime without set-theme permission
    }
}

export function initTheme() {
    applyClass();
    void applyNativeTheme();
}

export function setThemeSettings(next: Partial<ThemeSettings>) {
    settings = { ...settings, ...next };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    applyClass();
    void applyNativeTheme();
    listeners.forEach((l) => l());
}

export function useThemeSettings(): ThemeSettings {
    return useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => settings,
    );
}

// ---- chart palette (canvas needs concrete color strings) ----

export interface ChartColors {
    up: string;
    upVol: string;
    down: string;
    downVol: string;
    text: string;
    grid: string;
    crosshair: string;
    border: string;
    labelBg: string;
}

const CHROME: Record<
    'dark' | 'light',
    Pick<ChartColors, 'text' | 'grid' | 'crosshair' | 'border' | 'labelBg'>
> = {
    dark: {
        text: '#7e8798',
        grid: 'rgba(26, 31, 41, 0.7)',
        crosshair: '#3d8bff',
        border: '#1a1f29',
        labelBg: '#10131a',
    },
    light: {
        text: '#5f6b80',
        grid: 'rgba(221, 226, 233, 0.9)',
        crosshair: '#2962ff',
        border: '#dde2e9',
        labelBg: '#f7f8fa',
    },
};

const RG: Record<'dark' | 'light', { red: string; green: string; redVol: string; greenVol: string }> = {
    dark: {
        red: '#f23645',
        green: '#16b389',
        redVol: 'rgba(242, 54, 69, 0.45)',
        greenVol: 'rgba(22, 179, 137, 0.4)',
    },
    light: {
        red: '#d6213a',
        green: '#0a8a66',
        redVol: 'rgba(214, 33, 58, 0.4)',
        greenVol: 'rgba(10, 138, 102, 0.35)',
    },
};

export function getChartColors(s: ThemeSettings): ChartColors {
    const custom = activeCustom(s);
    if (custom) {
        const t = customTokens(custom, s.convention);
        const up = t.up!;
        const down = t.down!;
        return {
            up,
            upVol: withAlpha(up, 0.42),
            down,
            downVol: withAlpha(down, 0.4),
            text: t.mutedForeground!,
            grid: withAlpha(t.border!, 0.7),
            crosshair: t.accent!,
            border: t.border!,
            labelBg: t.panelRaised!,
        };
    }
    const mode = baseMode(s);
    const rg = RG[mode];
    const isTw = s.convention === 'tw';
    return {
        up: isTw ? rg.red : rg.green,
        upVol: isTw ? rg.redVol : rg.greenVol,
        down: isTw ? rg.green : rg.red,
        downVol: isTw ? rg.greenVol : rg.redVol,
        ...CHROME[mode],
    };
}

function withAlpha(hex: string, a: number): string {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
