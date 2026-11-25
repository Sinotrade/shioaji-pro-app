import { beforeEach, describe, expect, it } from 'vitest';
import { US_EXTENDED_MAX_SYMBOLS, getUsExtendedBars, isUsExtendedTrade, usMinuteLabel, getUsTickMeta, subscribeUsSessionTicks, normalizeUsBidAsk, normalizeUsTick, nyDateTime, recordUsTick, resetUsQuotesForTest, usSubscriptionBody, usTickChange, usChangeFrom, usReferenceFor, contractReferenceApplies, noteUsReference } from './us-quotes';

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

describe('US extended-hours bars (live only)', () => {
    const D = Date.UTC(2026, 10, 19) / 1000;
    const hm = (h: number, m: number, s = 0) => D + h * 3600 + m * 60 + s;
    const tick = (isoUtc: string, price: string, volume: number, session: 'PreMarket' | 'Regular' | 'AfterHours') => {
        const ms = Date.parse(`${isoUtc}Z`);
        recordUsTick({ key: 'US:AAPL', price, session, freshness: null, ts: ms, tsUs: ms * 1000, volume });
    };
    beforeEach(() => resetUsQuotesForTest());

    it('labels: regular keeps 09:31/16:00 clamps, extended covers 04:01–20:00', () => {
        expect(usMinuteLabel(hm(9, 30))).toBe(hm(9, 31));
        expect(usMinuteLabel(hm(16, 2))).toBe(hm(16, 0)); // 一般盤：收盤寬限內歸 16:00
        expect(usMinuteLabel(hm(16, 0, 1.4), true)).toBe(hm(16, 0)); // 收盤競價
        expect(usMinuteLabel(hm(16, 0, 20), true)).toBe(hm(16, 1));
        expect(usMinuteLabel(hm(4, 0), true)).toBe(hm(4, 1));
        expect(usMinuteLabel(hm(9, 29, 59.5), true)).toBe(hm(9, 30));
        expect(usMinuteLabel(hm(20, 1), true)).toBe(hm(20, 0));
        expect(isUsExtendedTrade('AfterHours', hm(16, 0, 1))).toBe(false); // 收盤競價屬一般盤
        expect(isUsExtendedTrade('AfterHours', hm(16, 30))).toBe(true);
        expect(isUsExtendedTrade('PreMarket', hm(3, 59))).toBe(false);
    });

    it('keeps pre-market and after-hours trades as 1-minute bars, never regular trades or the closing cross', () => {
        tick('2026-11-19T13:00:10', '100', 5, 'PreMarket'); // 08:00:10 → 08:01
        tick('2026-11-19T13:00:40', '102', 3, 'PreMarket');
        tick('2026-11-19T15:00:00', '110', 9, 'Regular');
        tick('2026-11-19T21:00:01', '111', 1_000, 'AfterHours'); // 收盤競價
        tick('2026-11-19T21:30:10', '105', 4, 'AfterHours'); // 16:31
        expect(getUsExtendedBars('US:AAPL')).toEqual([
            { time: hm(8, 1), open: 100, high: 102, low: 100, close: 102, volume: 8 },
            { time: hm(16, 31), open: 105, high: 105, low: 105, close: 105, volume: 4 },
        ]);
    });

    it('keeps the last 5 NY dates that had trades, so a weekend does not eat into them', () => {
        // 11/12（四）、11/13（五）、週末、11/16–11/19（一～四）：6 個有成交的日期
        const days = ['2026-11-12', '2026-11-13', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'];
        for (const d of days) tick(`${d}T13:00:30`, '100', 1, 'PreMarket'); // 盤前 08:01
        const kept = getUsExtendedBars('US:AAPL').map((b) => new Date(b.time * 1000).toISOString().slice(0, 10));
        expect(kept).toEqual(days.slice(1)); // 只丟最舊的 11/12，11/13（五）還在
    });

    it('caps the cache across symbols, evicting the one least recently updated', () => {
        const rec = (code: string) => {
            const ms = Date.parse('2026-11-19T13:00:30Z');
            recordUsTick({ key: `US:${code}`, price: '10', session: 'PreMarket', freshness: null, ts: ms, tsUs: ms * 1000, volume: 1 });
        };
        for (let i = 0; i < US_EXTENDED_MAX_SYMBOLS; i++) rec(`S${i}`);
        rec('S0'); // S0 又有成交 → 變成最新
        rec('NEW'); // 超過上限 → 丟最久沒更新的 S1
        expect(getUsExtendedBars('US:S1')).toEqual([]);
        expect(getUsExtendedBars('US:S0')).toHaveLength(1);
        expect(getUsExtendedBars('US:S2')).toHaveLength(1);
        expect(getUsExtendedBars('US:NEW')).toHaveLength(1);
    });
});

describe('extended-hours memory bars follow the TICL price definition', () => {
    beforeEach(() => resetUsQuotesForTest());
    it('odd lots only add volume', () => {
        const ms = (h: number, m: number, sec = 0) => Date.UTC(2026, 10, 18, h + 5, m, sec);
        const rec = (h: number, m: number, price: string, volume: number, oddLot: boolean) =>
            recordUsTick({ key: 'US:AAPL', price, session: 'PreMarket', freshness: null, ts: ms(h, m, 10), tsUs: ms(h, m, 10) * 1000, volume, updatesLast: false, oddLot });
        rec(4, 0, '10', 100, true); // 還沒有整股成交：零股不開 K 棒
        expect(getUsExtendedBars('US:AAPL')).toEqual([]);
        rec(4, 0, '10', 100, false);
        rec(4, 0, '12', 3, true);
        rec(4, 1, '9', 2, true);
        const bars = getUsExtendedBars('US:AAPL');
        expect(bars.map(b => [b.open, b.high, b.low, b.close, b.volume])).toEqual([[10, 10, 10, 10, 103], [10, 10, 10, 10, 2]]);
        // 零股開的那一分：第一筆整股成交到了，開高低收改從它開始
        rec(4, 1, '11', 5, false);
        rec(4, 1, '10.5', 1, false);
        expect(getUsExtendedBars('US:AAPL').at(-1)).toMatchObject({ open: 11, high: 11, low: 10.5, close: 10.5, volume: 8 });
    });
});
