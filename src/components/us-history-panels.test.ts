import { describe, expect, it } from 'vitest';
import { usBestLevel } from './us-depth';
import { usTapeRowsFromHistory } from './us-tick-tape';

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
        const ticks = [1, 2, 3].map(i => ({ ts: i, time: `09:30:0${i}.000000`, price: 100 + i, volume: i, bid: null, ask: null, tickType: 1, session: 'Regular' as const, oddLot: false }));
        const rows = usTapeRowsFromHistory(ticks, 2);
        expect(rows.map(r => r.price)).toEqual(['103', '102']);
        expect(rows[0]!.time).toBe('09:30:03.000000');
    });
});
