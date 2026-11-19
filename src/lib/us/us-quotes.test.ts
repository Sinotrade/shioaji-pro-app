import { beforeEach, describe, expect, it } from 'vitest';
import { getUsRegularLine, getUsSessionTicks, normalizeUsBidAsk, normalizeUsTick, nyDateTime, recordUsTick, resetUsQuotesForTest, usSubscriptionBody, usTickChange, usTickReference } from './us-quotes';

// 2026-11-17 14:30:05 America/New_York（EST, UTC-5）
const T = Date.UTC(2026, 10, 17, 19, 30, 5) * 1000;

beforeEach(resetUsQuotesForTest);

describe('regular-session line', () => {
    const meta = (utcMs: number, price: string, session: 'Regular' | 'AfterHours' | 'PreMarket' = 'Regular') => ({ key: 'US:AAPL', price, session, freshness: null, ts: utcMs, volume: 1 });
    it('keeps the last trade per minute and survives the switch to after-hours', () => {
        const t = (h: number, mi: number, s: number) => Date.UTC(2026, 10, 18, h, mi, s);
        recordUsTick(meta(t(14, 31, 1), '10'));
        recordUsTick(meta(t(14, 31, 50), '11'));
        recordUsTick(meta(t(14, 32, 5), '12'));
        recordUsTick(meta(t(21, 0, 1), '13', 'AfterHours'));
        expect(getUsSessionTicks('US:AAPL').map(x => x.price)).toEqual(['13']); // 本時段清空
        expect(getUsRegularLine('US:AAPL').map(x => x.price)).toEqual(['11', '12']); // 一般盤保留
        recordUsTick(meta(Date.UTC(2026, 10, 19, 14, 31), '20'));
        expect(getUsRegularLine('US:AAPL').map(x => x.price)).toEqual(['20']); // 換日重來
    });
});

describe('US quote adapter', () => {
    it('maps a us_tick to the shared tick shape keyed US:CODE', () => {
        const r = normalizeUsTick({ exchange: 'NASDAQ', code: 'aapl', datetime: T, price: '231.4500', volume: 100, total_volume: 5000, session: 'Regular', freshness: { status: 'Realtime' } });
        expect(r?.tick).toMatchObject({ code: 'US:AAPL', close: '231.4500', volume: 100, total_volume: 5000, date: '2026-11-17', time: '14:30:05', simtrade: false, intraday_odd: false });
        expect(r?.meta).toMatchObject({ key: 'US:AAPL', price: '231.4500', session: 'Regular', freshness: 'Realtime' });
    });
    it('computes the pre-market change from the regular close, keeping the raw sub-penny price', () => {
        // 2026-11-19 美東盤前實際收到的 us_tick（ed7f77df sidecar）：SDK 的 price_chg／pct_chg 是一般盤漲跌 0
        const raw = { exchange: 'NASDAQ', code: 'AAPL', datetime: 1795092699431770, price: '354.1244', volume: 25, close: '352.45', open: null, high: null, low: null, total_volume: 255203, tick_type: 0, chg_type: 0, price_chg: '0', pct_chg: '0', odd_lot: true, session: 'PreMarket' as const };
        const r = normalizeUsTick(raw)!;
        expect(r.tick.close).toBe('354.1244');
        expect(r.tick.price_chg).toBe('1.6744');
        expect(r.tick.pct_chg).toBe('0.48');
        // 一般盤還沒開：開高低留空，不拿成交價補；參考＝漲跌基準（最近一般盤收盤價）
        expect([r.tick.open, r.tick.high, r.tick.low]).toEqual(['', '', '']);
        expect(usTickReference(r.tick)).toBe('352.45');
        // 盤後同樣以當日一般盤收盤價計算
        expect(usTickChange({ ...raw, session: 'AfterHours', close: '355' }, '354.5')).toEqual({ priceChg: '-0.5', pctChg: '-0.14' });
    });
    it('derives the reference from price minus change', () => {
        expect(usTickReference({ close: '353.65', price_chg: '1.2' })).toBe('352.45');
        expect(usTickReference({ close: '353.65', price_chg: undefined })).toBeNull();
        expect(usTickReference(undefined)).toBeNull();
    });
    it('keeps the SDK change during the regular session', () => {
        expect(usTickChange({ close: '352.45', price_chg: '1.2', pct_chg: '0.34', session: 'Regular' }, '353.65')).toEqual({ priceChg: '1.2', pctChg: '0.34' });
        expect(usTickChange({ close: null, price_chg: '0', pct_chg: '0', session: 'PreMarket' }, '1')).toEqual({ priceChg: '0', pctChg: '0' });
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
