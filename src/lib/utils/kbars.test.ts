import { describe, expect, it } from 'vitest';
import { aggregate, kbarsToCandles, wallClockToUtc } from './kbars';
import type { KBars } from '../types/market';

describe('K-bar utilities', () => {
    it('sorts candles ascending and keeps the newest duplicate timestamp', () => {
        const kbars: KBars = {
            datetime: [
                '2026-08-18 09:02:00',
                '2026-08-18 09:01:00',
                '2026-08-18 09:02:00',
            ],
            Open: [2, 1, 3],
            High: [3, 2, 4],
            Low: [1, 1, 2],
            Close: [2.5, 1.5, 3.5],
            Volume: [20, 10, 30],
            Amount: [50, 15, 105],
        };

        const candles = kbarsToCandles(kbars);

        expect(candles.map((bar) => bar.time)).toEqual([
            wallClockToUtc('2026-08-18 09:01:00'),
            wallClockToUtc('2026-08-18 09:02:00'),
        ]);
        expect(candles[1]).toMatchObject({ open: 3, close: 3.5, volume: 30 });
    });

    it('aggregates 1-minute bars into the selected timeframe with correct OHLCV', () => {
        const candles = kbarsToCandles({
            datetime: [
                '2026-08-18 09:00:00',
                '2026-08-18 09:01:00',
                '2026-08-18 09:04:00',
                '2026-08-18 09:05:00',
            ],
            Open: [10, 11, 12, 13],
            High: [12, 13, 14, 15],
            Low: [9, 10, 11, 12],
            Close: [11, 12, 13, 14],
            Volume: [100, 200, 300, 400],
            Amount: [0, 0, 0, 0],
        });

        const bars = aggregate(candles, 5);

        expect(bars).toEqual([
            {
                time: wallClockToUtc('2026-08-18 09:00:00'),
                open: 10,
                high: 14,
                low: 9,
                close: 13,
                volume: 600,
            },
            {
                time: wallClockToUtc('2026-08-18 09:05:00'),
                open: 13,
                high: 15,
                low: 12,
                close: 14,
                volume: 400,
            },
        ]);
    });
});
