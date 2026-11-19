import { describe, expect, it } from 'vitest';
import { usBestLevel } from './us-depth';
import { mergeUsTape, usTapeRowFromMeta, usTapeRowsFromHistory } from './us-tick-tape';

describe('usBestLevel', () => {
    it('reads the single best level and the decimal spread', () => {
        const r = usBestLevel({ bid_price: ['352.39'], bid_volume: [100], ask_price: ['352.41'], ask_volume: [200] });
        expect(r.bid).toEqual({ price: '352.39', vol: 100 });
        expect(r.ask).toEqual({ price: '352.41', vol: 200 });
        expect(Number(r.spread)).toBeCloseTo(0.02);
    });
    it('hides empty sides', () => {
        const r = usBestLevel({ bid_price: ['0'], bid_volume: [0], ask_price: [], ask_volume: [] });
        expect(r).toEqual({ bid: null, ask: null, spread: null });
        expect(usBestLevel(undefined).bid).toBeNull();
    });
});

describe('usTapeRowsFromHistory', () => {
    it('puts the newest first and caps the rows', () => {
        const ticks = [1, 2, 3].map(i => ({ ts: i, tsUs: i * 1000, time: `09:30:0${i}.000000`, price: 100 + i, volume: i, bid: null, ask: null, tickType: 1, session: 'Regular' as const, oddLot: false }));
        const rows = usTapeRowsFromHistory(ticks, 2);
        expect(rows.map(r => r.price)).toEqual(['103', '102']);
        expect(rows[0]!.time).toBe('09:30:03.000000');
    });
});

describe('mergeUsTape', () => {
    const t0 = Date.UTC(2026, 10, 18, 20, 59, 59);
    const hist = usTapeRowsFromHistory([0, 1, 2].map(i => ({ ts: t0 + i, tsUs: (t0 + i) * 1000, time: `15:59:59.00${i}000`, price: 352 + i / 100, volume: 10 + i, bid: null, ask: null, tickType: 0, session: 'Regular' as const, oddLot: false })));
    it('drops live rows already in history and keeps newer ones on top', () => {
        const dup = usTapeRowFromMeta({ key: 'US:AAPL', price: '352.02', session: 'Regular', freshness: null, ts: t0 + 2, tsUs: (t0 + 2) * 1000, volume: 12, tickType: 1 });
        const newer = usTapeRowFromMeta({ key: 'US:AAPL', price: '352.5', session: 'AfterHours', freshness: null, ts: t0 + 5000, tsUs: (t0 + 5000) * 1000 + 7, volume: 3, tickType: 1 });
        const rows = mergeUsTape([newer, dup], hist);
        expect(rows.map(r => r.price)).toEqual(['352.5', '352.02', '352.01', '352']);
        expect(rows[0]!.time).toBe('16:00:04.000007');
    });
    it('keeps a same-price same-volume trade in a different microsecond of the same ms', () => {
        const near = usTapeRowFromMeta({ key: 'US:AAPL', price: '352.02', session: 'Regular', freshness: null, ts: t0 + 2, tsUs: (t0 + 2) * 1000 + 800, volume: 12 });
        expect(mergeUsTape([near], hist)).toHaveLength(4);
    });
    it('keeps a live row that only shares the timestamp', () => {
        const other = usTapeRowFromMeta({ key: 'US:AAPL', price: '352.02', session: 'Regular', freshness: null, ts: t0 + 2, tsUs: (t0 + 2) * 1000, volume: 99 });
        expect(mergeUsTape([other], hist)).toHaveLength(4);
    });
});
