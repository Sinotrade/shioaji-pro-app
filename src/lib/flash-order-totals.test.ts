import { afterEach, expect, it, vi } from 'vitest';
import { flashOrderTotals, flashTotalsSince, flashWorkingOrders, sameContractMonth } from './flash-order-totals';
import { tradingDayStart } from './futures-fifo';
import type { Trade } from './types/order';

// rows are timed in array order (the cover replay is chronological); a fill gets one
// deal detail at the order time unless the test gives its own details
const t = (action: 'Buy' | 'Sell', quantity: number, deal: number, cancel: number, status: string, extra: Record<string, unknown> = {}, st: Record<string, unknown> = {}) => {
    const ts = 'order_ts' in st ? st.order_ts : ++clock;
    const deals = deal > 0 && typeof ts === 'number' ? [{ seq: `d${clock}`, price: 100, quantity: deal, ts }] : [];
    return ({ contract: { code: '2317' }, order: { id: `o${Math.random()}`, action, price: 100, quantity, order_cond: 'Cash', ...extra },
        status: { status, order_ts: ts, deal_quantity: deal, cancel_quantity: cancel, deals, ...st } }) as unknown as Trade;
};
let clock = 1_000;
const all = () => true;
const none = () => undefined;
const T = (trades: Trade[], stock = true, since = 0) => flashOrderTotals(trades, all, stock, since, none);
const short = { daytrade_short: true };
const plain = { daytrade_short: false };

afterEach(() => { vi.unstubAllGlobals(); });

it('counts ordered net of cancels, filled and working per side (customer case 32(20) / 40(20))', () => {
    const r = T([
        t('Sell', 20, 20, 0, 'Filled', short), t('Sell', 20, 0, 0, 'Submitted', short),
        t('Buy', 12, 12, 0, 'Filled'), t('Buy', 8, 8, 0, 'Filled'), t('Buy', 12, 0, 0, 'Submitted'),
        t('Sell', 5, 0, 5, 'Cancelled', short), t('Sell', 3, 0, 0, 'Failed'),
    ]);
    expect(r.buy).toEqual({ ordered: 32, filled: 20, working: 12, cancelled: 0 });
    expect(r.sell).toEqual({ ordered: 40, filled: 20, working: 20, cancelled: 5 });
    expect(r.dayShort).toEqual({ sold: 20, covered: 20, open: 0, unknownSell: 0, unknownBuy: 0, untimedSell: 0, untimedBuy: 0 });
});

it('a partly filled then cancelled order counts only what filled; a part-filled one keeps its rest working', () => {
    const r = T([t('Buy', 10, 4, 6, 'Cancelled'), t('Sell', 10, 3, 2, 'PartFilled')], false);
    expect(r.buy).toEqual({ ordered: 4, filled: 4, working: 0, cancelled: 6 });
    expect(r.sell).toEqual({ ordered: 8, filled: 3, working: 5, cancelled: 2 });
});

it('only cash buys cover day-trade short sells; a known plain sell is not a short', () => {
    const r = T([
        t('Sell', 30, 30, 0, 'Filled', short), t('Sell', 5, 5, 0, 'Filled', plain),
        t('Buy', 20, 20, 0, 'Filled'), t('Buy', 5, 5, 0, 'Filled', { order_cond: 'MarginTrading' }),
    ]);
    expect(r.dayShort).toEqual({ sold: 30, covered: 20, open: 10, unknownSell: 0, unknownBuy: 0, untimedSell: 0, untimedBuy: 0 });
});

// PR #400 review P1: report-projected rows carry no order_cond / daytrade_short
it('never guesses Cash: a sell without the day-trade flag or any row without order_cond is unknown', () => {
    const r = T([
        t('Sell', 10, 10, 0, 'Filled', short),
        t('Sell', 4, 4, 0, 'Filled'), // Cash, flag unknown (not sent by this app)
        t('Sell', 2, 2, 0, 'Filled', { order_cond: undefined, daytrade_short: true }), // cond unknown
        t('Buy', 6, 6, 0, 'Filled', { order_cond: undefined }), // could be a margin buy
        t('Buy', 3, 3, 0, 'Filled'),
    ]);
    expect(r.dayShort).toEqual({ sold: 10, covered: 3, open: 7, unknownSell: 6, unknownBuy: 6, untimedSell: 0, untimedBuy: 0 });
});

// PR #400 review round 3 P1: replay fills in time order
it('replays fills in time order: only cash buys after a day-trade short sale cover it', () => {
    // 買 10 → 一般賣 10 → 當沖先賣 10：待回補 10（之前的買進不是回補）
    expect(T([t('Buy', 10, 10, 0, 'Filled'), t('Sell', 10, 10, 0, 'Filled', plain), t('Sell', 10, 10, 0, 'Filled', short)]).dayShort)
        .toEqual({ sold: 10, covered: 0, open: 10, unknownSell: 0, unknownBuy: 0, untimedSell: 0, untimedBuy: 0 });
    // 先賣 10 → 買 4 → 先賣 5 → 買 20：每次回補最多扣到 0，多買的不留給之後
    expect(T([t('Sell', 10, 10, 0, 'Filled', short), t('Buy', 4, 4, 0, 'Filled'), t('Sell', 5, 5, 0, 'Filled', short), t('Buy', 20, 20, 0, 'Filled'),
        t('Sell', 3, 3, 0, 'Filled', short)]).dayShort).toEqual({ sold: 18, covered: 15, open: 3, unknownSell: 0, unknownBuy: 0, untimedSell: 0, untimedBuy: 0 });
    // one order filled in pieces around a short sale: only the later piece covers
    const buy = t('Buy', 6, 6, 0, 'Filled', {}, { order_ts: 10, deals: [{ seq: 'a', price: 100, quantity: 2, ts: 11 }, { seq: 'b', price: 100, quantity: 4, ts: 30 }] });
    const sell = t('Sell', 5, 5, 0, 'Filled', short, { order_ts: 20, deals: [{ seq: 'c', price: 100, quantity: 5, ts: 20 }] });
    expect(T([buy, sell]).dayShort).toEqual({ sold: 5, covered: 4, open: 1, unknownSell: 0, unknownBuy: 0, untimedSell: 0, untimedBuy: 0 });
    // same second: not counted as a cover (better to show 待補 than a false 補齊)
    expect(T([t('Buy', 5, 5, 0, 'Filled', {}, { order_ts: 50 }), t('Sell', 5, 5, 0, 'Filled', short, { order_ts: 50 })]).dayShort?.open).toBe(5);
});

it('fills in order_cond / daytrade_short recorded when this app sent the order', () => {
    const sell = t('Sell', 8, 8, 0, 'Filled', { order_cond: undefined });
    const buy = t('Buy', 8, 8, 0, 'Filled', { order_cond: undefined });
    const conds = (x: Trade) => x === sell ? { cond: 'Cash', daytradeShort: true } : x === buy ? { cond: 'MarginTrading', daytradeShort: false } : undefined;
    expect(flashOrderTotals([sell, buy], all, true, 0, conds).dayShort).toEqual({ sold: 8, covered: 0, open: 8, unknownSell: 0, unknownBuy: 0, untimedSell: 0, untimedBuy: 0 });
});

it('an unknown buy alone (no short sale to cover) reports nothing', () => {
    expect(T([t('Buy', 6, 6, 0, 'Filled', { order_cond: undefined })]).dayShort).toBeNull();
});

it('futures (stock=false) never report a day-trade short', () => {
    expect(T([t('Sell', 2, 2, 0, 'Filled', short)], false).dayShort).toBeNull();
});

// PR #400 review P2: /order/trades also lists the previous session
it('counts only this trading day (same start as futures FIFO)', () => {
    const since = tradingDayStart(Date.UTC(2026, 10, 10, 2) / 1000); // 2026-11-10 10:00 Taipei
    const r = T([
        t('Buy', 5, 5, 0, 'Filled', {}, { order_ts: since - 3600 }), // yesterday
        t('Buy', 2, 2, 0, 'Filled', {}, { order_ts: since + 60 }),
        t('Buy', 4, 4, 0, 'Filled', {}, { order_ts: undefined, deals: [{ seq: 'a', price: 100, quantity: 4, ts: since - 10 }] }), // no order_ts, old deal
        t('Buy', 3, 1, 0, 'PartFilled', {}, { order_ts: undefined, deals: [{ seq: 'b', price: 100, quantity: 1, ts: since + 10 }] }),
        t('Buy', 1, 0, 0, 'Submitted', {}, { order_ts: undefined }), // no time at all, still working
    ], true, since);
    expect(r.buy).toEqual({ ordered: 6, filled: 3, working: 3, cancelled: 0 });
});

it('skips malformed quantities', () => {
    expect(T([t('Buy', Number.NaN, 0, 0, 'Submitted')]).buy.ordered).toBe(0);
});

// PR #400 review P3: continuous-month rows carry the real month in target_code
it('matches a contract month both ways through target_code and the stream alias', () => {
    const row = (code: string, target_code: string | null) => ({ contract: { code, target_code } }) as unknown as Trade;
    const mxfi6 = { code: 'MXFI6', target_code: null };
    const r1 = { code: 'MXFR1', target_code: 'MXFI6' };
    expect(sameContractMonth(row('MXFR1', 'MXFI6'), mxfi6)).toBe(true);
    expect(sameContractMonth(row('MXFI6', null), r1)).toBe(true);
    expect(sameContractMonth(row('MXFR1', 'MXFI6'), r1)).toBe(true);
    expect(sameContractMonth(row('MXFI6', null), { code: 'MXFR1', target_code: null }, c => (c === 'MXFI6' ? 'MXFR1' : undefined))).toBe(true);
    expect(sameContractMonth(row('MXFR1', 'MXFJ6'), mxfi6)).toBe(false);
    expect(sameContractMonth(row('MXFJ6', null), r1)).toBe(false);
    // round 3 P2: both sides know their real month → the alias code alone never matches
    expect(sameContractMonth(row('MXFR1', 'MXFI6'), { code: 'MXFR1', target_code: 'MXFJ6' })).toBe(false);
    expect(sameContractMonth(row('MXFR1', 'MXFJ6'), { code: 'MXFR1', target_code: 'MXFJ6' })).toBe(true);
    // only one side knows the real month → alias matching
    expect(sameContractMonth(row('MXFR1', null), r1)).toBe(true);
    expect(sameContractMonth(row('MXFR1', 'MXFI6'), { code: 'MXFR1', target_code: null })).toBe(true);
    expect(sameContractMonth(row('MXFI6', null), { code: 'MXFR1', target_code: null }, c => (c === 'MXFJ6' ? 'MXFR1' : undefined))).toBe(false);
});

it('the 顯示委託合計 setting survives saving: only an explicit false is kept (absent = on)', async () => {
    const { normalizeFlashOrderOpts } = await import('./flash-account');
    expect(normalizeFlashOrderOpts({ orderType: 'ROD', showTotals: false })?.showTotals).toBe(false);
    expect(normalizeFlashOrderOpts({ orderType: 'ROD', showTotals: true })).not.toHaveProperty('showTotals');
    expect(normalizeFlashOrderOpts({ orderType: 'ROD' })).not.toHaveProperty('showTotals');
});

// review round 2 P2: stocks use Taipei midnight, futures keep the 15:00 night-session start
it('trading-day start: stocks from Taipei midnight, futures from the previous 15:00', () => {
    const at1600 = Date.UTC(2026, 10, 10, 8); // Tue 16:00 Taipei
    expect(flashTotalsSince(true, at1600)).toBe(Date.UTC(2026, 10, 9, 16) / 1000); // Tue 00:00
    expect(flashTotalsSince(false, at1600)).toBe(Date.UTC(2026, 10, 10, 7) / 1000); // Tue 15:00 (night session)
    const at1000 = Date.UTC(2026, 10, 10, 2);
    expect(flashTotalsSince(false, at1000)).toBe(tradingDayStart(at1000 / 1000));
});

// PR #400 review round 4 P3: fills without a detail time are never given a guessed time
it('fill quantity beyond the deal details is untimed: kept out of the replay and reported', () => {
    // short 10 with no details at all → untimed, not 補齊 even after a later buy
    const r = T([t('Sell', 10, 10, 0, 'Filled', short, { deals: [] }), t('Buy', 10, 10, 0, 'Filled')]).dayShort!;
    expect(r).toEqual({ sold: 0, covered: 0, open: 0, unknownSell: 0, unknownBuy: 0, untimedSell: 10, untimedBuy: 0 });
    // a buy filled 6 with details for 2 only: the other 4 are untimed, not placed at the last detail time
    const b = T([t('Sell', 5, 5, 0, 'Filled', short), t('Buy', 6, 6, 0, 'Filled', {}, { deals: [{ seq: 'x', price: 100, quantity: 2, ts: 5_000 }] })]).dayShort!;
    expect(b).toEqual({ sold: 5, covered: 2, open: 3, unknownSell: 0, unknownBuy: 0, untimedSell: 0, untimedBuy: 4 });
    // a detail without a time is untimed too
    expect(T([t('Sell', 3, 3, 0, 'Filled', short, { deals: [{ seq: 'y', price: 100, quantity: 3, ts: 0 }] })]).dayShort?.untimedSell).toBe(3);
});

it('flashWorkingOrders lists the same orders the totals count as working', () => {
    const rows = [
        t('Buy', 5, 2, 0, 'PartFilled'), t('Buy', 5, 0, 5, 'Cancelled'), t('Buy', 3, 0, 0, 'Failed'), t('Buy', 4, 4, 0, 'Filled'),
        t('Sell', 2, 0, 0, 'Submitted'), t('Buy', 1, 0, 0, 'Submitted', {}, { order_ts: 1 }), // before since
    ];
    const since = 2;
    const w = flashWorkingOrders(rows, all, since);
    expect(w.buy).toEqual([rows[0]]);
    expect(w.sell).toEqual([rows[4]]);
    const totals = flashOrderTotals(rows, all, false, since, none);
    expect(totals.buy.working).toBe(3);
    expect(totals.sell.working).toBe(2);
});
