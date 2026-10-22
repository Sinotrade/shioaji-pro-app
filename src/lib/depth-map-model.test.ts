import { describe, expect, it } from 'vitest';
import { appendDepthColumn, depthPriceTicks, depthTimeRange, MAX_DEPTH_COLUMNS, observedSpanMs } from './depth-map-model';
import type { DisplayBook } from './display-book';

const makeBook = (time: string, source: DisplayBook['source'] = 'stream'): DisplayBook => ({
    time, source,
    bids: [{ price: 50000, vol: 3 }],
    asks: [{ price: 50001, vol: 4 }],
});

describe('depth map geometry and samples', () => {
    it('uses market timestamps instead of assigning artificial equal-width intervals', () => {
        const a = appendDepthColumn([], makeBook('2026-10-15 09:00:00'), 50000);
        const b = appendDepthColumn(a, makeBook('2026-10-15 09:00:10'), 50001);
        expect(b[1]!.timeMs - b[0]!.timeMs).toBe(10_000);
        expect(depthTimeRange(b)).toEqual({ start: b[0]!.timeMs - 50_000, end: b[1]!.timeMs });
    });

    it('coalesces equal-resolution timestamps and rejects older packets', () => {
        const first = appendDepthColumn([], makeBook('2026-10-15 09:00:00'), null);
        const updated = appendDepthColumn(first, { ...makeBook('2026-10-15 09:00:00'), bids: [] }, null);
        expect(updated).toHaveLength(1);
        expect(updated[0]!.bids).toEqual([]);
        const old = appendDepthColumn(updated, makeBook('2026-10-15 08:59:59'), null);
        expect(old).toEqual(updated);
        expect(appendDepthColumn(old, makeBook('unknown'), null)).toEqual(old);
    });

    it('does not merge L1 snapshot history with the live five-level stream', () => {
        const fallback = appendDepthColumn([], makeBook('2026-10-15 08:59:59', 'snapshot'), null);
        const actual = appendDepthColumn(fallback, makeBook('2026-10-15 09:00:00'), 50000);
        expect(actual).toHaveLength(1);
        expect(actual[0]!.source).toBe('stream');
        expect(appendDepthColumn(actual, makeBook('2026-10-15 09:00:01', 'snapshot'), null)).toEqual(actual);
    });

    it('limits retained samples and resets across long market inactivity', () => {
        let columns = appendDepthColumn([], makeBook('2026-10-15 09:00:00'), null);
        for (let i = 1; i < 400; i++) {
            columns = appendDepthColumn(columns, makeBook(new Date(Date.parse('2026-10-15T01:00:00Z') + i * 1000).toISOString()), null);
        }
        expect(columns).toHaveLength(MAX_DEPTH_COLUMNS);
        const reset = appendDepthColumn(columns, makeBook('2026-10-15 09:30:00'), null);
        expect(reset).toHaveLength(1);
    });

    it('does not imply that a wall persists through a long silence', () => {
        const a = appendDepthColumn([], makeBook('2026-10-15 09:00:00'), null)[0]!;
        const b = appendDepthColumn([], makeBook('2026-10-15 09:00:10'), null)[0]!;
        expect(observedSpanMs(a, b)).toBe(2000);
        expect(observedSpanMs(a)).toBe(0);
        expect(observedSpanMs(b, a)).toBe(0);
    });

    it('provides readable finite price-axis ticks without fabricating price data', () => {
        expect(depthPriceTicks(49992, 50008)).toEqual([49995, 50000, 50005]);
        expect(depthPriceTicks(Number.NaN, 50000)).toEqual([]);
        expect(depthTimeRange([])).toBeNull();
    });
});
