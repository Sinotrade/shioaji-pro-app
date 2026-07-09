// src/components/onboarding-setup.css.ts — first-run "no API key yet" gate.
// Full-screen, not a popover — this replaces the entire dashboard until the
// user has a working server, so it needs its own visual weight.

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const shell = style({
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: vars.color.background,
    zIndex: 1000,
});

export const card = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.md,
    width: 'min(26rem, 92vw)',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.lg,
    boxShadow: '0 24px 64px rgba(0, 0, 0, 0.45)',
    padding: vars.space.xl,
});

export const logo = style({
    fontFamily: vars.font.display,
    fontSize: '1.1rem',
    fontWeight: 700,
    color: vars.color.foreground,
});

export const subtitle = style({
    fontFamily: vars.font.body,
    fontSize: '0.78rem',
    color: vars.color.mutedForeground,
    marginTop: '-6px',
});

export const fieldGroup = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
});

export const label = style({
    fontFamily: vars.font.display,
    fontSize: '0.66rem',
    fontWeight: 600,
    letterSpacing: '0.04em',
    color: vars.color.mutedForeground,
});

export const inputRow = style({
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
});

export const input = style({
    width: '100%',
    fontFamily: vars.font.mono,
    fontSize: '0.82rem',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
    padding: '9px 34px 9px 11px',
    outline: 'none',
    ':focus': { borderColor: vars.color.accent },
});

export const eyeBtn = style({
    position: 'absolute',
    right: '8px',
    display: 'inline-flex',
    alignItems: 'center',
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    color: vars.color.mutedForeground,
    padding: '4px',
    ':hover': { color: vars.color.foreground },
});

export const modeRow = style({
    display: 'flex',
    gap: '6px',
});

const modeBtnBase = style({
    flex: 1,
    fontFamily: vars.font.body,
    fontSize: '0.76rem',
    fontWeight: 600,
    cursor: 'pointer',
    borderRadius: vars.radius.md,
    padding: '8px',
    border: `1px solid ${vars.color.border}`,
    background: 'transparent',
    color: vars.color.mutedForeground,
});

export const modeBtn = styleVariants({
    normal: [modeBtnBase],
    sim: [
        modeBtnBase,
        {
            borderColor: vars.color.accent,
            color: vars.color.foreground,
            background: vars.color.muted,
        },
    ],
    prod: [
        modeBtnBase,
        {
            borderColor: vars.color.danger,
            color: vars.color.danger,
            background: vars.color.muted,
        },
    ],
});

export const prodWarn = style({
    fontFamily: vars.font.body,
    fontSize: '0.68rem',
    color: vars.color.danger,
});

export const caRow = style({
    display: 'flex',
    gap: '6px',
});

export const caPickBtn = style([
    modeBtnBase,
    { flex: 1, textAlign: 'left', fontWeight: 400 },
]);

export const hint = style({
    fontFamily: vars.font.body,
    fontSize: '0.68rem',
    color: vars.color.mutedForeground,
    lineHeight: 1.5,
});

export const errorText = style({
    fontFamily: vars.font.body,
    fontSize: '0.7rem',
    fontWeight: 600,
    color: vars.color.danger,
    whiteSpace: 'pre-wrap',
});

export const submitBtn = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    fontFamily: vars.font.display,
    fontSize: '0.86rem',
    fontWeight: 700,
    cursor: 'pointer',
    borderRadius: vars.radius.md,
    padding: '11px',
    border: 'none',
    background: vars.color.accent,
    color: '#0b0e14',
    ':disabled': { opacity: 0.5, cursor: 'default' },
});

export const footer = style({
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
    textAlign: 'center',
});
