import { describe, expect, it } from 'vitest';
import { SESSION_SLOTS, type GroupFlow } from './chain-flow';
import {
    asinhScale,
    comparesRanks,
    divergingScale,
    heatCell,
    heatFull,
    heatLevel,
    quadrantCounts,
    quadrantOf,
    rankOrder,
    rankValue,
    rankMoves,
    rankTurnover,
    riverLength,
    riverWidth,
    windowSum,
    rotationExtent,
    rotationPoint,
    rotationTrail,
    smoothTrail,
    relaxCircles,
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

describe('rank', () => {
    it('reads cumulative or windowed flow, zero before the first bar', () => {
        const g = group([[30, 100, 5], [40, 100, 30], [41, 100, -10]]);
        expect(rankValue(g, 41, 'cum')).toBe(25);
        expect(rankValue(g, 41, '5')).toBe(20);
        expect(rankValue(g, 41, '15')).toBe(25);
        expect(rankValue(g, 41, '30')).toBe(25);
        expect(rankValue(g, 50, '5')).toBe(0);
        expect(rankValue(g, null, 'cum')).toBe(0);
    });

    it('orders inflow first, outflow last, ties by id', () => {
        const rows = rankOrder(
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

describe('rotation bubbles', () => {
    it('places a group by net, intensity and acceleration', () => {
        // ten quiet minutes of mild inflow, then five strong ones
        const minutes: [number, number, number][] = [];
        for (let s = 10; s < 20; s += 1) minutes.push([s, 100, 10]);
        for (let s = 20; s < 25; s += 1) minutes.push([s, 100, 60]);
        const p = rotationPoint(group(minutes), 24, 5)!;
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

describe('rotation baseline and smoothing', () => {
    it('compares the recent window with the last 30 minutes, not the whole session', () => {
        const minutes: [number, number, number][] = [];
        // strong open, then flat for 40 minutes, then a 10-minute push
        for (let s = 0; s < 10; s += 1) minutes.push([s, 100, 100]);
        for (let s = 10; s < 50; s += 1) minutes.push([s, 100, 0]);
        for (let s = 50; s < 60; s += 1) minutes.push([s, 100, 50]);
        const p = rotationPoint(group(minutes), 59)!;
        // recent 50 %, baseline (slots 30..59) 500 / 3000 ≈ 16.7 %
        expect(p.y).toBeCloseTo(50 - (500 / 3000) * 100);
    });

    it('averages interior trail points and keeps both ends', () => {
        const pts = [0, 30, 0, 30].map((y, slot) => ({ slot, net: slot * 10, x: 0, y, size: 1 }));
        const out = smoothTrail(pts);
        expect(out.map((p) => p.y)).toEqual([0, 10, 20, 30]);
        expect(out[1]!.net).toBe(10);
    });
});

describe('heat', () => {
    it('sums the recent window and keeps per-minute ratios, from the first bar', () => {
        const g = group([[40, 100, 50], [42, 200, -100]]);
        const cell = heatCell(g.net, g.turnover, 42, 5);
        expect(cell.net).toBe(-50);
        expect(cell.turnover).toBe(300);
        expect(cell.ratio).toBeCloseTo(-50 / 300);
        expect(cell.minutes).toEqual([null, null, 0.5, null, -0.5]);
        expect(cell.amounts).toEqual([0, 0, 100, 0, 200]);
        // window reaching before the open
        expect(heatCell(g.net, g.turnover, 1, 5).minutes).toHaveLength(5);
        expect(heatCell(g.net, g.turnover, null, 5)).toEqual({ net: 0, turnover: 0, ratio: null, minutes: [], amounts: [] });
    });

    it('maps ratios to a graded colour level against the full-colour ratio', () => {
        expect(heatLevel(null)).toBe(0);
        expect(heatLevel(0.5)).toBe(1);
        expect(heatLevel(-0.9)).toBe(1);
        expect(heatLevel(0.25, 0.5)).toBeCloseTo(0.5 ** 0.8);
        expect(heatLevel(0, 0.2)).toBe(0);
    });

    it('scales colour by the 90th percentile of current ratios, with a floor', () => {
        const ratios = Array.from({ length: 10 }, (_, i) => (i % 2 ? -1 : 1) * (i + 1) * 0.02);
        // |ratios| 0.02 … 0.20 → the 90th percentile is 0.20
        expect(heatFull(ratios)).toBeCloseTo(0.2);
        // a tile at the median is clearly paler than the top one
        expect(heatLevel(0.1, heatFull(ratios))).toBeLessThan(0.6);
        expect(heatFull([0.001, null, -0.002])).toBe(0.05);
        expect(heatFull([])).toBe(0.5);
    });
});

describe('diverging scale', () => {
    it('keeps one scale after clamping the zero line, so bars never clip or flatten', () => {
        const { zero, scale } = divergingScale([100, 90, -1]);
        expect(zero).toBe(15);
        expect(100 * scale).toBeCloseTo(85); // the largest inflow fills its side
        expect(90 * scale).toBeCloseTo(76.5); // and +90 stays shorter than +100
        expect(1 * scale).toBeLessThanOrEqual(zero);
    });

    it('balances both sides and handles empty input', () => {
        const both = divergingScale([50, -50]);
        expect(both.zero).toBe(50);
        expect(50 * both.scale).toBeCloseTo(50);
        expect(divergingScale([])).toEqual({ zero: 50, scale: 0 });
        const out = divergingScale([-30, -10]);
        expect(out.zero).toBe(85);
        expect(30 * out.scale).toBeCloseTo(85);
    });
});

describe('river width', () => {
    it('scales thickness by the square root of turnover with a floor', () => {
        expect(riverWidth(100, 100)).toBe(14);
        expect(riverWidth(25, 100)).toBeCloseTo(3 + 11 * 0.5);
        expect(riverWidth(0, 100)).toBe(3);
        expect(riverWidth(50, 0)).toBe(3);
        expect(riverWidth(500, 100)).toBe(14);
    });
});

describe('rank windows', () => {
    it('sums net and turnover over the last N minutes or the whole session', () => {
        const series = new Float64Array(SESSION_SLOTS);
        for (let i = 0; i <= 40; i += 1) series[i] = 1;
        expect(windowSum(series, 40, '5')).toBe(5);
        expect(windowSum(series, 40, '30')).toBe(30);
        expect(windowSum(series, 40, 'cum')).toBe(41);
        expect(windowSum(series, 3, '15')).toBe(4);
    });

    it('uses session turnover for the cumulative ranking', () => {
        const g = group([[40, 100, 10], [41, 50, -3]]);
        expect(rankTurnover(g, 41, '5')).toBe(150);
        expect(rankTurnover(g, 41, 'cum')).toBe(g.total);
        expect(rankTurnover(g, null, '5')).toBe(0);
    });
});

describe('rank change baseline', () => {
    it('compares ranks only across exactly one new minute', () => {
        expect(comparesRanks(40, 41)).toBe(true);
        expect(comparesRanks(40, 40)).toBe(false);
        expect(comparesRanks(30, 41)).toBe(false);
        expect(comparesRanks(null, 41)).toBe(false);
        expect(comparesRanks(40, null)).toBe(false);
    });
});

describe('river length', () => {
    it('uses one square-root scale for both sides', () => {
        expect(riverLength(400, 400)).toBe(1);
        expect(riverLength(-100, 400)).toBe(0.5);
        expect(riverLength(25, 400)).toBe(0.25);
        expect(riverLength(10, 0)).toBe(0);
    });
});

describe('bubble relaxation', () => {
    const box = { x0: 0, x1: 400, y0: 0, y1: 300 };
    it('pushes overlapping bubbles apart, within the cap and the box', () => {
        const circles = [
            { x: 200, y: 150, r: 20 },
            { x: 205, y: 150, r: 20 },
            { x: 200, y: 150, r: 10 },
        ];
        const out = relaxCircles(circles, box);
        const d = Math.hypot(out[0]!.x - out[1]!.x, out[0]!.y - out[1]!.y);
        expect(d).toBeGreaterThan(20);
        out.forEach((p, i) => {
            const c = circles[i]!;
            expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeLessThanOrEqual(c.r * 1.2 + 1e-6);
        });
        expect(relaxCircles(circles, box)).toEqual(out);
    });
    it('leaves separated bubbles alone and clamps to the box', () => {
        const out = relaxCircles(
            [
                { x: 50, y: 50, r: 10 },
                { x: 395, y: 298, r: 12 },
            ],
            box,
        );
        expect(out[0]).toEqual({ x: 50, y: 50 });
        expect(out[1]).toEqual({ x: 388, y: 288 });
    });
});
