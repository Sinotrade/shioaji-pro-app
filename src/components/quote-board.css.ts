// src/components/quote-board.css.ts

import { globalStyle, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const board = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.lg,
    padding: `${vars.space.sm} ${vars.space.md}`,
    flexShrink: 0,
    borderBottom: `1px solid ${vars.color.border}`,
    overflow: 'hidden',
});

export const symbolBlock = style({
    display: 'flex',
    flexDirection: 'column',
    minWidth: '7rem',
});

export const symbolCode = style({
    fontFamily: vars.font.display,
    fontSize: '1.15rem',
    fontWeight: 700,
    letterSpacing: '0.01em',
    color: vars.color.foreground,
});

export const symbolName = style({
    fontSize: '0.72rem',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
});

const bigPriceBase = style({
    fontFamily: vars.font.mono,
    fontSize: '1.9rem',
    fontWeight: 600,
    lineHeight: 1,
    fontVariantNumeric: 'tabular-nums',
});

export const bigPrice = styleVariants({
    up: [bigPriceBase, { color: vars.color.up }],
    down: [bigPriceBase, { color: vars.color.down }],
    flat: [bigPriceBase, { color: vars.color.flat }],
});

export const changeBlock = style({
    display: 'flex',
    flexDirection: 'column',
    fontFamily: vars.font.mono,
    fontSize: '0.82rem',
    fontVariantNumeric: 'tabular-nums',
});

export const statGrid = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(4, auto)',
    columnGap: vars.space.lg,
    rowGap: '2px',
    marginLeft: 'auto',
    fontFamily: vars.font.mono,
    fontSize: '0.72rem',
    fontVariantNumeric: 'tabular-nums',
});

export const statLabel = style({
    fontFamily: vars.font.display,
    color: vars.color.mutedForeground,
    fontSize: '0.62rem',
    fontWeight: 500,
});

export const statValue = style({
    textAlign: 'right',
});

const limitBadgeBase = style({
    fontFamily: vars.font.display,
    fontSize: '0.66rem',
    fontWeight: 700,
    letterSpacing: '0.08em',
    color: '#fff',
    borderRadius: vars.radius.sm,
    padding: '3px 8px',
    alignSelf: 'center',
});

export const limitBadge = styleVariants({
    up: [limitBadgeBase, { background: vars.color.up }],
    down: [limitBadgeBase, { background: vars.color.down }],
});

export const compactBoard = style({ flexWrap: 'wrap', gap: '6px 14px', padding: '7px 12px', containerType: 'inline-size' });
globalStyle(`${compactBoard} ${symbolBlock}`, { minWidth: 80 });
globalStyle(`${compactBoard} ${symbolCode}`, { fontSize: 15 });
globalStyle(`${compactBoard} ${symbolName}`, { fontSize: 11 });
globalStyle(`${compactBoard} ${bigPriceBase}`, { fontSize: 26 });
globalStyle(`${compactBoard} ${changeBlock}`, { fontSize: 12 });
export const quickStats = style({ display: 'flex', flex: 1, justifyContent: 'flex-end', gap: 16, fontSize: 11,
    color: vars.color.mutedForeground, whiteSpace: 'nowrap',
    '@container': { '(max-width: 760px)': { display: 'none' } } });
export const detailButton = style({ marginLeft: 'auto', minHeight: 32, padding: '5px 9px', fontSize: 12,
    color: vars.color.foreground, background: vars.color.panelRaised, border: `1px solid ${vars.color.border}`,
    borderRadius: 5, cursor: 'pointer', ':focus-visible': { outline: '2px solid #22d3ee', outlineOffset: 2 } });
export const expandedStats = style({ flexBasis: '100%', marginLeft: 0, padding: '8px 0 2px',
    borderTop: `1px solid ${vars.color.border}`, maxHeight: 150, overflow: 'auto' });
