// src/components/option-expiry-picker.css.ts

import { style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const strip = style({
    display: 'flex',
    alignItems: 'stretch',
    gap: '6px',
    flex: '1 1 auto',
    minWidth: 0,
    overflowX: 'auto',
    overflowY: 'hidden',
    scrollbarWidth: 'thin',
    overscrollBehaviorX: 'contain',
    // 預留捲軸空間，overlay 捲軸不壓到標籤文字
    paddingBottom: '4px',
});

export const group = style({
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    flexShrink: 0,
    selectors: {
        '& + &': {
            paddingLeft: '6px',
            borderLeft: `1px solid ${vars.color.border}`,
        },
    },
});

export const monthLabel = style({
    fontFamily: vars.font.display,
    fontSize: '0.58rem',
    fontWeight: 600,
    color: vars.color.mutedForeground,
    padding: '0 2px',
    whiteSpace: 'nowrap',
});

const chipBase = style({
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: '4px',
    flexShrink: 0,
    whiteSpace: 'nowrap',
    fontFamily: vars.font.mono,
    fontSize: '0.66rem',
    fontVariantNumeric: 'tabular-nums',
    padding: '2px 6px',
    cursor: 'pointer',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
    ':hover': { color: vars.color.foreground, background: vars.color.muted },
    ':focus-visible': {
        outline: `1px solid ${vars.color.accent}`,
        outlineOffset: '-1px',
    },
});

export const chip = styleVariants({
    off: [chipBase],
    on: [
        chipBase,
        {
            color: vars.color.foreground,
            background: vars.color.accentDim,
            borderColor: vars.color.accent,
            ':hover': {
                color: vars.color.foreground,
                background: vars.color.accentDim,
            },
        },
    ],
});

const dateBase = style({
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

const kindBase = style({
    fontFamily: vars.font.display,
    fontSize: '0.58rem',
    fontWeight: 500,
});

export const kind = styleVariants({
    monthly: [kindBase, { color: vars.color.accent }],
    weekly: [kindBase],
});

export const days = style({
    fontSize: '0.58rem',
    opacity: 0.75,
});
