// src/components/orb.tsx — 3×3 lattice 活動指示器（啟動中／思考中）。
// 核心技法：每顆點跑同一個 keyframe，用「負值 animation-delay」把各點
// 播種到週期的不同相位，整個格子就讀成一道行進的波，而不是九顆各自
// 閃爍的點。幾何與相位都是純 CSS 動畫（transform/opacity），零 JS 逐幀。
// 完整技法筆記與使用準則：docs/design/orb-activity-indicator.md

import type { CSSProperties } from 'react';
import * as styles from './orb.css';

const N = 3;
const MID = (N - 1) / 2;
const PERIOD_MS = 1400;

export type OrbVariant = 'radial' | 'comet';

// comet 用的順時針外圈路徑（中心點不參與）
const RING: [number, number][] = [
    [0, 0],
    [1, 0],
    [2, 0],
    [2, 1],
    [2, 2],
    [1, 2],
    [0, 2],
    [0, 1],
];

function delayMs(variant: OrbVariant, x: number, y: number): number {
    if (variant === 'comet') {
        const i = RING.findIndex(([rx, ry]) => rx === x && ry === y);
        return i < 0 ? 0 : -(i / RING.length) * PERIOD_MS;
    }
    // radial：波面從中心向外擴散
    return -Math.hypot(x - MID, y - MID) * (PERIOD_MS * 0.22);
}

export function Orb({
    size = 14,
    variant = 'radial',
    style: styleProp,
}: {
    size?: number;
    variant?: OrbVariant;
    style?: CSSProperties;
}) {
    const pitch = size / N;
    const dotSize = Math.max(2, Math.round(pitch * 0.55));
    const cells = [];
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            if (variant === 'comet' && x === 1 && y === 1) continue;
            cells.push(
                <span
                    key={`${x}-${y}`}
                    className={styles.dot}
                    style={{
                        width: dotSize,
                        height: dotSize,
                        left: x * pitch + (pitch - dotSize) / 2,
                        top: y * pitch + (pitch - dotSize) / 2,
                        animationDuration: `${PERIOD_MS}ms`,
                        animationDelay: `${delayMs(variant, x, y)}ms`,
                    }}
                />,
            );
        }
    }
    return (
        <span
            className={styles.stage}
            style={{ width: size, height: size, ...styleProp }}
            aria-hidden
        >
            {cells}
        </span>
    );
}
