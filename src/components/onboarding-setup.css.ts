// src/components/onboarding-setup.css.ts — first-run "no API key yet" gate.
// Full-screen, not a popover — this replaces the entire dashboard until the
// user has a working server, so it needs its own visual weight.

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';
import { DOCKED_WIDTH, GUIDE_FONT, g } from './apply-guide.css';

export const shell = style({
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: vars.color.background,
    zIndex: 1000,
});

// 申請視窗蓋住右側時：導覽卡貼齊左側。原生端保留左側 540px（apply_window.rs guide），
// 卡片 508px＋左邊 16px
export const shellDocked = style([shell, {
    justifyContent: 'flex-start',
    paddingLeft: 16,
}]);


export const guideColumn = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    maxHeight: '92vh',
    minHeight: 0,
});

export const guideErrors = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    width: 'min(34rem, calc(100vw - 2rem))',
    boxSizing: 'border-box',
    fontSize: GUIDE_FONT,
    color: g.text,
    padding: vars.space.md,
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.lg,
});

export const guideErrorsDocked = style([guideErrors, { width: `min(${DOCKED_WIDTH}, calc(100vw - 2rem))` }]);

export const guideLink = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    alignSelf: 'flex-start',
    padding: 0,
    border: 0,
    background: 'transparent',
    color: vars.color.accent,
    cursor: 'pointer',
    fontFamily: vars.font.body,
    minHeight: 44,
    fontSize: '1em',
    fontWeight: 650,
    textDecoration: 'underline',
    textUnderlineOffset: '0.2em',
    ':focus-visible': { outline: `3px solid ${vars.color.accent}`, outlineOffset: 2 },
});

export const card = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.md,
    // 帳號元件用 em 排版，卡片字級決定它在首次設定的大小
    width: 'min(34rem, calc(100vw - 2rem))',
    maxHeight: '92vh',
    overflowY: 'auto',
    boxSizing: 'border-box',
    // 2026-11 無障礙：與申請導覽同一個字級（標準約 17.7px、大字 20px）
    fontSize: GUIDE_FONT,
    color: vars.color.foreground,
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.lg,
    boxShadow: '0 24px 64px rgba(0, 0, 0, 0.45)',
    padding: vars.space.xl,
});


export const logo = style({
    fontFamily: vars.font.display,
    fontSize: '1.3em',
    fontWeight: 700,
    color: vars.color.foreground,
});

export const subtitle = style({
    fontFamily: vars.font.body,
    fontSize: '0.9em',
    color: g.text2,
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
    fontSize: '0.88em',
    color: g.text2,
    lineHeight: 1.6,
    margin: 0,
});

export const errorText = style({
    fontFamily: vars.font.body,
    fontSize: '0.95em',
    fontWeight: 600,
    margin: 0,
    color: g.danger,
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
