// src/components/orb.css.ts — Orb 活動指示器五大家族的樣式。
// 共通技法：單一靜態 keyframe，路徑點／相位由每個點的 inline CSS 自訂
// 屬性（--o*）與負值 animation-delay 決定 — 純 transform/opacity/filter，
// 零動態 keyframe 注入。技法筆記：docs/design/orb-activity-indicator.md

import { keyframes, style } from '@vanilla-extract/css';

export const stage = style({
    position: 'relative',
    display: 'inline-block',
    flexShrink: 0,
});

// ---- lattice（3×3 點陣）與 ring（8 點圓環）共用的脈動 ----

const pulse = keyframes({
    '0%, 100%': { opacity: 0.15, transform: 'scale(0.55)' },
    '30%': { opacity: 1, transform: 'scale(1)' },
});

export const dot = style({
    position: 'absolute',
    borderRadius: '50%',
    background: 'currentColor',
    animationName: pulse,
    animationIterationCount: 'infinite',
    animationTimingFunction: 'ease-in-out',
});

// ---- globe（3D 點球儀）：8 個路徑點展開成 12.5% 間隔的 keyframe，
//      每點的投影座標與深度透明度由 --g0x..--g7o 提供 ----

const globeSpin = keyframes(
    Object.fromEntries(
        Array.from({ length: 8 }, (_, s) => [
            s === 0 ? '0%, 100%' : `${s * 12.5}%`,
            {
                transform: `translate(var(--g${s}x), var(--g${s}y))`,
                opacity: `var(--g${s}o)`,
            },
        ]),
    ),
);

export const globeDot = style({
    position: 'absolute',
    left: '50%',
    top: '50%',
    borderRadius: '50%',
    background: 'currentColor',
    willChange: 'transform, opacity',
    animationName: globeSpin,
    animationIterationCount: 'infinite',
    animationTimingFunction: 'linear',
});

// ---- focus（四圓佔方角，「清晰焦點」順時針巡迴；blur 讀作景深）----

const focusTurn = keyframes({
    '0%, 100%': {
        opacity: 0.06,
        filter: 'blur(1.5px)',
        transform: 'translate(var(--ox), var(--oy)) scale(1.1)',
    },
    '10%': {
        opacity: 1,
        filter: 'blur(0px)',
        transform: 'translate(var(--ox), var(--oy)) scale(1)',
    },
    '32%': {
        opacity: 0.3,
        filter: 'blur(0.8px)',
        transform: 'translate(var(--ox), var(--oy)) scale(1.04)',
    },
    '60%': {
        opacity: 0.1,
        filter: 'blur(1.5px)',
        transform: 'translate(var(--ox), var(--oy)) scale(1.1)',
    },
});

export const focusShape = style({
    position: 'absolute',
    left: '50%',
    top: '50%',
    borderRadius: '50%',
    background: 'currentColor',
    animationName: focusTurn,
    animationIterationCount: 'infinite',
    animationTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
});

// ---- morph（8 點在四個幾何形狀間變形）：4 個路徑點 ----

const morphShape = keyframes({
    '0%, 5%': { transform: 'translate(var(--m1))' },
    '25%, 30%': { transform: 'translate(var(--m2))' },
    '50%, 55%': { transform: 'translate(var(--m3))' },
    '75%, 80%': { transform: 'translate(var(--m4))' },
    '100%': { transform: 'translate(var(--m1))' },
});

export const morphDot = style({
    position: 'absolute',
    left: '50%',
    top: '50%',
    borderRadius: '50%',
    background: 'currentColor',
    animationName: morphShape,
    animationIterationCount: 'infinite',
    animationTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
});
