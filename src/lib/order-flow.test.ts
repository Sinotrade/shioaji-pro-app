import { describe, expect, it } from 'vitest';
import {
    buildOrderFlow,
    summarizeOrderFlow,
    type OrderFlowTrade,
} from './order-flow';
import type { Candle } from './types/market';

function bar(time: number): Candle {
    return { time, open: 0, high: 0, low: 0, close: 0, volume: 0 };
}
const bars = [bar(0), bar(60), bar(120)];
// bar0: buy10 sell4 → delta 6, cvd 6
// bar1: buy2       → delta 2, cvd 8
// bar2: sell9      → delta -9, cvd -1
const trades: OrderFlowTrade[] = [
    { time: 5, price: 1, volume: 10, side: 1 },
    { time: 10, price: 1, volume: 4, side: -1 },
    { time: 65, price: 1, volume: 2, side: 1 },
    { time: 125, price: 1, volume: 9, side: -1 },
];

describe('buildOrderFlow', () => {
    it('buckets aggressor volume into bars with running CVD', () => {
        const flow = buildOrderFlow(trades, bars);
        expect(flow.map((f) => f.delta)).toEqual([6, 2, -9]);
        expect(flow.map((f) => f.cvd)).toEqual([6, 8, -1]);
        expect(flow.map((f) => [f.buy, f.sell])).toEqual([
            [10, 4], [2, 0], [0, 9],
        ]);
        expect(flow[0]!.imbalance).toBeCloseTo(6 / 14);
        expect(flow[1]!.imbalance).toBe(1);
    });

    it('cuts ticks and bars at untilTime (replay seek)', () => {
        const flow = buildOrderFlow(trades, bars, 60);
        expect(flow).toHaveLength(1);
        expect(flow[0]!.delta).toBe(6);
        expect(flow[0]!.cvd).toBe(6);
    });

    it('ignores ticks outside the bar range', () => {
        const early: OrderFlowTrade[] = [
            { time: -50, price: 1, volume: 99, side: 1 },
            ...trades,
        ];
        const flow = buildOrderFlow(early, bars);
        expect(flow[0]!.buy).toBe(10);
    });
});

describe('summarizeOrderFlow', () => {
    it('returns session totals and inner/outer percentages', () => {
        const s = summarizeOrderFlow(buildOrderFlow(trades, bars));
        expect(s.buy).toBe(12);
        expect(s.sell).toBe(13);
        expect(s.delta).toBe(-1);
        expect(s.cvd).toBe(-1);
        expect(s.buyPct).toBeCloseTo((12 / 25) * 100);
        expect(s.sellPct).toBeCloseTo((13 / 25) * 100);
        expect(s.bars).toBe(3);
    });
});
