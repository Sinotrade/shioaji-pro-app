// src/components/bracket-status.css.ts

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const list = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.xs,
});

const rowBase = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: '4px 6px',
    background: vars.color.inset,
    borderRadius: vars.radius.sm,
    fontSize: '0.7rem',
    fontVariantNumeric: 'tabular-nums',
    color: vars.color.foreground,
    minWidth: 0,
    overflowWrap: 'break-word',
});

export const row = styleVariants({
    ok: [rowBase, { border: `1px solid ${vars.color.border}` }],
    warn: [rowBase, { border: `1px solid ${vars.color.amber}` }],
    err: [rowBase, { border: `1px solid ${vars.color.danger}` }],
});

// Narrow tickets (~200px): items wrap as whole words instead of shrinking
// to one character per line.
export const head = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: vars.space.xs,
    rowGap: '1px',
    fontFamily: vars.font.mono,
    whiteSpace: 'nowrap',
});

export const grow = style({ flex: '1 1 auto' });

export const note = styleVariants({
    ok: { color: vars.color.success },
    warn: { color: vars.color.amber },
    err: { color: vars.color.danger },
    muted: { color: vars.color.mutedForeground },
});

export const actions = style({
    display: 'flex',
    gap: vars.space.xs,
    flexWrap: 'wrap',
});

export const button = style({
    fontFamily: vars.font.display,
    fontSize: '0.64rem',
    fontWeight: 600,
    cursor: 'pointer',
    background: 'transparent',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.foreground,
    padding: '1px 6px',
    ':hover': { borderColor: vars.color.borderBright },
    ':disabled': { opacity: 0.5, cursor: 'default' },
});
