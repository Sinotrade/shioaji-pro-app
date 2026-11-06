// src/components/app-error-boundary.css.ts

import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const icon = style({
    color: vars.color.danger,
});

export const message = style({
    margin: 0,
    maxWidth: '32rem',
    maxHeight: '6rem',
    overflow: 'hidden',
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    lineHeight: 1.5,
    color: vars.color.mutedForeground,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
});

export const actions = style({
    display: 'flex',
    gap: vars.space.sm,
});
