// src/lib/chain-motion.ts — derived views for the live 族群動態 panel.
//
// Pure helpers on top of chain-flow's per-minute group aggregates:
// - race: groups ordered by net inflow (cumulative since the first bar, or
//   the last five minutes), inflow above, outflow below.
// - tide (潮汐) bubbles: a point per group. x = net inflow since the first
//   bar (drawn on an asinh scale), y = 加速 (last-five-minute intensity minus
//   the session intensity, pp), size = last-five-minute turnover, colour =
//   one of four states, with a trail of earlier minutes.

import { SESSION_SLOTS, WINDOW, type GroupFlow } from './chain-flow';

export type RaceMetric = 'cum' | 'flow5';

/** Value a group races on at `now`. */
export function raceValue(flow: GroupFlow, now: number | null, metric: RaceMetric): number {
    if (now === null) return 0;
    return metric === 'flow5' ? flow.flow5 : flow.cumNet[now]!;
}

export interface RaceRow<T> {
    item: T;
    id: string;
    value: number;
    /** 0-based position among all rows (inflow first, then outflow). */
    rank: number;
    side: 'in' | 'out';
}

/** Inflow (largest first) then outflow (largest outflow last), ties by id for stability. */
export function raceOrder<T>(items: readonly T[], id: (item: T) => string, value: (item: T) => number): RaceRow<T>[] {
    return items
        .map((item) => ({ item, id: id(item), value: value(item) }))
        .sort((a, b) => b.value - a.value || a.id.localeCompare(b.id))
        .map((row, rank) => ({ ...row, rank, side: row.value >= 0 ? ('in' as const) : ('out' as const) }));
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
    /** 加速 (pp): last-five-minute intensity minus 強度. */
    y: number;
    /** Turnover of the last five minutes (bubble size). */
    size: number;
}

/** Rotation coordinates of a group at `slot`, or null without turnover. */
export function rotationPoint(flow: GroupFlow, slot: number, window = WINDOW): RotationPoint | null {
    if (slot < 0 || slot >= SESSION_SLOTS) return null;
    let net = 0;
    let turnover = 0;
    let recentNet = 0;
    let recentTurnover = 0;
    for (let i = 0; i <= slot; i += 1) {
        net += flow.net[i]!;
        turnover += flow.turnover[i]!;
        if (i > slot - window) {
            recentNet += flow.net[i]!;
            recentTurnover += flow.turnover[i]!;
        }
    }
    if (turnover <= 0 || recentTurnover <= 0) return null;
    const x = (net / turnover) * 100;
    return { slot, net, x, y: (recentNet / recentTurnover) * 100 - x, size: recentTurnover };
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

/** States in reading order: inflow accelerating → outflow accelerating. */
export const QUADRANTS: readonly Quadrant[] = ['leading', 'weakening', 'improving', 'lagging'];

export const QUADRANT_LABEL: Record<Quadrant, string> = {
    leading: '加速流入',
    weakening: '流入放緩',
    improving: '流出放緩',
    lagging: '加速流出',
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
