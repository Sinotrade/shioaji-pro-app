// 美股一般盤主行／盤前盤後副行（自選清單、報價板共用）
import { describe, expect, it } from 'vitest';
import type { SseTick, UsTickSessionFields } from '../types/market';
import { parseUsSnapshotRow, type UsSnapshot } from './us-history';
import { nextUsWeekday, normalizeUsTick, noteUsReference, resetUsQuotesForTest, usSessionOf, usTradeDateOf, type RawUsTick } from './us-quotes';
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
    it('splits the New York day at 04:00, 09:30, 16:00 and 20:00; trading day D = [D-1 20:00, D 20:00)', () => {
        expect(at(19, 3, 59)).toEqual({ phase: 'overnight', date: '2026-11-19', lastPost: '2026-11-18' });
        expect(at(19, 4)).toEqual({ phase: 'pre', date: '2026-11-19', lastPost: '2026-11-18' });
        expect(at(19, 9, 29).phase).toBe('pre');
        expect(at(19, 9, 30).phase).toBe('regular');
        expect(at(19, 16)).toEqual({ phase: 'post', date: '2026-11-19', lastPost: '2026-11-19' });
        expect(at(19, 19, 59).phase).toBe('post');
        // 週四 20:00：夜盤，交易日是週五
        expect(at(19, 20)).toEqual({ phase: 'overnight', date: '2026-11-20', lastPost: '2026-11-19' });
        // 週五 20:00 到週日 20:00：收盤，交易日是下週一，保留週五盤後
        expect(at(20, 20)).toEqual({ phase: 'closed', date: '2026-11-23', lastPost: '2026-11-20' });
        expect(at(21, 12)).toEqual({ phase: 'closed', date: '2026-11-23', lastPost: '2026-11-20' }); // 週六
        expect(at(22, 19, 59).phase).toBe('closed');
        // 週日 20:00：夜盤開始，交易日週一
        expect(at(22, 20)).toEqual({ phase: 'overnight', date: '2026-11-23', lastPost: '2026-11-20' });
        expect(at(23, 2)).toEqual({ phase: 'overnight', date: '2026-11-23', lastPost: '2026-11-20' });
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
        expect(t.us).toEqual({ session: 'Regular', tradeDate: '2026-11-20', ts: 1795194455317, regular: '135.62', regularChg: '-10.36', regularPct: '-7.1', extClose: '', extHigh: '', extLow: '', updatesLast: false });
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
        // 即時 tick 比快照新（ts 較晚）：取即時的延長時段價
        const t = tick('2026-11-19', { session: 'PreMarket', regular: '', extClose: '354.12', extHigh: '356', extLow: '353.58', ts: 1795092500000 }, { open: '', close: '354.13' });
        const v = usSessionView({ tick: t, snap: row, reference: '352.45', now: at(19, 7) });
        // 漲跌 0 沒有意義：標昨收，不給 0.00 0.00%
        expect(v.main).toEqual({ price: 352.45, chg: undefined, pct: undefined, prevClose: true });
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

    it('snapshot-only fallback: post-market ext_close vs the snapshot close; last_price alone never makes a secondary line', () => {
        const post = snap({ session: 'AfterHours', close: 352, lastPrice: 352.5, extClose: 353 });
        expect(usSessionView({ snap: post, reference: '349', now: at(19, 18) }).ext).toMatchObject({ price: 353, base: 352 });
        // 盤後還沒有整股成交：last_price 可能是收盤競價或零股，不算延長時段價
        const noExt = snap({ session: 'AfterHours', close: 102, lastPrice: 102, extClose: null });
        expect(usSessionView({ snap: noExt, reference: '100', now: at(19, 17) }).ext).toBeNull();
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

    it('prevClose: a snapshot with no regular open today, or a not-yet-open tick; a real change is kept', () => {
        // 一般盤時段、今天還沒有整股成交的商品：快照 open 0、漲跌 0
        const idle = usSessionView({ snap: snap({ open: 0, changePrice: 0, changeRate: 0 }), reference: '352', now: at(19, 12) });
        expect(idle.main).toMatchObject({ price: 352, prevClose: true, chg: undefined });
        // 快照沒有，只有盤前 tick 帶的一般盤值（open 空）
        const t = tick('2026-11-19', { session: 'PreMarket', regular: '352', extClose: '353' }, { open: '' });
        expect(usSessionView({ tick: t, snap: null, reference: '352', now: at(19, 7) }).main).toMatchObject({ price: 352, prevClose: true });
        // 前一日快照仍帶真實漲跌（例如 04:00 前打開）：照常顯示
        const y = usSessionView({ snap: snap({ open: 0, changePrice: 1.5, changeRate: 0.43 }), reference: null, now: at(19, 7) });
        expect(y.main).toEqual({ price: 352, chg: 1.5, pct: 0.43 });
        // 今天已開盤：不是昨收
        expect(usSessionView({ snap: snap(), reference: '349', now: at(19, 12) }).main!.prevClose).toBeUndefined();
    });

    it('legacy tick without session fields: close is the regular price', () => {
        const v = usSessionView({ tick: { date: '2026-11-19', close: '25.3', open: '', price_chg: '1.2', pct_chg: '4.98' }, snap: null, reference: null, now: at(19, 12) });
        expect(v).toEqual({ main: { price: 25.3, chg: 1.2, pct: 4.98 }, ext: null });
    });
});

describe('overnight (Nasdaq 23x5, session 4) and trading-day rollover', () => {
    it('parses session 4 / Overnight; unknown values are Unknown, never Regular', () => {
        expect(usSessionOf(4)).toBe('Overnight');
        expect(usSessionOf('4')).toBe('Overnight');
        expect(usSessionOf('Overnight')).toBe('Overnight');
        expect(usSessionOf(2)).toBe('Regular');
        expect(usSessionOf(7)).toBe('Unknown');
        expect(usSessionOf('Closed')).toBe('Unknown');
        expect(usSessionOf({})).toBe('Unknown');
        expect(usSessionOf(null)).toBeNull();
        expect(parseUsSnapshotRow({ region: 'US', code: 'AAPL', close: 1, session: 4 })!.session).toBe('Overnight');
        expect(parseUsSnapshotRow({ region: 'US', code: 'AAPL', close: 1, session: 9 })!.session).toBe('Unknown');
    });

    it('an overnight print after 20:00 belongs to the next trading day (Sunday night → Monday)', () => {
        expect(nextUsWeekday('2026-12-06', 1)).toBe('2026-12-07');
        expect(nextUsWeekday('2026-12-04', 1)).toBe('2026-12-07');
        expect(nextUsWeekday('2026-12-05', 0)).toBe('2026-12-07');
        // 2026-12-06（日）21:00 ET＝12-07 02:00Z
        const us = Date.UTC(2026, 11, 7, 2, 0) * 1000;
        expect(usTradeDateOf(us, 'Overnight')).toBe('2026-12-07');
        expect(usTradeDateOf(us, 'AfterHours')).toBe('2026-12-06'); // 20:00 後的盤後寬限成交不換日
        const raw = { exchange: 'NASDAQ', code: 'AAPL', datetime: us, price: '230.5', volume: 100, close: '229', open: null, price_chg: '0', pct_chg: '0', updates_last: false, session: 4, ext_close: '230.5', ext_high: '231', ext_low: '230' } as unknown as RawUsTick;
        const t = normalizeUsTick(raw)!.tick;
        expect(t.close).toBe('230.5'); // 圖表照樣拿到這筆
        expect(t.date).toBe('2026-12-06'); // 圖表時間軸仍是美東日期
        expect(t.us).toMatchObject({ session: 'Overnight', tradeDate: '2026-12-07', extClose: '230.5' });
        // 漲跌用新交易日（12-07）的參考價，不是 12-06 的
        resetUsQuotesForTest();
        noteUsReference('US:AAPL', '2026-12-06', '200');
        noteUsReference('US:AAPL', '2026-12-07', '229');
        expect(normalizeUsTick(raw)!.tick.price_chg).toBe('1.5');
        resetUsQuotesForTest();
    });

    it('an overnight print at 21:00 shows live (not greyed) vs the new day reference, replacing the greyed post-market', () => {
        // 週四 21:00：tick 是夜盤（交易日週五），快照還停在週四盤後
        const night = tick('2026-11-19', { session: 'Overnight', tradeDate: '2026-11-20', regular: '353.10', extClose: '354.50', ts: et(19, 21) }, { open: '', time: '21:00:05' });
        const post = snap({ session: 'AfterHours', close: 353.1, extClose: 354, ts: et(19, 19, 59) });
        const v = usSessionView({ tick: night, snap: post, reference: '353.1', now: at(19, 21) });
        expect(v.ext).toMatchObject({ session: 'Overnight', label: '夜盤', price: 354.5, base: 353.1, closed: false, date: '2026-11-20', time: '21:00:05' });
        expect(v.ext!.chg).toBeCloseTo(1.4, 6);
        // 主行：tick 已是週五（新交易日），快照還是週四 → 用 tick 的一般盤值（週四收盤），標昨收
        expect(v.main).toMatchObject({ price: 353.1, prevClose: true });
    });

    it('before overnight data exists the post-market stays greyed through the night and clears at 04:00', () => {
        const t = tick('2026-11-19', { session: 'AfterHours', regular: '353.10', extClose: '354.00', ts: et(19, 19) });
        expect(usSessionView({ tick: t, snap: null, reference: '349', now: at(19, 21) }).ext).toMatchObject({ session: 'AfterHours', closed: true });
        expect(usSessionView({ tick: t, snap: null, reference: '349', now: at(20, 3) }).ext).toMatchObject({ closed: true });
        expect(usSessionView({ tick: t, snap: null, reference: '349', now: at(20, 4) }).ext).toBeNull();
    });

    it('yesterday\'s post-market does not reappear the next evening (no post trades that day)', () => {
        const t = tick('2026-11-18', { session: 'AfterHours', regular: '353.10', extClose: '354.00' });
        expect(usSessionView({ tick: t, snap: null, reference: '349', now: at(19, 21) }).ext).toBeNull();
    });

    it('Friday post-market stays greyed over the weekend until Sunday-night overnight trades arrive', () => {
        const fri = tick('2026-11-20', { session: 'AfterHours', regular: '353.10', extClose: '354.00', ts: et(20, 19) });
        expect(usSessionView({ tick: fri, snap: null, reference: '349', now: at(21, 12) }).ext).toMatchObject({ closed: true });
        expect(usSessionView({ tick: fri, snap: null, reference: '349', now: at(22, 20, 30) }).ext).toMatchObject({ session: 'AfterHours', closed: true });
        const sun = tick('2026-11-22', { session: 'Overnight', tradeDate: '2026-11-23', regular: '353.10', extClose: '355', ts: et(22, 20, 31) }, { open: '' });
        expect(usSessionView({ tick: sun, snap: null, reference: '353.1', now: at(22, 20, 31) }).ext).toMatchObject({ session: 'Overnight', closed: false, price: 355 });
    });

    it('the overnight value carries into pre-market until a pre-market trade arrives', () => {
        const night = snap({ tradeDate: '2026-11-20', session: 'Overnight', open: 0, close: 353.1, reference: 353.1, changePrice: 0, changeRate: 0, extClose: 354.5, ts: et(20, 3, 59) });
        const atFour = usSessionView({ snap: night, reference: '353.1', now: at(20, 4, 1) });
        expect(atFour.ext).toMatchObject({ session: 'Overnight', closed: false });
        expect(atFour.main).toMatchObject({ price: 353.1, prevClose: true });
        const pre = tick('2026-11-20', { session: 'PreMarket', regular: '353.10', extClose: '355.2', ts: et(20, 4, 2) }, { open: '' });
        expect(usSessionView({ tick: pre, snap: night, reference: '353.1', now: at(20, 4, 2) }).ext).toMatchObject({ session: 'PreMarket', price: 355.2 });
    });

    it('a newer same-day session change clears an older value (overnight → pre-market reset with ext_close 0)', () => {
        const night = tick('2026-11-20', { session: 'Overnight', tradeDate: '2026-11-20', regular: '353.10', extClose: '354.5', ts: et(20, 3, 50) }, { open: '' });
        const preReset = snap({ tradeDate: '2026-11-20', session: 'PreMarket', open: 0, close: 353.1, reference: 353.1, changePrice: 0, changeRate: 0, extClose: null, ts: et(20, 4, 0, ) + 30_000 });
        expect(usSessionView({ tick: night, snap: preReset, reference: '353.1', now: at(20, 4, 1) }).ext).toBeNull();
        // 20:00 後 session 不明的快照不算換時段：盤後照樣轉灰保留
        const post = tick('2026-11-19', { session: 'AfterHours', regular: '353.10', extClose: '354', ts: et(19, 19, 50) });
        const unknown = snap({ session: 'Unknown', extClose: null, ts: et(19, 20, 30) });
        expect(usSessionView({ tick: post, snap: unknown, reference: '349', now: at(19, 20, 31) }).ext).toMatchObject({ closed: true });
    });

    it('a newer-day overnight tick beats yesterday\'s snapshot for the main line (no stale change)', () => {
        const old = snap({ tradeDate: '2026-11-19', close: 100, changePrice: 5, changeRate: 5.26, session: 'AfterHours', ts: et(19, 19) });
        const night = tick('2026-11-19', { session: 'Overnight', tradeDate: '2026-11-20', regular: '110', extClose: '112', ts: et(19, 21) }, { open: '' });
        const v = usSessionView({ tick: night, snap: old, reference: '110', now: at(19, 21) });
        expect(v.main).toMatchObject({ price: 110, prevClose: true });
        expect(v.ext).toMatchObject({ session: 'Overnight', price: 112, base: 110, chg: 2 });
    });

    it('a stale same-day tick does not override a newer snapshot (main and post-market base)', () => {
        // 斷線前最後一筆是 15:59 的一般盤；16:00 後重抓的快照有收盤競價後的收盤與盤後價
        const stale = tick('2026-11-19', { regular: '352.80', ts: et(19, 15, 59) }, { open: '350' });
        const fresh = snap({ close: 353.1, changePrice: 4.1, changeRate: 1.17, session: 'AfterHours', extClose: 353.6, ts: et(19, 18) });
        const v = usSessionView({ tick: stale, snap: fresh, reference: '349', now: at(19, 18, 1) });
        expect(v.main).toMatchObject({ price: 353.1, chg: 4.1 });
        expect(v.ext).toMatchObject({ price: 353.6, base: 353.1 });
    });
});
