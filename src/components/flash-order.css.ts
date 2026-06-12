// src/components/flash-order.css.ts

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

const COLS = '3rem 1fr 4.8rem 1fr 3rem';

export const wrap = style({
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    height: '100%',
});

// wraps so an 8-strip tile (~240px wide) still shows every control
export const controls = style({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: vars.space.xs,
    padding: `4px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

export const qtyInput = style({
    width: '2.8rem',
    fontFamily: vars.font.mono,
    fontSize: '0.78rem',
    fontWeight: 600,
    textAlign: 'center',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '2px 4px',
    outline: 'none',
    ':focus': { borderColor: vars.color.accent },
});

export const qtyLabel = style({
    fontSize: '0.64rem',
    color: vars.color.mutedForeground,
});

export const stepBtn = style({
    fontFamily: vars.font.mono,
    fontSize: '0.7rem',
    width: '1.3rem',
    height: '1.3rem',
    lineHeight: 1,
    cursor: 'pointer',
    color: vars.color.mutedForeground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: 0,
    ':hover': { color: vars.color.foreground },
});

const armBase = style({
    flex: 1,
    fontFamily: vars.font.display,
    fontSize: '0.66rem',
    fontWeight: 700,
    padding: '3px 0',
    cursor: 'pointer',
    borderRadius: vars.radius.sm,
    border: '1px solid',
    transition: 'all 0.12s',
    whiteSpace: 'nowrap',
});

export const armBtn = styleVariants({
    off: [
        armBase,
        {
            color: vars.color.mutedForeground,
            borderColor: vars.color.border,
            background: vars.color.inset,
        },
    ],
    on: [
        armBase,
        {
            color: '#1a1304',
            borderColor: vars.color.amber,
            background: vars.color.amber,
            animation: 'pulse-glow 1.4s infinite',
        },
    ],
});

const smallToggle = style({
    fontFamily: vars.font.body,
    fontSize: '0.64rem',
    borderRadius: vars.radius.sm,
    padding: '2px 8px',
    cursor: 'pointer',
    border: '1px solid',
    whiteSpace: 'nowrap',
});

export const followBtn = styleVariants({
    on: [
        smallToggle,
        {
            color: vars.color.accent,
            borderColor: vars.color.accent,
            background: vars.color.accentDim,
            fontWeight: 600,
        },
    ],
    off: [
        smallToggle,
        {
            color: vars.color.mutedForeground,
            borderColor: vars.color.border,
            background: 'transparent',
            ':hover': { color: vars.color.foreground },
        },
    ],
});

export const recenterBtn = style({
    fontFamily: vars.font.body,
    fontSize: '0.64rem',
    color: vars.color.mutedForeground,
    background: 'transparent',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '2px 8px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    ':hover': { color: vars.color.foreground },
});

// ---- action bar (market orders / flatten / cancel-all) ----

export const actionBar = style({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: vars.space.xs,
    padding: `3px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

const mktBase = style({
    flex: 1,
    fontFamily: vars.font.display,
    fontSize: '0.66rem',
    fontWeight: 700,
    padding: '3px 0',
    cursor: 'pointer',
    borderRadius: vars.radius.sm,
    border: '1px solid',
    transition: 'all 0.12s',
});

export const mktBtn = styleVariants({
    buy: [
        mktBase,
        {
            color: vars.color.up,
            borderColor: vars.color.up,
            background: vars.color.upDim,
        },
    ],
    sell: [
        mktBase,
        {
            color: vars.color.down,
            borderColor: vars.color.down,
            background: vars.color.downDim,
        },
    ],
});

export const flatBtn = style([
    mktBase,
    {
        flex: '0 0 auto',
        padding: '3px 10px',
        color: vars.color.amber,
        borderColor: vars.color.amber,
        background: 'rgba(224, 164, 60, 0.08)',
    },
]);

export const cancelAllBtn = style([
    mktBase,
    {
        flex: '0 0 auto',
        padding: '3px 10px',
        color: vars.color.danger,
        borderColor: vars.color.border,
        background: vars.color.inset,
        ':hover': { borderColor: vars.color.danger },
        ':disabled': {
            opacity: 0.4,
            cursor: 'not-allowed',
            borderColor: vars.color.border,
        },
    },
]);

// ---- position bar ----

export const posBar = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    padding: `2px ${vars.space.sm}`,
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    fontVariantNumeric: 'tabular-nums',
    color: vars.color.mutedForeground,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

export const posLong = style({ color: vars.color.up, fontWeight: 600 });
export const posShort = style({ color: vars.color.down, fontWeight: 600 });

// ---- ladder ----

export const headRow = style({
    display: 'grid',
    gridTemplateColumns: COLS,
    fontFamily: vars.font.display,
    fontSize: '0.6rem',
    fontWeight: 600,
    color: vars.color.mutedForeground,
    textAlign: 'center',
    padding: '3px 0',
    borderBottom: `1px solid ${vars.color.border}`,
    background: vars.color.panel,
    flexShrink: 0,
});

// fixed window — no native scrolling; the wheel shifts the anchor in ticks
export const ladderBody = style({
    flex: 1,
    minHeight: 0,
    position: 'relative',
    overflow: 'hidden',
    fontFamily: vars.font.mono,
    fontSize: '0.72rem',
    fontVariantNumeric: 'tabular-nums',
});

export const waiting = style({
    padding: vars.space.md,
    fontSize: '0.68rem',
    color: vars.color.mutedForeground,
    textAlign: 'center',
});

const rowBase = style({
    display: 'grid',
    gridTemplateColumns: COLS,
    height: '22px',
    alignItems: 'stretch',
    borderBottom: `1px solid rgba(127, 127, 127, 0.07)`,
});

export const row = styleVariants({
    normal: [rowBase],
    last: [
        rowBase,
        {
            background: vars.color.accentDim,
        },
    ],
});

const cellBase = style({
    display: 'flex',
    alignItems: 'center',
    position: 'relative',
    overflow: 'hidden',
});

export const chipCell = style([
    cellBase,
    {
        justifyContent: 'center',
        gap: '2px',
    },
]);

const chipBase = style({
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    fontWeight: 700,
    lineHeight: 1,
    minWidth: '1.7rem',
    padding: '2px 3px',
    cursor: 'pointer',
    borderRadius: vars.radius.sm,
    border: '1px solid',
    transition: 'all 0.1s',
});

export const orderChip = styleVariants({
    buy: [
        chipBase,
        {
            color: vars.color.up,
            borderColor: vars.color.up,
            background: vars.color.upDim,
            ':hover': { color: '#fff', background: vars.color.up },
        },
    ],
    sell: [
        chipBase,
        {
            color: vars.color.down,
            borderColor: vars.color.down,
            background: vars.color.downDim,
            ':hover': { color: '#fff', background: vars.color.down },
        },
    ],
});

// solid badge = today's filled quantity at this price (not clickable),
// in contrast to the outlined working-order chip
const fillBase = style({
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    fontWeight: 700,
    lineHeight: 1,
    minWidth: '1.4rem',
    padding: '3px 3px',
    textAlign: 'center',
    borderRadius: vars.radius.sm,
    color: '#fff',
    cursor: 'default',
});

export const fillBadge = styleVariants({
    buy: [fillBase, { background: vars.color.up, opacity: 0.85 }],
    sell: [fillBase, { background: vars.color.down, opacity: 0.85 }],
});

export const buyCell = style([
    cellBase,
    {
        justifyContent: 'flex-end',
        paddingRight: '8px',
        cursor: 'pointer',
        color: vars.color.up,
        selectors: {
            '&:hover': { background: vars.color.upDim },
        },
    },
]);

export const sellCell = style([
    cellBase,
    {
        justifyContent: 'flex-start',
        paddingLeft: '8px',
        cursor: 'pointer',
        color: vars.color.down,
        selectors: {
            '&:hover': { background: vars.color.downDim },
        },
    },
]);

export const disabledCell = style({
    cursor: 'not-allowed',
    opacity: 0.55,
});

export const priceCell = style([
    cellBase,
    {
        justifyContent: 'center',
        gap: '4px',
        fontWeight: 600,
        borderLeft: `1px solid ${vars.color.border}`,
        borderRight: `1px solid ${vars.color.border}`,
    },
]);

// limit-up/down rows: price cell filled solid in the limit color
export const bandUp = style({
    background: vars.color.up,
    color: '#fff',
    fontWeight: 700,
});
export const bandDown = style({
    background: vars.color.down,
    color: '#fff',
    fontWeight: 700,
});

// average-cost marker on the price cell
export const avgMark = style({
    boxShadow: `inset 3px 0 0 ${vars.color.amber}`,
});

// inherits the cell color so it stays readable on filled limit rows
export const lastVol = style({
    fontSize: '0.58rem',
    fontWeight: 400,
    color: 'inherit',
    opacity: 0.75,
});

const volBarBase = style({
    position: 'absolute',
    top: '3px',
    bottom: '3px',
    zIndex: 0,
    borderRadius: '2px',
    background: 'currentcolor',
    opacity: 0.18,
});

export const volBarBid = style([volBarBase, { right: 0 }]);
export const volBarAsk = style([volBarBase, { left: 0 }]);

export const cellText = style({
    position: 'relative',
    zIndex: 1,
});

// floating "back to last price" pill when price leaves the window
const jumpBase = style({
    position: 'absolute',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 5,
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    fontWeight: 600,
    padding: '3px 12px',
    cursor: 'pointer',
    borderRadius: '999px',
    color: vars.color.accent,
    border: `1px solid ${vars.color.accent}`,
    background: vars.color.panelRaised,
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.35)',
    whiteSpace: 'nowrap',
});

export const jumpBtn = styleVariants({
    top: [jumpBase, { top: '6px' }],
    bottom: [jumpBase, { bottom: '6px' }],
});

export const totalsRow = style({
    display: 'flex',
    justifyContent: 'space-between',
    padding: `2px ${vars.space.sm}`,
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    fontVariantNumeric: 'tabular-nums',
    borderTop: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

export const totalBid = style({ color: vars.color.up });
export const totalAsk = style({ color: vars.color.down });

export const hint = style({
    padding: `2px ${vars.space.sm}`,
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
    borderTop: `1px solid ${vars.color.border}`,
    flexShrink: 0,
    textAlign: 'center',
});
