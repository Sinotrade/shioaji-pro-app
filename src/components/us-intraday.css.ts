// src/components/us-intraday.css.ts

import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const wrap = style({
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    padding: vars.space.sm,
    gap: vars.space.sm,
});

export const head = style({
    display: 'flex',
    justifyContent: 'space-between',
    gap: vars.space.md,
    fontSize: '0.78rem',
});

export const note = style({ color: vars.color.mutedForeground, fontSize: '0.68rem' });

export const chart = style({ flex: 1, minHeight: 0, width: '100%' });

const lineBase = { fill: 'none', strokeWidth: 1.5, vectorEffect: 'non-scaling-stroke' } as const;
export const lineUp = style({ ...lineBase, stroke: vars.color.up });
export const lineDown = style({ ...lineBase, stroke: vars.color.down });
export const refLine = style({
    stroke: vars.color.mutedForeground,
    strokeDasharray: '4 4',
    strokeWidth: 1,
    vectorEffect: 'non-scaling-stroke',
});

export const empty = style({
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: vars.color.mutedForeground,
    fontSize: '0.8rem',
});

export const foot = style({
    display: 'flex',
    justifyContent: 'space-between',
    fontFamily: vars.font.mono,
    fontSize: '0.72rem',
    color: vars.color.mutedForeground,
});
