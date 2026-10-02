// src/components/chart-drawing-tools.css.ts — 畫圖工具（左側分組工具列、
// 浮動物件工具列、設定視窗、物件列表、文字輸入框）
//
// 顏色一律用主題 token；只有「武裝中」沿用交易模式那組琥珀語彙。

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

// ── 左側工具列 ───────────────────────────────────────────────────────

// 直排本體 — 固定寬度，佔位而非浮動（浮動會蓋住最左邊那幾根 K 棒）
export const rail = style({
    position: 'relative',
    zIndex: 6,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '1px',
    flexShrink: 0,
    padding: '4px 3px',
    borderRight: `1px solid ${vars.color.border}`,
    background: vars.color.panel,
    // 矮面板放不下全部按鈕時整條可捲動；捲軸不佔寬度，滾輪照常可捲
    minHeight: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
    scrollbarWidth: 'none',
    selectors: { '&::-webkit-scrollbar': { display: 'none' } },
});

export const railSpacer = style({ flex: 1, minHeight: '4px' });

const btnBase = style({
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '26px',
    height: '24px',
    padding: 0,
    cursor: 'pointer',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    transition: 'all 0.12s',
    ':hover': { color: vars.color.foreground, background: vars.color.muted },
});

export const railBtn = styleVariants({
    normal: [btnBase],
    // 武裝中的工具沿用交易模式那組的視覺語彙（琥珀＝等你點圖），外加
    // 一圈描邊，與「游標」的選中底色明顯不同
    armed: [
        btnBase,
        {
            boxShadow: `0 0 0 1px ${vars.color.foreground}`,
            color: '#1a1304',
            background: vars.color.amber,
            borderColor: vars.color.amber,
            ':hover': { color: '#1a1304', background: vars.color.amber },
        },
    ],
    active: [btnBase, { color: vars.color.foreground, background: vars.color.muted }],
    // 開關類（磁吸、全部鎖定）開啟時：強調色描邊
    on: [
        btnBase,
        {
            color: vars.color.accent,
            background: vars.color.accentDim,
            borderColor: vars.color.accent,
        },
    ],
    disabled: [
        btnBase,
        {
            opacity: 0.35,
            cursor: 'not-allowed',
            ':hover': { color: vars.color.mutedForeground, background: 'transparent' },
        },
    ],
});

// 組按鈕右下角的小三角 — 點它展開組內工具
export const groupWrap = style({ position: 'relative', flexShrink: 0 });

export const caret = style({
    position: 'absolute',
    right: '-2px',
    bottom: '-1px',
    width: '10px',
    height: '10px',
    padding: 0,
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    selectors: {
        '&::after': {
            content: '""',
            position: 'absolute',
            right: '2px',
            bottom: '2px',
            borderLeft: '4px solid transparent',
            borderBottom: `4px solid ${vars.color.mutedForeground}`,
        },
        '&:hover::after': { borderBottomColor: vars.color.foreground },
    },
});

export const railDivider = style({
    width: '18px',
    height: '1px',
    margin: '3px 0',
    background: vars.color.border,
    flexShrink: 0,
});

// ── 彈出層（工具組、色盤、線寬）──────────────────────────────────────

// portal 到 body、以視窗座標定位（位置由元件依可用空間算），不受 K 線
// 面板邊界裁切；視窗仍放不下時限高並捲動
export const pop = style({
    zIndex: 1000,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: '6px',
    overflowY: 'auto',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.md,
    boxShadow: '0 10px 26px rgba(0, 0, 0, 0.4)',
    whiteSpace: 'nowrap',
    fontFamily: vars.font.body,
    fontSize: '0.7rem',
    color: vars.color.foreground,
});

export const popTitle = style({
    padding: '2px 6px 4px',
    fontSize: '0.64rem',
    color: vars.color.mutedForeground,
});

export const flyItem = styleVariants({
    normal: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        minWidth: '12.5rem',
        padding: '4px 6px',
        borderRadius: vars.radius.sm,
        cursor: 'pointer',
        color: vars.color.foreground,
        background: 'transparent',
        border: 'none',
        fontFamily: vars.font.body,
        fontSize: '0.7rem',
        textAlign: 'left',
        ':hover': { background: vars.color.muted },
    },
    active: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        minWidth: '12.5rem',
        padding: '4px 6px',
        borderRadius: vars.radius.sm,
        cursor: 'pointer',
        color: vars.color.foreground,
        background: vars.color.accentDim,
        border: 'none',
        fontFamily: vars.font.body,
        fontSize: '0.7rem',
        textAlign: 'left',
    },
});

export const flyLabel = style({ flex: 1 });

export const kbd = style({
    fontFamily: vars.font.mono,
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
    border: `1px solid ${vars.color.border}`,
    borderRadius: '3px',
    padding: '0 4px',
});

export const starBtn = styleVariants({
    off: {
        display: 'inline-flex',
        padding: '2px',
        cursor: 'pointer',
        background: 'transparent',
        border: 'none',
        color: vars.color.mutedForeground,
        ':hover': { color: vars.color.amber },
    },
    on: {
        display: 'inline-flex',
        padding: '2px',
        cursor: 'pointer',
        background: 'transparent',
        border: 'none',
        color: vars.color.amber,
    },
});

// 工具列按鈕的提示（portal 到 body，fixed 定位在按鈕旁、垂直置中）
export const tip = style({
    position: 'fixed',
    zIndex: 1001,
    transform: 'translateY(-50%)',
    pointerEvents: 'none',
    padding: '3px 8px',
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    lineHeight: 1.4,
    whiteSpace: 'nowrap',
    color: vars.color.foreground,
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
});

// ── 浮動物件工具列 ───────────────────────────────────────────────────

export const floatBar = style({
    position: 'absolute',
    zIndex: 7,
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    padding: '3px',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.md,
    boxShadow: '0 8px 20px rgba(0, 0, 0, 0.35)',
    fontFamily: vars.font.body,
    fontSize: '0.68rem',
    color: vars.color.foreground,
    whiteSpace: 'nowrap',
});

export const floatText = style([
    btnBase,
    { width: 'auto', padding: '0 6px', color: vars.color.foreground, fontSize: '0.68rem', fontFamily: vars.font.mono },
]);

export const floatSep = style({
    width: '1px',
    height: '16px',
    margin: '0 2px',
    background: vars.color.border,
});

export const swatchDot = style({
    width: '14px',
    height: '14px',
    borderRadius: '3px',
    border: `1px solid ${vars.color.border}`,
});

export const dashIcon = styleVariants({
    solid: { width: '16px', height: 0, borderTop: `2px solid currentColor` },
    dashed: { width: '16px', height: 0, borderTop: `2px dashed currentColor` },
});

export const palette = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(5, 1fr)',
    gap: '4px',
    padding: '2px',
});

const swatchBase = style({
    width: '18px',
    height: '18px',
    borderRadius: '3px',
    cursor: 'pointer',
    border: '2px solid transparent',
    padding: 0,
});

export const swatch = styleVariants({
    normal: [swatchBase],
    // 選中的色塊用前景色描邊 — 深淺主題下都看得出來是哪一個
    active: [swatchBase, { borderColor: vars.color.foreground }],
});

// ── 設定視窗 ─────────────────────────────────────────────────────────

export const overlay = style({
    position: 'fixed',
    inset: 0,
    zIndex: 2000,
    background: 'rgba(0, 0, 0, 0.45)',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingTop: '12vh',
});

export const dialog = style({
    display: 'flex',
    flexDirection: 'column',
    width: 'min(24rem, 92vw)',
    maxHeight: '76vh',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.lg,
    boxShadow: '0 24px 64px rgba(0, 0, 0, 0.5)',
    overflow: 'hidden',
    fontFamily: vars.font.body,
    color: vars.color.foreground,
});

export const dialogHeader = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 14px 6px',
    fontSize: '0.84rem',
    fontWeight: 600,
});

export const tabs = style({
    display: 'flex',
    gap: '2px',
    padding: '0 12px',
    borderBottom: `1px solid ${vars.color.border}`,
});

export const tab = styleVariants({
    normal: {
        padding: '6px 10px',
        cursor: 'pointer',
        background: 'transparent',
        border: 'none',
        borderBottom: '2px solid transparent',
        color: vars.color.mutedForeground,
        fontFamily: vars.font.body,
        fontSize: '0.72rem',
    },
    active: {
        padding: '6px 10px',
        cursor: 'pointer',
        background: 'transparent',
        border: 'none',
        borderBottom: `2px solid ${vars.color.accent}`,
        color: vars.color.foreground,
        fontFamily: vars.font.body,
        fontSize: '0.72rem',
    },
});

export const dialogBody = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '12px 14px',
    overflowY: 'auto',
});

export const dialogFooter = style({
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '6px',
    padding: '8px 14px 12px',
});

export const row = style({
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '0.7rem',
    color: vars.color.mutedForeground,
});

export const label = style({ minWidth: '4.2em' });

const chipBase = style({
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    padding: '2px 8px',
    cursor: 'pointer',
    background: 'transparent',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    ':hover': { color: vars.color.foreground },
});

export const chip = styleVariants({
    normal: [chipBase],
    active: [chipBase, { color: vars.color.foreground, background: vars.color.muted }],
    primary: [
        chipBase,
        { color: vars.color.foreground, background: vars.color.accentDim, borderColor: vars.color.accent },
    ],
});

export const slider = style({
    WebkitAppearance: 'none',
    appearance: 'none',
    width: '110px',
    height: '4px',
    borderRadius: '2px',
    background: `linear-gradient(to right, ${vars.color.accent} var(--sj-fill, 50%), ${vars.color.border} var(--sj-fill, 50%))`,
    outline: 'none',
    cursor: 'pointer',
    selectors: {
        '&::-webkit-slider-thumb': {
            WebkitAppearance: 'none',
            appearance: 'none',
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            background: vars.color.accent,
            border: 'none',
        },
        '&::-moz-range-thumb': {
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            background: vars.color.accent,
            border: 'none',
        },
    },
});

export const input = style({
    minWidth: 0,
    width: '7rem',
    fontFamily: vars.font.mono,
    fontSize: '0.7rem',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '2px 6px',
    outline: 'none',
    ':focus': { borderColor: vars.color.accent },
});

export const wideInput = style([input, { flex: 1, width: 'auto', fontFamily: vars.font.body }]);

export const priceInput = style([input, { width: '6.4rem', textAlign: 'right', fontWeight: 600 }]);

export const hint = style({
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
    whiteSpace: 'normal',
    lineHeight: 1.45,
});

// ── 物件列表 ─────────────────────────────────────────────────────────

export const list = style({
    display: 'flex',
    flexDirection: 'column',
    flexShrink: 0,
    width: '184px',
    minHeight: 0,
    borderLeft: `1px solid ${vars.color.border}`,
    background: vars.color.panel,
    fontFamily: vars.font.body,
    fontSize: '0.7rem',
    color: vars.color.foreground,
});

export const listHeader = style({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 8px',
    fontWeight: 600,
    borderBottom: `1px solid ${vars.color.border}`,
});

export const listCount = style({ color: vars.color.mutedForeground, fontWeight: 400 });

export const listBody = style({ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px' });

export const listRow = styleVariants({
    normal: {
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        padding: '3px 4px',
        borderRadius: vars.radius.sm,
        cursor: 'pointer',
        ':hover': { background: vars.color.muted },
    },
    selected: {
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        padding: '3px 4px',
        borderRadius: vars.radius.sm,
        cursor: 'pointer',
        background: vars.color.accentDim,
    },
    dropTarget: {
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        padding: '3px 4px',
        borderRadius: vars.radius.sm,
        cursor: 'pointer',
        boxShadow: `inset 0 2px 0 ${vars.color.accent}`,
    },
});

export const grip = style({ display: 'inline-flex', color: vars.color.mutedForeground, cursor: 'grab' });

export const dot = style({ width: '8px', height: '8px', borderRadius: '2px', flexShrink: 0 });

export const rowName = styleVariants({
    normal: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    hidden: {
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        opacity: 0.5,
    },
});

export const iconBtn = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '18px',
    height: '18px',
    padding: 0,
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    borderRadius: '3px',
    color: vars.color.mutedForeground,
    ':hover': { color: vars.color.foreground, background: vars.color.muted },
});

export const listFooter = style({
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '6px 8px',
    borderTop: `1px solid ${vars.color.border}`,
});

export const empty = style({ padding: '10px 6px', color: vars.color.mutedForeground, whiteSpace: 'normal' });

// ── 文字註記輸入框 ───────────────────────────────────────────────────

export const textEditor = style({
    position: 'absolute',
    zIndex: 8,
    minWidth: '8rem',
    minHeight: '1.6rem',
    padding: '3px 6px',
    fontFamily: 'sans-serif',
    fontSize: '12px',
    lineHeight: '16px',
    color: vars.color.foreground,
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.accent}`,
    borderRadius: '3px',
    outline: 'none',
    resize: 'both',
});

// 斐波那契比例清單（設定視窗）
export const fibLevels = style({ display: 'flex', flexDirection: 'column', gap: '4px' });

export const fibLevelRow = style({ display: 'flex', alignItems: 'center', gap: '6px' });
