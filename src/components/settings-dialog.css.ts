// src/components/settings-dialog.css.ts — 統一設定 dialog：置中、左側分類
// 欄＋右內容；窄視窗時分類欄轉為頂部橫向 chips。視覺語彙沿用 server
// manager 的 srvDialog 家族（hud-header.css.ts）。

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

const NARROW = 'screen and (max-width: 640px)';

export const backdrop = style({
    position: 'fixed',
    inset: 0,
    zIndex: 209,
    background: 'rgba(0, 0, 0, 0.45)',
});

export const dialog = style({
    position: 'fixed',
    top: '7vh',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 210,
    width: 'min(38rem, calc(100vw - 32px))',
    // fixed-ish height so switching categories doesn't bounce the layout
    height: 'min(30rem, 84vh)',
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.md,
    background: vars.color.panelRaised,
    boxShadow: '0 18px 48px rgba(0, 0, 0, 0.45)',
    padding: vars.space.md,
});

export const body = style({
    display: 'flex',
    gap: vars.space.md,
    flex: 1,
    minHeight: 0,
    '@media': {
        [NARROW]: { flexDirection: 'column', gap: vars.space.sm },
    },
});

export const nav = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    width: '9.5rem',
    flexShrink: 0,
    borderRight: `1px solid ${vars.color.border}`,
    paddingRight: vars.space.sm,
    '@media': {
        [NARROW]: {
            flexDirection: 'row',
            width: '100%',
            borderRight: 'none',
            borderBottom: `1px solid ${vars.color.border}`,
            paddingRight: 0,
            paddingBottom: vars.space.sm,
            overflowX: 'auto',
        },
    },
});

const navItemBase = style({
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    fontFamily: vars.font.body,
    fontSize: '0.74rem',
    fontWeight: 500,
    textAlign: 'left',
    padding: '6px 9px',
    cursor: 'pointer',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    whiteSpace: 'nowrap',
    transition: 'all 0.12s',
    flexShrink: 0,
});

export const navItem = styleVariants({
    off: [navItemBase, { ':hover': { color: vars.color.foreground, background: vars.color.muted } }],
    on: [
        navItemBase,
        {
            color: vars.color.accent,
            background: vars.color.accentDim,
            borderColor: vars.color.accent,
            fontWeight: 600,
        },
    ],
});

export const content = style({
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    paddingRight: '2px',
});

// unsigned account row (issue #16): visible but never selectable
export const acctUnsigned = style({
    opacity: 0.55,
    cursor: 'not-allowed',
});

export const unsignedTag = style({
    marginLeft: '6px',
    fontSize: '0.6rem',
    color: vars.color.amber,
});

export const errorText = style({
    fontSize: '0.68rem',
    color: vars.color.danger,
    whiteSpace: 'pre-wrap',
});
