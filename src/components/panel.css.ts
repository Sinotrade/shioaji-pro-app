// src/components/panel.css.ts — shared panel chrome

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const panel = style({
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    background: vars.color.panel,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
    overflow: 'hidden',
});

export const panelTitle = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    padding: `7px ${vars.space.md}`,
    fontFamily: vars.font.display,
    fontSize: '0.68rem',
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: vars.color.mutedForeground,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
    userSelect: 'none',
});

export const panelTitleDeco = style({
    width: '3px',
    height: '12px',
    background: vars.color.accent,
    borderRadius: '1px',
    flexShrink: 0,
});

export const panelBody = style({
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
});

export const dirText = styleVariants({
    up: { color: vars.color.up },
    down: { color: vars.color.down },
    flat: { color: vars.color.flat },
});

// 非價格的狀態文字（下單回饋、驗證錯誤、風險警示）：固定綠／紅，
// 不可用 dirText（up/down 會隨台股／國際配色翻轉）
export const statusText = styleVariants({
    ok: { color: vars.color.success },
    err: { color: vars.color.danger },
});

export const mono = style({
    fontFamily: vars.font.mono,
    fontVariantNumeric: 'tabular-nums',
});

export const btn = style({
    fontFamily: vars.font.display,
    fontSize: '0.72rem',
    fontWeight: 600,
    color: vars.color.foreground,
    background: vars.color.muted,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '4px 12px',
    cursor: 'pointer',
    transition: 'background 0.12s, border-color 0.12s',
    ':hover': {
        borderColor: vars.color.borderBright,
        background: vars.color.panelRaised,
    },
    ':disabled': {
        opacity: 0.4,
        cursor: 'not-allowed',
    },
});

export const refreshToolbar = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    padding: `0 ${vars.space.sm}`,
    flexShrink: 0,
    minWidth: 0,
});
