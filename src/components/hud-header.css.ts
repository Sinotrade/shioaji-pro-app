// src/components/hud-header.css.ts

import { keyframes, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const header = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.md,
    padding: `8px ${vars.space.md}`,
    background: vars.color.panel,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

export const logoBlock = style({
    display: 'flex',
    alignItems: 'baseline',
    gap: vars.space.sm,
});

export const logoMain = style({
    fontFamily: vars.font.display,
    fontSize: '0.95rem',
    fontWeight: 700,
    letterSpacing: '0.02em',
    color: vars.color.foreground,
});

export const logoSub = style({
    fontFamily: vars.font.display,
    fontSize: '0.68rem',
    fontWeight: 500,
    color: vars.color.mutedForeground,
});

export const spacer = style({ flex: 1 });

export const chip = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontFamily: vars.font.mono,
    fontSize: '0.72rem',
    fontVariantNumeric: 'tabular-nums',
    padding: '3px 10px',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    background: vars.color.inset,
    whiteSpace: 'nowrap',
});

export const chipLabel = style({
    fontFamily: vars.font.display,
    color: vars.color.mutedForeground,
    fontSize: '0.64rem',
    fontWeight: 500,
});

const blink = keyframes({
    '0%, 100%': { opacity: 1 },
    '50%': { opacity: 0.35 },
});

const ledBase = style({
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    flexShrink: 0,
});

export const led = styleVariants({
    live: [ledBase, { background: vars.color.down }],
    connecting: [
        ledBase,
        {
            background: vars.color.amber,
            animation: `${blink} 1s infinite`,
        },
    ],
    down: [
        ledBase,
        {
            background: vars.color.up,
            animation: `${blink} 0.6s infinite`,
        },
    ],
});

export const simBadge = style({
    fontFamily: vars.font.display,
    fontSize: '0.64rem',
    fontWeight: 600,
    letterSpacing: '0.06em',
    color: vars.color.amber,
    border: `1px solid rgba(224, 164, 60, 0.45)`,
    background: 'rgba(224, 164, 60, 0.08)',
    borderRadius: vars.radius.sm,
    padding: '3px 10px',
});

export const prodBadge = style({
    fontFamily: vars.font.display,
    fontSize: '0.64rem',
    fontWeight: 700,
    letterSpacing: '0.06em',
    color: '#fff',
    background: vars.color.up,
    border: `1px solid ${vars.color.up}`,
    borderRadius: vars.radius.sm,
    padding: '3px 10px',
});

export const settingsWrap = style({
    position: 'relative',
});

export const popover = style({
    position: 'absolute',
    top: 'calc(100% + 8px)',
    right: 0,
    zIndex: 200,
    width: '15rem',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.md,
    boxShadow: '0 12px 32px rgba(0, 0, 0, 0.35)',
    padding: vars.space.md,
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
});

export const popoverBackdrop = style({
    position: 'fixed',
    inset: 0,
    zIndex: 199,
});

export const settingLabel = style({
    fontFamily: vars.font.display,
    fontSize: '0.62rem',
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: vars.color.mutedForeground,
});

export const settingGroup = style({
    display: 'flex',
    gap: '2px',
});

const optBase = style({
    flex: 1,
    fontFamily: vars.font.body,
    fontSize: '0.7rem',
    fontWeight: 500,
    padding: '5px 0',
    cursor: 'pointer',
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    transition: 'all 0.12s',
});

export const opt = styleVariants({
    off: [optBase, { ':hover': { color: vars.color.foreground } }],
    on: [
        optBase,
        {
            color: vars.color.accent,
            borderColor: vars.color.accent,
            background: vars.color.accentDim,
            fontWeight: 600,
        },
    ],
});

const killBase = style({
    fontFamily: vars.font.display,
    fontSize: '0.72rem',
    fontWeight: 700,
    padding: '8px 0',
    cursor: 'pointer',
    borderRadius: vars.radius.sm,
    border: '1px solid',
    transition: 'all 0.12s',
});

export const killBtnOff = style([
    killBase,
    {
        color: vars.color.danger,
        borderColor: vars.color.border,
        background: vars.color.inset,
        ':hover': { borderColor: vars.color.danger },
    },
]);

export const killBtnOn = style([
    killBase,
    {
        color: '#fff',
        borderColor: vars.color.danger,
        background: vars.color.danger,
        animation: 'pulse-glow 1.2s infinite',
    },
]);

export const riskLabel = style({
    fontSize: '0.66rem',
    color: vars.color.mutedForeground,
    width: '4.2rem',
    flexShrink: 0,
    alignSelf: 'center',
});

export const menuItem = style({
    fontFamily: vars.font.body,
    fontSize: '0.72rem',
    fontWeight: 500,
    textAlign: 'left',
    padding: '5px 8px',
    cursor: 'pointer',
    background: 'transparent',
    border: `1px solid transparent`,
    borderRadius: vars.radius.sm,
    color: vars.color.foreground,
    transition: 'background 0.12s',
    ':hover': { background: vars.color.muted },
    ':disabled': {
        color: vars.color.mutedForeground,
        cursor: 'not-allowed',
        background: 'transparent',
    },
});

export const saveRow = style({
    display: 'flex',
    gap: vars.space.xs,
});

export const saveInput = style({
    flex: 1,
    minWidth: 0,
    fontFamily: vars.font.body,
    fontSize: '0.72rem',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '3px 8px',
    outline: 'none',
    ':focus': { borderColor: vars.color.accent },
    '::placeholder': { color: vars.color.mutedForeground },
});

export const profileRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.xs,
});

export const profileDelete = style({
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    width: '20px',
    height: '20px',
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    flexShrink: 0,
    ':hover': { color: vars.color.danger, background: vars.color.muted },
});

export const updateBtn = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '7px',
    fontFamily: vars.font.display,
    fontSize: '0.72rem',
    fontWeight: 600,
    padding: '7px 0',
    cursor: 'pointer',
    borderRadius: vars.radius.sm,
    border: `1px solid ${vars.color.border}`,
    background: vars.color.inset,
    color: vars.color.accent,
    transition: 'all 0.12s',
    ':hover': {
        borderColor: vars.color.accent,
        background: vars.color.accentDim,
    },
});

export const emptyHint = style({
    fontSize: '0.68rem',
    color: vars.color.mutedForeground,
    padding: '2px 8px',
});

export const convPreview = style({
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    display: 'flex',
    gap: vars.space.md,
    fontVariantNumeric: 'tabular-nums',
});

export const resetBtn = style({
    fontFamily: vars.font.display,
    fontSize: '0.66rem',
    fontWeight: 500,
    color: vars.color.mutedForeground,
    background: 'transparent',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '3px 10px',
    cursor: 'pointer',
    transition: 'all 0.12s',
    ':hover': {
        color: vars.color.foreground,
        borderColor: vars.color.borderBright,
    },
});

export const clock = style({
    fontFamily: vars.font.mono,
    fontSize: '0.82rem',
    fontWeight: 500,
    color: vars.color.foreground,
    fontVariantNumeric: 'tabular-nums',
});
