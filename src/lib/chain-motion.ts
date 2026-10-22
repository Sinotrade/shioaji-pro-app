// src/lib/chain-motion.ts — derived views for the live 族群動態 panel.
//
// Pure helpers on top of chain-flow's per-minute group aggregates:
// - rank: groups ordered by net inflow (cumulative since the first bar, or
//   the last five minutes), inflow above, outflow below.
// - rotation (輪動) bubbles: a point per group. x = net inflow since the first
//   bar (drawn on an asinh scale), y = 加速 (last-ten-minute intensity minus
//   the last 30 minutes', pp), size = last-ten-minute turnover, colour =
//   one of four states, with a trail of earlier minutes. Momentum needs
//   MOMENTUM_WARMUP minutes of bars; before that the view does not classify.
//   Net axis: robust per-side extents, asymmetric asinh, soft-clamped edges;
//   collision relaxation and a warm-up beeswarm keep bubbles apart.

import { SESSION_SLOTS, type GroupFlow } from './chain-flow';

/** Ranking window: the last 5 / 15 / 30 minutes, or everything observed. */
export type RankMetric = '5' | '15' | '30' | 'cum';
export const RANK_METRICS = ['5', '15', '30', 'cum'] as const;

/** Minutes in a window, or null for the whole observed session. */
export function metricMinutes(metric: RankMetric): number | null {
    return metric === 'cum' ? null : Number(metric);
}

/** Sum of `series` over the window ending at `now` (inclusive). */
export function windowSum(series: ArrayLike<number>, now: number, metric: RankMetric): number {
    const n = metricMinutes(metric);
    let sum = 0;
    for (let i = n === null ? 0 : Math.max(0, now - n + 1); i <= now; i += 1) sum += series[i]!;
    return sum;
}

/** Value a group is ranked on at `now`: net inflow over the window. */
export function rankValue(flow: GroupFlow, now: number | null, metric: RankMetric): number {
    if (now === null) return 0;
    return windowSum(flow.net, now, metric);
}

/** Turnover behind a rank value (session-to-date for the cumulative ranking). */
export function rankTurnover(flow: GroupFlow, now: number | null, metric: RankMetric): number {
    if (now === null) return 0;
    return metric === 'cum' ? flow.total : windowSum(flow.turnover, now, metric);
}

/**
 * Rank changes are reported only when exactly one new minute bar landed since
 * the previous order; anything else (a catch-up burst, the first bars after
 * the snapshot, a switch of window or filter) just resets the baseline.
 */
export function comparesRanks(prevNow: number | null, now: number | null): boolean {
    return now !== null && prevNow !== null && now - prevNow === 1;
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
 * Lane length as a share (0…1) of the half track: square root of the value
 * against the largest absolute value on screen, one scale for both sides, so
 * small flows stay visible next to a dominant one while order is preserved.
 */
export function riverLength(value: number, maxAbs: number): number {
    if (!(maxAbs > 0) || !Number.isFinite(value)) return 0;
    return Math.sqrt(Math.min(1, Math.abs(value) / maxAbs));
}

/**
 * Bar thickness in px for a group's turnover: square-root scaled against the
 * largest turnover on screen so area, not height, tracks money traded, and a
 * thin floor keeps quiet groups visible.
 */
export function riverWidth(turnover: number, max: number, min = 3, full = 14): number {
    if (!(max > 0) || !(turnover > 0)) return min;
    return min + (full - min) * Math.sqrt(Math.min(1, turnover / max));
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

/**
 * Minutes of received bars before 資金動能 means anything. Until the session
 * has more than RECENT minutes, the recent window and the baseline cover the
 * same bars and y is exactly 0 for every group; five more minutes give the
 * baseline something the recent window does not contain.
 */
export const MOMENTUM_WARMUP = RECENT + 5;

/** Minutes still missing before the momentum is shown (0 = ready). */
export function momentumWarmup(from: number | null, now: number | null, need = MOMENTUM_WARMUP): number {
    if (now === null) return need;
    const observed = now - (from ?? 0) + 1;
    return Math.max(0, need - observed);
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

/**
 * Soft clamp of a non-negative axis fraction: linear up to `knee`, then it
 * eases towards 1 with matching slope, so an outlier sits against the edge
 * but stays distinct from its neighbours and never leaves the plot.
 */
export function softUnit(t: number, knee = 0.9): number {
    if (!(t > 0)) return 0;
    if (t <= knee) return t;
    const tail = 1 - knee;
    return knee + tail * (1 - Math.exp(-(t - knee) / tail));
}

/** Round up to 1 / 2 / 5 × 10^n. */
export function niceCeil(value: number): number {
    if (!(value > 0)) return 1;
    const p = 10 ** Math.floor(Math.log10(value));
    const m = value / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

/** The `q` quantile of non-negative numbers (0 when empty). */
function quantile(values: number[], q: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q + 0.5))]!;
}

/**
 * Robust extents of the net-inflow axis, one per side: the `q` quantile of
 * that side's magnitudes plus a margin, rounded up to 1 / 2 / 5 and never
 * below `floor`. A lone outlier does not squash every other group (it is
 * soft-clamped to the edge by `netFrac`).
 */
export function netExtents(values: Iterable<number>, { q = 0.95, floor = 1e8, margin = 1.1 } = {}): { pos: number; neg: number } {
    const pos: number[] = [];
    const neg: number[] = [];
    for (const v of values) {
        if (!Number.isFinite(v)) continue;
        if (v > 0) pos.push(v);
        else if (v < 0) neg.push(-v);
    }
    return {
        pos: niceCeil(Math.max(floor, quantile(pos, q) * margin)),
        neg: niceCeil(Math.max(floor, quantile(neg, q) * margin)),
    };
}

/** asinh net axis: one scale for both sides, zero placed where both fit. */
export interface NetScale {
    unit: number;
    /** asinh extents of each side (after the minimum share). */
    uPos: number;
    uNeg: number;
    /** Position of zero across the width, 0…1. */
    zero: number;
}

/**
 * Asymmetric asinh scale: a market where almost every group flows in uses
 * the width for inflow instead of leaving half the plot empty, yet the
 * smaller side keeps at least `minShare` of the width (so 淨流出 stays
 * readable) and both sides share one px-per-unit, so equal flows sit at
 * equal distances from zero.
 */
export function netScale(pos: number, neg: number, unit = 1e8, minShare = 0.2): NetScale {
    let uPos = Math.asinh(Math.max(pos, unit * 1e-3) / unit);
    let uNeg = Math.asinh(Math.max(neg, unit * 1e-3) / unit);
    const k = minShare / (1 - minShare);
    if (uNeg < uPos * k) uNeg = uPos * k;
    if (uPos < uNeg * k) uPos = uNeg * k;
    return { unit, uPos, uNeg, zero: uNeg / (uNeg + uPos) };
}

/** Position of a net value across the width, 0…1 (soft-clamped at both edges). */
export function netFrac(value: number, scale: NetScale): number {
    if (!Number.isFinite(value)) return scale.zero;
    const u = Math.asinh(value / scale.unit);
    return u >= 0
        ? scale.zero + softUnit(u / scale.uPos) * (1 - scale.zero)
        : scale.zero - softUnit(-u / scale.uNeg) * scale.zero;
}

const NET_TICK_STEPS = [1, 2, 5];

/**
 * Readable ticks (TWD) for a net axis `width` px wide: 1 / 2 / 5 × 10^n on
 * both sides, inside the linear part of the scale, largest first, each at
 * least `minGap` px from zero and from every kept tick.
 */
export function netTicks(scale: NetScale, width: number, minGap = 44): number[] {
    const candidates: number[] = [];
    for (let e = -2; e <= 4; e += 1) for (const m of NET_TICK_STEPS) candidates.push(m * 10 ** e * scale.unit);
    const kept: number[] = [];
    const xs: number[] = [scale.zero * width];
    for (const sign of [1, -1]) {
        for (const c of [...candidates].reverse()) {
            const v = sign * c;
            const u = Math.abs(Math.asinh(v / scale.unit)) / (sign > 0 ? scale.uPos : scale.uNeg);
            if (u > 0.9) continue;
            const x = netFrac(v, scale) * width;
            if (xs.some((o) => Math.abs(o - x) < minGap)) continue;
            xs.push(x);
            kept.push(v);
        }
    }
    return kept.sort((a, b) => a - b);
}

/**
 * Beeswarm on a centre line: each circle keeps its x and takes the free y
 * closest to `cy` (largest first, so the heavy groups sit on the line). Used
 * while there is no second dimension yet; no two circles overlap as long as
 * the box has room, and the order is deterministic.
 */
export function beeswarm(circles: readonly Circle[], cy: number, box: { y0: number; y1: number }): number[] {
    const order = circles.map((_, i) => i).sort((a, b) => circles[b]!.r - circles[a]!.r || a - b);
    const ys = new Array<number>(circles.length).fill(cy);
    const placed: number[] = [];
    for (const i of order) {
        const c = circles[i]!;
        const lo = box.y0 + c.r;
        const hi = box.y1 - c.r;
        const candidates = [cy];
        for (const j of placed) {
            const o = circles[j]!;
            const dx = Math.abs(o.x - c.x);
            const reach = o.r + c.r + 1;
            if (dx >= reach) continue;
            const dy = Math.sqrt(reach * reach - dx * dx);
            candidates.push(ys[j]! - dy, ys[j]! + dy);
        }
        const free = (y: number) =>
            placed.every((j) => {
                const o = circles[j]!;
                return Math.hypot(o.x - c.x, ys[j]! - y) >= o.r + c.r - 1e-6;
            });
        candidates.sort((a, b) => Math.abs(a - cy) - Math.abs(b - cy) || a - b);
        const inBox = candidates.find((y) => y >= lo && y <= hi && free(y));
        // no room left in the box: the free spot closest to it, clamped
        ys[i] = inBox ?? Math.max(lo, Math.min(hi, candidates.find(free) ?? cy));
        placed.push(i);
    }
    return ys;
}

/** Largest overlap between two circles as a share of their radii sum (0 = none). */
export function maxOverlap(circles: readonly Circle[]): number {
    let worst = 0;
    for (let i = 0; i < circles.length; i += 1) {
        for (let j = i + 1; j < circles.length; j += 1) {
            const a = circles[i]!;
            const b = circles[j]!;
            const sum = a.r + b.r;
            if (sum <= 0) continue;
            worst = Math.max(worst, 1 - Math.hypot(a.x - b.x, a.y - b.y) / sum);
        }
    }
    return worst;
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

/**
 * Colour side of one heat minute bar. A flat minute (no price change, e.g. a
 * stock pinned at the limit, or no baseline yet) has turnover but no
 * direction: it must not read as inflow.
 */
export function minuteSide(ratio: number | null | undefined): 'in' | 'out' | 'flat' | 'none' {
    if (ratio === null || ratio === undefined) return 'none';
    return ratio > 0 ? 'in' : ratio < 0 ? 'out' : 'flat';
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

export interface Circle {
    x: number;
    y: number;
    r: number;
    /**
     * Region the centre must stay in (e.g. its quadrant), on top of the box:
     * relaxation may nudge a bubble, never carry it across a zero line.
     */
    keep?: { x0: number; x1: number; y0: number; y1: number };
}

/**
 * Gentle collision relaxation for the rotation bubbles: overlapping pairs are
 * pushed apart (up to `overlap` × the sum of radii may still overlap), each
 * bubble is pulled back towards its data position and never strays more
 * than `maxShift` × its radius from it, and stays inside `box` (and its own
 * `keep` region, when given).
 * Deterministic: the same input gives the same layout every minute.
 */
export function relaxCircles(
    circles: readonly Circle[],
    box: { x0: number; x1: number; y0: number; y1: number },
    { iterations = 60, overlap = 0.12, maxShift = 1.2, pull = 0.04 } = {},
): { x: number; y: number }[] {
    const clamp = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));
    const settle = (p: { x: number; y: number }, c: Circle) => {
        p.x = clamp(p.x, box.x0 + c.r, box.x1 - c.r);
        p.y = clamp(p.y, box.y0 + c.r, box.y1 - c.r);
        if (c.keep) {
            p.x = clamp(p.x, c.keep.x0, c.keep.x1);
            p.y = clamp(p.y, c.keep.y0, c.keep.y1);
        }
    };
    const home = circles.map((c) => {
        const p = { x: c.x, y: c.y };
        settle(p, c);
        return p;
    });
    const pos = home.map((p) => ({ ...p }));
    const n = circles.length;
    for (let it = 0; it < iterations; it++) {
        let moved = false;
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const a = pos[i]!;
                const b = pos[j]!;
                const min = (circles[i]!.r + circles[j]!.r) * (1 - overlap);
                let dx = b.x - a.x;
                let dy = b.y - a.y;
                let d = Math.hypot(dx, dy);
                if (d >= min) continue;
                if (d < 1e-6) {
                    // coincident: split along a fixed per-pair angle
                    const angle = ((i * 7 + j * 13) % 16) * (Math.PI / 8);
                    dx = Math.cos(angle);
                    dy = Math.sin(angle);
                    d = 1;
                }
                const push = ((min - Math.min(d, min)) / 2) * 0.5;
                const ux = dx / d;
                const uy = dy / d;
                a.x -= ux * push;
                a.y -= uy * push;
                b.x += ux * push;
                b.y += uy * push;
                moved = true;
            }
        }
        for (let i = 0; i < n; i++) {
            const c = circles[i]!;
            const p = pos[i]!;
            const h = home[i]!;
            p.x += (h.x - p.x) * pull;
            p.y += (h.y - p.y) * pull;
            const sx = p.x - h.x;
            const sy = p.y - h.y;
            const shift = Math.hypot(sx, sy);
            const cap = c.r * maxShift;
            if (shift > cap) {
                p.x = h.x + (sx / shift) * cap;
                p.y = h.y + (sy / shift) * cap;
            }
            settle(p, c);
        }
        if (!moved) break;
    }
    // a dense pile the capped pass could not open (many groups at one spot):
    // separate it for real, still inside the box; a pile-up hides groups
    // (the worst overlap is measured during each pass: no extra O(n²) scan)
    const limit = overlap + 0.02;
    let worst = maxOverlap(pos.map((p, i) => ({ ...p, r: circles[i]!.r })));
    for (let it = 0; it < iterations * 2 && worst > limit; it++) {
        worst = 0;
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const a = pos[i]!;
                const b = pos[j]!;
                const sum = circles[i]!.r + circles[j]!.r;
                const min = sum * (1 - overlap);
                let dx = b.x - a.x;
                let dy = b.y - a.y;
                let d = Math.hypot(dx, dy);
                if (sum > 0) worst = Math.max(worst, 1 - d / sum);
                if (d >= min) continue;
                if (d < 1e-6) {
                    const angle = ((i * 7 + j * 13) % 16) * (Math.PI / 8);
                    dx = Math.cos(angle);
                    dy = Math.sin(angle);
                    d = 1;
                }
                // a fixed per-pair tilt: groups on one line (equal y) must be
                // able to step off it, or the pile only compresses sideways
                const tilt = (((i * 7 + j * 13) % 5) - 2) * 0.2;
                const ux = (dx / d) * Math.cos(tilt) - (dy / d) * Math.sin(tilt);
                const uy = (dx / d) * Math.sin(tilt) + (dy / d) * Math.cos(tilt);
                const push = (min - d) / 2;
                a.x -= ux * push;
                a.y -= uy * push;
                b.x += ux * push;
                b.y += uy * push;
            }
        }
        for (let i = 0; i < n; i++) {
            const c = circles[i]!;
            const p = pos[i]!;
            settle(p, c);
        }
    }
    return pos;
}
