// src/lib/chain-motion.ts — derived views for the live 族群動態 panel.
//
// Pure helpers on top of chain-flow's per-minute group aggregates:
// - rank: groups ordered by net inflow (cumulative since the first bar, or
//   the last five minutes), inflow above, outflow below.
// - rotation (輪動) bubbles: a point per group. x = net inflow since the first
//   bar (drawn on an asinh scale), y = 加速 (last-ten-minute intensity minus
//   the last 30 minutes', pp), size = last-ten-minute turnover, colour =
//   one of four states, with a trail of earlier minutes.

import { SESSION_SLOTS, type GroupFlow } from './chain-flow';

export type RankMetric = 'cum' | 'flow5';

/** Value a group is ranked on at `now`. */
export function rankValue(flow: GroupFlow, now: number | null, metric: RankMetric): number {
    if (now === null) return 0;
    return metric === 'flow5' ? flow.flow5 : flow.cumNet[now]!;
}

export interface RankRow<T> {
    item: T;
    id: string;
    value: number;
    /** 0-based position among all rows (inflow first, then outflow). */
    rank: number;
    side: 'in' | 'out';
}

/** Inflow (largest first) then outflow (largest outflow last), ties by id for stability. */
export function rankOrder<T>(items: readonly T[], id: (item: T) => string, value: (item: T) => number): RankRow<T>[] {
    return items
        .map((item) => ({ item, id: id(item), value: value(item) }))
        .sort((a, b) => b.value - a.value || a.id.localeCompare(b.id))
        .map((row, rank) => ({ ...row, rank, side: row.value >= 0 ? ('in' as const) : ('out' as const) }));
}

/**
 * Diverging bar layout: the zero line (% of the track) sits where both sides
 * fit, kept within [min, 100 − min], and one scale (% per unit) is shared by
 * both sides and recomputed after the zero is clamped, so no bar clips and
 * equal values stay equal length.
 */
export function divergingScale(values: Iterable<number>, min = 15): { zero: number; scale: number } {
    let maxIn = 0;
    let maxOut = 0;
    for (const v of values) {
        if (v > 0) maxIn = Math.max(maxIn, v);
        else maxOut = Math.max(maxOut, -v);
    }
    const total = maxIn + maxOut;
    if (total <= 0) return { zero: 50, scale: 0 };
    const zero = Math.min(100 - min, Math.max(min, (maxOut / total) * 100));
    const room = Math.min(maxIn > 0 ? (100 - zero) / maxIn : Infinity, maxOut > 0 ? zero / maxOut : Infinity);
    return { zero, scale: room };
}

/** Rank moves since the previous order (positive = moved up). New ids are 0. */
export function rankMoves(previous: ReadonlyMap<string, number>, rows: readonly { id: string; rank: number }[]) {
    const moves = new Map<string, number>();
    for (const row of rows) {
        const before = previous.get(row.id);
        moves.set(row.id, before === undefined ? 0 : before - row.rank);
    }
    return moves;
}

export interface RotationPoint {
    slot: number;
    /** Net inflow (TWD) from the first bar to `slot`. */
    net: number;
    /** 強度 (%): Σnet ÷ Σturnover from the first bar to `slot`. */
    x: number;
    /** 加速 (pp): last-ten-minute intensity minus the last 30 minutes'. */
    y: number;
    /** Turnover of the recent window (bubble size). */
    size: number;
}

/** Recent window of the rotation view's acceleration (minutes): 10 keeps the sign-estimate noise down. */
export const RECENT = 10;
/** Minutes of the baseline the recent intensity is compared with. */
export const BASELINE = 30;

/**
 * Rotation coordinates of a group at `slot`, or null without turnover.
 * y compares the last `window` minutes' intensity with the last `base`
 * minutes' (smoother than against the whole session, and it forgets the
 * open).
 */
export function rotationPoint(flow: GroupFlow, slot: number, window = RECENT, base = BASELINE): RotationPoint | null {
    if (slot < 0 || slot >= SESSION_SLOTS) return null;
    let net = 0;
    let turnover = 0;
    let recentNet = 0;
    let recentTurnover = 0;
    let baseNet = 0;
    let baseTurnover = 0;
    for (let i = 0; i <= slot; i += 1) {
        const n = flow.net[i]!;
        const t = flow.turnover[i]!;
        net += n;
        turnover += t;
        if (i > slot - base) {
            baseNet += n;
            baseTurnover += t;
        }
        if (i > slot - window) {
            recentNet += n;
            recentTurnover += t;
        }
    }
    if (turnover <= 0 || recentTurnover <= 0) return null;
    const x = (net / turnover) * 100;
    return { slot, net, x, y: ((recentNet / recentTurnover) - baseNet / baseTurnover) * 100, size: recentTurnover };
}

/** Three-point moving average of a trail (display only; ends kept). */
export function smoothTrail(points: readonly RotationPoint[]): RotationPoint[] {
    return points.map((p, i) => {
        if (i === 0 || i === points.length - 1) return p;
        const a = points[i - 1]!;
        const b = points[i + 1]!;
        return { ...p, net: (a.net + p.net + b.net) / 3, y: (a.y + p.y + b.y) / 3 };
    });
}

/** The last `length` defined points ending at `slot`, oldest first, `every` minutes apart. */
export function rotationTrail(flow: GroupFlow, slot: number, length = 10, every = 1, from = 0): RotationPoint[] {
    const points: RotationPoint[] = [];
    for (let s = slot; s >= from && points.length < length; s -= every) {
        const p = rotationPoint(flow, s);
        if (p) points.push(p);
    }
    return points.reverse();
}

export type Quadrant = 'leading' | 'weakening' | 'lagging' | 'improving';

/** RRG quadrants in reading order: 領先 → 轉弱 → 改善 → 落後. */
export const QUADRANTS: readonly Quadrant[] = ['leading', 'weakening', 'improving', 'lagging'];

export const QUADRANT_LABEL: Record<Quadrant, string> = {
    leading: '領先',
    weakening: '轉弱',
    improving: '改善',
    lagging: '落後',
};

/** Count groups per state. */
export function quadrantCounts(points: Iterable<{ x: number; y: number }>): Record<Quadrant, number> {
    const counts: Record<Quadrant, number> = { leading: 0, weakening: 0, improving: 0, lagging: 0 };
    for (const p of points) counts[quadrantOf(p.x, p.y)] += 1;
    return counts;
}

/**
 * Symmetric log-like scale (asinh) for net TWD: small flows stay readable
 * next to the largest group, sign preserved. `unit` is where it turns from
 * linear to logarithmic.
 */
export function asinhScale(value: number, extent: number, unit = 1e7): number {
    if (extent <= 0) return 0;
    return Math.asinh(value / unit) / Math.asinh(extent / unit);
}

export function quadrantOf(x: number, y: number): Quadrant {
    if (x >= 0) return y >= 0 ? 'leading' : 'weakening';
    return y >= 0 ? 'improving' : 'lagging';
}

/** Symmetric axis extent that fits every point, at least `min`, rounded up to `step`. */
export function rotationExtent(values: Iterable<number>, min = 4, step = 2): number {
    let max = min;
    for (const v of values) if (Number.isFinite(v)) max = Math.max(max, Math.abs(v));
    return Math.ceil((max * 1.1) / step) * step;
}

// ── heat ──────────────────────────────────────────────────────────────────

/** Recent-window heat of one group or stock (works from the first bar, no history needed). */
export interface HeatCell {
    /** Net inflow over the window. */
    net: number;
    turnover: number;
    /** net ÷ turnover, −1…1; null without turnover. */
    ratio: number | null;
    /** Per-minute net ÷ turnover, oldest first, `window` entries (null = no bar). */
    minutes: (number | null)[];
    /** Per-minute turnover, aligned with `minutes`. */
    amounts: number[];
}

/** Fallback ratio at which a heat tile reaches full colour. */
export const HEAT_FULL = 0.5;
/** Floor of the adaptive full-colour ratio: a quiet market stays pale. */
export const HEAT_FLOOR = 0.05;

export function heatCell(net: Float64Array, turnover: Float64Array, now: number | null, window: number): HeatCell {
    const minutes: (number | null)[] = [];
    const amounts: number[] = [];
    let n = 0;
    let t = 0;
    if (now !== null) {
        for (let i = now - window + 1; i <= now; i += 1) {
            const a = i >= 0 ? turnover[i]! : 0;
            const v = i >= 0 ? net[i]! : 0;
            n += v;
            t += a;
            minutes.push(a > 0 ? v / a : null);
            amounts.push(a);
        }
    }
    return { net: n, turnover: t, ratio: t > 0 ? n / t : null, minutes, amounts };
}

/**
 * Adaptive full-colour ratio: the `q` quantile of the current |ratios|, so
 * the spread of today's flows stays visible instead of every tile
 * saturating. Never below HEAT_FLOOR.
 */
export function heatFull(ratios: Iterable<number | null>, q = 0.9): number {
    const abs: number[] = [];
    for (const r of ratios) if (r !== null && Number.isFinite(r)) abs.push(Math.abs(r));
    if (abs.length === 0) return HEAT_FULL;
    abs.sort((a, b) => a - b);
    return Math.max(HEAT_FLOOR, abs[Math.min(abs.length - 1, Math.floor(abs.length * q))]!);
}

/** Colour strength 0…1 of a ratio against `full` (gentle 0.8 power so mild flows still register). */
export function heatLevel(ratio: number | null, full = HEAT_FULL): number {
    if (ratio === null || !Number.isFinite(ratio) || full <= 0) return 0;
    return Math.min(1, (Math.abs(ratio) / full) ** 0.8);
}
