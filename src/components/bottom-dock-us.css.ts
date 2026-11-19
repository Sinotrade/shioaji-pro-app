// src/components/bottom-dock-us.css.ts — 美股下單面板與美股委託／庫存區段

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const header = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.xs,
    flexWrap: 'wrap',
});

/** 「美股」市場徽章：所有美股畫面都標，避免和台股混淆 */
export const marketBadge = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    fontFamily: vars.font.display,
    fontSize: '0.62rem',
    fontWeight: 700,
    letterSpacing: '0.04em',
    padding: '1px 6px',
    borderRadius: vars.radius.sm,
    color: vars.color.accent,
    background: vars.color.accentDim,
    border: `1px solid ${vars.color.accent}`,
    whiteSpace: 'nowrap',
});

export const accountSelect = style({
    flex: 1,
    minWidth: 0,
    fontFamily: vars.font.mono,
    fontSize: '0.7rem',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '3px 6px',
});

export const searchWrap = style({
    position: 'relative',
    flex: 1,
    minWidth: 0,
});

export const searchInput = style({
    width: '100%',
    boxSizing: 'border-box',
    fontFamily: vars.font.mono,
    fontSize: '0.9rem',
    fontWeight: 600,
    textTransform: 'uppercase',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '5px 8px',
    outline: 'none',
    ':focus': { borderColor: vars.color.accent },
});

export const suggestions = style({
    position: 'absolute',
    zIndex: 20,
    top: 'calc(100% + 2px)',
    left: 0,
    right: 0,
    margin: 0,
    padding: 2,
    listStyle: 'none',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.sm,
    boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
    maxHeight: 260,
    overflowY: 'auto',
});

export const suggestion = styleVariants({
    off: {
        display: 'flex',
        alignItems: 'baseline',
        gap: vars.space.sm,
        width: '100%',
        padding: '4px 6px',
        cursor: 'pointer',
        background: 'transparent',
        border: 'none',
        borderRadius: vars.radius.sm,
        color: vars.color.foreground,
        textAlign: 'left',
        ':hover': { background: vars.color.muted },
    },
    on: {
        display: 'flex',
        alignItems: 'baseline',
        gap: vars.space.sm,
        width: '100%',
        padding: '4px 6px',
        cursor: 'pointer',
        background: vars.color.accentDim,
        border: 'none',
        borderRadius: vars.radius.sm,
        color: vars.color.foreground,
        textAlign: 'left',
    },
});

export const suggestionCode = style({
    fontFamily: vars.font.mono,
    fontSize: '0.78rem',
    fontWeight: 700,
    minWidth: '4.5rem',
});

export const suggestionName = style({
    flex: 1,
    minWidth: 0,
    fontSize: '0.7rem',
    color: vars.color.mutedForeground,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

export const suggestionExchange = style({
    fontFamily: vars.font.mono,
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
});

export const infoCard = style({
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    gap: '2px 8px',
    padding: '6px 8px',
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
});

export const infoName = style({
    fontSize: '0.74rem',
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

export const infoMeta = style({
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
});

export const refLabel = style({
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
    textAlign: 'right',
});

export const refValue = style({
    fontFamily: vars.font.mono,
    fontSize: '0.92rem',
    fontWeight: 700,
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
});

export const notice = style({
    display: 'flex',
    alignItems: 'flex-start',
    gap: 6,
    fontSize: '0.7rem',
    lineHeight: 1.45,
    color: vars.color.mutedForeground,
    padding: '6px 8px',
    border: `1px dashed ${vars.color.border}`,
    borderRadius: vars.radius.sm,
});

export const warn = style({
    color: vars.color.amber,
});

export const unit = style({
    fontSize: '0.66rem',
    color: vars.color.mutedForeground,
    flexShrink: 0,
});

export const smallBtn = style({
    fontFamily: vars.font.display,
    fontSize: '0.62rem',
    padding: '3px 6px',
    cursor: 'pointer',
    background: vars.color.muted,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
    ':hover': { borderColor: vars.color.borderBright },
    ':disabled': { opacity: 0.4, cursor: 'not-allowed' },
});

// ---- 委託／庫存區段（底部 dock） ----

export const section = style({
    borderTop: `1px solid ${vars.color.border}`,
    marginTop: vars.space.xs,
    // 用剩下的高度，表格只在這一層捲動（不再巢狀捲動、不被 45% 截斷）
    flex: '0 1 auto',
    minHeight: 0,
    overflowY: 'auto',
});

export const sectionHead = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    padding: '4px 10px',
    fontSize: '0.7rem',
    color: vars.color.mutedForeground,
});

export const hint = style({
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '3px 10px',
    fontSize: '0.68rem',
    color: vars.color.amber,
});

export const table = style({
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.72rem',
});

export const th = style({
    textAlign: 'left',
    fontWeight: 500,
    fontSize: '0.64rem',
    color: vars.color.mutedForeground,
    padding: '3px 8px',
    borderBottom: `1px solid ${vars.color.border}`,
    whiteSpace: 'nowrap',
});

export const td = style({
    padding: '4px 8px',
    borderBottom: `1px solid ${vars.color.border}`,
    whiteSpace: 'nowrap',
    verticalAlign: 'middle',
});

export const num = style({
    fontFamily: vars.font.mono,
    fontVariantNumeric: 'tabular-nums',
    textAlign: 'right',
});

export const actions = style({
    display: 'flex',
    gap: 4,
    justifyContent: 'flex-end',
});

export const inlineInput = style({
    width: '5.5rem',
    fontFamily: vars.font.mono,
    fontSize: '0.72rem',
    textAlign: 'right',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '2px 5px',
    outline: 'none',
    ':focus': { borderColor: vars.color.accent },
});

export const rowError = style({
    fontSize: '0.66rem',
    color: vars.color.danger,
    whiteSpace: 'normal',
});

// ---- 改價兩步對話框 ----

export const backdrop = style({
    position: 'fixed',
    inset: 0,
    zIndex: 1000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,0.45)',
});

export const dialog = style({
    width: 'min(420px, calc(100vw - 32px))',
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    padding: vars.space.md,
    background: vars.color.panel,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.lg,
    boxShadow: '0 12px 36px rgba(0,0,0,0.45)',
    color: vars.color.foreground,
});

export const dialogTitle = style({
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: '0.86rem',
    fontWeight: 700,
});

export const step = styleVariants({
    pending: { display: 'flex', gap: 8, fontSize: '0.74rem', color: vars.color.mutedForeground },
    running: { display: 'flex', gap: 8, fontSize: '0.74rem', color: vars.color.foreground },
    ok: { display: 'flex', gap: 8, fontSize: '0.74rem', color: vars.color.success },
    err: { display: 'flex', gap: 8, fontSize: '0.74rem', color: vars.color.danger },
});

export const dialogActions = style({
    display: 'flex',
    justifyContent: 'flex-end',
    gap: vars.space.sm,
    marginTop: vars.space.xs,
});
