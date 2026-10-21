// src/components/notice-center.css.ts

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const wrap = style({
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    height: '100%',
});

export const toolbar = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.xs,
    padding: `4px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

const filterBase = style({
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    padding: '2px 10px',
    cursor: 'pointer',
    borderRadius: '999px',
    border: '1px solid',
});

export const filter = styleVariants({
    on: [
        filterBase,
        {
            color: vars.color.accent,
            borderColor: vars.color.accent,
            background: vars.color.accentDim,
            fontWeight: 600,
        },
    ],
    off: [
        filterBase,
        {
            color: vars.color.mutedForeground,
            borderColor: vars.color.border,
            background: 'transparent',
            ':hover': { color: vars.color.foreground },
        },
    ],
});

export const clearBtn = style({
    fontFamily: vars.font.body,
    fontSize: '0.64rem',
    color: vars.color.mutedForeground,
    background: 'transparent',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '2px 10px',
    cursor: 'pointer',
    ':hover': { color: vars.color.danger, borderColor: vars.color.danger },
    ':disabled': { opacity: 0.4, cursor: 'not-allowed' },
});

export const list = style({
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
});

export const row = style({
    display: 'grid',
    gridTemplateColumns: '14px 4.6rem minmax(0, 1fr)',
    columnGap: vars.space.sm,
    alignItems: 'baseline',
    padding: `4px ${vars.space.sm}`,
    borderBottom: `1px solid rgba(127, 127, 127, 0.08)`,
});

const iconBase = style({
    fontFamily: vars.font.mono,
    fontSize: '0.7rem',
    fontWeight: 700,
    textAlign: 'center',
});

export const icon = styleVariants({
    ok: [iconBase, { color: vars.color.success }],
    err: [iconBase, { color: vars.color.danger }],
    info: [iconBase, { color: vars.color.mutedForeground }],
});

export const time = style({
    fontFamily: vars.font.mono,
    fontSize: '0.64rem',
    color: vars.color.mutedForeground,
    fontVariantNumeric: 'tabular-nums',
});

export const rowBody = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    minWidth: 0,
});

export const title = style({
    fontFamily: vars.font.body,
    fontSize: '0.72rem',
    fontWeight: 600,
    color: vars.color.foreground,
});

export const body = style({
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    color: vars.color.mutedForeground,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});
