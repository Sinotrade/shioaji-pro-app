// src/components/settings-dialog.css.ts — 統一設定 dialog：置中、左側分類
// 欄＋右內容；窄視窗時分類欄轉為頂部橫向 chips。視覺語彙沿用 server
// manager 的 srvDialog 家族（hud-header.css.ts）。

import { createContainer, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

// dialog 一縮窄就轉 chips：dialog 滿寬 38rem 時 content box 是 36rem − 2px（padding 1rem＋border 1px）。
// container query 的 rem 跟 root 字級（fontScale）走；media query 的 rem 固定 16px，
// 字級 1.15／1.3 時 dialog 早在 640px 前就縮了，分類欄還佔著寬度，價位框會截掉末位數字。
// 舊 WebView（Safari < 16）不認 @container：保留 640px media query 當退路
const NARROW = 'screen and (max-width: 640px)';
const dialogBox = createContainer();
const NARROW_BOX = `${dialogBox} (max-width: 35.8rem)`;
const NARROW_ACCOUNTS_BOX = `${dialogBox} (max-width: 43.8rem)`;

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
    containerName: dialogBox,
    containerType: 'inline-size',
    // 程式化 focus() 進視窗本體（tabIndex=-1）時不畫整個視窗的焦點框；內部控制項照常有焦點環
    selectors: { '&:focus': { outline: 'none' } },
});

// 帳號頁的測試單需要同列容納市場、商品、價格與操作。
export const accountsDialog = style({ width: 'min(46rem, calc(100vw - 32px))' });

const narrowBody = { flexDirection: 'column', gap: vars.space.sm } as const;
const narrowNav = {
    flexDirection: 'row',
    width: '100%',
    borderRight: 'none',
    borderBottom: `1px solid ${vars.color.border}`,
    paddingRight: 0,
    paddingBottom: vars.space.sm,
    overflowX: 'auto',
} as const;

export const body = style({
    display: 'flex',
    gap: vars.space.md,
    flex: 1,
    minHeight: 0,
    '@media': { [NARROW]: narrowBody },
    '@container': {
        [NARROW_BOX]: narrowBody,
        [NARROW_ACCOUNTS_BOX]: { selectors: { [`${accountsDialog} &`]: narrowBody } },
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
    '@media': { [NARROW]: narrowNav },
    '@container': {
        [NARROW_BOX]: narrowNav,
        [NARROW_ACCOUNTS_BOX]: { selectors: { [`${accountsDialog} &`]: narrowNav } },
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

export const signLinks = style({
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px 12px',
    marginTop: '4px',
});

export const signLink = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    color: vars.color.accent,
    textDecoration: 'none',
    selectors: {
        '&:hover': { textDecoration: 'underline' },
    },
});

export const errorText = style({
    fontSize: '0.68rem',
    color: vars.color.danger,
    whiteSpace: 'pre-wrap',
});
