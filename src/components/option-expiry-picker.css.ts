// src/components/option-expiry-picker.css.ts

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

// 收合列：‹ [到期摘要 ▾] › — 只佔一列、不橫向捲動；極窄時摘要以省略號截斷
export const picker = style({
    display: 'flex',
    alignItems: 'stretch',
    gap: '2px',
    flex: '0 1 auto',
    minWidth: 0,
});

const controlBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    fontVariantNumeric: 'tabular-nums',
    color: vars.color.foreground,
    background: 'transparent',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    ':hover': { background: vars.color.muted, borderColor: vars.color.borderBright },
    ':focus-visible': {
        outline: `1px solid ${vars.color.accent}`,
        outlineOffset: '-1px',
    },
    ':disabled': {
        cursor: 'default',
        opacity: 0.4,
        background: 'transparent',
        borderColor: vars.color.border,
    },
});

export const step = style([
    controlBase,
    {
        justifyContent: 'center',
        flexShrink: 0,
        width: '1.4rem',
        padding: 0,
        fontSize: '0.8rem',
        lineHeight: 1,
        color: vars.color.mutedForeground,
        ':hover': { color: vars.color.foreground },
    },
]);

export const trigger = style([
    controlBase,
    {
        gap: '5px',
        minWidth: 0,
        flex: '0 1 auto',
        padding: '2px 6px',
        overflow: 'hidden',
        selectors: {
            '&[aria-expanded="true"]': {
                borderColor: vars.color.accent,
                background: vars.color.accentDim,
            },
        },
    },
]);

export const caret = style({
    flexShrink: 0,
    marginLeft: '1px',
    fontSize: '0.6rem',
    color: vars.color.mutedForeground,
});

export const empty = style({
    color: vars.color.mutedForeground,
});

const dateBase = style({
    flexShrink: 0,
    fontFamily: vars.font.mono,
    fontWeight: 600,
});

// 遇假日調整的到期日：虛線底線提示，詳情見 tooltip
export const date = styleVariants({
    normal: [dateBase],
    shifted: [
        dateBase,
        {
            textDecoration: 'underline dotted',
            textUnderlineOffset: '2px',
        },
    ],
});

// 到期鈕變窄時依序讓位：剩餘天數、週幾；日期、週月標記與箭頭保持完整
export const weekday = style({
    flexShrink: 1,
    minWidth: 0,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'clip',
    fontFamily: vars.font.display,
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
});

const badgeBase = style({
    flexShrink: 0,
    fontFamily: vars.font.display,
    fontSize: '0.56rem',
    fontWeight: 600,
    lineHeight: 1.3,
    padding: '0 4px',
    borderRadius: vars.radius.sm,
    border: '1px solid transparent',
});

export const badge = styleVariants({
    monthly: [
        badgeBase,
        {
            color: vars.color.accent,
            background: vars.color.accentDim,
            borderColor: vars.color.accent,
        },
    ],
    weekly: [
        badgeBase,
        {
            color: vars.color.mutedForeground,
            background: vars.color.muted,
            borderColor: vars.color.border,
        },
    ],
});

const daysBase = style({
    fontFamily: vars.font.display,
    fontSize: '0.6rem',
    whiteSpace: 'nowrap',
});

export const days = styleVariants({
    normal: [daysBase, { color: vars.color.mutedForeground }],
    today: [daysBase, { color: vars.color.danger, fontWeight: 600 }],
});

// 收合列的剩餘天數最先讓位（省略號截斷）
export const triggerDays = style({
    flexShrink: 100,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
});

// ---- 展開清單（portal 到 body、fixed 定位，不被面板 overflow／transform 裁切）----

export const list = style({
    position: 'fixed',
    zIndex: 1000,
    boxSizing: 'border-box',
    overflowY: 'auto',
    overflowX: 'hidden',
    overscrollBehavior: 'contain',
    padding: '4px',
    background: vars.color.panelRaised,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
    boxShadow: '0 6px 20px rgba(0, 0, 0, 0.35)',
    color: vars.color.foreground,
    outline: 'none',
    scrollbarWidth: 'thin',
});

export const groupLabel = style({
    fontFamily: vars.font.display,
    fontSize: '0.58rem',
    fontWeight: 600,
    color: vars.color.mutedForeground,
    padding: '6px 6px 2px',
});

export const firstGroupLabel = style({
    paddingTop: '2px',
});

export const option = style({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 6px',
    fontSize: '0.66rem',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    borderRadius: vars.radius.sm,
    border: '1px solid transparent',
    cursor: 'pointer',
    color: vars.color.foreground,
    selectors: {
        '&[data-active="true"]': { background: vars.color.muted },
        '&[aria-selected="true"]': {
            background: vars.color.accentDim,
            borderColor: vars.color.accent,
        },
        '&[data-active="true"][aria-selected="true"]': {
            boxShadow: `inset 0 0 0 1px ${vars.color.accent}`,
        },
    },
});

export const shiftedNote = style({
    flexShrink: 0,
    fontFamily: vars.font.display,
    fontSize: '0.56rem',
    color: vars.color.amber,
});

export const optionDays = style({
    marginLeft: 'auto',
    paddingLeft: '10px',
});
