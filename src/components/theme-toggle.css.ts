// src/components/theme-toggle.css.ts

import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const button = style({
    width: '2rem',
    height: '2rem',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '1rem',
    color: vars.color.foreground,
    background: vars.color.background,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
    cursor: 'pointer',
    transition: 'background 0.15s ease',
    ':hover': {
        background: vars.color.muted,
    },
});
