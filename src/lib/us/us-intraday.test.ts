import { describe, expect, it } from 'vitest';
import type { UsTickMeta } from './us-quotes';
import { US_INTRADAY_W, usIntradaySeries, usIntradaySessionPath, usSessionReference } from './us-intraday';

const wall = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13), +s.slice(14, 16)) / 1000;
const tick = (utc: number, price: string, session: UsTickMeta['session'] = 'Regular'): UsTickMeta => ({ key: 'US:AAPL', price, session, freshness: null, ts: utc, volume: 1 });

describe('usSessionReference', () => {
    it('uses a reference only for a trading day after its close date', () => {
        expect(usSessionReference(351.91, '2026-11-17', '2026-11-18')).toBe(351.91);
        expect(usSessionReference(352.45, '2026-11-18', '2026-11-18')).toBeNull();
        expect(usSessionReference(352.45, '2026-11-19', '2026-11-18')).toBeNull();
        expect(usSessionReference(351.91, undefined, '2026-11-18')).toBe(351.91);
        expect(usSessionReference(null, '2026-11-17', '2026-11-18')).toBeNull();
    });
});

describe('usIntradaySeries', () => {
    const history = { date: '2026-11-18', bars: [
        { time: wall('2026-11-18T09:31'), open: 1, high: 1, low: 1, close: 100, volume: 1 },
        { time: wall('2026-11-18T09:32'), open: 1, high: 1, low: 1, close: 101, volume: 1 },
    ] };

    it('draws history closes then newer regular ticks of the same day', () => {
        const s = usIntradaySeries(history, [
            tick(Date.UTC(2026, 10, 18, 14, 31, 30), '99'), // 比最後一根舊：略過
            tick(Date.UTC(2026, 10, 18, 14, 32, 30), '102'),
            tick(Date.UTC(2026, 10, 18, 22, 0), '103', 'AfterHours'), // 盤後不畫
        ])!;
        expect(s.date).toBe('2026-11-18');
        expect(s.fromHistory).toBe(true);
        expect(s.start).toBe(wall('2026-11-18T09:30'));
        expect(s.end).toBe(wall('2026-11-18T16:00'));
        expect(s.points.map(p => p.price)).toEqual([100, 101, 102]);
    });

    it('switches to a newer live trading day', () => {
        const s = usIntradaySeries(history, [tick(Date.UTC(2026, 10, 19, 14, 45), '105')])!;
        expect(s.date).toBe('2026-11-19');
        expect(s.fromHistory).toBe(false);
        expect(s.points).toEqual([{ t: wall('2026-11-19T09:45'), price: 105 }]);
    });

    it('returns null with no history and no regular ticks', () => {
        expect(usIntradaySeries(null, [tick(Date.UTC(2026, 10, 18, 12, 0), '1', 'PreMarket')])).toBeNull();
    });

    it('lays x on the 09:30–16:00 session', () => {
        const s = usIntradaySeries(history, [])!;
        const path = usIntradaySessionPath(s, 100);
        const first = Number(path.points.split(' ')[0]!.split(',')[0]);
        expect(first).toBeCloseTo((60 / (390 * 60)) * US_INTRADAY_W, 1);
        expect(path.last).toBe(101);
        expect(path.refY).not.toBeNull();
    });
});
