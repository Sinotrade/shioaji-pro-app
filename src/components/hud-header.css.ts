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
    // 窄視窗時 flex 壓縮會讓副標逐字折行、header 長成兩列
    whiteSpace: 'nowrap',
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

// server 版本與 app 期望不一致的警示（hover 有完整說明）
export const versionWarn = style({
    color: vars.color.amber,
    fontWeight: 600,
    cursor: 'help',
});

export const spacer = style({ flex: 1 });

// 頂欄所有 chip/按鈕的統一高度 — 字級與 padding 各異會造成 23/25px
// 混排，邊框線上下參差（使用者回報的「水平不齊」）
const HEADER_ITEM_H = '25px';

export const chip = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    fontFamily: vars.font.mono,
    fontSize: '0.72rem',
    fontVariantNumeric: 'tabular-nums',
    padding: '0 10px',
    height: HEADER_ITEM_H,
    boxSizing: 'border-box',
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


// indeterminate progress shimmer for the manager popover while starting
const slide = keyframes({
    '0%': { transform: 'translateX(-100%)' },
    '100%': { transform: 'translateX(250%)' },
});

export const progressTrack = style({
    height: '3px',
    borderRadius: '2px',
    background: vars.color.muted,
    overflow: 'hidden',
    position: 'relative',
});

export const progressGlider = style({
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: '40%',
    borderRadius: '2px',
    background: `linear-gradient(90deg, transparent, ${vars.color.amber}, transparent)`,
    animation: `${slide} 1.3s ease-in-out infinite`,
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
    padding: '0 10px',
    height: '25px',
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    whiteSpace: 'nowrap',
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
    padding: '0 10px',
    height: '25px',
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    whiteSpace: 'nowrap',
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

// header 版 Kill Switch：resetBtn 的尺寸、killBtnOn 的警示色 — 鎖定中
// 必須一眼看見且一鍵可解
export const killHeaderOn = style({
    fontFamily: vars.font.display,
    fontSize: '0.66rem',
    fontWeight: 700,
    color: '#fff',
    background: vars.color.danger,
    border: `1px solid ${vars.color.danger}`,
    borderRadius: vars.radius.sm,
    padding: '0 10px',
    height: '25px',
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    animation: 'pulse-glow 1.2s infinite',
});

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

// ⚡全開 layout picker thumbnails
export const flashLayoutItem = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    width: '100%',
    padding: '5px 8px',
    cursor: 'pointer',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: vars.radius.sm,
    textAlign: 'left',
    ':hover': { background: vars.color.muted },
});

export const flashThumb = style({
    position: 'relative',
    width: '56px',
    height: '34px',
    flexShrink: 0,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: '3px',
});

export const flashThumbRegion = style({
    position: 'absolute',
    display: 'grid',
    gap: '1px',
});

export const flashThumbCell = style({
    background: vars.color.accent,
    opacity: 0.55,
    borderRadius: '1px',
});

export const flashLayoutLabel = style({
    fontFamily: vars.font.body,
    fontSize: '0.72rem',
    fontWeight: 500,
    color: vars.color.foreground,
    display: 'flex',
    flexDirection: 'column',
});

export const presetDesc = style({
    display: 'block',
    fontSize: '0.6rem',
    fontWeight: 400,
    color: vars.color.mutedForeground,
    marginTop: '1px',
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
    ':disabled': {
        cursor: 'wait',
        color: vars.color.mutedForeground,
        borderColor: vars.color.border,
        background: vars.color.inset,
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
    padding: '0 10px',
    height: '25px',
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
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

// 窄視窗時 header 維持單列：文字已全部 nowrap 不再折行，改依優先序
// 自動收起純資訊項（互動按鈕與 LIVE 永遠保留、不會被裁切）。被收起
// 的資訊各有替代入口：加權/基差可加自選或開行情面板、銀行水位在帳務
// dock、時鐘看系統列；這幾項本來就能在 設定 → 頂欄顯示 手動關閉。
export const infoAutoHide = styleVariants({
    // 先收：基差、時鐘
    first: {
        '@media': { '(max-width: 1400px)': { display: 'none' } },
    },
    // 再收：銀行水位
    second: {
        '@media': { '(max-width: 1150px)': { display: 'none' } },
    },
    // 最後收：加權
    last: {
        '@media': { '(max-width: 1050px)': { display: 'none' } },
    },
});

// ---- server manager：狀態卡 chips、switch 列與設定 dialog ----

export const srvChipRow = style({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '4px',
});

export const srvChip = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    fontVariantNumeric: 'tabular-nums',
    padding: '2px 7px',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    background: vars.color.inset,
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
});

export const srvPhaseRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    fontFamily: vars.font.display,
    fontSize: '0.76rem',
    fontWeight: 600,
    color: vars.color.foreground,
});

export const switchRow = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: vars.space.sm,
    padding: '1px 0',
});

export const switchLabel = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontFamily: vars.font.body,
    fontSize: '0.72rem',
    color: vars.color.foreground,
    minWidth: 0,
});

const switchTrackBase = style({
    position: 'relative',
    width: '30px',
    height: '16px',
    borderRadius: '999px',
    border: '1px solid',
    cursor: 'pointer',
    flexShrink: 0,
    padding: 0,
    transition: 'all 0.15s',
    '::after': {
        content: '',
        position: 'absolute',
        top: '2px',
        width: '10px',
        height: '10px',
        borderRadius: '50%',
        transition: 'all 0.15s',
    },
    ':disabled': { opacity: 0.5, cursor: 'wait' },
});

export const switchTrack = styleVariants({
    off: [
        switchTrackBase,
        {
            background: vars.color.inset,
            borderColor: vars.color.border,
            '::after': { left: '2px', background: vars.color.mutedForeground },
            ':hover': { borderColor: vars.color.borderBright },
        },
    ],
    on: [
        switchTrackBase,
        {
            background: vars.color.accentDim,
            borderColor: vars.color.accent,
            '::after': { left: '16px', background: vars.color.accent },
        },
    ],
});

export const srvDialogBackdrop = style({
    position: 'fixed',
    inset: 0,
    zIndex: 209,
    background: 'rgba(0, 0, 0, 0.45)',
});

export const srvDialog = style({
    position: 'fixed',
    top: '7vh',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 210,
    width: 'min(26rem, calc(100vw - 32px))',
    maxHeight: '84vh',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.md,
    background: vars.color.panelRaised,
    boxShadow: '0 18px 48px rgba(0, 0, 0, 0.45)',
    padding: vars.space.md,
});

export const srvDialogTitle = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontFamily: vars.font.display,
    fontSize: '0.8rem',
    fontWeight: 700,
    color: vars.color.foreground,
});

export const srvSection = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    paddingTop: vars.space.sm,
    borderTop: `1px solid ${vars.color.border}`,
});

export const srvDanger = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    paddingTop: vars.space.sm,
    borderTop: `1px dashed ${vars.color.danger}`,
});
