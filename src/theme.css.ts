// src/theme.css.ts — themeable design tokens.
// 2 modes (dark / light) × 2 price-color conventions
// (tw: red-up green-down, intl: green-up red-down) = 4 theme classes.

import {
    createTheme,
    globalKeyframes,
    globalStyle,
} from '@vanilla-extract/css';

interface Palette {
    background: string;
    panel: string;
    panelRaised: string;
    inset: string;
    foreground: string;
    muted: string;
    mutedForeground: string;
    border: string;
    borderBright: string;
    accent: string;
    accentDim: string;
    amber: string;
    red: string;
    redDim: string;
    redFlash: string;
    green: string;
    greenDim: string;
    greenFlash: string;
}

// 深色＝原本的純黑（使用者 2026-09-29 決定只留純黑與淺色）
const dark: Palette = {
    background: '#000000',
    panel: '#0a0c10',
    panelRaised: '#10131a',
    inset: '#040508',
    foreground: '#d5dbe8',
    muted: '#14181f',
    mutedForeground: '#7e8798',
    border: '#1a1f29',
    borderBright: '#2a3140',
    accent: '#3d8bff',
    accentDim: 'rgba(61, 139, 255, 0.12)',
    amber: '#e0a43c',
    red: '#f23645',
    redDim: 'rgba(242, 54, 69, 0.13)',
    redFlash: 'rgba(242, 54, 69, 0.2)',
    green: '#16b389',
    greenDim: 'rgba(22, 179, 137, 0.13)',
    greenFlash: 'rgba(22, 179, 137, 0.18)',
};

const light: Palette = {
    background: '#eef0f3',
    panel: '#ffffff',
    panelRaised: '#f7f8fa',
    inset: '#f1f3f6',
    foreground: '#1c2433',
    muted: '#e9ecf1',
    mutedForeground: '#5f6b80',
    border: '#dde2e9',
    borderBright: '#c3ccd9',
    accent: '#2962ff',
    accentDim: 'rgba(41, 98, 255, 0.10)',
    amber: '#b97f14',
    red: '#d6213a',
    redDim: 'rgba(214, 33, 58, 0.10)',
    redFlash: 'rgba(214, 33, 58, 0.16)',
    green: '#0a8a66',
    greenDim: 'rgba(10, 138, 102, 0.10)',
    greenFlash: 'rgba(10, 138, 102, 0.14)',
};

// tw: red = up (台股慣例); intl: green = up
function makeTokens(p: Palette, convention: 'tw' | 'intl') {
    const up = convention === 'tw' ? p.red : p.green;
    const upDim = convention === 'tw' ? p.redDim : p.greenDim;
    const upFlash = convention === 'tw' ? p.redFlash : p.greenFlash;
    const down = convention === 'tw' ? p.green : p.red;
    const downDim = convention === 'tw' ? p.greenDim : p.redDim;
    const downFlash = convention === 'tw' ? p.greenFlash : p.redFlash;
    return {
        color: {
            background: p.background,
            panel: p.panel,
            panelRaised: p.panelRaised,
            inset: p.inset,
            foreground: p.foreground,
            muted: p.muted,
            mutedForeground: p.mutedForeground,
            border: p.border,
            borderBright: p.borderBright,
            accent: p.accent,
            accentDim: p.accentDim,
            magenta: p.mutedForeground,
            amber: p.amber,
            up,
            upDim,
            upFlash,
            down,
            downDim,
            downFlash,
            flat: p.mutedForeground,
            // 狀態色（成功／錯誤／正式環境等）固定綠／紅，不隨漲跌配色翻轉；
            // 價格、買賣方向才用 up／down
            success: p.green,
            successDim: p.greenDim,
            danger: p.red,
            dangerDim: p.redDim,
        },
        space: {
            xs: '0.25rem',
            sm: '0.5rem',
            md: '1rem',
            lg: '1.5rem',
            xl: '2rem',
        },
        radius: {
            sm: '0.25rem',
            md: '0.375rem',
            lg: '0.5rem',
        },
        font: {
            display:
                "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
            mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
            body: "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
        },
    };
}

export const [darkTwClass, vars] = createTheme(makeTokens(dark, 'tw'));

export const themeClasses: Record<string, string> = {
    'dark-tw': darkTwClass,
    'dark-intl': createTheme(vars, makeTokens(dark, 'intl')),
    'light-tw': createTheme(vars, makeTokens(light, 'tw')),
    'light-intl': createTheme(vars, makeTokens(light, 'intl')),
};

// price-update flash animations follow the active theme
globalKeyframes('flash-up', {
    '0%': { background: vars.color.upFlash },
    '100%': { background: 'transparent' },
});

globalKeyframes('flash-down', {
    '0%': { background: vars.color.downFlash },
    '100%': { background: 'transparent' },
});

globalStyle('html, body', {
    background: vars.color.background,
    color: vars.color.foreground,
});

globalStyle('body', {
    fontFamily: vars.font.body,
});

// native <option> popups don't inherit the themed select colors on
// Linux/Windows — without this, dark themes render white-on-white text
// in every dropdown (issue #1)
globalStyle('select option', {
    background: vars.color.panel,
    color: vars.color.foreground,
});

globalStyle('::-webkit-scrollbar', { width: '8px', height: '8px' });
globalStyle('::-webkit-scrollbar-track', { background: 'transparent' });
globalStyle('::-webkit-scrollbar-thumb', {
    background: vars.color.border,
    borderRadius: '4px',
});
globalStyle('::-webkit-scrollbar-thumb:hover', {
    background: vars.color.borderBright,
});
