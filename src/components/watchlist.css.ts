// src/components/watchlist.css.ts

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const list = style({
    display: 'flex',
    flexDirection: 'column',
});

const rowBase = style({
    position: 'relative',
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    gridTemplateRows: 'auto auto',
    columnGap: vars.space.sm,
    padding: `6px ${vars.space.md}`,
    cursor: 'pointer',
    borderBottom: `1px solid ${vars.color.border}`,
    borderLeft: '2px solid transparent',
    transition: 'background 0.12s, border-color 0.12s',
    ':hover': {
        background: vars.color.muted,
    },
});

export const row = styleVariants({
    normal: [rowBase],
    selected: [
        rowBase,
        {
            background: vars.color.accentDim,
            borderLeftColor: vars.color.accent,
        },
    ],
});

export const code = style({
    fontFamily: vars.font.mono,
    fontSize: '0.8rem',
    fontWeight: 600,
    color: vars.color.foreground,
});

export const name = style({
    fontSize: '0.68rem',
    color: vars.color.mutedForeground,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
});

export const price = style({
    fontFamily: vars.font.mono,
    fontSize: '0.82rem',
    fontWeight: 600,
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
});

export const change = style({
    fontFamily: vars.font.mono,
    fontSize: '0.68rem',
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
});

export const flash = styleVariants({
    up: { animation: 'flash-up 0.5s ease-out' },
    down: { animation: 'flash-down 0.5s ease-out' },
    none: {},
});

export const removeBtn = style({
    gridColumn: '1 / -1',
    display: 'none',
});

export const listPicker = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.xs,
    padding: `4px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

export const listSelect = style({
    flex: 1,
    minWidth: 0,
    fontFamily: vars.font.body,
    fontSize: '0.72rem',
    fontWeight: 500,
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '3px 6px',
    outline: 'none',
    ':focus': { borderColor: vars.color.accent },
});

export const listBtn = style({
    fontFamily: vars.font.mono,
    fontSize: '0.72rem',
    width: '24px',
    height: '24px',
    cursor: 'pointer',
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    flexShrink: 0,
    ':hover': { color: vars.color.foreground, borderColor: vars.color.borderBright },
});

export const listBtnDanger = style({
    color: '#fff',
    background: vars.color.danger,
    borderColor: vars.color.danger,
    fontSize: '0.6rem',
});

export const rowRemove = style({
    position: 'absolute',
    right: '4px',
    top: '50%',
    transform: 'translateY(-50%)',
    width: '18px',
    height: '18px',
    fontSize: '0.62rem',
    lineHeight: 1,
    cursor: 'pointer',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    opacity: 0,
    transition: 'opacity 0.12s',
    selectors: {
        [`${rowBase}:hover &`]: { opacity: 1 },
        '&:hover': { color: vars.color.danger, borderColor: vars.color.danger },
    },
});

export const loadingHint = style({
    padding: vars.space.md,
    textAlign: 'center',
    fontSize: '0.7rem',
    color: vars.color.mutedForeground,
});

export const addRow = style({
    display: 'flex',
    gap: vars.space.xs,
    padding: vars.space.sm,
    borderTop: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

export const addInput = style({
    flex: 1,
    minWidth: 0,
    fontFamily: vars.font.mono,
    fontSize: '0.76rem',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '4px 8px',
    outline: 'none',
    ':focus': {
        borderColor: vars.color.accent,
    },
    '::placeholder': {
        color: vars.color.mutedForeground,
    },
});

export const typeSelect = style({
    fontFamily: vars.font.body,
    fontSize: '0.72rem',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    outline: 'none',
});
