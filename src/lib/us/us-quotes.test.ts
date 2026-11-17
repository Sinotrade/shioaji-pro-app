import { beforeEach, describe, expect, it } from 'vitest';
import { getUsSessionTicks, normalizeUsBidAsk, normalizeUsTick, nyDateTime, recordUsTick, resetUsQuotesForTest, usSubscriptionBody } from './us-quotes';

// 2026-11-17 14:30:05 America/New_York（EST, UTC-5）
const T = Date.UTC(2026, 10, 17, 19, 30, 5) * 1000;

beforeEach(resetUsQuotesForTest);

describe('US quote adapter', () => {
    it('maps a us_tick to the shared tick shape keyed US:CODE', () => {
        const r = normalizeUsTick({ exchange: 'NASDAQ', code: 'aapl', datetime: T, price: '231.4500', volume: 100, total_volume: 5000, session: 'Regular', freshness: { status: 'Realtime' } });
        expect(r?.tick).toMatchObject({ code: 'US:AAPL', close: '231.4500', volume: 100, total_volume: 5000, date: '2026-11-17', time: '14:30:05', simtrade: false, intraday_odd: false });
        expect(r?.meta).toMatchObject({ key: 'US:AAPL', price: '231.4500', session: 'Regular', freshness: 'Realtime' });
    });
    it('drops ticks without a price', () => {
        expect(normalizeUsTick({ exchange: 'NASDAQ', code: 'AAPL', datetime: T, price: null, volume: 0 })).toBeNull();
    });
    it('keeps only the best bid/ask level', () => {
        const b = normalizeUsBidAsk({ exchange: 'NYSE', code: 'T', datetime: T, bid_price: ['25.01', '25'], bid_volume: [300, 100], ask_price: ['25.02'], ask_volume: [200] });
        expect(b).toMatchObject({ code: 'US:T', bid_price: ['25.01'], bid_volume: [300], ask_price: ['25.02'], ask_volume: [200] });
    });
    it('builds the flat subscribe body with the real exchange', () => {
        expect(usSubscriptionBody({ code: 'aapl', exchange: 'NASDAQ' }, 'Tick')).toEqual({ security_type: 'STK', region: 'US', exchange: 'NASDAQ', code: 'AAPL', target_code: null, quote_type: 'Tick', intraday_odd: false });
    });
    it('keeps only the current session for the intraday line', () => {
        const meta = (session: 'PreMarket' | 'Regular', s: number) => ({ key: 'US:AAPL', price: '1', session, freshness: null, ts: T / 1000 + s * 1000, volume: 1 });
        recordUsTick(meta('PreMarket', 0));
        recordUsTick(meta('PreMarket', 1));
        recordUsTick(meta('Regular', 2));
        expect(getUsSessionTicks('US:AAPL')).toHaveLength(1);
    });
    it('formats New York local time', () => {
        expect(nyDateTime(T)).toEqual({ date: '2026-11-17', time: '14:30:05' });
    });
});
