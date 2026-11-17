// src/components/us-quote-board.css.ts

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const board = style({ flexWrap: 'wrap', rowGap: vars.space.sm });

export const ident = style({ display: 'flex', flexDirection: 'column', gap: 2 });

export const code = style({
    fontFamily: vars.font.mono,
    fontSize: '1rem',
    fontWeight: 600,
});

export const badge = style({
    fontFamily: vars.font.body,
    fontSize: '0.6rem',
    fontWeight: 600,
    marginLeft: 6,
    padding: '0 4px',
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    border: `1px solid ${vars.color.border}`,
    verticalAlign: 'middle',
});

export const meta = style({
    fontSize: '0.7rem',
    color: vars.color.mutedForeground,
});

export const dir = styleVariants({
    up: { color: vars.color.up },
    down: { color: vars.color.down },
    flat: { color: vars.color.flat },
});

export const halt = style({
    fontSize: '0.72rem',
    fontWeight: 700,
    color: vars.color.danger,
    border: `1px solid ${vars.color.danger}`,
    borderRadius: vars.radius.sm,
    padding: '2px 6px',
});
