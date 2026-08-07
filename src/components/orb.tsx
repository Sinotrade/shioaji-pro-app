// src/components/orb.tsx — 活動指示器（啟動中／載入／思考中）。
// aicss.dev orbs 概念的 clean-room 重實作，五大家族十個變體：
//   lattice: 'radial' | 'band' | 'comet' | 'sweep' | 'shuffle'（3×3 點陣波）
//   ring:    'ring' | 'ringAlt' | 'ringShuffle'（8 點圓環）
//   globe:   'globe'（3D 點球儀旋轉）
//   focus:   'focus'（四圓焦點巡迴，blur 當景深）
//   morph:   'morph'（8 點在圓→八角→方→菱形間變形）
// 核心技法（單一 keyframe × 負值 delay 相位差 × CSS 自訂屬性路徑點）
// 與使用準則：docs/design/orb-activity-indicator.md

import type { CSSProperties } from 'react';
import * as styles from './orb.css';

export type OrbVariant =
    | 'radial'
    | 'band'
    | 'comet'
    | 'sweep'
    | 'shuffle'
    | 'ring'
    | 'ringAlt'
    | 'ringShuffle'
    | 'globe'
    | 'focus'
    | 'morph';

interface OrbProps {
    size?: number;
    variant?: OrbVariant;
    style?: CSSProperties;
}

// ---- lattice：3×3、共用脈動、相位函數即波形 ----

const N = 3;
const MID = (N - 1) / 2;

// comet／shuffle 走的順時針外圈（中心點不參與 comet）
const RING_WALK: [number, number][] = [
    [0, 0],
    [1, 0],
    [2, 0],
    [2, 1],
    [2, 2],
    [1, 2],
    [0, 2],
    [0, 1],
];

function latticeDelay(
    variant: OrbVariant,
    x: number,
    y: number,
    period: number,
): number {
    switch (variant) {
        case 'band': // 對角掃帶
            return ((x + y) / (2 * (N - 1))) * period;
        case 'sweep': // 直欄左→右
            return (x / (N - 1)) * (period * 0.8);
        case 'comet': {
            // 亮頭拖尾繞外圈
            const i = RING_WALK.findIndex(([rx, ry]) => rx === x && ry === y);
            return i < 0 ? 0 : -(i / RING_WALK.length) * period;
        }
        case 'shuffle': {
            // 亂序跳點（外圈索引 ×3 打散）
            const i = RING_WALK.findIndex(([rx, ry]) => rx === x && ry === y);
            if (i < 0) return 0;
            return -(((i * 3) % RING_WALK.length) / RING_WALK.length) * period;
        }
        default: // radial：波面從中心擴散
            return -Math.hypot(x - MID, y - MID) * (period * 0.22);
    }
}

function latticeCells(variant: OrbVariant, size: number) {
    const period = 1400;
    const pitch = size / N;
    const d = Math.max(2, Math.round(pitch * 0.55));
    const cells = [];
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            if (variant === 'comet' && x === 1 && y === 1) continue;
            cells.push(
                <span
                    key={`${x}-${y}`}
                    className={styles.dot}
                    style={{
                        width: d,
                        height: d,
                        left: x * pitch + (pitch - d) / 2,
                        top: y * pitch + (pitch - d) / 2,
                        animationDuration: `${period}ms`,
                        animationDelay: `${latticeDelay(variant, x, y, period)}ms`,
                    }}
                />,
            );
        }
    }
    return cells;
}

// ---- ring：8 點圓環、共用脈動 ----

const RING_N = 8;

function ringDelay(variant: OrbVariant, i: number, period: number): number {
    switch (variant) {
        case 'ringAlt': // 奇偶兩組交替
            return i % 2 === 0 ? 0 : -(period / 2);
        case 'ringShuffle':
            return -(((i * 3) % RING_N) / RING_N) * period;
        default: // ring：亮頭順時針繞圈
            return -(((RING_N - 1 - i) / RING_N) * period);
    }
}

function ringCells(variant: OrbVariant, size: number) {
    const period = 1600;
    const r = size * 0.36;
    const d = Math.max(2, Math.round(size * 0.14));
    const cells = [];
    for (let i = 0; i < RING_N; i++) {
        const a = (i / RING_N) * Math.PI * 2 - Math.PI / 2;
        cells.push(
            <span
                key={i}
                className={styles.dot}
                style={{
                    width: d,
                    height: d,
                    left: size / 2 + Math.cos(a) * r - d / 2,
                    top: size / 2 + Math.sin(a) * r - d / 2,
                    animationDuration: `${period}ms`,
                    animationDelay: `${ringDelay(variant, i, period)}ms`,
                }}
            />,
        );
    }
    return cells;
}

// ---- globe：5 緯度環 × 8 點的球體，8 步旋轉路徑點預先投影 ----

const GLOBE_LATS = [52, 26, 0, -26, -52];
const GLOBE_LON_N = 8;
const GLOBE_STEPS = 8;
const GLOBE_TILT = (14 * Math.PI) / 180;

function globeCells(size: number) {
    const R = size * 0.42;
    const d = Math.max(1.5, size * 0.09);
    const ct = Math.cos(GLOBE_TILT);
    const st = Math.sin(GLOBE_TILT);
    const cells = [];
    for (const latDeg of GLOBE_LATS) {
        const lat = (latDeg * Math.PI) / 180;
        for (let j = 0; j < GLOBE_LON_N; j++) {
            const lon = (j / GLOBE_LON_N) * Math.PI * 2;
            const vars: Record<string, string> = {};
            for (let s = 0; s < GLOBE_STEPS; s++) {
                const spin = (s / GLOBE_STEPS) * Math.PI * 2;
                const x = Math.cos(lat) * Math.cos(lon + spin) * R;
                const z = Math.cos(lat) * Math.sin(lon + spin) * R;
                const y = Math.sin(lat) * R;
                // 傾斜 14° 後投影；z 當深度做透明度衰減
                const py = y * ct - z * st;
                const pz = y * st + z * ct;
                const t = Math.max(0, Math.min(1, (pz / R + 0.15) / 1.15));
                vars[`--g${s}x`] = `${x.toFixed(1)}px`;
                vars[`--g${s}y`] = `${py.toFixed(1)}px`;
                vars[`--g${s}o`] = (0.12 + 0.88 * t * t).toFixed(2);
            }
            cells.push(
                <span
                    key={`${latDeg}-${j}`}
                    className={styles.globeDot}
                    style={
                        {
                            width: d,
                            height: d,
                            margin: `${-d / 2}px 0 0 ${-d / 2}px`,
                            animationDuration: '4500ms',
                            ...vars,
                        } as CSSProperties
                    }
                />,
            );
        }
    }
    return cells;
}

// ---- focus：四圓佔方角，焦點順時針巡迴 ----

function focusCells(size: number) {
    const off = size * 0.23;
    const d = size * 0.3;
    const corners: [number, number, number][] = [
        [-off, -off, 0],
        [off, -off, -3000],
        [off, off, -2000],
        [-off, off, -1000],
    ];
    return corners.map(([ox, oy, delay], i) => (
        <span
            key={i}
            className={styles.focusShape}
            style={
                {
                    width: d,
                    height: d,
                    margin: `${-d / 2}px 0 0 ${-d / 2}px`,
                    animationDuration: '4000ms',
                    animationDelay: `${delay}ms`,
                    '--ox': `${ox}px`,
                    '--oy': `${oy}px`,
                } as CSSProperties
            }
        />
    ));
}

// ---- morph：8 點在四個形狀的對應頂點間變形 ----

type ShapePoint = (i: number, r: number) => [number, number];

const shapeCircle: ShapePoint = (i, r) => {
    const a = (i / RING_N) * Math.PI * 2 - Math.PI / 2;
    return [Math.cos(a) * r, Math.sin(a) * r];
};

const shapeOctagon: ShapePoint = (i, r) => {
    const a = (i / RING_N) * Math.PI * 2 - Math.PI / 2;
    const sector = Math.round(a / (Math.PI / 4)) * (Math.PI / 4);
    return [Math.cos(sector) * r * 0.92, Math.sin(sector) * r * 0.92];
};

function perimeter(
    corners: [number, number][],
    i: number,
    phase: number,
): [number, number] {
    const t = ((i / RING_N) * corners.length + phase) % corners.length;
    const side = Math.floor(t) % corners.length;
    const frac = t - Math.floor(t);
    const from = corners[side] ?? [0, 0];
    const to = corners[(side + 1) % corners.length] ?? [0, 0];
    return [
        from[0] + (to[0] - from[0]) * frac,
        from[1] + (to[1] - from[1]) * frac,
    ];
}

const shapeSquare: ShapePoint = (i, r) => {
    const h = r * 0.85;
    return perimeter(
        [
            [-h, -h],
            [h, -h],
            [h, h],
            [-h, h],
        ],
        i,
        0.5,
    );
};

const shapeDiamond: ShapePoint = (i, r) =>
    perimeter(
        [
            [0, -r],
            [r, 0],
            [0, r],
            [-r, 0],
        ],
        i,
        0,
    );

function morphCells(size: number) {
    const r = size * 0.36;
    const d = Math.max(2, Math.round(size * 0.14));
    const shapes = [shapeCircle, shapeOctagon, shapeSquare, shapeDiamond];
    const cells = [];
    for (let i = 0; i < RING_N; i++) {
        const vars: Record<string, string> = {};
        shapes.forEach((fn, s) => {
            const [x, y] = fn(i, r);
            vars[`--m${s + 1}`] = `${x.toFixed(1)}px, ${y.toFixed(1)}px`;
        });
        cells.push(
            <span
                key={i}
                className={styles.morphDot}
                style={
                    {
                        width: d,
                        height: d,
                        margin: `${-d / 2}px 0 0 ${-d / 2}px`,
                        animationDuration: '4800ms',
                        ...vars,
                    } as CSSProperties
                }
            />,
        );
    }
    return cells;
}

export function Orb({
    size = 14,
    variant = 'radial',
    style: styleProp,
}: OrbProps) {
    let cells;
    switch (variant) {
        case 'ring':
        case 'ringAlt':
        case 'ringShuffle':
            cells = ringCells(variant, size);
            break;
        case 'globe':
            cells = globeCells(size);
            break;
        case 'focus':
            cells = focusCells(size);
            break;
        case 'morph':
            cells = morphCells(size);
            break;
        default:
            cells = latticeCells(variant, size);
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
