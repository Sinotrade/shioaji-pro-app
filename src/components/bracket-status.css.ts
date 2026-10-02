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

export const banner = style({
    padding: '5px 8px',
    borderRadius: vars.radius.sm,
    border: `1px solid ${vars.color.danger}`,
    background: vars.color.inset,
    color: vars.color.danger,
    fontSize: '0.74rem',
    fontWeight: 700,
});

export const code = style({
    fontWeight: 700,
    color: vars.color.foreground,
});

export const acrossDay = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    margin: '2px 0',
    padding: '5px 6px',
    borderRadius: vars.radius.sm,
    background: vars.color.background,
    border: `1px solid ${vars.color.border}`,
});

export const acrossTitle = style({
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    color: vars.color.danger,
    fontWeight: 700,
});

export const facts = style({
    display: 'flex',
    flexWrap: 'wrap',
    gap: '3px',
});

export const chip = style({
    fontFamily: vars.font.mono,
    padding: '0 5px',
    borderRadius: vars.radius.sm,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    whiteSpace: 'nowrap',
});

export const stepRow = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '4px',
});

export const stepLabel = style({
    fontWeight: 600,
    minWidth: '1.2em',
});

export const iconButton = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '18px',
    height: '18px',
    padding: 0,
    cursor: 'pointer',
    background: 'transparent',
    color: vars.color.foreground,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    ':hover': { borderColor: vars.color.borderBright },
    ':disabled': { opacity: 0.5, cursor: 'default' },
});

export const primary = style({
    fontFamily: vars.font.display,
    fontSize: '0.68rem',
    fontWeight: 700,
    cursor: 'pointer',
    width: '100%',
    padding: '3px 6px',
    borderRadius: vars.radius.sm,
    border: `1px solid ${vars.color.accent}`,
    background: vars.color.accent,
    color: vars.color.background,
    ':disabled': {
        opacity: 1,
        cursor: 'default',
        background: 'transparent',
        color: vars.color.mutedForeground,
        borderColor: vars.color.border,
    },
});

export const field = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: vars.space.xs,
});

export const qtyInput = style({
    width: '3.6em',
    textAlign: 'center',
    fontFamily: vars.font.mono,
    fontSize: '0.7rem',
    padding: '1px 4px',
    background: vars.color.background,
    color: vars.color.foreground,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
});
