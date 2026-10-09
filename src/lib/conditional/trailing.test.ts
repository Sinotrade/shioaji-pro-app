// src/lib/conditional/trailing.test.ts — 移動停損 only moves favourably (#226).
import { describe, expect, it } from 'vitest';
import { newTrail, trailStep, type TrailState } from './trailing';

const step = (p: number, n: number) => p + n; // TXF: 1 point per tick

function run(long: boolean, stop0: number, s0: TrailState, prices: number[]) {
    let stop = stop0;
    let s = s0;
    const out: number[] = [];
    for (const p of prices) {
        ({ stop, state: s } = trailStep(long, stop, s, p, step));
        out.push(stop);
    }
    return { stops: out, state: s };
}

describe('trailStep', () => {
    it('research example (long): E 20,000, A 20, D 15, S 5', () => {
        const { stops } = run(true, 19960, newTrail(20000, 20, 15, 5), [20010, 20020, 20024, 20025, 20050, 20034]);
        // inactive, activates at +20 → 20,005; 20,024 < anchor+5 keeps it; 20,025 → 20,010; jump to 20,050 → 20,035 at once
        expect(stops).toEqual([19960, 20005, 20005, 20010, 20035, 20035]);
    });

    it('never moves against the position, even when the price falls back or a smaller extreme comes', () => {
        const { stops } = run(true, 19960, newTrail(20000, 20, 15, 5), [20030, 20000, 19990, 20031, 20040]);
        expect(stops[0]).toBe(20015);
        for (let i = 1; i < stops.length; i++) expect(stops[i]!).toBeGreaterThanOrEqual(stops[i - 1]!);
        expect(stops).toEqual([20015, 20015, 20015, 20015, 20025]);
    });

    it('a stop already tighter than the trail is kept (e.g. after 保本)', () => {
        const { stops } = run(true, 20018, newTrail(20000, 20, 15, 5), [20020, 20026]);
        expect(stops).toEqual([20018, 20018]);
    });

    it('short is the mirror image', () => {
        const { stops } = run(false, 20040, newTrail(20000, 20, 15, 5), [19990, 19980, 19976, 19975, 19950]);
        expect(stops).toEqual([20040, 19995, 19995, 19990, 19965]);
    });

    it('the extreme is tracked before activation (no back-fill of unseen prices)', () => {
        const { state } = run(true, 19960, newTrail(20000, 20, 15, 5), [20005, 20012, 20008]);
        expect(state).toMatchObject({ active: false, extreme: 20012 });
    });
});
