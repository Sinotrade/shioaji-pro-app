// src/components/api-explorer.css.ts

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const searchRow = style({
    width: '100%',
    maxWidth: '20rem',
    display: 'flex',
    alignItems: 'stretch',
    gap: vars.space.sm,
});

export const select = style({
    padding: `${vars.space.sm} ${vars.space.md}`,
    fontSize: '0.875rem',
    color: vars.color.foreground,
    background: vars.color.background,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
    outline: 'none',
    cursor: 'pointer',
    ':focus': {
        borderColor: vars.color.accent,
    },
});

export const input = style({
    flex: 1,
    padding: `${vars.space.sm} ${vars.space.md}`,
    fontFamily: vars.font.mono,
    fontSize: '0.875rem',
    color: vars.color.foreground,
    background: vars.color.background,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
    outline: 'none',
    ':focus': {
        borderColor: vars.color.accent,
    },
});

export const buttonRow = style({
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: vars.space.sm,
});

export const lookupButton = style({
    padding: `${vars.space.sm} ${vars.space.md}`,
    fontSize: '0.875rem',
    fontWeight: 500,
    color: '#ffffff',
    background: vars.color.accent,
    border: `1px solid ${vars.color.accent}`,
    borderRadius: vars.radius.md,
    cursor: 'pointer',
    transition: 'opacity 0.15s ease',
    ':hover': {
        opacity: 0.9,
    },
    ':disabled': {
        opacity: 0.5,
        cursor: 'not-allowed',
    },
});

export const errorCard = style({
    width: '100%',
    maxWidth: '20rem',
    padding: vars.space.md,
    fontSize: '0.875rem',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
});

const dotBase = style({
    width: '0.5rem',
    height: '0.5rem',
    display: 'inline-block',
    marginRight: vars.space.sm,
    verticalAlign: 'middle',
    borderRadius: '9999px',
});

export const dot = styleVariants({
    err: [dotBase, { background: vars.color.danger }],
});
