import { describe, expect, it } from 'vitest';
import { mergeTradeIntoBars, replayPendingTrades } from './chart-live-bars';
import type { Candle } from './types/market';

const bar = (time: number, p = 10): Candle => ({ time, open: p, high: p, low: p, close: p, volume: 1 });

describe('mergeTradeIntoBars', () => {
    it('opens a new bar, updates the tail, and routes an older bucket to its own bar', () => {
        const bars = [bar(60), bar(120)];
        expect(mergeTradeIntoBars(bars, bars[1]!, 180, 12, 2)?.kind).toBe('new');
        expect(bars).toHaveLength(3);
        const tail = bars[2]!;
        expect(mergeTradeIntoBars(bars, tail, 180, 13, 1)).toMatchObject({ kind: 'tail' });
        expect(tail).toMatchObject({ high: 13, close: 13, volume: 3 });
        const r = mergeTradeIntoBars(bars, tail, 60, 5, 4);
        expect(r).toMatchObject({ kind: 'older', bar: { time: 60, low: 5, close: 5, volume: 5 } });
        expect(tail).toMatchObject({ low: 12, close: 13, volume: 3 }); // 最新一根不受影響
    });
    it('drops an older trade whose bar is missing (gap)', () => {
        const bars = [bar(60), bar(240)];
        expect(mergeTradeIntoBars(bars, bars[1]!, 120, 1, 1)).toBeNull();
        expect(bars[1]).toMatchObject({ close: 10, volume: 1 });
    });
});

describe('replayPendingTrades', () => {
    it('keeps only trades at or after the last history label, in arrival order', () => {
        const t = [{ time: 100, price: 1, volume: 1 }, { time: 179.5, price: 2, volume: 1 }, { time: 180, price: 3, volume: 1 }, { time: 200, price: 4, volume: 1 }];
        expect(replayPendingTrades(t, 180).map((x) => x.price)).toEqual([3, 4]);
        expect(replayPendingTrades(t, -Infinity)).toHaveLength(4);
    });
});
