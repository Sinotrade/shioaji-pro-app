// src/components/sector-heatmap.css.ts

import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const wrap = style({
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    height: '100%',
});

export const toolbar = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    padding: `4px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

export const catSelect = style({
    fontFamily: vars.font.body,
    fontSize: '0.7rem',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '2px 6px',
    outline: 'none',
    ':focus': { borderColor: vars.color.accent },
});

export const hint = style({
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
});

export const gridBox = style({
    flex: 1,
    minHeight: 0,
    position: 'relative',
    padding: vars.space.sm,
});

// Treemap sizing (成交額/amount) — same d3-hierarchy squarified-treemap
// convention as market-pulse-panel.tsx's industry contribution map, so a
// tile's AREA carries meaning (size = amount) instead of every stock
// rendering as an identical-size cell regardless of how much traded.
export const treemap = style({
    position: 'relative',
    width: '100%',
    height: '100%',
});

export const tile = style({
    position: 'absolute',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '1px',
    padding: '5px 6px',
    border: `1px solid color-mix(in srgb, var(--heat-color) 58%, ${vars.color.border})`,
    borderRadius: vars.radius.sm,
    cursor: 'pointer',
    textAlign: 'left',
    background: `color-mix(in srgb, var(--heat-color) var(--heat-alpha), ${vars.color.panel})`,
    color: vars.color.foreground,
    overflow: 'hidden',
    transition: 'transform 0.08s',
    fontVariantNumeric: 'tabular-nums',
    ':hover': { transform: 'scale(1.03)', zIndex: 1 },
});

export const tileCode = style({
    fontFamily: vars.font.mono,
    fontSize: '0.7rem',
    fontWeight: 700,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '100%',
});

export const tileName = style({
    fontFamily: vars.font.body,
    fontSize: '0.58rem',
    opacity: 0.85,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '100%',
});

export const tilePct = style({
    alignSelf: 'flex-end',
    fontFamily: vars.font.mono,
    fontSize: '0.64rem',
    fontWeight: 700,
    color: 'var(--heat-color)',
});
