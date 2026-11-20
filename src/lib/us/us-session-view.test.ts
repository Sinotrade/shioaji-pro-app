// 美股一般盤主行／盤前盤後副行（自選清單、報價板共用）
import { describe, expect, it } from 'vitest';
import type { SseTick, UsTickSessionFields } from '../types/market';
import { parseUsSnapshotRow, type UsSnapshot } from './us-history';
import { normalizeUsTick, type RawUsTick } from './us-quotes';
import { msToNextUsBoundary, usMarketPhase, usSessionView } from './us-session-view';

// 2026-11-19（四）美東是 EST（UTC−5）
const et = (day: number, h: number, m = 0) => Date.UTC(2026, 10, day, h + 5, m);
const at = (day: number, h: number, m = 0) => usMarketPhase(et(day, h, m));

const tick = (date: string, us: Partial<UsTickSessionFields>, over: Partial<SseTick> = {}): SseTick => ({
    code: 'US:AAPL', date, time: '12:00:00', open: '350', high: '355', low: '345', close: us.regular ?? '0', volume: 1, total_volume: 1, tick_type: 0,
    us: { session: 'Regular', regular: '', regularChg: '', regularPct: '', extClose: '', extHigh: '', extLow: '', ...us },
    ...over,
});

const snap = (over: Partial<UsSnapshot> = {}): UsSnapshot => ({
    code: 'AAPL', exchange: 'NASDAQ', ts: null, tradeDate: '2026-11-19', open: 350, high: 355, low: 345, close: 352, reference: 349,
    changePrice: 3, changeRate: 0.86, totalVolume: 1, buyPrice: null, sellPrice: null, buyVolume: null, sellVolume: null,
    session: 'Regular', lastPrice: 352, extClose: null, extHigh: null, extLow: null, ...over,
});

describe('usMarketPhase', () => {
    it('splits the New York day at 04:00, 09:30, 16:00 and 20:00; weekends are closed', () => {
        expect(at(19, 3, 59).phase).toBe('closed');
        expect(at(19, 4)).toEqual({ phase: 'pre', date: '2026-11-19' });
        expect(at(19, 9, 29).phase).toBe('pre');
        expect(at(19, 9, 30).phase).toBe('regular');
        expect(at(19, 16).phase).toBe('post');
        expect(at(19, 19, 59).phase).toBe('post');
        expect(at(19, 20).phase).toBe('closed');
        expect(at(21, 12)).toEqual({ phase: 'closed', date: '2026-11-21' }); // 週六
    });
    it('schedules the next check at the next boundary, at most 30 minutes ahead', () => {
        expect(msToNextUsBoundary(et(19, 9, 25))).toBe(5 * 60_000 + 250);
        expect(msToNextUsBoundary(et(19, 12))).toBe(30 * 60_000);
    });
});

describe('normalizeUsTick session fields', () => {
    // 2026-11-20 sim sidecar 的一般盤零股成交：price 是這筆，close 是一般盤價
    const raw = { exchange: 'NASDAQ', code: 'NVDA', datetime: 1795194455317050, price: '135.63', volume: 2, close: '135.62', open: '143.57', high: '143.725', low: '135.06', price_chg: '-10.36', pct_chg: '-7.1', odd_lot: true, updates_last: false, session: 'Regular', ext_close: null, ext_high: null, ext_low: null } as RawUsTick;
    it('keeps close as the trade price for charts and adds the regular / extended state', () => {
        const t = normalizeUsTick(raw)!.tick;
        expect(t.close).toBe('135.63');
        expect(t.us).toEqual({ session: 'Regular', regular: '135.62', regularChg: '-10.36', regularPct: '-7.1', extClose: '', extHigh: '', extLow: '', updatesLast: false });
    });
    it('reads ext_* during the extended session', () => {
        const t = normalizeUsTick({ ...raw, session: 'AfterHours', ext_close: '136.10', ext_high: '136.5', ext_low: '135.9' })!.tick;
        expect(t.us).toMatchObject({ session: 'AfterHours', extClose: '136.10', extHigh: '136.5', extLow: '135.9' });
    });
});

describe('usSessionView', () => {
    it('pre-market: main is the previous close from the snapshot, secondary is the ext price vs the reference', () => {
        // 2026-11-19 美東盤前的真實快照（close＝reference＝前一日收盤）
        const row = parseUsSnapshotRow({ region: 'US', ts: 1795092423642980000, trade_date: '2026-11-19', code: 'AAPL', exchange: 'NASDAQ', open: 0.0, high: 0.0, low: 0.0, close: 352.45, reference: 352.45, change_price: 0.0, change_rate: 0.0, session: 'PreMarket', last_price: 354.06, ext_close: 353.98, ext_high: 356.0, ext_low: 353.58 })!;
        const t = tick('2026-11-19', { session: 'PreMarket', regular: '', extClose: '354.12', extHigh: '356', extLow: '353.58' }, { open: '', close: '354.13' });
        const v = usSessionView({ tick: t, snap: row, reference: '352.45', now: at(19, 7) });
        expect(v.main).toEqual({ price: 352.45, chg: 0, pct: 0 });
        expect(v.ext).toMatchObject({ session: 'PreMarket', label: '盤前', price: 354.12, base: 352.45, high: 356, low: 353.58, closed: false });
        expect(v.ext!.chg).toBeCloseTo(1.67, 6);
        expect(v.ext!.pct).toBeCloseTo((1.67 / 352.45) * 100, 6);
    });

    it('regular: no secondary line; odd-lot and ext trades do not move the main price', () => {
        // 這筆是零股成交（close＝135.63），一般盤價仍是 135.62
        const t = tick('2026-11-19', { regular: '135.62', regularChg: '-10.36', regularPct: '-7.1' }, { close: '135.63', open: '143.57' });
        const v = usSessionView({ tick: t, snap: snap({ extClose: 140 }), reference: '145.98', now: at(19, 12) });
        expect(v.main!.price).toBe(135.62);
        expect(v.main!.chg).toBeCloseTo(-10.36, 6);
        expect(v.ext).toBeNull();
    });

    it('closing-auction print (session AfterHours, updates_last) counts as regular', () => {
        const t = tick('2026-11-19', { session: 'AfterHours', regular: '353.10', updatesLast: true, extClose: '' }, { close: '353.10', time: '16:00:01' });
        const v = usSessionView({ tick: t, snap: null, reference: '349', now: at(19, 16) });
        expect(v.main!.price).toBe(353.1);
        expect(v.main!.chg).toBeCloseTo(4.1, 6);
        expect(v.ext).toBeNull();
    });

    it('post-market: ext price vs today\'s regular close', () => {
        const t = tick('2026-11-19', { session: 'AfterHours', regular: '353.10', extClose: '354.00', extHigh: '354.5', extLow: '352.9' }, { close: '354.00' });
        const v = usSessionView({ tick: t, snap: null, reference: '349', now: at(19, 17) });
        expect(v.main!.price).toBe(353.1);
        expect(v.ext).toMatchObject({ label: '盤後', price: 354, base: 353.1, closed: false });
        expect(v.ext!.chg).toBeCloseTo(0.9, 6);
        expect(v.ext!.pct).toBeCloseTo((0.9 / 353.1) * 100, 6);
    });

    it('a pre-market value is not shown in the post-market', () => {
        const t = tick('2026-11-19', { session: 'PreMarket', regular: '353.10', extClose: '351' });
        expect(usSessionView({ tick: t, snap: null, reference: '349', now: at(19, 17) }).ext).toBeNull();
    });

    it('after the post-market ends the last value stays, greyed, through the night and the weekend', () => {
        const t = tick('2026-11-19', { session: 'AfterHours', regular: '353.10', extClose: '354.00' });
        expect(usSessionView({ tick: t, snap: null, reference: '349', now: at(19, 21) }).ext).toMatchObject({ price: 354, closed: true });
        expect(usSessionView({ tick: t, snap: null, reference: '349', now: at(20, 2) }).ext).toMatchObject({ price: 354, closed: true });
        const fri = tick('2026-11-20', { session: 'AfterHours', regular: '353.10', extClose: '354.00' });
        expect(usSessionView({ tick: fri, snap: null, reference: '349', now: at(22, 12) }).ext).toMatchObject({ closed: true });
    });

    it('rollover at 04:00 clears yesterday\'s post-market value', () => {
        const t = tick('2026-11-19', { session: 'AfterHours', regular: '353.10', extClose: '354.00' });
        const v = usSessionView({ tick: t, snap: null, reference: '349', now: at(20, 4, 1) });
        expect(v.ext).toBeNull();
        expect(v.main!.price).toBe(353.1); // 主行留前一日收盤
    });

    it('a newer snapshot (new trade date) wins over yesterday\'s live tick for the main line', () => {
        const t = tick('2026-11-19', { session: 'AfterHours', regular: '353.10', extClose: '354.00' });
        const s = snap({ tradeDate: '2026-11-20', close: 353.1, reference: 353.1, changePrice: 0, changeRate: 0, session: 'PreMarket', lastPrice: 355, extClose: 355 });
        const v = usSessionView({ tick: t, snap: s, reference: '353.1', now: at(20, 5) });
        expect(v.main).toEqual({ price: 353.1, chg: 0, pct: 0 });
        expect(v.ext).toMatchObject({ label: '盤前', price: 355, base: 353.1 });
    });

    it('snapshot-only fallback: post-market ext_close vs the snapshot close; last_price only when the session is explicit', () => {
        const post = snap({ session: 'AfterHours', close: 352, lastPrice: 353, extClose: null });
        expect(usSessionView({ snap: post, reference: '349', now: at(19, 18) }).ext).toMatchObject({ price: 353, base: 352 });
        // 20:00 後 session 不再標盤後，但有 ext_close：仍是那天的盤後
        const late = snap({ session: 'Unknown', close: 352, lastPrice: 352, extClose: 351.5 });
        expect(usSessionView({ snap: late, reference: '349', now: at(19, 22) }).ext).toMatchObject({ label: '盤後', price: 351.5, closed: true });
        // 一般盤快照：沒有副行，主行是快照值
        const reg = usSessionView({ snap: snap(), reference: '349', now: at(19, 12) });
        expect(reg).toEqual({ main: { price: 352, chg: 3, pct: 0.86 }, ext: null });
    });

    it('missing reference: pre-market base falls back to the previous close; without any price there is no change', () => {
        const s = snap({ reference: null, close: 100, changePrice: 0, changeRate: 0, session: 'PreMarket', extClose: 110 });
        const v = usSessionView({ snap: s, reference: null, now: at(19, 8) });
        expect(v.ext).toMatchObject({ price: 110, base: 100, chg: 10, pct: 10 });
        const bare = tick('2026-11-19', { session: 'PreMarket', regular: '', extClose: '110' }, { open: '' });
        const none = usSessionView({ tick: bare, snap: null, reference: null, now: at(19, 8) });
        expect(none.main).toBeNull();
        expect(none.ext).toMatchObject({ price: 110, base: null, chg: undefined, pct: undefined });
    });

    it('legacy tick without session fields: close is the regular price', () => {
        const v = usSessionView({ tick: { date: '2026-11-19', close: '25.3', open: '', price_chg: '1.2', pct_chg: '4.98' }, snap: null, reference: null, now: at(19, 12) });
        expect(v).toEqual({ main: { price: 25.3, chg: 1.2, pct: 4.98 }, ext: null });
    });
});
