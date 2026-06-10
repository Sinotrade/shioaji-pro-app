// src/App.css.ts

import { style } from '@vanilla-extract/css';
import { vars } from './theme.css';

export const header = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: `${vars.space.md} ${vars.space.lg}`,
    borderBottom: `1px solid ${vars.color.border}`,
});

export const headerStatus = style({
    fontSize: '0.875rem',
});

export const main = style({
    maxWidth: '36rem',
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: vars.space.lg,
    padding: `${vars.space.xl} ${vars.space.lg}`,
    textAlign: 'center',
});

export const logo = style({
    width: '240px',
    height: 'auto',
    marginBottom: vars.space.sm,
});

export const title = style({
    margin: 0,
    fontSize: '1.5rem',
    fontWeight: 600,
});

export const hint = style({
    margin: 0,
    color: vars.color.mutedForeground,
});

export const code = style({
    padding: `${vars.space.xs} ${vars.space.sm}`,
    fontFamily: vars.font.mono,
    fontSize: '0.875rem',
    background: vars.color.muted,
    borderRadius: vars.radius.sm,
});
