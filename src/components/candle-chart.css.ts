// src/components/candle-chart.css.ts

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const wrap = style({
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
});

export const toolbar = style({
    display: 'flex',
    gap: '2px',
    padding: `4px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

const tfBase = style({
    fontFamily: vars.font.mono,
    fontSize: '0.7rem',
    fontWeight: 500,
    padding: '2px 10px',
    cursor: 'pointer',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    transition: 'all 0.12s',
    ':hover': { color: vars.color.foreground },
});

export const tfBtn = styleVariants({
    normal: [tfBase],
    active: [
        tfBase,
        {
            color: vars.color.foreground,
            background: vars.color.muted,
        },
    ],
});

export const iconBtn = style([
    tfBase,
    {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2px 6px',
    },
]);

export const toolbarDivider = style({
    width: '1px',
    alignSelf: 'stretch',
    margin: '2px 4px',
    background: vars.color.border,
});

const modeBase = style({
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    fontWeight: 500,
    padding: '2px 8px',
    cursor: 'pointer',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    transition: 'all 0.12s',
    ':hover': { color: vars.color.foreground },
});

export const modeBtn = styleVariants({
    normal: [modeBase],
    active: [
        modeBase,
        { color: vars.color.foreground, background: vars.color.muted },
    ],
    armed: [
        modeBase,
        {
            color: '#1a1304',
            background: vars.color.amber,
            borderColor: vars.color.amber,
            fontWeight: 600,
        },
    ],
});

// 圖表下單數量 — 緊貼交易模式按鈕群，帶「量」標籤（不再孤懸右側）
export const qtyWrap = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    fontFamily: vars.font.body,
    fontSize: '0.64rem',
    color: vars.color.mutedForeground,
    marginLeft: '2px',
});

export const qtyInput = style({
    width: '2.6rem',
    fontFamily: vars.font.mono,
    fontSize: '0.7rem',
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

// 指標按鈕獨立靠右（它屬於圖表工具，不屬於交易模式群）
export const indicatorBtn = styleVariants({
    normal: [modeBase, { marginLeft: 'auto' }],
    active: [
        modeBase,
        {
            marginLeft: 'auto',
            color: vars.color.foreground,
            background: vars.color.muted,
        },
    ],
});


export const modeHint = style({
    position: 'absolute',
    top: '8px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 5,
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    fontWeight: 600,
    color: '#1a1304',
    background: vars.color.amber,
    borderRadius: vars.radius.sm,
    padding: '2px 10px',
    pointerEvents: 'none',
});

export const triggerList = style({
    position: 'absolute',
    top: '8px',
    left: '8px',
    zIndex: 5,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    fontFamily: vars.font.mono,
    fontSize: '0.64rem',
    fontVariantNumeric: 'tabular-nums',
});

export const triggerRow = style({
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '1px 6px',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.foreground,
});

export const orderCancel = style({
    fontFamily: vars.font.display,
    fontSize: '0.58rem',
    fontWeight: 600,
    letterSpacing: '0.04em',
    cursor: 'pointer',
    background: 'transparent',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    color: vars.color.danger,
    padding: '0 6px',
    ':hover': {
        borderColor: vars.color.danger,
        background: vars.color.muted,
    },
});

export const triggerRemove = style({
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    lineHeight: 1,
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    color: vars.color.mutedForeground,
    padding: '1px 2px',
    ':hover': { color: vars.color.danger },
});

export const chartHost = style({
    flex: 1,
    minHeight: 0,
    position: 'relative',
});

// ---- indicator legend（TradingView 式，圖上左上角，一列一個實例）----

const legendItemBase = style({
    position: 'relative', // anchors the ⋯ context menu
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '1px 4px 1px 6px',
    background: 'color-mix(in srgb, ' + vars.color.panel + ' 72%, transparent)',
    borderRadius: vars.radius.sm,
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    fontVariantNumeric: 'tabular-nums',
    width: 'fit-content',
    pointerEvents: 'auto',
});

export const legendItem = styleVariants({
    normal: [legendItemBase],
    hidden: [legendItemBase, { opacity: 0.45 }],
});

export const legendLabel = style({
    fontFamily: vars.font.mono,
    fontSize: '0.62rem',
    fontWeight: 600,
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    padding: 0,
    ':hover': { textDecoration: 'underline' },
});

export const legendVals = style({
    display: 'inline-flex',
    gap: '6px',
});

export const legendVal = style({
    fontWeight: 500,
});

export const legendCtrls = style({
    display: 'inline-flex',
    gap: '1px',
    opacity: 0,
    transition: 'opacity 0.12s',
    selectors: {
        [`${legendItemBase}:hover &`]: { opacity: 1 },
    },
});

export const legendCtrlBtn = style({
    display: 'inline-flex',
    alignItems: 'center',
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    color: vars.color.mutedForeground,
    padding: '1px 2px',
    borderRadius: vars.radius.sm,
    ':hover': { color: vars.color.foreground, background: vars.color.muted },
});

// 副圖指標的 legend — 絕對定位到自己的 pane 左上角
export const paneLegend = style({
    position: 'absolute',
    left: '8px',
    zIndex: 5,
    fontFamily: vars.font.mono,
    fontSize: '0.64rem',
    fontVariantNumeric: 'tabular-nums',
});

export const legendNote = style({
    fontFamily: vars.font.body,
    fontSize: '0.58rem',
    color: vars.color.mutedForeground,
});

export const legendMenuBackdrop = style({
    position: 'fixed',
    inset: 0,
    zIndex: 40,
});

export const legendMenu = style({
    position: 'absolute',
    top: 'calc(100% + 3px)',
    left: 0,
    zIndex: 41,
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    width: '11rem',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.md,
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
    padding: '4px',
});

const legendMenuItemBase = style({
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    fontFamily: vars.font.body,
    fontSize: '0.7rem',
    textAlign: 'left',
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    borderRadius: vars.radius.sm,
    color: vars.color.foreground,
    padding: '5px 8px',
    ':hover': { background: vars.color.muted },
    ':disabled': { opacity: 0.35, cursor: 'default' },
});

export const legendMenuItem = legendMenuItemBase;

export const legendMenuItemDanger = style([
    legendMenuItemBase,
    { color: vars.color.danger },
]);

export const emptyMsg = style({
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: vars.color.mutedForeground,
    fontFamily: vars.font.display,
    fontSize: '0.78rem',
});
