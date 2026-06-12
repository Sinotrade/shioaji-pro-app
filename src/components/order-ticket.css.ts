// src/components/order-ticket.css.ts

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const body = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    padding: vars.space.md,
});

export const sideTabs = style({
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: vars.space.xs,
});

const sideBase = style({
    fontFamily: vars.font.display,
    fontSize: '0.8rem',
    fontWeight: 700,
    letterSpacing: '0.04em',
    padding: '7px 0',
    cursor: 'pointer',
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    transition: 'all 0.12s',
});

export const buyTab = styleVariants({
    off: [sideBase, { ':hover': { color: vars.color.up } }],
    on: [
        sideBase,
        {
            color: '#fff',
            background: vars.color.up,
            borderColor: vars.color.up,
        },
    ],
});

export const sellTab = styleVariants({
    off: [sideBase, { ':hover': { color: vars.color.down } }],
    on: [
        sideBase,
        {
            color: '#fff',
            background: vars.color.down,
            borderColor: vars.color.down,
        },
    ],
});

export const fieldRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.xs,
});

export const fieldLabel = style({
    width: '3.4rem',
    fontFamily: vars.font.display,
    fontSize: '0.66rem',
    fontWeight: 500,
    color: vars.color.mutedForeground,
    flexShrink: 0,
});

export const numInput = style({
    flex: 1,
    minWidth: 0,
    fontFamily: vars.font.mono,
    fontSize: '0.92rem',
    fontWeight: 600,
    textAlign: 'right',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '5px 8px',
    outline: 'none',
    fontVariantNumeric: 'tabular-nums',
    ':focus': {
        borderColor: vars.color.accent,
    },
});

export const stepBtn = style({
    fontFamily: vars.font.mono,
    fontSize: '0.8rem',
    fontWeight: 600,
    width: '26px',
    height: '30px',
    cursor: 'pointer',
    background: vars.color.muted,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.foreground,
    ':hover': {
        borderColor: vars.color.borderBright,
        background: vars.color.panelRaised,
    },
});

export const segGroup = style({
    display: 'flex',
    flex: 1,
    gap: '2px',
});

const segBase = style({
    flex: 1,
    fontFamily: vars.font.body,
    fontSize: '0.68rem',
    fontWeight: 500,
    padding: '4px 0',
    cursor: 'pointer',
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    transition: 'all 0.12s',
});

export const seg = styleVariants({
    off: [segBase, { ':hover': { color: vars.color.foreground } }],
    on: [
        segBase,
        {
            color: vars.color.accent,
            borderColor: vars.color.accent,
            background: vars.color.accentDim,
            fontWeight: 600,
        },
    ],
});

const iconToggleBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    flexShrink: 0,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    background: 'transparent',
    color: vars.color.mutedForeground,
    cursor: 'pointer',
    transition: 'all 0.12s',
});

export const iconToggle = styleVariants({
    off: [
        iconToggleBase,
        { ':hover': { color: vars.color.foreground, borderColor: vars.color.borderBright } },
    ],
    on: [
        iconToggleBase,
        {
            color: vars.color.accent,
            borderColor: vars.color.accent,
            background: vars.color.accentDim,
        },
    ],
});

const execBase = style({
    fontFamily: vars.font.display,
    fontSize: '0.82rem',
    fontWeight: 700,
    letterSpacing: '0.04em',
    padding: '9px 0',
    marginTop: vars.space.xs,
    cursor: 'pointer',
    border: '1px solid',
    borderRadius: vars.radius.sm,
    transition: 'all 0.12s',
    ':disabled': { opacity: 0.35, cursor: 'not-allowed' },
});

export const execBtn = styleVariants({
    buy: [
        execBase,
        {
            color: '#fff',
            background: vars.color.up,
            borderColor: vars.color.up,
            ':hover': { filter: 'brightness(1.1)' },
        },
    ],
    sell: [
        execBase,
        {
            color: '#fff',
            background: vars.color.down,
            borderColor: vars.color.down,
            ':hover': { filter: 'brightness(1.1)' },
        },
    ],
    armed: [
        execBase,
        {
            color: '#1a1304',
            background: vars.color.amber,
            borderColor: vars.color.amber,
            animation: 'pulse-glow 0.9s infinite',
        },
    ],
});

export const costRow = style({
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
    fontVariantNumeric: 'tabular-nums',
});

export const feedback = style({
    fontFamily: vars.font.mono,
    fontSize: '0.68rem',
    minHeight: '1.2em',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
});
