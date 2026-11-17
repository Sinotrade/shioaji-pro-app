// src/components/chart-order-popover.css.ts — K 線圖下單設定（#204）

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const anchor = style({
    position: 'relative',
    display: 'inline-flex',
    marginLeft: '2px',
});

const chipBase = style({
    display: 'inline-flex',
    whiteSpace: 'nowrap',
    alignItems: 'center',
    gap: '5px',
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    fontWeight: 500,
    padding: '1px 8px',
    cursor: 'pointer',
    borderRadius: vars.radius.sm,
    border: `1px solid ${vars.color.accentDim}`,
    background: 'transparent',
    color: vars.color.foreground,
    transition: 'all 0.12s',
    ':hover': { borderColor: vars.color.accent },
});

export const chip = styleVariants({
    closed: [chipBase],
    open: [chipBase, { borderColor: vars.color.accent, background: vars.color.muted }],
});

export const chipQty = style({
    fontFamily: vars.font.mono,
    fontWeight: 600,
});

export const backdrop = style({
    position: 'fixed',
    inset: 0,
    zIndex: 40,
});

export const pop = style({
    position: 'absolute',
    top: 'calc(100% + 4px)',
    left: 0,
    zIndex: 41,
    width: '19rem',
    display: 'grid',
    // long contract names must shrink (ellipsis), never widen the popover
    gridTemplateColumns: 'minmax(0, 1fr)',
    gap: '8px',
    padding: '10px',
    fontFamily: vars.font.body,
    fontSize: '0.7rem',
    color: vars.color.foreground,
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.md,
    boxShadow: '0 12px 30px rgba(0, 0, 0, 0.35)',
});

// narrow panels (閃電下單): the popover spans the host row (the nearest
// positioned ancestor) instead of hanging off the button, so it never
// overflows the panel; `top` is set from the button position when opened
export const anchorStatic = style({
    position: 'static',
});

export const popPanel = style({
    left: '6px',
    right: '6px',
    width: 'auto',
    maxWidth: '20rem',
    marginLeft: 'auto',
});

export const head = style({
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: '8px',
    fontWeight: 600,
    fontSize: '0.74rem',
});

export const headTitle = style({
    whiteSpace: 'nowrap',
    flexShrink: 0,
});

export const headNote = style({
    minWidth: 0,
    fontWeight: 400,
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

export const row = style({
    display: 'grid',
    gridTemplateColumns: '3.6rem 1fr',
    alignItems: 'center',
    gap: '6px',
});

export const label = style({
    color: vars.color.mutedForeground,
});

export const seg = style({
    display: 'flex',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    overflow: 'hidden',
});

const segBase = style({
    flex: 1,
    fontFamily: vars.font.body,
    fontSize: '0.68rem',
    padding: '3px 0',
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    borderRight: `1px solid ${vars.color.border}`,
    color: vars.color.mutedForeground,
    selectors: {
        '&:last-child': { borderRight: 'none' },
        '&:disabled': { opacity: 0.45, cursor: 'not-allowed' },
    },
    ':hover': { color: vars.color.foreground },
});

export const segBtn = styleVariants({
    off: [segBase],
    on: [segBase, { background: vars.color.muted, color: vars.color.foreground, fontWeight: 600 }],
});

export const qtyRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
});

export const qtyInput = style({
    width: '4rem',
    fontFamily: vars.font.mono,
    fontSize: '0.72rem',
    fontWeight: 600,
    textAlign: 'right',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '2px 6px',
    outline: 'none',
    ':focus': { borderColor: vars.color.accent },
});

const presetBase = style({
    fontFamily: vars.font.mono,
    fontSize: '0.64rem',
    padding: '1px 6px',
    cursor: 'pointer',
    background: 'transparent',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    ':hover': { color: vars.color.foreground, borderColor: vars.color.borderBright },
});

export const preset = styleVariants({
    off: [presetBase],
    on: [presetBase, { color: vars.color.foreground, borderColor: vars.color.accent }],
});

export const select = style({
    width: '100%',
    fontFamily: vars.font.body,
    fontSize: '0.68rem',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '2px 4px',
    outline: 'none',
    ':focus': { borderColor: vars.color.accent },
});

export const info = style({
    color: vars.color.foreground,
    fontSize: '0.66rem',
});

// a note under a row's control (second grid column)
export const rowNote = style({
    gridColumn: '2',
    color: vars.color.foreground,
    fontSize: '0.66rem',
});

export const summary = style({
    borderTop: `1px solid ${vars.color.border}`,
    paddingTop: '8px',
    color: vars.color.mutedForeground,
    lineHeight: 1.5,
});

export const foot = style({
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '6px',
});

const footBase = style({
    fontFamily: vars.font.body,
    fontSize: '0.68rem',
    padding: '3px 10px',
    cursor: 'pointer',
    borderRadius: vars.radius.sm,
    border: `1px solid ${vars.color.border}`,
    background: 'transparent',
    color: vars.color.foreground,
    ':hover': { borderColor: vars.color.borderBright },
});

export const footBtn = styleVariants({
    normal: [footBase],
    primary: [footBase, { borderColor: vars.color.accent, background: vars.color.muted, fontWeight: 600 }],
});

// 信用條件列下的一句話：零股停用說明、可否融資券狀態
const creditNoteBase = style({
    fontSize: '0.62rem',
    lineHeight: 1.4,
    paddingLeft: 'calc(3.6rem + 6px)',
    color: vars.color.mutedForeground,
});

export const creditNote = styleVariants({
    ok: [creditNoteBase],
    bad: [creditNoteBase, { color: vars.color.danger }],
});

// 信用條件五個選項：依字數分配寬度、不換行（「借券豁免」不折成兩行）
export const segFit = style({
    flex: '1 0 auto',
    padding: '3px 4px',
    whiteSpace: 'nowrap',
});

// 窄面板（彈出層被 popover-fit 縮寬）放不下時整顆換到下一行，不被裁掉
export const segWrap = style({
    flexWrap: 'wrap',
});
