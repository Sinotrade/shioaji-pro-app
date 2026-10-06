import { describe, expect, it } from 'vitest';
import type { Candle } from '../types/market';
import { researchLevels, toHeikinAshi, v9Resonance, v9TrendTint } from './research-chart';
import { wallClockToUtc } from './kbars';

const bar = (time: number, open: number, high: number, low: number, close: number): Candle => ({
    time, open, high, low, close, volume: 1,
});

describe('research chart helpers', () => {
    it('confirms cached futures daily candles at same-date 13:45 and never at the preceding 05:00', () => {
        const t = wallClockToUtc;
        const daily = [
            bar(t('2026-09-30T00:00:00'), 100, 102, 99, 101),
            bar(t('2026-10-01T00:00:00'), 101, 103, 100, 102),
        ];
        const count = (at: string) => v9Resonance([], 'FUT', t(at), daily).frames.find(frame => frame.minutes === 1440)!.bars;
        expect(count('2026-10-01T05:00:00')).toBe(1);
        expect(count('2026-10-01T13:44:59')).toBe(1);
        expect(count('2026-10-01T13:45:00')).toBe(2);
    });

    it('converts raw bars to average candles without mutating the source', () => {
        const raw = [bar(1, 10, 14, 8, 12), bar(2, 12, 16, 11, 15)];
        expect(toHeikinAshi(raw)).toMatchObject([
            { open: 11, close: 11, high: 14, low: 8 },
            { open: 11, close: 13.5, high: 16, low: 11 },
        ]);
        expect(raw[1]!.open).toBe(12);
    });

    it('reports prior-session support/resistance and the opening range', () => {
        const d1 = Date.UTC(2026, 8, 17, 9, 1) / 1000;
        const d2 = Date.UTC(2026, 8, 18, 9, 1) / 1000;
        const levels = researchLevels([
            bar(d1, 10, 12, 9, 11),
            bar(d1 + 60, 11, 13, 10, 12),
            bar(d2, 20, 21, 19, 20),
            bar(d2 + 60, 20, 23, 18, 22),
            bar(d2 + 120, 22, 23, 20, 21),
            bar(d2 + 180, 21, 22, 19, 20),
            bar(d2 + 240, 20, 21, 19, 20),
        ]);
        expect(levels).toEqual(expect.arrayContaining([
            { id: 'open', title: '開盤', price: 20, kind: 'open' },
            { id: 'or-high', title: '開盤5分高', price: 23, kind: 'opening-range' },
            { id: 'or-low', title: '開盤5分低', price: 18, kind: 'opening-range' },
            { id: 'prev-high', title: '昨高', price: 13, kind: 'previous' },
            { id: 'prev-low', title: '昨低', price: 9, kind: 'previous' },
            { id: 'prev-close', title: '昨收', price: 12, kind: 'previous' },
        ]));
    });

    it('keeps a futures night session intact across midnight for support/resistance', () => {
        const daySession = Date.UTC(2026, 8, 17, 8, 46) / 1000;
        const nightStart = Date.UTC(2026, 8, 17, 15, 1) / 1000;
        const afterMidnight = Date.UTC(2026, 8, 18, 1, 1) / 1000;
        const raw = [
            bar(daySession, 100, 104, 98, 102),
            bar(nightStart, 105, 108, 103, 106),
            ...Array.from({ length: 4 }, (_, i) => bar(nightStart + (i + 1) * 60, 106, 107, 104, 106)),
            bar(afterMidnight, 106, 110, 104, 109),
        ];
        const levels = researchLevels(raw, 5, 'FUT');
        expect(levels).toEqual(expect.arrayContaining([
            { id: 'open', title: '開盤', price: 105, kind: 'open' },
            { id: 'or-high', title: '開盤5分高', price: 108, kind: 'opening-range' },
            { id: 'or-low', title: '開盤5分低', price: 103, kind: 'opening-range' },
            { id: 'prev-high', title: '昨高', price: 104, kind: 'previous' },
            { id: 'prev-low', title: '昨低', price: 98, kind: 'previous' },
        ]));
        expect(researchLevels(raw, 5, 'FUT', nightStart + 239).map(level => level.id))
            .toEqual(['open', 'prev-high', 'prev-low', 'prev-close']);
        expect(researchLevels(raw.filter(minute => minute.time !== nightStart + 120), 5, 'FUT')
            .some(level => level.kind === 'opening-range')).toBe(false);
    });

    it('shows the open early but does not call a forming two-minute range opening5m', () => {
        const start = wallClockToUtc('2026-10-01T09:00:00');
        const levels = researchLevels([
            bar(start + 60, 20, 21, 19, 20),
            bar(start + 120, 20, 23, 18, 22),
        ]);
        expect(levels).toEqual([{ id: 'open', title: '開盤', price: 20, kind: 'open' }]);
    });

    it('includes the fifth minute and excludes the auction and sixth-minute extremes', () => {
        const start = wallClockToUtc('2026-10-01T09:00:00');
        const raw = [
            bar(start, 20, 999, 1, 20),
            ...Array.from({ length: 4 }, (_, i) => bar(start + (i + 1) * 60, 21, 22, 19, 21)),
            bar(start + 300, 21, 28, 17, 25),
            bar(start + 360, 25, 100, 2, 26),
        ];
        expect(researchLevels(raw)).toEqual([
            { id: 'open', title: '開盤', price: 20, kind: 'open' },
            { id: 'or-high', title: '開盤5分高', price: 28, kind: 'opening-range' },
            { id: 'or-low', title: '開盤5分低', price: 17, kind: 'opening-range' },
        ]);
        expect(researchLevels(raw, 5, 'STK', start)).toEqual([
            { id: 'open', title: '開盤', price: 20, kind: 'open' },
        ]);
    });

    it('does not certify a missing minute even when later bars and the clock are present', () => {
        const start = wallClockToUtc('2026-10-01T09:00:00');
        const raw = [1, 2, 4, 5, 6].map(minute => bar(start + minute * 60, 20, 22, 19, 21));
        expect(researchLevels(raw, 5, 'STK', start + 600)).toEqual([
            { id: 'open', title: '開盤', price: 20, kind: 'open' },
        ]);
        // No fill is added for a no-trade/missing 09:03; this is not a diagnosis
        // of disconnection, merely insufficient evidence for a complete range.
        expect(raw).toHaveLength(5);
    });

    it('filters future bars before selecting a session or completing the opening range', () => {
        const start = wallClockToUtc('2026-10-01T09:00:00');
        const raw = [
            ...Array.from({ length: 5 }, (_, i) => bar(start + (i + 1) * 60, 20, 22 + i, 19, 21)),
            bar(start + 86400 + 60, 100, 101, 99, 100),
        ];
        const beforeClose = researchLevels(raw, 5, 'STK', start + 299);
        expect(beforeClose).toEqual([{ id: 'open', title: '開盤', price: 20, kind: 'open' }]);
        expect(researchLevels(raw, 5, 'STK', start + 300)).toEqual([
            { id: 'open', title: '開盤', price: 20, kind: 'open' },
            { id: 'or-high', title: '開盤5分高', price: 26, kind: 'opening-range' },
            { id: 'or-low', title: '開盤5分低', price: 19, kind: 'opening-range' },
        ]);
    });

    it('does not invent an opening from a partial page that begins after the first minute', () => {
        const start = wallClockToUtc('2026-10-01T09:00:00');
        const raw = [2, 3, 4, 5, 6].map(minute => bar(start + minute * 60, 20, 22, 19, 21));
        expect(researchLevels(raw)).toEqual([]);
    });

    it('rejects a zero-volume opening but accepts an explicitly supplied later zero-volume minute', () => {
        const start = wallClockToUtc('2026-10-01T09:00:00');
        const raw = Array.from({ length: 5 }, (_, i) => bar(start + (i + 1) * 60, 20, 22, 19, 21));
        expect(researchLevels([
            { ...bar(start, 20, 21, 19, 20), volume: 0 },
            ...raw.map((minute, i) => i === 0 ? { ...minute, volume: 0 } : minute),
        ])).toEqual([]);
        const withObservedZero = raw.map((minute, i) => i === 2 ? { ...minute, volume: 0 } : minute);
        expect(researchLevels(withObservedZero).map(level => level.id)).toEqual(['open', 'or-high', 'or-low']);
    });

    it('cleans, sorts and deduplicates raw minutes without mutating them or counting invalid revisions', () => {
        const start = wallClockToUtc('2026-10-01T09:00:00');
        const raw = [
            ...Array.from({ length: 5 }, (_, i) => bar(start + (5 - i) * 60, 20, 22, 19, 21)),
            bar(start + 180, 20, 26, 18, 21),
            { ...bar(start + 180, 20, 99, 1, 21), volume: NaN },
            bar(start + 86400 + 60, 100, 99, 98, 100),
            { ...bar(start + 86400 + 120, 100, 101, 99, 100), volume: -1 },
            bar(start + 86400 + 180, 0, 0, 0, 0),
            bar(start + 86400 + 181, 100, 101, 99, 100),
            bar(NaN, 100, 101, 99, 100),
        ];
        const before = raw.map(minute => ({ ...minute }));
        expect(researchLevels(raw)).toEqual([
            { id: 'open', title: '開盤', price: 20, kind: 'open' },
            { id: 'or-high', title: '開盤5分高', price: 26, kind: 'opening-range' },
            { id: 'or-low', title: '開盤5分低', price: 18, kind: 'opening-range' },
        ]);
        expect(raw).toEqual(before);
    });

    it('uses futures day minute-END labels 08:46 through 08:50 for the completed5m range', () => {
        const start = wallClockToUtc('2026-10-01T08:45:00');
        const raw = Array.from({ length: 5 }, (_, i) => bar(start + (i + 1) * 60, 100, 102, 99, 101));
        expect(researchLevels(raw, 5, 'FUT', start + 299).map(level => level.id)).toEqual(['open']);
        expect(researchLevels(raw, 5, 'FUT', start + 300).map(level => level.id)).toEqual(['open', 'or-high', 'or-low']);
    });

    it('labels incomplete multi-timeframe sources instead of inventing V9 resonance', () => {
        const sparse = Array.from({ length: 116 }, (_, i) => bar(
            Date.UTC(2026, 0, 1 + i, 1) / 1000, 100 + i, 101 + i, 99 + i, 100.5 + i,
        ));
        expect(v9Resonance(sparse).frames.every(frame => frame.side === 'insufficient')).toBe(true);
        expect(v9Resonance(sparse).summary).toContain('資料不足4');
    });

    it('shows four-timeframe alignment only after all V9 slow-MACD windows are present', () => {
        const rising = Array.from({ length: 140 }, (_, i) => bar(
            Date.UTC(2026, 0, 1 + i, 1) / 1000, 100 + i, 101.5 + i, 99.5 + i, 101 + i,
        ));
        const resonance = v9Resonance(rising);
        expect(resonance.frames.every(frame => frame.side === 'long')).toBe(true);
        expect(resonance.summary).toBe('四週期同多');
    });

    it('tints confirmed long/short sessions and leaves warm-up neutral', () => {
        // Same-session minute bars (09:00 Taipei = 01:00 UTC) so the ATR
        // 防守線 two-bar same-session confirmation can accumulate.
        const base = Date.UTC(2026, 8, 21, 1, 0) / 1000;
        const trendBars = (dir: 1 | -1): Candle[] =>
            Array.from({ length: 260 }, (_, i) => {
                const open = 100 + dir * i * 0.2;
                const close = 100 + dir * (i + 1) * 0.2;
                return {
                    time: base + i * 60,
                    open,
                    high: Math.max(open, close) + 0.05,
                    low: Math.min(open, close) - 0.05,
                    close,
                    volume: 1000,
                };
            });

        // A slow, mean-reverting sine oscillates between both sides.
        const sineBars: Candle[] = Array.from({ length: 260 }, (_, i) => {
            const close = 100 + 0.15 * Math.sin(i / 10);
            const open = i === 0 ? close : 100 + 0.15 * Math.sin((i - 1) / 10);
            return {
                time: base + i * 60,
                open,
                high: Math.max(open, close) + 0.02,
                low: Math.min(open, close) - 0.02,
                close,
                volume: 1000,
            };
        });

        const longTint = v9TrendTint(trendBars(1));
        const shortTint = v9TrendTint(trendBars(-1));
        const sineTint = v9TrendTint(sineBars);
        expect(longTint).toHaveLength(260);
        expect(shortTint).toHaveLength(260);
        expect(sineTint).toHaveLength(260);
        // The first bar of a session is unconfirmed, hence neutral.
        expect(longTint[0]!.side).toBe(0);
        expect(shortTint[0]!.side).toBe(0);
        // Mapped sides are always one of long/neutral/short.
        const legal = (side: number) => side === 1 || side === 0 || side === -1;
        expect(longTint.every((point) => legal(point.side))).toBe(true);
        expect(shortTint.every((point) => legal(point.side))).toBe(true);
        // Confirmed tail of a steady ramp is one-sided.
        expect(longTint.slice(-10).every((point) => point.side === 1)).toBe(true);
        expect(shortTint.slice(-10).every((point) => point.side === -1)).toBe(true);
        // Oscillating data can map to both the long and short bands (and gaps).
        const sineSides = new Set(sineTint.map((point) => point.side));
        expect(sineSides.has(1)).toBe(true);
        expect(sineSides.has(-1)).toBe(true);
        // Tint times align 1:1 with the source bars.
        expect(longTint.every((point, i) => point.time === trendBars(1)[i]!.time)).toBe(true);
    });
});
