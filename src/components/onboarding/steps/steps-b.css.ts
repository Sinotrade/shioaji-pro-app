// src/components/onboarding/steps/steps-b.css.ts — Plan / Creating / Done / Stopped steps.
// 字級沿用原本的 API Key 表單（標籤 0.72rem、提示 0.75rem、輸入框 38px）；色彩只用 theme tokens。
// 表單語彙（layout.md 的 grouped form）：卡片 16px → 群組 10px → 控制項 8px → 分段選取 7px；間距走 8px 節奏。

import { globalStyle, keyframes, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../../theme.css';
import { linkText } from '../login-glass.css';

const CONTROL = '38px';
const COMPACT = '30px';

export const radius = { group: 10, control: 8, thumb: 7 } as const;
export const hairline = `1px solid color-mix(in srgb, ${vars.color.foreground} 8%, transparent)`;
// inset group: a standard-material-like fill inside the glass card (no second backdrop blur)
export const groupFill = `light-dark(rgba(255, 255, 255, 0.55), color-mix(in srgb, ${vars.color.foreground} 4%, transparent))`;

export const focusRing = {
    outline: `2px solid ${vars.color.accent}`,
    outlineOffset: 2,
} as const;

// text fields: accent border plus a soft ring; the transparent outline still shows in forced-colors mode
export const fieldFocus = {
    borderColor: vars.color.accent,
    outline: '2px solid transparent',
    boxShadow: `0 0 0 3px color-mix(in srgb, ${vars.color.accent} 28%, transparent)`,
} as const;

// step changes cross-fade the new content in once
const fade = keyframes({ from: { opacity: 0 } });
export const stepFade = {
    animation: `${fade} 150ms ease-out`,
    '@media': { '(prefers-reduced-motion: reduce)': { animation: 'none' } },
} as const;

// theme 沒有 danger/amber 的淡色 token，沿用既有 onboarding.css 的 rgba 做法。
// 淡色底上的文字一律用 foreground：danger / success 色在淺色主題的淡底上對比不到 4.5:1。
const tint = {
    danger: 'rgba(239, 68, 68, 0.1)',
    dangerLine: 'rgba(239, 68, 68, 0.45)',
    warn: 'rgba(224, 164, 60, 0.12)',
    warnLine: 'rgba(224, 164, 60, 0.45)',
    ok: 'rgba(34, 197, 94, 0.1)',
    okLine: 'rgba(34, 197, 94, 0.4)',
} as const;

export const srOnly = style({
    position: 'absolute',
    width: 1,
    height: 1,
    margin: -1,
    padding: 0,
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
    border: 0,
});

// ── layout & type ────────────────────────────────────────────────

export const root = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    minWidth: 0,
    fontFamily: vars.font.body,
    color: vars.color.foreground,
    ...stepFade,
});

export const header = style({ display: 'flex', flexDirection: 'column', gap: '4px' });

export const heading = style({ display: 'flex', alignItems: 'center', gap: '8px' });

export const title = style({
    margin: 0,
    fontFamily: vars.font.display,
    fontSize: '1rem',
    fontWeight: 700,
    lineHeight: 1.35,
    selectors: { '&:focus:not(:focus-visible)': { outline: 'none' } },
});

const headIconBase = style({ flexShrink: 0 });

export const headIcon = styleVariants({
    accent: [headIconBase, { color: vars.color.accent }],
    ok: [headIconBase, { color: vars.color.success }],
    warn: [headIconBase, { color: vars.color.amber }],
});

export const lead = style({
    margin: 0,
    fontSize: '0.8125rem',
    lineHeight: 1.5,
    color: vars.color.mutedForeground,
});

export const sectionTitle = style({
    margin: '4px 0 0',
    fontFamily: vars.font.display,
    fontSize: '0.8125rem',
    fontWeight: 700,
    lineHeight: 1.4,
});

export const hint = style({
    margin: 0,
    fontSize: '0.75rem',
    lineHeight: 1.5,
    color: vars.color.mutedForeground,
});

export const fieldError = style({
    margin: 0,
    fontSize: '0.75rem',
    lineHeight: 1.45,
    fontWeight: 600,
    color: vars.color.danger,
});

// quiet section header above a group (the label stays a <label>/<legend>; a rendered legend ignores gap, so margins space it)
export const label = style({
    padding: 0,
    fontFamily: vars.font.display,
    fontSize: '0.72rem',
    fontWeight: 600,
    letterSpacing: '0.04em',
    color: vars.color.mutedForeground,
});

export const sectionLabel = style([label, { display: 'block', marginBottom: '6px' }]);

export const labelRow = style({ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px', marginBottom: '6px' });

export const section = style({ display: 'flex', flexDirection: 'column', minWidth: 0, margin: 0, padding: 0, border: 0 });

// group footers: hints and errors directly under their group
export const footer = style([hint, { marginTop: '6px' }]);
export const footerError = style([fieldError, { marginTop: '6px' }]);

export const plainList = style({ display: 'grid', gap: '2px', margin: 0, padding: 0, listStyle: 'none' });

export const input = style({
    boxSizing: 'border-box',
    width: '100%',
    height: CONTROL,
    padding: '0 11px',
    fontFamily: vars.font.mono,
    fontSize: '0.82rem',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: radius.control,
    // 不指定 color-scheme：沿用 theme-store 設在 <html> 的深淺色，原生日期選單才讀得清楚。
    selectors: {
        '&:focus-visible': fieldFocus,
        '&[aria-invalid="true"]': { borderColor: vars.color.danger },
    },
});

// ── groups ───────────────────────────────────────────────────────

const groupBase = style({
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    background: groupFill,
    border: hairline,
    borderRadius: radius.group,
    '@media': { '(prefers-contrast: more)': { borderColor: vars.color.borderBright } },
});

export const group = styleVariants({
    rows: [groupBase, { padding: '6px 12px' }],
    field: [groupBase, { padding: '8px' }],
    inline: [groupBase, { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: '8px', padding: '8px' }],
});

// a row that starts under a hairline
export const divided = style({ marginTop: '6px', paddingTop: '6px', borderTop: hairline });

// subordinate content, indented to the parent row's label (16px box + 10px gap)
const INDENT = '26px';
export const sub = style({ display: 'grid', gap: '8px', minWidth: 0, padding: `2px 0 6px ${INDENT}` });
export const subRow = style({ display: 'grid', gap: '2px', minWidth: 0, margin: `6px 0 0 ${INDENT}`, padding: '2px 0', borderTop: hairline });
export const subError = style([fieldError, { padding: `0 0 4px ${INDENT}` }]);

// ── choices ──────────────────────────────────────────────────────

export const checkRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    minHeight: '28px',
    fontSize: '0.8125rem',
    lineHeight: 1.45,
    cursor: 'pointer',
});

// long labels wrap: the box stays on the first line
export const checkRowTop = style([checkRow, { alignItems: 'flex-start', paddingBlock: '4px' }]);

export const control = style({
    flexShrink: 0,
    width: 16,
    height: 16,
    margin: 0,
    accentColor: vars.color.accent,
    cursor: 'inherit',
    selectors: {
        '&:focus-visible': focusRing,
        // same font size as the label, so 1.45em is the first line box
        [`${checkRowTop} &`]: { fontSize: 'inherit', marginTop: 'calc((1.45em - 16px) / 2)' },
    },
});

// 權限 2x2；帳戶一排，窄螢幕自動換行。
export const checkGrid = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: '4px 12px',
});

export const checkFlow = style({ display: 'flex', flexWrap: 'wrap', gap: '4px 18px' });

export const ipRow = style({ display: 'flex', gap: '8px', alignItems: 'center' });

export const chipRow = style({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' });

export const grow = style({ flex: '2 1 8rem', width: 'auto', '@media': { '(max-width: 480px)': { flexBasis: '100%' } } });

// 到期日的快速選項：一條圓角軌道、等寬分段，與目前日期相符的那段呈選取狀態（aria-pressed）
export const segmented = style({
    display: 'grid',
    gridAutoFlow: 'column',
    gridAutoColumns: '1fr',
    flex: '1 0 auto', // fills the row once it wraps under the date
    boxSizing: 'border-box',
    height: CONTROL,
    padding: '1px',
    gap: '1px',
    background: vars.color.inset,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: radius.control,
});

export const segment = style({
    minWidth: 0,
    padding: '0 10px',
    fontFamily: vars.font.body,
    fontSize: '0.8125rem',
    fontWeight: 500,
    whiteSpace: 'nowrap',
    color: vars.color.foreground,
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: radius.thumb,
    cursor: 'pointer',
    selectors: {
        '&:hover:not([aria-pressed="true"])': { background: `color-mix(in srgb, ${vars.color.foreground} 6%, transparent)` },
        '&[aria-pressed="true"]': {
            fontWeight: 600,
            background: `light-dark(${vars.color.panel}, ${vars.color.panelRaised})`,
            borderColor: vars.color.borderBright,
            boxShadow: '0 1px 2px rgba(0, 0, 0, 0.16)',
        },
        '&:focus-visible': { ...focusRing, outlineOffset: 1 },
    },
});

// ── buttons ──────────────────────────────────────────────────────

const btnBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    minHeight: CONTROL,
    boxSizing: 'border-box',
    padding: '0 16px',
    fontFamily: vars.font.display,
    fontSize: '0.875rem',
    fontWeight: 700,
    textDecoration: 'none',
    cursor: 'pointer',
    borderRadius: radius.control,
    border: '1px solid transparent',
    selectors: {
        '&:focus-visible': focusRing,
        '&:disabled': { opacity: 0.5, cursor: 'not-allowed' },
    },
});

export const btn = styleVariants({
    // the one prominent action per step (buttons.md): accent fill, 40px, group radius
    primary: [btnBase, { height: 40, borderRadius: radius.group, color: vars.color.panelRaised, background: vars.color.accent }],
    outline: [
        btnBase,
        {
            color: vars.color.foreground,
            background: 'transparent',
            borderColor: vars.color.borderBright,
            selectors: { '&:hover:not(:disabled)': { borderColor: vars.color.accent } },
        },
    ],
    compact: [
        btnBase,
        {
            flexShrink: 0,
            minHeight: COMPACT,
            padding: '0 12px',
            fontSize: '0.8125rem',
            whiteSpace: 'nowrap',
            color: vars.color.foreground,
            background: 'transparent',
            borderColor: vars.color.borderBright,
            selectors: { '&:hover:not(:disabled)': { borderColor: vars.color.accent } },
        },
    ],
});

export const textBtn = style({
    alignSelf: 'flex-start',
    justifySelf: 'start',
    minHeight: '28px',
    padding: '0 4px',
    marginLeft: '-4px',
    fontSize: '0.8125rem',
    color: linkText,
    textDecoration: 'underline',
    textUnderlineOffset: 4,
    cursor: 'pointer',
    background: 'transparent',
    border: 0,
    borderRadius: radius.thumb,
    selectors: { '&:focus-visible': focusRing },
});

export const actions = style({ display: 'grid', gap: '8px', marginTop: '8px' });

export const fitContent = style({ alignSelf: 'flex-start' });

// ── banners ──────────────────────────────────────────────────────

const bannerBase = style({
    display: 'flex',
    alignItems: 'flex-start',
    gap: '10px',
    margin: 0,
    padding: '10px 12px',
    fontSize: '0.78rem',
    lineHeight: 1.5,
    color: vars.color.foreground,
    borderRadius: radius.group,
    border: '1px solid transparent',
});

export const banner = styleVariants({
    info: [bannerBase, { background: vars.color.inset, borderColor: vars.color.border }],
    warn: [bannerBase, { background: tint.warn, borderColor: tint.warnLine }],
    ok: [bannerBase, { background: tint.ok, borderColor: tint.okLine }],
    danger: [bannerBase, { background: tint.danger, borderColor: tint.dangerLine, fontWeight: 600 }],
});

export const bannerTitle = style({ display: 'block', fontWeight: 700, marginBottom: '2px' });

// ── summary list: an inset group with hairline-separated rows ────

export const summary = style({
    display: 'grid',
    gridTemplateColumns: 'max-content minmax(0, 1fr)',
    margin: 0,
    padding: '0 12px',
    fontSize: '0.8125rem',
    lineHeight: 1.5,
    background: groupFill,
    border: hairline,
    borderRadius: radius.group,
});

globalStyle(`${summary} dt, ${summary} dd`, { padding: '7px 0' });
globalStyle(`${summary} dt`, { paddingRight: '16px', color: vars.color.mutedForeground });
globalStyle(`${summary} dd`, { margin: 0, minWidth: 0, overflowWrap: 'anywhere' });
globalStyle(`${summary} dt:not(:first-child), ${summary} dt:not(:first-child) + dd`, { borderTop: hairline });

export const mono = style({ fontFamily: vars.font.mono, overflowWrap: 'anywhere' });

export const list = style({
    display: 'grid',
    gap: '6px',
    margin: 0,
    paddingLeft: '18px',
    fontSize: '0.78rem',
    lineHeight: 1.55,
    color: vars.color.mutedForeground,
});

export const link = style({
    color: linkText,
    whiteSpace: 'nowrap',
    textDecoration: 'underline',
    textUnderlineOffset: 4,
    selectors: { '&:focus-visible': focusRing },
});

// ── creating ─────────────────────────────────────────────────────

const spin = keyframes({ to: { transform: 'rotate(360deg)' } });

export const spinner = style({
    flexShrink: 0,
    color: vars.color.accent,
    animation: `${spin} 1s linear infinite`,
    '@media': { '(prefers-reduced-motion: reduce)': { animation: 'none' } },
});

export const progress = style({
    display: 'grid',
    gap: '12px',
    margin: 0,
    padding: 0,
    listStyle: 'none',
    fontSize: '0.8125rem',
});

export const progressItem = style({ display: 'flex', alignItems: 'center', gap: '12px' });

export const progressMark = style({ display: 'grid', placeItems: 'center', flexShrink: 0, width: 20, height: 20 });

export const dim = style({ color: vars.color.mutedForeground });

// ── done ─────────────────────────────────────────────────────────

export const secretPanel = style({
    display: 'grid',
    gap: '12px',
    padding: '12px',
    border: `1px solid ${tint.dangerLine}`,
    borderRadius: radius.group,
    background: tint.danger,
});

export const panelWarning = style({
    margin: 0,
    fontSize: '0.78rem',
    lineHeight: 1.5,
    fontWeight: 700,
});

export const keyRow = style({ display: 'grid', gap: '6px', minWidth: 0 });

export const keyHead = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: '2px 8px',
});

export const varName = style({
    fontFamily: vars.font.mono,
    fontSize: '0.72rem',
    color: vars.color.mutedForeground,
});

// 金鑰值獨佔一行，按鈕排在下一行：窄螢幕不會把值擠成一小條。
const keyValueBase = style({
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
    minHeight: CONTROL,
    boxSizing: 'border-box',
    padding: '8px 10px',
    fontFamily: vars.font.mono,
    fontSize: '0.76rem',
    lineHeight: 1.4,
    wordBreak: 'break-all',
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: radius.control,
});

export const keyValue = styleVariants({
    masked: [keyValueBase, { userSelect: 'none', color: vars.color.mutedForeground, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'clip' }],
    shown: [keyValueBase, { userSelect: 'all' }],
});

export const keyActions = style({ display: 'flex', flexWrap: 'wrap', gap: '8px' });

// 「複製」與「已複製」等寬，切換文字時按鈕不縮放。
export const copyBtn = style({ minWidth: '5.75rem' });

// 永遠渲染，內容只換字，下方版面不會被推動。
export const notice = style({
    margin: 0,
    minHeight: '2.6em',
    fontSize: '0.75rem',
    lineHeight: 1.45,
    color: vars.color.mutedForeground,
});

export const noticeAlert = style({ color: vars.color.danger, fontWeight: 600 });
