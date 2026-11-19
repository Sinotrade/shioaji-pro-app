import { beforeEach, describe, expect, it } from 'vitest';
import { getUsTickMeta, subscribeUsSessionTicks, normalizeUsBidAsk, normalizeUsTick, nyDateTime, recordUsTick, resetUsQuotesForTest, usSubscriptionBody, usTickChange, usChangeFrom, usReferenceFor, contractReferenceApplies, noteUsReference } from './us-quotes';

// 2026-11-17 14:30:05 America/New_York（EST, UTC-5）
const T = Date.UTC(2026, 10, 17, 19, 30, 5) * 1000;

beforeEach(resetUsQuotesForTest);

describe('US quote adapter', () => {
    it('maps a us_tick to the shared tick shape keyed US:CODE', () => {
        const r = normalizeUsTick({ exchange: 'NASDAQ', code: 'aapl', datetime: T, price: '231.4500', volume: 100, total_volume: 5000, session: 'Regular', freshness: { status: 'Realtime' } });
        expect(r?.tick).toMatchObject({ code: 'US:AAPL', close: '231.4500', volume: 100, total_volume: 5000, date: '2026-11-17', time: '14:30:05', simtrade: false, intraday_odd: false });
        expect(r?.meta).toMatchObject({ key: 'US:AAPL', price: '231.4500', session: 'Regular', freshness: 'Realtime' });
    });
    it('computes the extended-hours change from the known reference, not the tick close', () => {
        // 2026-11-19 美東盤前 us_tick（ed7f77df sidecar）：close 是最後一筆 updates_last 成交，不是官方收盤
        const raw = { exchange: 'NYSE', code: 'IBM', datetime: 1795092699431770, price: '229.08', volume: 2, close: '228.54', open: null, high: null, low: null, total_volume: 15663, tick_type: 0, chg_type: 0, price_chg: '0', pct_chg: '0', odd_lot: false, session: 'PreMarket' as const };
        // 還不知道參考價：不給漲跌
        let r = normalizeUsTick(raw)!;
        expect(r.tick.close).toBe('229.08');
        expect(r.tick.price_chg).toBeUndefined();
        expect([r.tick.open, r.tick.high, r.tick.low]).toEqual(['', '', '']);
        // 快照記下 11-19 的 reference 228.53 → 漲跌＝229.08 − 228.53
        noteUsReference('US:IBM', '2026-11-19', 228.53);
        r = normalizeUsTick(raw)!;
        expect(r.tick.price_chg).toBe('0.55');
        expect(r.tick.pct_chg).toBe('0.24');
        // 別天的參考價不適用
        expect(usTickChange({ ...raw, session: 'AfterHours' }, '229', null)).toEqual({});
    });
    it('keeps the SDK change during the regular session', () => {
        expect(usTickChange({ price_chg: '1.2', pct_chg: '0.34', session: 'Regular' }, '353.65', '999')).toEqual({ priceChg: '1.2', pctChg: '0.34' });
    });
    it('picks the reference for a trade date: same-day snapshot, then an applicable contract reference', () => {
        const contract = { us_reference: '228.53', reference_date: '2026-11-18' };
        expect(usReferenceFor('2026-11-19', { tradeDate: '2026-11-19', reference: 228.6 }, contract)).toEqual({ price: '228.6', date: null });
        expect(usReferenceFor('2026-11-19', { tradeDate: '2026-11-18', reference: 228.1 }, contract)).toEqual({ price: '228.53', date: '2026-11-18' });
        expect(usReferenceFor('2026-11-18', null, contract)).toEqual({ price: null, date: null });
        expect(contractReferenceApplies('2026-11-13', '2026-11-16')).toBe(true); // 週五 → 週一
        expect(contractReferenceApplies('2026-11-10', '2026-11-19')).toBe(false);
        expect(usChangeFrom('229.08', '228.53')).toEqual({ priceChg: '0.55', pctChg: '0.24' });
        expect(usChangeFrom('229.08', null)).toEqual({});
    });
    it('drops ticks without a price', () => {
        expect(normalizeUsTick({ exchange: 'NASDAQ', code: 'AAPL', datetime: T, price: null, volume: 0 })).toBeNull();
    });
    it('keeps only the best bid/ask level', () => {
        const b = normalizeUsBidAsk({ exchange: 'NYSE', code: 'T', datetime: T, bid_price: ['25.01', '25'], bid_volume: [300, 100], ask_price: ['25.02'], ask_volume: [200] });
        expect(b).toMatchObject({ code: 'US:T', bid_price: ['25.01'], bid_volume: [300], ask_price: ['25.02'], ask_volume: [200] });
    });
    it('builds the flat subscribe body with the real exchange', () => {
        expect(usSubscriptionBody({ code: 'aapl', exchange: 'NASDAQ' }, 'Tick')).toEqual({ security_type: 'STK', exchange: 'NASDAQ', code: 'AAPL', quote_type: 'Tick' });
    });
    it('notifies listeners per trade with that trade as the latest meta', () => {
        const meta = (session: 'PreMarket' | 'Regular', s: number) => ({ key: 'US:AAPL', price: String(s), session, freshness: null, ts: T / 1000 + s * 1000, volume: 1 });
        const seen: string[] = [];
        const off = subscribeUsSessionTicks('US:AAPL', () => seen.push(getUsTickMeta('US:AAPL')!.price));
        recordUsTick(meta('PreMarket', 0));
        recordUsTick(meta('Regular', 2));
        off();
        recordUsTick(meta('Regular', 3));
        expect(seen).toEqual(['0', '2']);
        expect(getUsTickMeta('US:AAPL')?.price).toBe('3');
    });
    it('formats New York local time', () => {
        expect(nyDateTime(T)).toEqual({ date: '2026-11-17', time: '14:30:05' });
    });
});
