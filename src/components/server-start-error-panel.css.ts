// src/components/server-start-error-panel.css.ts — the specific "why the
// server did not start" block on the first-run screen.

import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const panel = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    padding: '0.75rem 0.875rem',
    background: vars.color.dangerDim,
    border: `1px solid ${vars.color.danger}`,
    borderRadius: vars.radius.md,
    color: vars.color.foreground,
    minWidth: 0,
});

export const header = style({
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    color: vars.color.danger,
    fontFamily: vars.font.display,
    fontSize: '0.8125rem',
    fontWeight: 700,
});

export const icon = style({ flexShrink: 0 });

export const body = style({
    margin: 0,
    fontFamily: vars.font.body,
    fontSize: '0.75rem',
    lineHeight: 1.6,
    color: vars.color.foreground,
    overflowWrap: 'anywhere',
});

export const detailLabel = style({
    fontFamily: vars.font.display,
    fontSize: '0.66rem',
    fontWeight: 600,
    letterSpacing: '0.04em',
    color: vars.color.mutedForeground,
});

export const detail = style({
    margin: 0,
    padding: '0.5rem 0.625rem',
    maxHeight: '8.5rem',
    overflow: 'auto',
    fontFamily: vars.font.mono,
    fontSize: '0.6875rem',
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
});

export const footer = style({
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '0.5rem',
    paddingTop: '0.125rem',
});

export const logPath = style({
    display: 'flex',
    alignItems: 'center',
    gap: '0.375rem',
    flex: '1 1 12rem',
    minWidth: 0,
    fontFamily: vars.font.mono,
    fontSize: '0.6875rem',
    color: vars.color.mutedForeground,
    overflowWrap: 'anywhere',
});

export const openButton = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.375rem',
    marginLeft: 'auto',
    height: '1.75rem',
    padding: '0 0.625rem',
    fontFamily: vars.font.body,
    fontSize: '0.72rem',
    fontWeight: 600,
    cursor: 'pointer',
    color: vars.color.foreground,
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.md,
    selectors: {
        '&:hover:not(:disabled)': { borderColor: vars.color.accent, color: vars.color.accent },
        '&:disabled': { opacity: 0.5, cursor: 'default' },
    },
});

export const openError = style({
    margin: 0,
    width: '100%',
    fontFamily: vars.font.body,
    fontSize: '0.6875rem',
    color: vars.color.danger,
});
