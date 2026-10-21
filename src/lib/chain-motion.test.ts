import { describe, expect, it } from 'vitest';
import { SESSION_SLOTS, type GroupFlow } from './chain-flow';
import {
    asinhScale,
    quadrantCounts,
    quadrantOf,
    raceOrder,
    raceValue,
    rankMoves,
    rotationExtent,
    rotationPoint,
    rotationTrail,
} from './chain-motion';

function group(minutes: [slot: number, turnover: number, net: number][]): GroupFlow {
    const turnover = new Float64Array(SESSION_SLOTS);
    const net = new Float64Array(SESSION_SLOTS);
    const cumNet = new Float64Array(SESSION_SLOTS);
    for (const [slot, t, n] of minutes) {
        turnover[slot] = t;
        net[slot] = n;
    }
    let sum = 0;
    for (let i = 0; i < SESSION_SLOTS; i += 1) {
        sum += net[i]!;
        cumNet[i] = sum;
    }
    return {
        count: 1,
        turnover,
        net,
        cumNet,
        flow5: 7,
        turnover5: 10,
        accel: null,
        total: 0,
        pct: null,
        breadth: { up: 0, flat: 0, down: 0 },
    };
}

describe('race', () => {
    it('reads cumulative or five-minute flow, zero before the first bar', () => {
        const g = group([[40, 100, 30], [41, 100, -10]]);
        expect(raceValue(g, 41, 'cum')).toBe(20);
        expect(raceValue(g, 41, 'flow5')).toBe(7);
        expect(raceValue(g, null, 'cum')).toBe(0);
    });

    it('orders inflow first, outflow last, ties by id', () => {
        const rows = raceOrder(
            [
                { id: 'b', v: 5 },
                { id: 'c', v: -8 },
                { id: 'a', v: 5 },
                { id: 'd', v: 12 },
            ],
            (r) => r.id,
            (r) => r.v,
        );
        expect(rows.map((r) => r.id)).toEqual(['d', 'a', 'b', 'c']);
        expect(rows.map((r) => r.side)).toEqual(['in', 'in', 'in', 'out']);
        expect(rows.map((r) => r.rank)).toEqual([0, 1, 2, 3]);
    });

    it('reports rank moves since the previous order', () => {
        const moves = rankMoves(new Map([['a', 0], ['b', 1]]), [
            { id: 'b', rank: 0 },
            { id: 'a', rank: 1 },
            { id: 'n', rank: 2 },
        ]);
        expect(Object.fromEntries(moves)).toEqual({ b: 1, a: -1, n: 0 });
    });
});

describe('tide bubbles', () => {
    it('places a group by net, intensity and acceleration', () => {
        // ten quiet minutes of mild inflow, then five strong ones
        const minutes: [number, number, number][] = [];
        for (let s = 10; s < 20; s += 1) minutes.push([s, 100, 10]);
        for (let s = 20; s < 25; s += 1) minutes.push([s, 100, 60]);
        const p = rotationPoint(group(minutes), 24)!;
        expect(p.net).toBe(400);
        expect(p.x).toBeCloseTo((400 / 1500) * 100);
        expect(p.y).toBeCloseTo(60 - (400 / 1500) * 100);
        expect(p.size).toBe(500);
        expect(quadrantOf(p.net, p.y)).toBe('leading');
    });

    it('has no point without turnover and keeps trails oldest first', () => {
        const g = group([[30, 100, 10], [31, 100, -20], [33, 100, 5]]);
        expect(rotationPoint(g, 29)).toBeNull();
        expect(rotationPoint(g, -1)).toBeNull();
        const trail = rotationTrail(g, 33, 10, 1, 30);
        expect(trail.map((p) => p.slot)).toEqual([30, 31, 32, 33]);
        expect(rotationTrail(g, 33, 2).map((p) => p.slot)).toEqual([32, 33]);
    });

    it('names four states and counts them', () => {
        expect(quadrantOf(1, 1)).toBe('leading');
        expect(quadrantOf(1, -1)).toBe('weakening');
        expect(quadrantOf(-1, 1)).toBe('improving');
        expect(quadrantOf(-1, -1)).toBe('lagging');
        expect(quadrantCounts([{ x: 1, y: 1 }, { x: 2, y: 3 }, { x: -1, y: -1 }])).toEqual({
            leading: 2,
            weakening: 0,
            improving: 0,
            lagging: 1,
        });
    });

    it('scales symmetric axes', () => {
        expect(rotationExtent([1, -2])).toBe(6); // at least min 4 → 4.4 → 6
        expect(rotationExtent([-9.5, Number.NaN])).toBe(12);
        expect(asinhScale(0, 1e10)).toBe(0);
        expect(asinhScale(1e10, 1e10)).toBeCloseTo(1);
        expect(asinhScale(-1e10, 1e10)).toBeCloseTo(-1);
        // small flows stay visible next to the largest group
        expect(asinhScale(1e8, 1e10)).toBeGreaterThan(0.35);
        expect(asinhScale(5, 0)).toBe(0);
    });
});
