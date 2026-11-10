import { afterEach, expect, it, vi } from 'vitest';
import { flashOrderTotals, flashTotalsSince, sameContractMonth } from './flash-order-totals';
import { tradingDayStart } from './futures-fifo';
import type { Trade } from './types/order';

const t = (action: 'Buy' | 'Sell', quantity: number, deal: number, cancel: number, status: string, extra: Record<string, unknown> = {}, st: Record<string, unknown> = {}) =>
    ({ contract: { code: '2317' }, order: { id: `o${Math.random()}`, action, price: 100, quantity, order_cond: 'Cash', ...extra },
        status: { status, deal_quantity: deal, cancel_quantity: cancel, deals: [], ...st } }) as unknown as Trade;
const all = () => true;
const none = () => undefined;
const T = (trades: Trade[], stock = true, since = 0) => flashOrderTotals(trades, all, stock, since, none);
const short = { daytrade_short: true };
const plain = { daytrade_short: false };

afterEach(() => { vi.unstubAllGlobals(); });

it('counts ordered net of cancels, filled and working per side (customer case 32(20) / 40(20))', () => {
    const r = T([
        t('Buy', 12, 12, 0, 'Filled'), t('Buy', 8, 8, 0, 'Filled'), t('Buy', 12, 0, 0, 'Submitted'),
        t('Sell', 20, 20, 0, 'Filled', short), t('Sell', 20, 0, 0, 'Submitted', short),
        t('Sell', 5, 0, 5, 'Cancelled', short), t('Sell', 3, 0, 0, 'Failed'),
    ]);
    expect(r.buy).toEqual({ ordered: 32, filled: 20, working: 12, cancelled: 0 });
    expect(r.sell).toEqual({ ordered: 40, filled: 20, working: 20, cancelled: 5 });
    expect(r.dayShort).toEqual({ sold: 20, covered: 20, open: 0, unknownSell: 0, unknownBuy: 0 });
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
    expect(r.dayShort).toEqual({ sold: 30, covered: 20, open: 10, unknownSell: 0, unknownBuy: 0 });
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
    expect(r.dayShort).toEqual({ sold: 10, covered: 3, open: 7, unknownSell: 6, unknownBuy: 6 });
});

it('fills in order_cond / daytrade_short recorded when this app sent the order', () => {
    const sell = t('Sell', 8, 8, 0, 'Filled', { order_cond: undefined });
    const buy = t('Buy', 8, 8, 0, 'Filled', { order_cond: undefined });
    const conds = (x: Trade) => x === sell ? { cond: 'Cash', daytradeShort: true } : x === buy ? { cond: 'MarginTrading', daytradeShort: false } : undefined;
    expect(flashOrderTotals([sell, buy], all, true, 0, conds).dayShort).toEqual({ sold: 8, covered: 0, open: 8, unknownSell: 0, unknownBuy: 0 });
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
        t('Buy', 4, 4, 0, 'Filled', {}, { deals: [{ seq: 'a', price: 100, quantity: 4, ts: since - 10 }] }), // no order_ts, old deal
        t('Buy', 3, 1, 0, 'PartFilled', {}, { deals: [{ seq: 'b', price: 100, quantity: 1, ts: since + 10 }] }),
        t('Buy', 1, 0, 0, 'Submitted'), // no time at all, still working
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
