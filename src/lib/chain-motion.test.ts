import { describe, expect, it } from 'vitest';
import { SESSION_SLOTS, type GroupFlow } from './chain-flow';
import {
    asinhScale,
    comparesRanks,
    divergingScale,
    heatCell,
    minuteSide,
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
    beeswarm,
    maxOverlap,
    MOMENTUM_WARMUP,
    momentumWarmup,
    netExtents,
    netFrac,
    netScale,
    netTicks,
    niceCeil,
    RECENT,
    softUnit,
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
        volumeRatio: null,
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

    it('colours a flat minute neutral, not as inflow', () => {
        // live 2026-10-22: a limit-up stock trades at one price, net 0 with turnover
        const g = group([[40, 100, 0], [41, 100, 30], [42, 100, -30]]);
        expect(heatCell(g.net, g.turnover, 43, 4).minutes.map(minuteSide)).toEqual(['flat', 'in', 'out', 'none']);
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
        // percent changes on a quiet day: the caller's floor keeps them pale
        expect(heatFull([0.3, -0.4, 0.2], 0.9, 1)).toBe(1);
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
        // a pile the capped pass cannot open is separated for real, still close by
        expect(maxOverlap(out.map((p, i) => ({ ...p, r: circles[i]!.r })))).toBeLessThanOrEqual(0.14);
        out.forEach((p, i) => {
            const c = circles[i]!;
            expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeLessThanOrEqual(c.r * 1.5);
        });
        expect(relaxCircles(circles, box)).toEqual(out);
    });

    it('keeps the cap when a light nudge is enough', () => {
        const circles = [
            { x: 100, y: 100, r: 20 },
            { x: 130, y: 100, r: 20 },
        ];
        const out = relaxCircles(circles, box);
        out.forEach((p, i) => {
            const c = circles[i]!;
            expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeLessThanOrEqual(c.r * 1.2 + 1e-6);
        });
        expect(maxOverlap(out.map((p, i) => ({ ...p, r: circles[i]!.r })))).toBeLessThanOrEqual(0.14);
    });

    it('opens a 36-group pile on one line (the warm-up bug) without overlap beyond tolerance', () => {
        const wide = { x0: 40, x1: 1360, y0: 30, y1: 650 };
        const circles = Array.from({ length: 36 }, (_, i) => ({ x: 700 + i * 12, y: 340, r: 16 + (i % 5) * 4 }));
        const out = relaxCircles(circles, wide);
        expect(maxOverlap(out.map((p, i) => ({ ...p, r: circles[i]!.r })))).toBeLessThanOrEqual(0.14);
        out.forEach((p, i) => {
            const r = circles[i]!.r;
            expect(p.x).toBeGreaterThanOrEqual(wide.x0 + r - 1e-6);
            expect(p.x).toBeLessThanOrEqual(wide.x1 - r + 1e-6);
            expect(p.y).toBeGreaterThanOrEqual(wide.y0 + r - 1e-6);
            expect(p.y).toBeLessThanOrEqual(wide.y1 - r + 1e-6);
        });
    });

    it('never carries a bubble across a zero line in a dense same-quadrant pile', () => {
        // Codex repro: 36 groups just above the horizontal zero (cy = 208)
        const plot = { x0: 40, x1: 626, y0: 30, y1: 386 };
        const keep = { x0: 333, x1: Infinity, y0: -Infinity, y1: 208 };
        const circles = Array.from({ length: 36 }, (_, i) => ({ x: 340 + i * 0.5, y: 149, r: 14, keep }));
        const out = relaxCircles(circles, plot);
        for (const p of out) {
            expect(p.y).toBeLessThanOrEqual(208);
            expect(p.x).toBeGreaterThanOrEqual(333);
        }
        expect(maxOverlap(out.map((p) => ({ ...p, r: 14 })))).toBeLessThanOrEqual(0.14);
    });

    it('keeps a bubble wider than its quadrant room whole inside the frame', () => {
        const frame = { x0: 40, x1: 100, y0: 0, y1: 100 };
        const [p] = relaxCircles([{ x: 45, y: 50, r: 18, keep: { x0: -Infinity, x1: 51.99, y0: -Infinity, y1: Infinity } }], frame);
        expect(p!.x - 18).toBeGreaterThanOrEqual(40);
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

describe('beeswarm (warm-up layout)', () => {
    const box = { y0: 0, y1: 400 };
    it('keeps x, never overlaps and stays near the centre line', () => {
        const circles = Array.from({ length: 36 }, (_, i) => ({ x: 300 + i * 8, y: 0, r: 10 + (i % 4) * 3 }));
        const ys = beeswarm(circles, 200, box);
        const placed = circles.map((c, i) => ({ ...c, y: ys[i]! }));
        expect(maxOverlap(placed)).toBeLessThanOrEqual(1e-6);
        placed.forEach((c) => {
            expect(c.y - c.r).toBeGreaterThanOrEqual(0);
            expect(c.y + c.r).toBeLessThanOrEqual(400);
        });
        // the largest circle sits on the line
        expect(ys[3]).toBe(200);
        expect(beeswarm(circles, 200, box)).toEqual(ys);
    });
    it('leaves separated circles on the line', () => {
        expect(beeswarm([{ x: 0, y: 0, r: 5 }, { x: 50, y: 0, r: 5 }], 100, box)).toEqual([100, 100]);
    });
});

describe('momentum warm-up', () => {
    it('counts the minutes still missing from the first received bar', () => {
        expect(MOMENTUM_WARMUP).toBe(RECENT + 5);
        expect(momentumWarmup(100, null)).toBe(MOMENTUM_WARMUP);
        expect(momentumWarmup(100, 104)).toBe(MOMENTUM_WARMUP - 5); // 5 minutes received
        expect(momentumWarmup(100, 100 + MOMENTUM_WARMUP - 2)).toBe(1);
        expect(momentumWarmup(100, 100 + MOMENTUM_WARMUP - 1)).toBe(0);
        expect(momentumWarmup(100, 200)).toBe(0);
        expect(momentumWarmup(null, MOMENTUM_WARMUP - 1)).toBe(0);
    });
    it('is exactly zero momentum while the session is shorter than the recent window', () => {
        // why the warm-up exists: both windows hold the same bars
        const minutes: [number, number, number][] = [];
        for (let s = 100; s < 100 + RECENT; s += 1) minutes.push([s, 100, s % 3 === 0 ? 40 : -10]);
        const g = group(minutes);
        for (let s = 100; s < 100 + RECENT; s += 1) expect(rotationPoint(g, s)!.y).toBeCloseTo(0, 10);
        // and real once the warm-up is over
        for (let s = 100 + RECENT; s < 100 + MOMENTUM_WARMUP; s += 1) minutes.push([s, 100, 80]);
        expect(rotationPoint(group(minutes), 100 + MOMENTUM_WARMUP - 1)!.y).toBeGreaterThan(5);
    });
});

describe('net axis', () => {
    it('takes robust per-side extents: one outlier does not set the scale', () => {
        const values = [10.4e8, 6.3e8, 5.6e8, 5.3e8, 3.4e8, 2.4e8, 1.3e8, ...Array.from({ length: 27 }, (_, i) => (i + 1) * 0.04e8), -0.08e8];
        const { pos, neg } = netExtents(values);
        // p95 of 34 inflows is the runner-up, not the outlier: 6.3 × 1.1 → 10 億
        expect(pos).toBe(1e9);
        expect(netExtents([...values, 40e8]).pos).toBe(1e9);
        expect(neg).toBe(1e8); // floor
        expect(netExtents([])).toEqual({ pos: 1e8, neg: 1e8 });
        expect(niceCeil(6.9e8)).toBe(1e9);
        expect(niceCeil(1.3e8)).toBe(2e8);
    });
    it('puts zero where both sides fit, one px-per-unit, at least the minimum share each', () => {
        const all = netScale(1e10, 1e8);
        expect(all.zero).toBeCloseTo(0.2, 6); // inflow-only market: outflow keeps 20 %
        const even = netScale(1e9, 1e9);
        expect(even.zero).toBeCloseTo(0.5, 6);
        // equal flows are equal distances from zero (inside the linear part)
        const s = netScale(1e9, 5e8);
        expect(netFrac(2e8, s) - s.zero).toBeCloseTo(s.zero - netFrac(-2e8, s), 9);
    });
    it('soft-clamps outliers inside the edge, keeping their order', () => {
        const s = netScale(1e9, 1e9);
        const a = netFrac(1e9, s);
        const b = netFrac(3e9, s);
        const c = netFrac(1e11, s);
        expect(a).toBeLessThan(b);
        expect(b).toBeLessThan(c);
        expect(c).toBeLessThan(1);
        expect(netFrac(-1e11, s)).toBeGreaterThan(0);
        expect(softUnit(0.5)).toBe(0.5);
        expect(softUnit(1.5)).toBeLessThan(1);
        expect(softUnit(1.5)).toBeGreaterThan(softUnit(1.2));
        expect(softUnit(-1)).toBe(0);
    });
    it('picks readable ticks spaced apart on both sides', () => {
        const s = netScale(1e9, 1e8);
        const ticks = netTicks(s, 1300, 44);
        expect(ticks.some((t) => t > 0)).toBe(true);
        expect(ticks.some((t) => t < 0)).toBe(true);
        const xs = [s.zero * 1300, ...ticks.map((t) => netFrac(t, s) * 1300)].sort((a, b) => a - b);
        for (let i = 1; i < xs.length; i += 1) expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(44);
        for (const t of ticks) expect([1, 2, 5]).toContain(Number((Math.abs(t) / 10 ** Math.floor(Math.log10(Math.abs(t)))).toFixed(6)));
    });
});

describe('quadrant boundary', () => {
    it('classifies exact zeros consistently', () => {
        expect(quadrantOf(0, 0)).toBe('leading');
        expect(quadrantOf(0, -0.01)).toBe('weakening');
        expect(quadrantOf(-0.01, 0)).toBe('improving');
        expect(quadrantOf(-0.01, -0.01)).toBe('lagging');
    });
});
