import { describe, expect, it } from 'vitest';
import { confirmedDailySignals } from './use-entry-signals';
import { collectEntrySignals, collectShortSignals } from '../lib/stock-picker';
import { entrySignalsToMarkers } from '../lib/utils/v9-chart-markers';
import type { Candle } from '../lib/types/market';

const day = Date.UTC(2026, 9, 1) / 1000;
function dailySeries(side: 1 | -1): Candle[] {
    let price = side === 1 ? 100 : 120;
    const pattern = [0.9, 0.5, -0.4, 0.6, -0.3];
    return Array.from({ length: 40 }, (_, i) => {
        const open = price;
        const close = price + side * (i === 39 ? 2 : pattern[i % 5]!);
        price = close;
        return { time: day - (39 - i) * 86400, open: side === 1 ? Math.min(open, close) : Math.max(open, close),
            high: Math.max(open, close) + 0.3, low: Math.min(open, close) - 0.3, close, volume: i === 39 ? 300 : 100 };
    });
}

describe('daily signal load-time confirmation', () => {
    it('excludes a current partial long setup rather than freezing it as a future confirmed signal', () => {
        const daily = dailySeries(1);
        expect(collectEntrySignals(daily).some(signal => signal.time === day)).toBe(true);
        const morning = confirmedDailySignals(daily, 'STK', day + 9.5 * 3600);
        expect(morning.long).toEqual(collectEntrySignals(daily.slice(0, -1)));
        expect(morning.long.some(signal => signal.time === day)).toBe(false);
    });

    it('applies the same causal cutoff to current partial short setups', () => {
        const daily = dailySeries(-1);
        expect(collectShortSignals(daily).some(signal => signal.time === day)).toBe(true);
        const morning = confirmedDailySignals(daily, 'STK', day + 9.5 * 3600);
        expect(morning.short).toEqual(collectShortSignals(daily.slice(0, -1)));
        expect(morning.short.some(signal => signal.time === day)).toBe(false);
    });

    it('does not let the marker clock promote a setup excluded from the morning loaded signal set', () => {
        const morning = confirmedDailySignals(dailySeries(1), 'STK', day + 9.5 * 3600);
        const close = day + 13.5 * 3600;
        const last: Candle = { time: close, open: 105, high: 107, low: 105, close: 107, volume: 300 };
        expect(entrySignalsToMarkers(morning.long, [last], 1, 'STK', close)).toEqual([]);
    });

    it('only a post-close load can include the final stock daily signal', () => {
        const daily = dailySeries(1);
        expect(confirmedDailySignals(daily, 'STK', day + 13.5 * 3600).long).toEqual(collectEntrySignals(daily));
    });

    it('waits until 13:45 for futures daily results, not stock 13:30 or next-day 05:00', () => {
        const daily = dailySeries(1);
        expect(confirmedDailySignals(daily, 'FUT', day + 13.5 * 3600).long.some(signal => signal.time === day)).toBe(false);
        expect(confirmedDailySignals(daily, 'FUT', day + 13.75 * 3600).long.some(signal => signal.time === day)).toBe(true);
    });

    it('a historical cutoff cannot collect later loaded daily results', () => {
        const daily = dailySeries(1);
        const cutoff = daily[28]!.time + 12 * 3600;
        expect(confirmedDailySignals(daily, 'STK', cutoff).long).toEqual(collectEntrySignals(daily.slice(0, 28)));
    });
});
