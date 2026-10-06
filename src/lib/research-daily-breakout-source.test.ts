import { describe, expect, it } from 'vitest';
import { dailyBreakoutClosedSource } from './research-daily-breakout-source';
import type { Candle } from './types/market';

const stock = { code: '2330', exchange: 'TSE', region: 'TW', security_type: 'STK', target_code: null } as const;
const candle = (day: string): Candle => ({ time: Date.parse(`${day}T00:00:00Z`) / 1000,
    open: 100, high: 102, low: 99, close: 101, volume: 100 });
const now = (clock: string) => Date.parse(`2026-10-02T${clock}+08:00`);

describe('daily breakout provenance-checked source time gate', () => {
    it('does not promote the current date during the morning, even if cache claims closing evidence', () => {
        const rows = [candle('2026-10-01'), candle('2026-10-02'), candle('2026-10-05')];
        expect(dailyBreakoutClosedSource(rows, stock, now('09:30:00'))).toEqual([rows[0]]);
        expect(dailyBreakoutClosedSource(rows, stock, now('13:29:59'))).toEqual([rows[0]]);
        expect(dailyBreakoutClosedSource(rows, stock, now('13:30:00'))).toEqual(rows.slice(0, 2));
    });
    it('uses an explicit Taiwan offset independent of browser/computer timezone', () => {
        const rows = [candle('2026-10-02')];
        expect(dailyBreakoutClosedSource(rows, stock, Date.parse('2026-10-02T05:30:00Z'))).toEqual(rows);
        expect(dailyBreakoutClosedSource(rows, stock, Date.parse('2026-10-02T05:29:59Z'))).toEqual([]);
    });
    it('never feeds futures, indices, foreign stocks, unknown exchanges, or an invalid clock to stock research', () => {
        const rows = [candle('2026-10-01')];
        expect(dailyBreakoutClosedSource(rows, { ...stock, security_type: 'FUT' }, now('18:10:00'))).toEqual([]);
        expect(dailyBreakoutClosedSource(rows, { ...stock, security_type: 'IND' }, now('18:10:00'))).toEqual([]);
        expect(dailyBreakoutClosedSource(rows, { ...stock, region: 'US' }, now('18:10:00'))).toEqual([]);
        expect(dailyBreakoutClosedSource(rows, { ...stock, exchange: 'OES' }, now('18:10:00'))).toEqual([]);
        expect(dailyBreakoutClosedSource(rows, stock, NaN)).toEqual([]);
    });
    it('preserves cache objects without mutation and permits known Taiwan OTC contracts', () => {
        const row = candle('2026-10-01');
        const rows = Object.freeze([Object.freeze(row)]) as unknown as Candle[];
        const result = dailyBreakoutClosedSource(rows, { ...stock, exchange: 'OTC' }, now('18:10:00'));
        expect(result).toEqual(rows);
        expect(result).not.toBe(rows);
        expect(result[0]).not.toBe(row);
    });
    it('rejects malformed labels without silently joining the dates around a known bad record', () => {
        const first = candle('2026-09-30'), last = candle('2026-10-01');
        expect(dailyBreakoutClosedSource([first, { ...last, time: NaN }, last], stock, now('18:10:00'))).toEqual([]);
        expect(dailyBreakoutClosedSource([first, { ...last, time: last.time + 3600 }], stock, now('18:10:00'))).toEqual([]);
        expect(dailyBreakoutClosedSource([last, first], stock, now('18:10:00'))).toEqual([]);
        expect(dailyBreakoutClosedSource([first, first, last], stock, now('18:10:00'))).toEqual([]);
    });
});
