// src/components/child-setup-notice.css.ts

import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const wrap = style({
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: vars.space.sm,
    height: '100vh',
    padding: vars.space.lg,
    boxSizing: 'border-box',
    background: vars.color.panel,
    color: vars.color.foreground,
    fontFamily: vars.font.body,
    textAlign: 'center',
});

export const icon = style({
    color: vars.color.mutedForeground,
});

export const title = style({
    margin: 0,
    fontFamily: vars.font.display,
    fontSize: '0.9rem',
    fontWeight: 700,
});

export const body = style({
    margin: 0,
    maxWidth: '22rem',
    fontSize: '0.76rem',
    lineHeight: 1.5,
    color: vars.color.mutedForeground,
});

export const button = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: vars.space.xs,
    marginTop: vars.space.sm,
    padding: `${vars.space.xs} ${vars.space.md}`,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.sm,
    background: vars.color.panelRaised,
    color: vars.color.foreground,
    fontSize: '0.76rem',
    cursor: 'pointer',
    selectors: {
        '&:hover': { borderColor: vars.color.accent },
    },
});
