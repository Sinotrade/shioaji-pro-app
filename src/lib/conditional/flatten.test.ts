// src/lib/conditional/flatten.test.ts — 全平並取消 (#226): recomputed from
// fresh positions, closes exactly what is held, never reverses. All broker
// I/O is mocked: no order is sent.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountedPosition, Account } from '../types/portfolio';

const F: Account = { account_type: 'F', broker_id: 'bf', account_id: 'f1', person_id: '', signed: true, username: '' };
const S: Account = { account_type: 'S', broker_id: 'bs', account_id: 's1', person_id: '', signed: true, username: '' };

const m = vi.hoisted(() => ({
    trades: vi.fn(),
    positions: vi.fn(),
    cancel: vi.fn(),
    place: vi.fn(),
    order: [] as string[],
}));
vi.mock('../account-store', () => ({ getAccountState: () => ({ accounts: [F, S] }) }));
vi.mock('../account-tradable', () => ({ canTrade: () => true }));
vi.mock('../account-query', () => ({ createAccountQuery: () => ({ read: (_t: string, a: Account, f: (a: Account) => unknown) => f(a) }) }));
vi.mock('../contracts-cache', () => ({ ensureContract: async (code: string) => code === '2330'
    ? { code, security_type: 'STK', limit_up: 1100, limit_down: 900 } : { code, security_type: 'FUT', target_code: code } }));
vi.mock('../shioaji', () => ({
    fetchTrades: (t: string, a: Account) => { m.order.push(`trades:${a.account_id}`); return m.trades(a); },
    fetchPositions: (t: string, a: Account) => { m.order.push(`positions:${a.account_id}`); return m.positions(a); },
    cancelOrders: (ids: string[]) => { m.order.push(`cancel:${ids.join(',')}`); return m.cancel(ids); },
}));
vi.mock('../trade', () => ({ placeQuickOrder: (...a: unknown[]) => { m.order.push(`place:${(a[0] as { code: string }).code}`); return m.place(...a); } }));

const { planFlatten, executeFlatten } = await import('./flatten');

const pos = (over: Partial<AccountedPosition> & Record<string, unknown>): AccountedPosition =>
    ({ id: 1, code: 'TXFJ6', direction: 'Buy', quantity: 2, price: 1, last_price: 1, pnl: 0, account: F, ...over }) as AccountedPosition;
const working = (id: string, code: string, account: Account) => ({ contract: { code, target_code: code }, order: { id, account, quantity: 1 },
    status: { status: 'Submitted', deal_quantity: 0, cancel_quantity: 0, deals: [] } });

beforeEach(() => {
    m.order = [];
    for (const f of [m.trades, m.positions, m.cancel, m.place]) f.mockReset();
    m.trades.mockResolvedValue([]);
    m.positions.mockResolvedValue([]);
    m.place.mockResolvedValue({ order: { id: 'x' }, status: { status: 'PendingSubmit' } });
});

describe('planFlatten', () => {
    it('closes exactly what is held, on the opposite side; never more, never a reversal', () => {
        const plan = planFlatten([pos({}), pos({ code: 'MXFJ6', direction: 'Sell', quantity: 3 }), pos({ code: 'TXFJ6', quantity: 1 })], { type: 'all' });
        expect(plan.orders).toEqual([
            { account: { account_type: 'F', broker_id: 'bf', account_id: 'f1' }, code: 'TXFJ6', action: 'Sell', quantity: 3, market: 'futures' },
            { account: { account_type: 'F', broker_id: 'bf', account_id: 'f1' }, code: 'MXFJ6', action: 'Buy', quantity: 3, market: 'futures' },
        ]);
    });

    it('no position → no order; credit stock positions and both-sided holdings are left to the user', () => {
        expect(planFlatten([], { type: 'all' }).orders).toEqual([]);
        const plan = planFlatten([pos({ code: '2330', account: S, quantity: 1000, cond: 'MarginTrading' }),
            pos({ code: 'MXFJ6' }), pos({ code: 'MXFJ6', direction: 'Sell' })], { type: 'all' });
        expect(plan.orders).toEqual([]);
        expect(plan.skipped.map(s => s.code)).toEqual(['2330', 'MXFJ6']);
    });

    it('scope: this product / this account', () => {
        const rows = [pos({}), pos({ code: '2330', account: S, quantity: 1500, cond: 'Cash' })];
        expect(planFlatten(rows, { type: 'code', codes: ['TXFJ6'], account: null }).orders.map(o => o.code)).toEqual(['TXFJ6']);
        expect(planFlatten(rows, { type: 'account', account: { account_type: 'S', broker_id: 'bs', account_id: 's1' } }).orders)
            .toEqual([{ account: { account_type: 'S', broker_id: 'bs', account_id: 's1' }, code: '2330', action: 'Sell', quantity: 1500, market: 'stock' }]);
    });
});

describe('executeFlatten', () => {
    const stopConditional = vi.fn(async () => ({ stopped: 2, failed: [] as string[] }));

    it('stops conditionals, cancels, then re-reads positions (fills during the cancel count) and closes with MKP + Cover', async () => {
        m.trades.mockImplementation(async (a: Account) => a === F ? [working('w1', 'TXFJ6', F)] : []);
        m.cancel.mockResolvedValue([{ status: 'fulfilled', value: { status: { status: 'Cancelled' } } }]);
        // the cancel raced a fill: 3 lots now, not the 2 shown before
        m.positions.mockImplementation(async (a: Account) => a === F ? [{ id: 1, code: 'TXFJ6', direction: 'Buy', quantity: 3 }] : []);
        const r = await executeFlatten({ type: 'code', codes: ['TXFJ6'], account: null }, { stopConditional });
        expect(stopConditional).toHaveBeenCalledTimes(1);
        expect(m.order.indexOf('cancel:w1')).toBeLessThan(m.order.indexOf('positions:f1'));
        expect(m.place).toHaveBeenCalledTimes(1);
        const [, action, price, qty, opts] = m.place.mock.calls[0]!;
        expect([action, price, qty, opts.ocType, opts.futuresPriceType, opts.account.account_id]).toEqual(['Sell', null, 3, 'Cover', 'MKP', 'f1']);
        expect(r).toMatchObject({ stopped: 2, cancelled: 1, sent: [{ code: 'TXFJ6', action: 'Sell', quantity: 3 }] });
    });

    it('a product whose cancel is not confirmed is not closed', async () => {
        m.trades.mockImplementation(async (a: Account) => a === F ? [working('w1', 'TXFJ6', F)] : []);
        m.cancel.mockResolvedValue([{ status: 'rejected', reason: new Error('CANCEL_UNCONFIRMED') }]);
        m.positions.mockImplementation(async (a: Account) => a === F ? [{ id: 1, code: 'TXFJ6', direction: 'Buy', quantity: 2 }] : []);
        const r = await executeFlatten({ type: 'all' }, { stopConditional });
        expect(m.place).not.toHaveBeenCalled();
        expect(r.notSent.join()).toContain('刪單未確認，未平倉');
    });

    it('a failed position read sends nothing for that account; flat accounts send nothing', async () => {
        m.positions.mockImplementation(async (a: Account) => { if (a === F) throw new Error('timeout'); return []; });
        const r = await executeFlatten({ type: 'all' }, { stopConditional });
        expect(m.place).not.toHaveBeenCalled();
        expect(r.notSent.join()).toContain('持倉查詢失敗');
    });

    it('stocks: whole lots at market, the odd remainder as an odd-lot limit at the price limit', async () => {
        m.positions.mockImplementation(async (a: Account) => a === S ? [{ id: 1, code: '2330', direction: 'Buy', quantity: 2300, cond: 'Cash' }] : []);
        await executeFlatten({ type: 'account', account: { account_type: 'S', broker_id: 'bs', account_id: 's1' } }, { stopConditional });
        expect(m.place.mock.calls.map(c => [c[1], c[2], c[3], (c[4] as { orderLot?: string }).orderLot])).toEqual([
            ['Sell', null, 2, undefined], ['Sell', 900, 300, 'IntradayOdd']]);
    });

    it('a conditional order that could not be stopped, or one still sending, blocks everything', async () => {
        m.positions.mockImplementation(async (a: Account) => a === F ? [{ id: 1, code: 'TXFJ6', direction: 'Buy', quantity: 2 }] : []);
        const r1 = await executeFlatten({ type: 'all' }, { stopConditional: async () => ({ stopped: 0, failed: ['TXFJ6 觸價單：沒有回應'] }) });
        expect(r1.notSent.join()).toContain('沒有全部停止');
        const r2 = await executeFlatten({ type: 'all' }, { stopConditional, waitInFlight: async () => false });
        expect(r2.notSent.join()).toContain('送出中');
        expect(m.cancel).not.toHaveBeenCalled();
        expect(m.place).not.toHaveBeenCalled();
    });
});
