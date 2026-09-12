import { describe, expect, it } from 'vitest';
import { displayBook, marketTime } from './display-book';
import type { Snapshot, SseBidAsk } from './types/market';
const snap = (patch = {}) => ({ code: 'TXFI6', datetime: '2026-09-12 09:00:00', buy_price: 100, buy_volume: 2, sell_price: 101, sell_volume: 3, ...patch }) as Snapshot;
const stream = (patch = {}) => ({ code: 'TXFI6', date: '2026-09-12', time: '09:00:01', bid_price: ['102'], bid_volume: [4], ask_price: ['103'], ask_volume: [5], ...patch }) as SseBidAsk;
describe('display-only L1 fallback', () => {
    it('provides only one level and accepts an explicit alias without mutating inputs', () => {
        const s = snap(); const before = structuredClone(s);
        expect(displayBook('TXFR1', s, undefined, 'TXFI6')).toMatchObject({ source: 'snapshot', bids: [{ price: 100, vol: 2 }], asks: [{ price: 101, vol: 3 }] });
        expect(displayBook('OTHER', s)).toBeUndefined(); expect(s).toEqual(before);
    });
    it('prefers newer stream including authoritative empty sides, never mixing old snapshot levels', () => {
        const b = stream({ ask_price: [], ask_volume: [] }); const before = structuredClone(b);
        expect(displayBook('TXFI6', snap(), b)).toMatchObject({ source: 'stream', asks: [], bids: [{ price: 102, vol: 4 }] });
        expect(b).toEqual(before);
        expect(displayBook('TXFI6', snap(), stream({ time: '08:59:59' }))!.source).toBe('snapshot');
        expect(displayBook('TXFI6', snap(), stream({ code: 'OTHER' }))!.source).toBe('snapshot');
    });
    it('allows signed combo prices only with real positive volume', () => {
        const s = snap({ buy_price: -1, sell_price: 0 });
        expect(displayBook('TXFI6', s)!.bids).toEqual([]);
        expect(displayBook('TXFI6', s, undefined, undefined, true)).toMatchObject({ bids: [{ price: -1, vol: 2 }], asks: [{ price: 0, vol: 3 }] });
        expect(displayBook('TXFI6', snap({ buy_volume: 0, sell_price: NaN }), undefined, undefined, true)).toMatchObject({ bids: [], asks: [] });
    });
    it('normalizes Taiwan wall time and nanosecond fractions; unknown stream time cannot replace dated snapshot', () => {
        expect(marketTime('2026/09/12', '09:00:00.123456789')).toBe(Date.parse('2026-09-12T01:00:00.123Z'));
        expect(displayBook('TXFI6', snap(), stream({ date: '', time: '' }))!.source).toBe('snapshot');
    });
});
