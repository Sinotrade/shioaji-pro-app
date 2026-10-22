// src/lib/chain-river.ts — pure motion rules for the 排行 flow river.
//
// Each group's lane is a soft band growing from the centre axis with a
// glowing head at its leading edge; tiny particles stream from the axis to
// the head. Everything here is frame-rate independent: positions ease with
// an exponential approach, particles advance in units of the band length
// per second, and spawning is a Poisson-like draw against the elapsed time.

/** Hard cap on live particles across every lane (one canvas, one loop). */
export const MAX_PARTICLES = 1600;
/** Longest frame step the loop integrates; a stalled tab resumes calmly. */
export const MAX_STEP_S = 0.1;

/**
 * Share of the remaining distance covered after `dt` seconds of an
 * exponential approach at `rate` per second; 1 (snap) under reduced motion.
 */
export function easeStep(dt: number, rate: number, reduced = false): number {
    if (reduced) return 1;
    if (!(dt > 0) || !(rate > 0)) return 0;
    return 1 - Math.exp(-Math.min(dt, MAX_STEP_S) * rate);
}

/** Move `from` toward `to` by `k` (0…1); lands exactly when close enough. */
export function approach(from: number, to: number, k: number, epsilon = 0.01): number {
    const next = from + (to - from) * k;
    return Math.abs(to - next) < epsilon ? to : next;
}

/**
 * Magnitude of a group relative to the largest one on screen, 0…1, on a
 * square-root scale so quiet groups still read.
 */
export function magnitude(value: number, max: number): number {
    if (!(max > 0) || !Number.isFinite(value)) return 0;
    return Math.sqrt(Math.min(1, Math.abs(value) / max));
}

/** Particles born per second on a lane of magnitude `m`. */
export function spawnRate(m: number): number {
    return 6 + 46 * Math.max(0, Math.min(1, m));
}

/**
 * Particles to emit this frame: the whole part of `rate × dt`, plus one more
 * with probability equal to the fractional part.
 */
export function spawnCount(rate: number, dt: number, rand: () => number): number {
    const want = Math.max(0, rate * Math.min(dt, MAX_STEP_S));
    const whole = Math.floor(want);
    return whole + (rand() < want - whole ? 1 : 0);
}

/** Travel speed in band lengths per second; bigger flows run faster. */
export function particleSpeed(m: number, r: number): number {
    return 0.45 + r * 0.5 + 0.4 * Math.max(0, Math.min(1, m));
}

/**
 * Opacity along the run (p = 0 at the axis, 1 at the head): a quick fade in
 * off the axis, then a long fade toward the head.
 */
export function particleAlpha(p: number): number {
    if (!(p > 0) || p >= 1) return 0;
    return Math.min(1, Math.min(1, p * 6) * (1 - p) * 1.4);
}

/** Band thickness in px for a turnover share (square root, 3…16 px). */
export function bandThickness(turnover: number, max: number): number {
    if (!(max > 0) || !(turnover > 0)) return 3;
    return 3 + 13 * Math.sqrt(Math.min(1, turnover / max));
}

/** Head dot radius in px for a band thickness. */
export function headRadius(thick: number): number {
    return Math.max(2, thick / 2.6);
}

/**
 * Keep at most `max` particles, dropping the oldest first (they are pushed
 * in birth order). Returns the same array when nothing has to go.
 */
export function capParticles<T>(list: T[], max = MAX_PARTICLES): T[] {
    return list.length > max ? list.slice(list.length - max) : list;
}
