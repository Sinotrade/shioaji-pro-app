// src/components/realized-pnl-dialog.css.ts — historical realized P&L dialog
// (date-range query + summary + detail table). Shares the overlay/dialog
// shell convention used by indicator-dialog.css.ts.

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const overlay = style({
    position: 'fixed',
    inset: 0,
    zIndex: 2000,
    background: 'rgba(0, 0, 0, 0.45)',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingTop: '8vh',
});

export const dialog = style({
    display: 'flex',
    flexDirection: 'column',
    width: 'min(52rem, 94vw)',
    maxHeight: 'min(38rem, 82vh)',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.lg,
    boxShadow: '0 24px 64px rgba(0, 0, 0, 0.5)',
    overflow: 'hidden',
});

export const header = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: `${vars.space.md} ${vars.space.lg}`,
    fontFamily: vars.font.display,
    fontSize: '0.9rem',
    fontWeight: 600,
    color: vars.color.foreground,
});

export const closeBtn = style({
    display: 'inline-flex',
    alignItems: 'center',
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    color: vars.color.mutedForeground,
    padding: '4px',
    borderRadius: vars.radius.sm,
    ':hover': { color: vars.color.foreground, background: vars.color.muted },
});

export const toolbar = style({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '8px',
    padding: `0 ${vars.space.lg} ${vars.space.md}`,
    borderBottom: `1px solid ${vars.color.border}`,
    paddingBottom: vars.space.md,
});

export const dateLabel = style({
    fontFamily: vars.font.body,
    fontSize: '0.7rem',
    color: vars.color.mutedForeground,
});

export const dateInput = style({
    fontFamily: vars.font.mono,
    fontSize: '0.74rem',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '4px 6px',
    outline: 'none',
    ':focus': { borderColor: vars.color.accent },
});

const presetBtnBase = style({
    fontFamily: vars.font.body,
    fontSize: '0.7rem',
    cursor: 'pointer',
    background: 'transparent',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.foreground,
    padding: '4px 9px',
    ':hover': { borderColor: vars.color.borderBright },
});

export const presetBtn = styleVariants({
    normal: [presetBtnBase],
    active: [
        presetBtnBase,
        { borderColor: vars.color.accent, color: vars.color.accent },
    ],
});

export const spacer = style({ flex: 1 });

export const queryBtn = style({
    fontFamily: vars.font.body,
    fontSize: '0.74rem',
    fontWeight: 600,
    cursor: 'pointer',
    background: vars.color.accent,
    border: `1px solid ${vars.color.accent}`,
    color: '#0b0e14',
    borderRadius: vars.radius.sm,
    padding: '5px 14px',
    ':hover': { opacity: 0.9 },
    ':disabled': { opacity: 0.5, cursor: 'default' },
});

export const summaryBar = style({
    display: 'flex',
    alignItems: 'baseline',
    gap: '10px',
    padding: `${vars.space.sm} ${vars.space.lg}`,
    borderBottom: `1px solid ${vars.color.border}`,
    fontFamily: vars.font.body,
    fontSize: '0.76rem',
    color: vars.color.mutedForeground,
});

export const summaryTotal = style({
    fontFamily: vars.font.mono,
    fontSize: '1.05rem',
    fontWeight: 700,
});

export const body = style({
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
});

export const table = style({
    width: '100%',
    borderCollapse: 'collapse',
});

export const th = style({
    position: 'sticky',
    top: 0,
    zIndex: 1,
    textAlign: 'right',
    fontFamily: vars.font.display,
    fontSize: '0.62rem',
    fontWeight: 600,
    letterSpacing: '0.04em',
    color: vars.color.mutedForeground,
    background: vars.color.panelRaised,
    padding: '6px 10px',
    borderBottom: `1px solid ${vars.color.border}`,
    selectors: { '&:first-child': { textAlign: 'left' } },
});

export const td = style({
    textAlign: 'right',
    fontFamily: vars.font.mono,
    fontSize: '0.76rem',
    color: vars.color.foreground,
    padding: '6px 10px',
    borderBottom: `1px solid ${vars.color.border}`,
    whiteSpace: 'nowrap',
    selectors: { '&:first-child': { textAlign: 'left', fontFamily: vars.font.body } },
});

export const nameCell = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
});

export const nameCode = style({
    fontFamily: vars.font.mono,
    fontSize: '0.76rem',
});

export const nameLabel = style({
    fontFamily: vars.font.body,
    fontSize: '0.64rem',
    color: vars.color.mutedForeground,
});

export const empty = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '12rem',
    fontFamily: vars.font.body,
    fontSize: '0.78rem',
    color: vars.color.mutedForeground,
});

export const errorMsg = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '12rem',
    fontFamily: vars.font.body,
    fontSize: '0.78rem',
    color: vars.color.danger,
    padding: `0 ${vars.space.lg}`,
    textAlign: 'center',
});

export const footer = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: `${vars.space.sm} ${vars.space.lg}`,
    borderTop: `1px solid ${vars.color.border}`,
    fontFamily: vars.font.body,
    fontSize: '0.64rem',
    color: vars.color.mutedForeground,
});

export const openBtn = style({
    fontFamily: vars.font.body,
    fontSize: '0.68rem',
    cursor: 'pointer',
    background: 'transparent',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    padding: '3px 8px',
    ':hover': { borderColor: vars.color.borderBright, color: vars.color.foreground },
});
