// src/components/order-confirm-dialog.css.ts — 可視化委託確認 modal

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const overlay = style({
    position: 'fixed',
    inset: 0,
    zIndex: 2200,
    background: 'rgba(0, 0, 0, 0.45)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
});

export const dialog = style({
    display: 'flex',
    flexDirection: 'column',
    width: 'min(21rem, 92vw)',
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
    fontSize: '0.82rem',
    fontWeight: 600,
    color: vars.color.foreground,
});

export const envBadge = styleVariants({
    sim: {
        fontSize: '0.66rem',
        fontWeight: 600,
        padding: '2px 8px',
        borderRadius: vars.radius.sm,
        color: vars.color.mutedForeground,
        border: `1px solid ${vars.color.border}`,
    },
    prod: {
        fontSize: '0.66rem',
        fontWeight: 600,
        padding: '2px 8px',
        borderRadius: vars.radius.sm,
        color: vars.color.down,
        border: `1px solid ${vars.color.down}`,
    },
});

export const body = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: `0 ${vars.space.lg} ${vars.space.md}`,
});

export const actionLine = styleVariants({
    up: {
        display: 'flex',
        alignItems: 'baseline',
        gap: '8px',
        fontFamily: vars.font.display,
        fontSize: '1.05rem',
        fontWeight: 700,
        color: vars.color.up,
    },
    down: {
        display: 'flex',
        alignItems: 'baseline',
        gap: '8px',
        fontFamily: vars.font.display,
        fontSize: '1.05rem',
        fontWeight: 700,
        color: vars.color.down,
    },
});

export const contractName = style({
    fontSize: '0.9rem',
    fontWeight: 600,
    color: vars.color.foreground,
});

export const detailRow = style({
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '0.78rem',
    color: vars.color.mutedForeground,
});

export const detailValue = style({
    fontFamily: vars.font.mono,
    fontVariantNumeric: 'tabular-nums',
    color: vars.color.foreground,
});

export const note = style({
    fontSize: '0.72rem',
    color: vars.color.mutedForeground,
});

export const footer = style({
    display: 'flex',
    gap: '8px',
    padding: `${vars.space.md} ${vars.space.lg}`,
    borderTop: `1px solid ${vars.color.border}`,
});

export const cancelBtn = style({
    flex: 1,
    fontFamily: vars.font.display,
    fontSize: '0.78rem',
    fontWeight: 600,
    color: vars.color.foreground,
    background: vars.color.muted,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '8px 0',
    cursor: 'pointer',
    ':hover': { borderColor: vars.color.borderBright },
});

export const confirmBtn = styleVariants({
    up: {
        flex: 2,
        fontFamily: vars.font.display,
        fontSize: '0.78rem',
        fontWeight: 700,
        color: '#fff',
        background: vars.color.up,
        border: 'none',
        borderRadius: vars.radius.sm,
        padding: '8px 0',
        cursor: 'pointer',
        ':hover': { filter: 'brightness(1.1)' },
    },
    down: {
        flex: 2,
        fontFamily: vars.font.display,
        fontSize: '0.78rem',
        fontWeight: 700,
        color: '#fff',
        background: vars.color.down,
        border: 'none',
        borderRadius: vars.radius.sm,
        padding: '8px 0',
        cursor: 'pointer',
        ':hover': { filter: 'brightness(1.1)' },
    },
});
