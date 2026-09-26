// src/App.css.ts — app shell

import { style } from '@vanilla-extract/css';
import { vars } from './theme.css';

export const shell = style({
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: vars.color.background,
});

export const blockPlaceholder = style({
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: vars.space.xs,
    color: vars.color.mutedForeground,
    fontSize: '0.72rem',
});

export const loading = style({
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: vars.space.md,
    fontFamily: vars.font.display,
    fontWeight: 600,
    letterSpacing: '0.04em',
    color: vars.color.mutedForeground,
});
