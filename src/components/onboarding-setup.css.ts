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

// row of [setup card, agent side-panel] — wraps to a single column narrow
// viewport since the agent panel needs real width to be usable
export const layout = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'stretch',
    justifyContent: 'center',
    gap: vars.space.lg,
    maxWidth: '92vw',
});

export const card = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.md,
    // 帳號元件用 em 排版，卡片字級決定它在首次設定的大小
    width: 'min(30rem, 92vw)',
    maxHeight: '92vh',
    overflowY: 'auto',
    boxSizing: 'border-box',
    fontSize: '0.875rem',
    color: vars.color.foreground,
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.lg,
    boxShadow: '0 24px 64px rgba(0, 0, 0, 0.45)',
    padding: vars.space.xl,
});

export const agentCard = style({
    display: 'flex',
    flexDirection: 'column',
    width: 'min(24rem, 92vw)',
    height: 'min(38rem, 86vh)',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.lg,
    boxShadow: '0 24px 64px rgba(0, 0, 0, 0.45)',
    overflow: 'hidden',
});

export const agentHeader = style({
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontFamily: vars.font.display,
    fontSize: '0.78rem',
    fontWeight: 600,
    color: vars.color.foreground,
    padding: `${vars.space.sm} ${vars.space.md}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

export const agentBody = style({
    flex: 1,
    minHeight: 0,
});

export const logo = style({
    fontFamily: vars.font.display,
    fontSize: '1.1rem',
    fontWeight: 700,
    color: vars.color.foreground,
});

export const subtitle = style({
    fontFamily: vars.font.body,
    fontSize: '0.8125rem',
    color: vars.color.mutedForeground,
    marginTop: '2px',
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

export const importBtn = style([
    modeBtnBase,
    {
        flex: '1 1 0', // 「選擇 .env 檔案」「選擇資料夾」並排平分一列
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '6px',
        fontWeight: 500,
        borderStyle: 'dashed',
        borderColor: vars.color.borderBright,
        color: vars.color.foreground,
    },
]);

export const importRow = style({ display: 'flex', flexWrap: 'wrap', gap: '6px' });
export const importChoice = style({
    padding: '5px 10px', borderRadius: vars.radius.md, cursor: 'pointer',
    border: `1px solid ${vars.color.border}`, background: vars.color.inset,
    color: vars.color.foreground, fontFamily: vars.font.mono, fontSize: '0.75rem',
    selectors: {
        '&:hover:not(:disabled)': { borderColor: vars.color.accent, color: vars.color.accent },
        '&:disabled': { opacity: 0.5, cursor: 'default' },
    },
});
const importMessageBase = style({ fontFamily: vars.font.body, fontSize: '0.7rem', overflowWrap: 'anywhere' });
export const importMessage = styleVariants({
    ok: [importMessageBase, { color: vars.color.accent }],
    error: [importMessageBase, { color: vars.color.danger }],
});

export const hint = style({
    fontFamily: vars.font.body,
    fontSize: '0.75rem',
    color: vars.color.mutedForeground,
    lineHeight: 1.6,
    margin: 0,
});

export const errorText = style({
    fontFamily: vars.font.body,
    fontSize: '0.75rem',
    fontWeight: 600,
    margin: 0,
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

export const logoutBox = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    paddingTop: vars.space.md,
    borderTop: `1px solid ${vars.color.border}`,
});

export const logoutActions = style({ display: 'flex', justifyContent: 'flex-end', gap: '6px' });
