// src/lib/conditional/trailing.ts — 移動停損 (#226): a stop that follows
// the best price after the position is in profit, and only ever moves in the
// position's favour. Pure: the trigger engine feeds it prices and stores the
// state on the stop trigger.
//
// Long (short mirrored): from the first watched price on, the extreme H =
// max(H, P) is tracked. Once P ≥ base + A ticks it is active: stop =
// max(stop, H − D ticks) and the anchor is H. After that the stop moves only
// when H has gone at least S ticks past the anchor — straight to the latest
// H − D (one jump, never step by step). Ticks follow the legal price ladder.

export interface TrailState {
    /** cost basis the activation is measured from */
    base: number;
    /** 獲利 N 檔後啟動 */
    activateTicks: number;
    /** 距最高（低）N 檔 */
    distanceTicks: number;
    /** 每 N 檔移動 */
    stepTicks: number;
    active: boolean;
    extreme: number | null;
    anchor: number | null;
}

export type Steps = (price: number, ticks: number) => number;

export function newTrail(base: number, activateTicks: number, distanceTicks: number, stepTicks: number): TrailState {
    return { base, activateTicks, distanceTicks, stepTicks, active: false, extreme: null, anchor: null };
}

/** One price. `long`: the stop sells below; otherwise it buys back above. */
export function trailStep(long: boolean, stop: number, s: TrailState, price: number, step: Steps): { stop: number; state: TrailState } {
    const dir = long ? 1 : -1;
    const better = (a: number, b: number) => (long ? Math.max(a, b) : Math.min(a, b));
    const extreme = s.extreme === null ? price : better(s.extreme, price);
    let state: TrailState = { ...s, extreme };
    let next = stop;
    const reached = (p: number, level: number) => (long ? p >= level : p <= level);
    if (!s.active) {
        if (reached(price, step(s.base, dir * s.activateTicks))) {
            next = better(stop, step(extreme, -dir * s.distanceTicks));
            state = { ...state, active: true, anchor: extreme };
        }
    } else if (s.anchor !== null && reached(extreme, step(s.anchor, dir * Math.max(1, s.stepTicks)))) {
        next = better(stop, step(extreme, -dir * s.distanceTicks));
        state = { ...state, anchor: extreme };
    }
    return { stop: next, state };
}
