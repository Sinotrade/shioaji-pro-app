// src/components/chart-drawing-tools.css.ts — 畫圖工具列（圖表左側直排）
//
// TradingView 式的左側工具列：貼著 K 線圖左緣的窄直排，選工具、改樣式、
// 處理選取中的物件都在這一條上。

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

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
    // 矮面板放不下全部按鈕時整條可捲動（選取中的鎖定／隱藏／複製／刪除
    // 在最下面，被裁掉就點不到）。捲軸不佔寬度，滾輪照常可捲
    minHeight: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
    scrollbarWidth: 'none',
    selectors: { '&::-webkit-scrollbar': { display: 'none' } },
});

const btnBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '26px',
    height: '24px',
    cursor: 'pointer',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    transition: 'all 0.12s',
    ':hover': { color: vars.color.foreground, background: vars.color.muted },
});

export const railBtn = styleVariants({
    normal: [btnBase, { flexShrink: 0 }],
    // 武裝中的工具沿用交易模式那組的視覺語彙（琥珀＝等你點圖）
    armed: [
        btnBase,
        {
            flexShrink: 0,
            // 武裝中的工具外加一圈描邊，與「游標」的選中底色明顯不同
            boxShadow: `0 0 0 1px ${vars.color.foreground}`,
            color: '#1a1304',
            background: vars.color.amber,
            borderColor: vars.color.amber,
            ':hover': { color: '#1a1304', background: vars.color.amber },
        },
    ],
    active: [btnBase, { flexShrink: 0, color: vars.color.foreground, background: vars.color.muted }],
    disabled: [
        btnBase,
        {
            flexShrink: 0,
            opacity: 0.35,
            cursor: 'not-allowed',
            ':hover': { color: vars.color.mutedForeground, background: 'transparent' },
        },
    ],
});

export const railDivider = style({
    width: '18px',
    height: '1px',
    margin: '3px 0',
    background: vars.color.border,
    flexShrink: 0,
});

// 樣式鈕上的色塊 — 直接顯示目前顏色，不用打開面板就看得到
export const swatchBtn = style([
    btnBase,
    {
        flexShrink: 0,
        ':hover': { background: vars.color.muted },
    },
]);

export const swatchDot = style({
    width: '14px',
    height: '14px',
    borderRadius: '3px',
    border: `1px solid ${vars.color.border}`,
});

// 樣式面板：portal 到 body、以視窗座標定位（位置由元件依可用空間算），
// 不受 K 線面板邊界裁切；視窗仍放不下時限高並捲動
export const pop = style({
    zIndex: 1000,
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '8px 10px',
    overflowY: 'auto',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
    boxShadow: '0 6px 20px rgba(0, 0, 0, 0.35)',
    whiteSpace: 'nowrap',
    fontFamily: vars.font.body,
});

// 工具列按鈕的提示（portal 到 body，fixed 定位在按鈕右側、垂直置中）
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

export const row = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '0.64rem',
    color: vars.color.mutedForeground,
});

export const label = style({
    minWidth: '2.6em',
});

export const palette = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(5, 1fr)',
    gap: '4px',
});

const swatchBase = style({
    width: '16px',
    height: '16px',
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

const chipBase = style({
    fontFamily: vars.font.body,
    fontSize: '0.62rem',
    padding: '1px 7px',
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
});

export const slider = style({
    WebkitAppearance: 'none',
    appearance: 'none',
    width: '90px',
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

// 樣式面板內的水平分隔
export const popDivider = style({
    height: '1px',
    margin: '2px 0',
    background: vars.color.border,
});

export const priceInput = style({
    width: '5.4rem',
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    fontWeight: 600,
    textAlign: 'right',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '1px 6px',
    outline: 'none',
    ':focus': { borderColor: vars.color.accent },
});

export const hint = style({
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
    maxWidth: '16em',
    whiteSpace: 'normal',
    lineHeight: 1.4,
});
