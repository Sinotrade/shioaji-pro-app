// src/components/contract-card.css.ts

import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const card = style({
    width: '100%',
    maxWidth: '20rem',
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.xs,
    padding: vars.space.md,
    textAlign: 'left',
    fontSize: '0.875rem',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
});

export const row = style({
    display: 'flex',
    justifyContent: 'space-between',
    gap: vars.space.md,
});

export const label = style({
    color: vars.color.mutedForeground,
});

export const value = style({
    fontFamily: vars.font.mono,
});
