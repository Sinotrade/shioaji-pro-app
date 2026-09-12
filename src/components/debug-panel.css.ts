// src/components/debug-panel.css.ts

import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const wrap = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.xs,
    padding: vars.space.sm,
    overflowY: 'auto',
    minHeight: 0,
});

export const grid = style({
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '4px',
});

export const row = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: `4px ${vars.space.sm}`,
});

export const label = style({
    fontFamily: vars.font.display,
    fontSize: '0.6rem',
    fontWeight: 500,
    color: vars.color.mutedForeground,
});

export const value = style({
    fontFamily: vars.font.mono,
    fontSize: '0.72rem',
    fontWeight: 600,
    color: vars.color.foreground,
    fontVariantNumeric: 'tabular-nums',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

export const valueWarn = style([
    value,
    {
        color: vars.color.amber,
    },
]);

export const sectionTitle = style({
    fontFamily: vars.font.display,
    fontSize: '0.6rem',
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: vars.color.mutedForeground,
    marginTop: '4px',
});

export const eventDump = style({
    margin: 0,
    fontFamily: vars.font.mono,
    fontSize: '0.6rem',
    lineHeight: 1.5,
    color: vars.color.mutedForeground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: `3px ${vars.space.sm}`,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
});

export const monitorButton = style({
    color: vars.color.foreground, background: vars.color.inset,
    border: `1px solid ${vars.color.border}`, borderRadius: vars.radius.sm,
    padding: vars.space.sm, cursor: 'pointer', textAlign: 'left',
});
export const monitorFrame = style({
    width: '100%', minHeight: 640, flexShrink: 0,
    border: `1px solid ${vars.color.border}`, borderRadius: vars.radius.sm,
});
