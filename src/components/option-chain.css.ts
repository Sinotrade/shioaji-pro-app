// src/components/option-chain.css.ts

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
    gap: '6px',
    minWidth: 0,
    padding: `4px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

export const atm = style({
    marginLeft: 'auto',
    flexShrink: 0,
    whiteSpace: 'nowrap',
    fontFamily: vars.font.mono,
    fontSize: '0.68rem',
    color: vars.color.mutedForeground,
    fontVariantNumeric: 'tabular-nums',
});

export const table = style({
    width: '100%',
    borderCollapse: 'collapse',
    fontFamily: vars.font.mono,
    fontSize: '0.68rem',
    fontVariantNumeric: 'tabular-nums',
});

export const th = style({
    position: 'sticky',
    top: 0,
    textAlign: 'center',
    padding: `3px 4px`,
    fontFamily: vars.font.display,
    fontSize: '0.6rem',
    fontWeight: 500,
    color: vars.color.mutedForeground,
    background: vars.color.panel,
    borderBottom: `1px solid ${vars.color.border}`,
});

export const strikeTh = style({
    background: vars.color.muted,
});

export const td = style({
    textAlign: 'right',
    padding: `2px 6px`,
    borderBottom: `1px solid rgba(127, 127, 127, 0.08)`,
});

export const strike = style({
    textAlign: 'center',
    padding: `2px 8px`,
    fontWeight: 700,
    color: vars.color.foreground,
    background: vars.color.muted,
    borderBottom: `1px solid rgba(127, 127, 127, 0.08)`,
});

export const atmStrike = style({
    color: vars.color.accent,
    background: vars.color.accentDim,
});

export const pickableRow = style({
    cursor: 'pointer',
    ':hover': { background: vars.color.muted },
});
