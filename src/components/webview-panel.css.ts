// src/components/webview-panel.css.ts

import { style } from '@vanilla-extract/css';
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

export const urlText = style({
    flex: 1,
    minWidth: 0,
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

export const btn = style({
    fontFamily: vars.font.body,
    fontSize: '0.64rem',
    color: vars.color.mutedForeground,
    background: 'transparent',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '2px 10px',
    cursor: 'pointer',
    flexShrink: 0,
    ':hover': { color: vars.color.foreground },
});

export const frame = style({
    flex: 1,
    width: '100%',
    border: 0,
    // 面板底色跟著主題走；頁面載入前不要閃白
    background: 'transparent',
});

export const setup = style({
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: vars.space.sm,
    height: '100%',
    padding: vars.space.md,
});

export const setupRow = style({
    display: 'flex',
    gap: vars.space.xs,
});

export const input = style({
    fontFamily: vars.font.body,
    fontSize: '0.72rem',
    color: vars.color.foreground,
    background: 'transparent',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '6px 10px',
    width: '100%',
    maxWidth: 420,
    ':focus': { outline: 'none', borderColor: vars.color.accent },
});

export const hint = style({
    fontFamily: vars.font.body,
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
    textAlign: 'center',
    maxWidth: 420,
    lineHeight: 1.5,
});
