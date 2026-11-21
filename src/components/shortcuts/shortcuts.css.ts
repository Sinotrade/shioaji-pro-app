// src/components/shortcuts/shortcuts.css.ts — 快捷鍵設定頁、提示頁、鍵帽

import { globalStyle, keyframes, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../../theme.css';

const NARROW = 'screen and (max-width: 720px)';

// ── 鍵帽 ──────────────────────────────────────────────────────────────

export const keys = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
});

export const combo = style({ display: 'inline-flex', alignItems: 'center', gap: '2px' });

export const cap = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '1.3rem',
    height: '1.3rem',
    padding: '0 5px',
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    fontWeight: 600,
    lineHeight: 1,
    color: vars.color.foreground,
    background: vars.color.panel,
    border: `1px solid ${vars.color.borderBright}`,
    borderBottomWidth: '2px',
    borderRadius: vars.radius.sm,
    whiteSpace: 'nowrap',
    boxSizing: 'border-box',
});

export const capSm = style({ minWidth: '1.1rem', height: '1.1rem', fontSize: '0.6rem', padding: '0 4px' });

export const capThen = style({ fontSize: '0.6rem', color: vars.color.mutedForeground, margin: '0 1px' });
export const capOr = style({ fontSize: '0.62rem', color: vars.color.mutedForeground, margin: '0 3px' });

export const gesture = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '0.68rem',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
});

export const unset = style({
    fontSize: '0.66rem',
    color: vars.color.mutedForeground,
    border: `1px dashed ${vars.color.borderBright}`,
    borderRadius: vars.radius.sm,
    padding: '2px 8px',
    whiteSpace: 'nowrap',
});

// ── 徽章 ──────────────────────────────────────────────────────────────

const badgeBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    fontSize: '0.6rem',
    fontWeight: 600,
    lineHeight: 1,
    padding: '3px 5px',
    borderRadius: vars.radius.sm,
    whiteSpace: 'nowrap',
    letterSpacing: '0.02em',
});

export const badge = styleVariants({
    risk: [badgeBase, { color: vars.color.amber, background: `color-mix(in srgb, ${vars.color.amber} 12%, transparent)` }],
    danger: [badgeBase, { color: vars.color.danger, background: vars.color.dangerDim }],
    accent: [badgeBase, { color: vars.color.accent, background: vars.color.accentDim }],
    muted: [badgeBase, { color: vars.color.mutedForeground, background: vars.color.muted }],
    ok: [badgeBase, { color: vars.color.success, background: vars.color.successDim }],
});

// ── 共用小元件 ────────────────────────────────────────────────────────

export const searchWrap = style({
    flex: '1 1 auto',
    flexShrink: 0,
    minWidth: 0,
    minHeight: '1.85rem',
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '0 8px',
    height: '1.85rem',
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    selectors: { '&:focus-within': { borderColor: vars.color.accent } },
});

export const searchInput = style({
    flex: 1,
    minWidth: 0,
    border: 'none',
    outline: 'none',
    background: 'transparent',
    color: vars.color.foreground,
    fontFamily: vars.font.body,
    fontSize: '0.74rem',
    '::placeholder': { color: vars.color.mutedForeground },
});

const chipBase = style({
    fontFamily: vars.font.body,
    fontSize: '0.68rem',
    padding: '3px 9px',
    borderRadius: '999px',
    border: `1px solid ${vars.color.border}`,
    background: 'transparent',
    color: vars.color.mutedForeground,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    ':hover': { color: vars.color.foreground, borderColor: vars.color.borderBright },
});

export const chip = styleVariants({
    off: [chipBase],
    on: [chipBase, { color: vars.color.accent, borderColor: vars.color.accent, background: vars.color.accentDim, ':hover': { color: vars.color.accent, borderColor: vars.color.accent } }],
});

export const chipCount = style({ fontFamily: vars.font.mono, fontSize: '0.62rem', opacity: 0.8 });

export const spacer = style({ flex: 1 });

export const textBtn = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    border: 'none',
    background: 'transparent',
    padding: '3px 6px',
    fontFamily: vars.font.body,
    fontSize: '0.68rem',
    color: vars.color.mutedForeground,
    cursor: 'pointer',
    borderRadius: vars.radius.sm,
    whiteSpace: 'nowrap',
    ':hover': { color: vars.color.foreground, background: vars.color.muted },
    ':disabled': { opacity: 0.45, cursor: 'default', background: 'transparent', color: vars.color.mutedForeground },
});

export const iconBtn = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '1.45rem',
    height: '1.45rem',
    border: 'none',
    background: 'transparent',
    color: vars.color.mutedForeground,
    borderRadius: vars.radius.sm,
    cursor: 'pointer',
    flexShrink: 0,
    ':hover': { color: vars.color.foreground, background: vars.color.muted },
});

const actBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    fontFamily: vars.font.body,
    fontSize: '0.68rem',
    fontWeight: 600,
    padding: '4px 10px',
    borderRadius: vars.radius.sm,
    cursor: 'pointer',
    border: '1px solid transparent',
    whiteSpace: 'nowrap',
});

export const act = styleVariants({
    ghost: [actBase, { background: 'transparent', borderColor: vars.color.border, color: vars.color.foreground, ':hover': { borderColor: vars.color.borderBright } }],
    primary: [actBase, { background: vars.color.accent, color: '#fff', ':hover': { filter: 'brightness(1.08)' } }],
    danger: [actBase, { background: vars.color.dangerSolid, color: '#fff', ':hover': { filter: 'brightness(1.08)' } }],
});

// ── 設定頁 ────────────────────────────────────────────────────────────

export const settings = style({ display: 'flex', flexDirection: 'column', gap: vars.space.sm, minWidth: 0 });

export const lead = style({
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '8px 10px',
    flexShrink: 0,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
    background: `linear-gradient(135deg, ${vars.color.accentDim}, transparent 70%), ${vars.color.inset}`,
});

export const leadIcon = style({
    display: 'grid',
    placeItems: 'center',
    width: '1.8rem',
    height: '1.8rem',
    borderRadius: vars.radius.md,
    background: vars.color.accentDim,
    color: vars.color.accent,
    flexShrink: 0,
});

export const leadText = style({ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0, flex: 1 });
export const leadTitle = style({ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', fontSize: '0.74rem', fontWeight: 600, color: vars.color.foreground });
export const leadSub = style({ fontSize: '0.66rem', color: vars.color.mutedForeground });

export const toolbar = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    position: 'sticky',
    top: 0,
    zIndex: 2,
    background: vars.color.panelRaised,
    paddingBottom: '4px',
});

export const chips = style({ display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' });

export const group = style({ display: 'flex', flexDirection: 'column' });

export const groupHead = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '10px 2px 4px',
    fontFamily: vars.font.display,
    fontSize: '0.62rem',
    fontWeight: 600,
    letterSpacing: '0.06em',
    color: vars.color.mutedForeground,
    borderBottom: `1px solid ${vars.color.border}`,
});

export const groupCount = style({ fontFamily: vars.font.mono, fontWeight: 500, opacity: 0.7 });

export const row = style({
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto 1.45rem',
    alignItems: 'center',
    gap: '8px',
    padding: '7px 4px 7px 6px',
    borderBottom: `1px solid ${vars.color.border}`,
    borderRadius: 0,
    transition: 'background 0.12s',
    ':hover': { background: `color-mix(in srgb, ${vars.color.muted} 55%, transparent)` },
});

export const rowActive = style({ background: vars.color.accentDim, ':hover': { background: vars.color.accentDim } });
export const rowChanged = style({ boxShadow: `inset 2px 0 0 ${vars.color.accent}` });

export const rowText = style({ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 });
export const rowLabel = style({ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', fontSize: '0.74rem', color: vars.color.foreground });
export const rowHint = style({ fontSize: '0.64rem', lineHeight: 1.45, color: vars.color.mutedForeground });
export const rowDim = style({ opacity: 0.62 });

export const keyBtn = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '3px 4px 3px 6px',
    border: '1px solid transparent',
    borderRadius: vars.radius.sm,
    background: 'transparent',
    cursor: 'pointer',
    color: vars.color.mutedForeground,
    ':hover': { borderColor: vars.color.borderBright, background: vars.color.inset },
    ':focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: '1px' },
    ':disabled': { cursor: 'default', borderColor: 'transparent', background: 'transparent' },
});

export const editGlyph = style({ opacity: 0, transition: 'opacity 0.12s', color: vars.color.mutedForeground });
globalStyle(`${keyBtn}:hover:not(:disabled) ${editGlyph}, ${keyBtn}:focus-visible ${editGlyph}`, { opacity: 1 });

const pulse = keyframes({
    '0%, 100%': { boxShadow: `0 0 0 0 ${vars.color.accentDim}` },
    '50%': { boxShadow: `0 0 0 4px ${vars.color.accentDim}` },
});

export const recording = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 10px',
    fontFamily: vars.font.body,
    fontSize: '0.68rem',
    fontWeight: 600,
    color: vars.color.accent,
    background: vars.color.panel,
    border: `1px solid ${vars.color.accent}`,
    borderRadius: vars.radius.sm,
    cursor: 'pointer',
    animation: `${pulse} 1.4s ease-in-out infinite`,
    whiteSpace: 'nowrap',
});

export const recDot = style({ width: '6px', height: '6px', borderRadius: '50%', background: vars.color.accent });

export const lockCell = style({ display: 'grid', placeItems: 'center', color: vars.color.mutedForeground, opacity: 0.6 });

const noticeBase = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    margin: '4px 6px 6px',
    padding: '8px 10px',
    fontSize: '0.68rem',
    lineHeight: 1.5,
    borderRadius: vars.radius.sm,
    border: '1px solid',
});

export const notice = styleVariants({
    block: [noticeBase, { color: vars.color.danger, borderColor: `color-mix(in srgb, ${vars.color.danger} 40%, transparent)`, background: vars.color.dangerDim }],
    warn: [noticeBase, { color: vars.color.foreground, borderColor: `color-mix(in srgb, ${vars.color.amber} 45%, transparent)`, background: `color-mix(in srgb, ${vars.color.amber} 9%, transparent)` }],
    info: [noticeBase, { color: vars.color.foreground, borderColor: vars.color.border, background: vars.color.inset }],
});

export const noticeHead = style({ display: 'flex', alignItems: 'flex-start', gap: '6px', fontWeight: 600 });
export const noticeIcon = style({ flexShrink: 0, marginTop: '2px' });
export const noticeIconWarn = style({ color: vars.color.amber });
export const noticeNote = style({ color: vars.color.mutedForeground, paddingLeft: '18px' });
export const noticeActions = style({ display: 'flex', gap: '6px', justifyContent: 'flex-end' });

export const inlineSwitch = style({ display: 'inline-flex', alignItems: 'center', gap: '6px' });

export const foot = style({
    display: 'flex',
    alignItems: 'flex-start',
    gap: '6px',
    padding: '10px 4px 2px',
    fontSize: '0.64rem',
    lineHeight: 1.5,
    color: vars.color.mutedForeground,
});

export const empty = style({
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '6px',
    padding: '28px 0',
    fontSize: '0.72rem',
    color: vars.color.mutedForeground,
});

// ── 提示頁 ────────────────────────────────────────────────────────────

const fadeIn = keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });
const rise = keyframes({ from: { opacity: 0, transform: 'translate(-50%, 8px) scale(0.985)' }, to: { opacity: 1, transform: 'translate(-50%, 0) scale(1)' } });

export const overlay = style({
    position: 'fixed',
    inset: 0,
    zIndex: 260,
    background: 'rgba(0, 0, 0, 0.5)',
    backdropFilter: 'blur(2px)',
    animation: `${fadeIn} 0.12s ease-out`,
});

export const sheet = style({
    position: 'fixed',
    top: '6vh',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 261,
    width: 'min(60rem, calc(100vw - 32px))',
    maxHeight: '86vh',
    display: 'flex',
    flexDirection: 'column',
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.lg,
    background: vars.color.panelRaised,
    boxShadow: '0 24px 64px rgba(0, 0, 0, 0.5)',
    overflow: 'hidden',
    animation: `${rise} 0.16s cubic-bezier(0.2, 0.8, 0.2, 1)`,
});

export const sheetHead = style({
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '12px 14px',
    borderBottom: `1px solid ${vars.color.border}`,
    '@media': { [NARROW]: { flexWrap: 'wrap' } },
});

export const sheetTitle = style({
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '0.86rem',
    fontWeight: 600,
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
});

export const sheetTitleIcon = style({
    display: 'grid',
    placeItems: 'center',
    width: '1.7rem',
    height: '1.7rem',
    borderRadius: vars.radius.md,
    background: vars.color.accentDim,
    color: vars.color.accent,
});

export const context = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    fontSize: '0.66rem',
    color: vars.color.foreground,
    padding: '4px 9px',
    borderRadius: '999px',
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    whiteSpace: 'nowrap',
});

export const contextDot = style({ width: '6px', height: '6px', borderRadius: '50%', background: vars.color.success });

export const sheetBody = style({
    overflowY: 'auto',
    padding: '12px 14px 14px',
    columnCount: 3,
    columnGap: '14px',
    '@media': {
        'screen and (max-width: 1080px)': { columnCount: 2 },
        [NARROW]: { columnCount: 1 },
    },
});

export const card = style({
    breakInside: 'avoid',
    display: 'flex',
    flexDirection: 'column',
    marginBottom: '14px',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
    background: vars.color.panel,
    overflow: 'hidden',
});

export const cardLead = style({ borderColor: `color-mix(in srgb, ${vars.color.accent} 55%, ${vars.color.border})`, boxShadow: `0 0 0 1px ${vars.color.accentDim}` });

export const cardHead = style({
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    padding: '8px 10px',
    fontSize: '0.7rem',
    fontWeight: 600,
    color: vars.color.foreground,
    borderBottom: `1px solid ${vars.color.border}`,
    background: vars.color.inset,
});

export const cardIcon = style({ color: vars.color.mutedForeground, display: 'inline-flex' });

export const helpRow = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '10px',
    padding: '6px 10px',
    fontSize: '0.7rem',
    color: vars.color.foreground,
    selectors: { '& + &': { borderTop: `1px solid color-mix(in srgb, ${vars.color.border} 60%, transparent)` } },
});

export const helpRowDim = style({ color: vars.color.mutedForeground });
globalStyle(`${helpRowDim} ${cap}`, { opacity: 0.55 });

export const helpLabel = style({ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap', minWidth: 0 });
export const helpWhy = style({ fontSize: '0.6rem', color: vars.color.mutedForeground });
export const riskGlyph = style({ color: vars.color.amber, display: 'inline-flex' });

export const sheetFoot = style({
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    flexWrap: 'wrap',
    padding: '9px 14px',
    fontSize: '0.66rem',
    color: vars.color.mutedForeground,
    borderTop: `1px solid ${vars.color.border}`,
    background: vars.color.inset,
});

export const footItem = style({ display: 'inline-flex', alignItems: 'center', gap: '5px' });

export const footSafety = style({ display: 'inline-flex', alignItems: 'center', gap: '5px', color: vars.color.mutedForeground });

// ── 下單面板的 B／S 提示 ──────────────────────────────────────────────

export const ticketCap = style({
    marginLeft: '6px',
    verticalAlign: '1px',
});
