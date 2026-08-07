// src/components/orb.css.ts — 3×3 lattice 活動指示器的樣式。
// 技法說明與使用準則：docs/design/orb-activity-indicator.md

import { keyframes, style } from '@vanilla-extract/css';

const pulse = keyframes({
    '0%, 100%': { opacity: 0.15, transform: 'scale(0.55)' },
    '30%': { opacity: 1, transform: 'scale(1)' },
});

export const stage = style({
    position: 'relative',
    display: 'inline-block',
    flexShrink: 0,
});

// 顏色走 currentColor — 由使用端的文字色決定（琥珀＝忙碌、accent＝一般）
export const dot = style({
    position: 'absolute',
    borderRadius: '50%',
    background: 'currentColor',
    animationName: pulse,
    animationIterationCount: 'infinite',
    animationTimingFunction: 'ease-in-out',
});
