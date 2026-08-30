// src/approval/approval.css.ts — Agent 核可視窗（獨立 window 小頁）

import { globalStyle, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

globalStyle('html, body, #root', {
    margin: 0,
    height: '100%',
    background: vars.color.background,
    color: vars.color.foreground,
    fontFamily: vars.font.body,
});

export const shell = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    height: '100%',
    boxSizing: 'border-box',
    padding: '14px 16px',
    overflow: 'auto',
});

export const empty = style({
    margin: 'auto',
    fontSize: '0.82rem',
    color: vars.color.mutedForeground,
});

export const error = style({
    padding: '8px 10px',
    fontSize: '0.72rem',
    color: vars.color.down,
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.down}`,
    borderRadius: vars.radius.sm,
});

export const header = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontFamily: vars.font.display,
    fontSize: '0.9rem',
    fontWeight: 600,
});

export const envBadge = styleVariants({
    sim: {
        fontSize: '0.66rem',
        fontWeight: 600,
        padding: '2px 8px',
        borderRadius: vars.radius.sm,
        color: vars.color.mutedForeground,
        border: `1px solid ${vars.color.border}`,
    },
    prod: {
        fontSize: '0.66rem',
        fontWeight: 600,
        padding: '2px 8px',
        borderRadius: vars.radius.sm,
        color: vars.color.down,
        border: `1px solid ${vars.color.down}`,
    },
});

export const card = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.lg,
    padding: '12px 14px',
});

export const actionLine = styleVariants({
    up: {
        display: 'flex',
        alignItems: 'baseline',
        gap: '8px',
        fontFamily: vars.font.display,
        fontSize: '1.1rem',
        fontWeight: 700,
        color: vars.color.up,
    },
    down: {
        display: 'flex',
        alignItems: 'baseline',
        gap: '8px',
        fontFamily: vars.font.display,
        fontSize: '1.1rem',
        fontWeight: 700,
        color: vars.color.down,
    },
});

export const code = style({
    fontFamily: vars.font.mono,
    fontSize: '0.95rem',
    color: vars.color.foreground,
});

export const opLine = style({
    fontFamily: vars.font.display,
    fontSize: '1rem',
    fontWeight: 600,
});

export const row = style({
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '0.78rem',
    color: vars.color.mutedForeground,
});

export const value = style({
    fontFamily: vars.font.mono,
    fontVariantNumeric: 'tabular-nums',
    color: vars.color.foreground,
});

export const ttl = style({
    marginTop: '4px',
    fontSize: '0.7rem',
    color: vars.color.mutedForeground,
});

export const detailToggle = style({
    alignSelf: 'flex-start',
    fontSize: '0.72rem',
    color: vars.color.mutedForeground,
    background: 'transparent',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    textDecoration: 'underline',
    ':hover': { color: vars.color.foreground },
});

export const detail = style({
    margin: 0,
    padding: '10px',
    fontFamily: vars.font.mono,
    fontSize: '0.68rem',
    lineHeight: 1.5,
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    maxHeight: '220px',
    overflow: 'auto',
});

export const footer = style({
    display: 'flex',
    gap: '8px',
    marginTop: 'auto',
});

export const denyBtn = style({
    flex: 1,
    fontFamily: vars.font.display,
    fontSize: '0.8rem',
    fontWeight: 600,
    color: vars.color.foreground,
    background: vars.color.muted,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '9px 0',
    cursor: 'pointer',
    ':hover': { borderColor: vars.color.borderBright },
    ':disabled': { opacity: 0.4, cursor: 'not-allowed' },
});

export const approveBtn = style({
    flex: 1,
    fontFamily: vars.font.display,
    fontSize: '0.8rem',
    fontWeight: 700,
    color: '#fff',
    background: vars.color.accent,
    border: 'none',
    borderRadius: vars.radius.sm,
    padding: '9px 0',
    cursor: 'pointer',
    ':hover': { filter: 'brightness(1.1)' },
    ':disabled': { opacity: 0.4, cursor: 'not-allowed' },
});

export const hint = style({
    fontSize: '0.68rem',
    color: vars.color.mutedForeground,
});
