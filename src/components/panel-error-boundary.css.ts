// src/components/panel-error-boundary.css.ts — 面板崩潰隔離的錯誤狀態卡

import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const wrap = style({
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: vars.space.sm,
    padding: vars.space.md,
    textAlign: 'center',
});

export const icon = style({
    color: vars.color.danger,
});

export const title = style({
    fontSize: '0.72rem',
    fontWeight: 600,
    color: vars.color.foreground,
});

export const message = style({
    maxWidth: '32rem',
    maxHeight: '6rem',
    overflow: 'hidden',
    fontFamily: vars.font.mono,
    fontSize: '0.6rem',
    lineHeight: 1.5,
    color: vars.color.mutedForeground,
    wordBreak: 'break-all',
});

export const retry = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    marginTop: '2px',
    padding: '3px 10px',
    fontSize: '0.66rem',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    cursor: 'pointer',
    ':hover': { borderColor: vars.color.accent },
});
