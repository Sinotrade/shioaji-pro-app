// src/components/ticks-table.css.ts

import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const wrapper = style({
    width: '100%',
    maxWidth: '20rem',
    padding: vars.space.md,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
});

export const emptyCard = style({
    padding: vars.space.md,
    fontSize: '0.875rem',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
});

export const meta = style({
    marginBottom: vars.space.xs,
    fontSize: '0.75rem',
    color: vars.color.mutedForeground,
});

export const table = style({
    width: '100%',
    fontFamily: vars.font.mono,
    fontSize: '0.8125rem',
    borderCollapse: 'collapse',
});

export const th = style({
    padding: vars.space.xs,
    textAlign: 'right',
    fontWeight: 500,
    color: vars.color.mutedForeground,
    borderBottom: `1px solid ${vars.color.border}`,
});

export const thLeft = style([
    th,
    {
        textAlign: 'left',
    },
]);

export const td = style({
    padding: vars.space.xs,
    textAlign: 'right',
    borderBottom: `1px solid ${vars.color.border}`,
});

export const tdLeft = style([
    td,
    {
        textAlign: 'left',
    },
]);

export const tickTypeBuy = style({
    color: vars.color.buyRed,
});

export const tickTypeSell = style({
    color: vars.color.sellGreen,
});
