import { describe, expect, it } from 'vitest';
import { emptyPending, mergePendingTrades, mergeTradeIntoBars, pushPending } from './chart-live-bars';
import type { Candle } from './types/market';

const bar = (time: number, p = 10): Candle => ({ time, open: p, high: p, low: p, close: p, volume: 1 });
const minuteLabel = (t: number) => Math.ceil(t / 60) * 60;

describe('mergeTradeIntoBars', () => {
    it('volume-only trades keep OHLC and open a flat bar at the last close', () => {
        const bars = [bar(60, 10)];
        expect(mergeTradeIntoBars(bars, bars[0]!, 60, 99, 5, true)).toMatchObject({ kind: 'tail', bar: { open: 10, high: 10, low: 10, close: 10, volume: 6 } });
        expect(mergeTradeIntoBars(bars, bars[0]!, 120, 99, 2, true)).toMatchObject({ kind: 'new', bar: { time: 120, open: 10, high: 10, low: 10, close: 10, volume: 2 } });
        // 還沒有 K 棒：不畫
        expect(mergeTradeIntoBars([], null, 60, 99, 2, true)).toBeNull();
    });
    it('a bar opened by a volume-only trade takes OHLC from its first priced trade', () => {
        const bars = [bar(60, 100)];
        const opened = mergeTradeIntoBars(bars, bars[0]!, 120, 99, 2, true)!.bar;
        expect(mergeTradeIntoBars(bars, opened, 120, 110, 3)).toMatchObject({ kind: 'tail', bar: { open: 110, high: 110, low: 110, close: 110, volume: 5 } });
        expect(mergeTradeIntoBars(bars, opened, 120, 105, 1)).toMatchObject({ bar: { open: 110, high: 110, low: 105, close: 105, volume: 6 } });
        // 再來的只加量成交不動價格
        expect(mergeTradeIntoBars(bars, opened, 120, 1, 4, true)).toMatchObject({ bar: { open: 110, high: 110, low: 105, close: 105, volume: 10 } });
    });
    it('opens a new bar and updates the tail', () => {
        const bars = [bar(60), bar(120)];
        expect(mergeTradeIntoBars(bars, bars[1]!, 180, 12, 2)?.kind).toBe('new');
        expect(bars).toHaveLength(3);
        const tail = bars[2]!;
        expect(mergeTradeIntoBars(bars, tail, 180, 13, 1)).toMatchObject({ kind: 'tail' });
        expect(tail).toMatchObject({ high: 13, close: 13, volume: 3 });
    });
    it('drops a trade for a bucket older than the tail and leaves every bar untouched', () => {
        const bars = [bar(60), bar(120), bar(180)];
        const before = JSON.parse(JSON.stringify(bars));
        expect(mergeTradeIntoBars(bars, bars[2]!, 60, 5, 4)).toBeNull();
        expect(mergeTradeIntoBars(bars, bars[2]!, 120, 50, 4)).toBeNull();
        expect(bars).toEqual(before);
    });
});

describe('pending trades', () => {
    it('marks overflow instead of silently dropping once the buffer is full', () => {
        const p = emptyPending('k');
        expect(pushPending(p, { time: 1, price: 1, volume: 1 }, 2)).toBe(true);
        expect(pushPending(p, { time: 2, price: 1, volume: 1 }, 2)).toBe(true);
        expect(p.overflow).toBe(false);
        expect(pushPending(p, { time: 3, price: 1, volume: 1 }, 2)).toBe(false);
        expect(p.overflow).toBe(true);
        expect(p.trades).toHaveLength(2);
    });
    it('reduces buffered trades into bars past the covered label, in memory', () => {
        const bars = [bar(120), bar(180)];
        const trades = [
            { time: 150, price: 99, volume: 9 }, // label 180 = covered → 已在歷史
            { time: 179.5, price: 99, volume: 9 }, // label 180 → 已在歷史
            { time: 180.5, price: 11, volume: 2 }, // label 240 → 新的一根
            { time: 200, price: 13, volume: 1 },
            { time: 250, price: 12, volume: 3 }, // label 300
        ];
        const tail = mergePendingTrades(bars, trades, 180, minuteLabel, (l) => l);
        expect(bars.map((b) => b.time)).toEqual([120, 180, 240, 300]);
        expect(bars[1]).toMatchObject({ close: 10, volume: 1 }); // 歷史那根沒被改
        expect(bars[2]).toMatchObject({ open: 11, high: 13, close: 13, volume: 3 });
        expect(tail).toBe(bars[3]);
    });
    it('merges into a partial aggregated tail and honors barTime null (filtered)', () => {
        const bars = [bar(300)]; // 5 分 K 尾端（只涵蓋到 1 分 K 標籤 180）
        const trades = [
            { time: 200, price: 14, volume: 2 }, // label 240 → 5 分 K 300
            { time: 400, price: 1, volume: 5 }, // 被濾掉
        ];
        mergePendingTrades(bars, trades, 180, minuteLabel, (l) => (l > 300 ? null : Math.ceil(l / 300) * 300));
        expect(bars).toHaveLength(1);
        expect(bars[0]).toMatchObject({ high: 14, close: 14, volume: 3 });
    });
});
