import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeOrderEvent, type OrderEventReport } from './order-report';
import schema from './fixtures/order-callback-openapi-1.7.5.json';
import type { TradeObservation } from './trade-observations';

const mocks = vi.hoisted(() => ({
    status: 'live', order: null as ((r: OrderEventReport) => void) | null,
    statusChanged: null as (() => void) | null,
    response: null as ((value: TradeObservation) => void) | null,
    ensure: vi.fn(), cached: vi.fn(),
    positions: vi.fn(), trades: vi.fn(), balance: vi.fn(), margin: vi.fn(), subscribe: vi.fn(),
    account: { account_type: 'S', broker_id: 'fixture', account_id: 'a', person_id: 'fixture', signed: true, username: 'fixture' },
}));
vi.mock('./account-store', () => ({ useAccounts: () => ({ accounts: [mocks.account], selectedStock: mocks.account, selectedFutures: null }), getAccountState: () => ({ accounts: [mocks.account] }), refreshAccounts: vi.fn() }));
vi.mock('./runtime', () => ({ getApiBase: () => 'http://fixture.invalid' }));
vi.mock('./boot', () => ({ subscribeProductionTradeEvents: mocks.subscribe }));
vi.mock('./trade-observations', () => ({ onTradeResponse: (cb: typeof mocks.response) => { mocks.response = cb; return vi.fn(); } }));
vi.mock('./contracts-cache', () => ({ ensureContract: mocks.ensure, getCachedContract: mocks.cached }));
vi.mock('./quote-ownership', () => ({ retainQuote: () => vi.fn() }));
vi.mock('./shioaji', () => ({ fetchPositions: mocks.positions, fetchTrades: mocks.trades, fetchAccountBalance: mocks.balance, fetchMargin: mocks.margin }));
vi.mock('./stream', () => ({ ensureStream: vi.fn(), getStreamStatus: () => mocks.status,
    onOrderEvent: (cb: typeof mocks.order) => { mocks.order = cb; return vi.fn(); },
    onAnyTick: () => vi.fn(), subscribeStatusStore: (cb: typeof mocks.statusChanged) => { mocks.statusChanged = cb; return vi.fn(); },
}));
const epoch = 1789200000;
const baseline = () => ({ id: 1, code: '2330', direction: 'Buy', quantity: 1000, price: 100, last_price: 100, pnl: 0, yd_quantity: 1000 });
function order(id = 'new', price = 100, ts = epoch + 2, operation = 'New'): OrderEventReport {
    return normalizeOrderEvent({ state: 'StockOrder', data: { StockOrder: {
        operation: { op_type: operation, op_code: '00', op_msg: '' },
        order: { id, seqno: id, ordno: id, account: mocks.account, action: 'Buy', price, quantity: 3, order_lot: 'Common', order_cond: 'Cash', price_type: 'LMT', order_type: 'ROD' },
        status: { exchange_ts: ts, order_quantity: 3, cancel_quantity: 0, modified_price: 0 },
        contract: { code: '2330', security_type: 'STK', exchange: 'TSE' },
    } } })!;
}
function deal(): OrderEventReport {
    return normalizeOrderEvent({ state: 'StockDeal', data: { StockDeal: {
        trade_id: 'new', seqno: 'new', ordno: 'new', exchange_seq: 'fill-1', broker_id: 'fixture', account_id: 'a',
        action: 'Buy', code: '2330', price: 101, quantity: 1, order_lot: 'Common', order_cond: 'Cash', ts: epoch + 2,
    } } })!;
}
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
let root: ReactTestRenderer | undefined;
let store: typeof import('./trading-state');
async function flush() { await act(async () => { await Promise.resolve(); }); }
async function emit(report: OrderEventReport) { await act(async () => { mocks.order!(report); vi.advanceTimersByTime(50); }); }
beforeEach(async () => {
    vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(epoch * 1000);
    vi.stubGlobal('BroadcastChannel', undefined); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.status = 'live'; mocks.order = null; mocks.statusChanged = null; mocks.response = null; mocks.account.account_type = 'S';
    mocks.positions.mockReset().mockImplementation(async () => [baseline()]);
    mocks.trades.mockReset().mockResolvedValue([]); mocks.balance.mockReset().mockResolvedValue({ acc_balance: 100, date: '2026-09-12', errmsg: '' });
    mocks.subscribe.mockReset().mockResolvedValue(undefined);
    mocks.ensure.mockReset().mockResolvedValue({ code: '2330', security_type: 'STK' });
    mocks.cached.mockReset().mockReturnValue({ code: '2330', security_type: 'STK' });
    store = await import('./trading-state');
    function Consumer() { store.useTradingState(); return null; }
    await act(async () => { root = create(createElement(Consumer)); });
});
afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('shared trading state with isolated broker fixtures', () => {
    it('marks both orders and positions stale for a futures deal arriving before order metadata', async () => {
        mocks.account.account_type = 'F';
        mocks.positions.mockResolvedValueOnce([]); mocks.margin.mockResolvedValue({ equity: 100 });
        vi.advanceTimersByTime(1500);
        await act(async () => { await store.refreshTradingState(); });
        expect(store.getTradingState().queries.orders.needsReconcile).toBe(false);
        expect(store.getTradingState().queries.positions.needsReconcile).toBe(false);
        const calls = [mocks.positions.mock.calls.length, mocks.trades.mock.calls.length];
        await emit(normalizeOrderEvent({ state: 'FuturesDeal', data: { FuturesDeal: {
            trade_id: 'unknown-future', seqno: 'unknown', ordno: 'unknown', exchange_seq: 'early-fill',
            broker_id: 'fixture', account_id: 'a', code: 'TXF', full_code: 'TXFI6',
            action: 'Buy', price: 200, quantity: 1, ts: epoch + 3,
        } } })!);
        for (const scope of ['orders', 'positions'] as const) {
            expect(store.getTradingState().queries[scope].needsReconcile).toBe(true);
            expect(store.getTradingState().queries[scope].error).toBeTruthy();
        }
        expect([mocks.positions.mock.calls.length, mocks.trades.mock.calls.length]).toEqual(calls);
    });
    it.each(['positions', 'orders', 'account'] as const)('refreshes only the requested %s endpoints', async scope => {
        const before = [mocks.positions.mock.calls.length, mocks.trades.mock.calls.length, mocks.balance.mock.calls.length, mocks.margin.mock.calls.length];
        vi.advanceTimersByTime(1500);
        await act(async () => { await store.refreshTradingState(scope); });
        const after = [mocks.positions.mock.calls.length, mocks.trades.mock.calls.length, mocks.balance.mock.calls.length, mocks.margin.mock.calls.length];
        expect(after.map((n, i) => n - before[i]!)).toEqual(scope === 'positions' ? [1, 0, 0, 0] : scope === 'orders' ? [0, 1, 0, 0] : [0, 0, 1, 0]);
        if (scope === 'account') {
            mocks.account.account_type = 'F'; mocks.margin.mockResolvedValue({ equity: 100 });
            vi.advanceTimersByTime(1500);
            await act(async () => { await store.refreshTradingState('account'); });
            expect(mocks.positions.mock.calls.length).toBe(after[0]); expect(mocks.trades.mock.calls.length).toBe(after[1]);
            expect(mocks.balance.mock.calls.length).toBe(after[2]); expect(mocks.margin.mock.calls.length).toBe(after[3]! + 1);
        }
    });
    it('does not clear another scope error or update its timestamp after successful orders refresh', async () => {
        vi.advanceTimersByTime(1500); mocks.positions.mockRejectedValueOnce(new Error('offline'));
        await act(async () => { await store.refreshTradingState('positions'); });
        const positions = { ...store.getTradingState().queries.positions };
        const account = { ...store.getTradingState().queries.account };
        expect(positions.error).toBeTruthy(); expect(positions.needsReconcile).toBe(true);
        vi.advanceTimersByTime(1500);
        await act(async () => { await store.refreshTradingState('orders'); });
        expect(store.getTradingState().queries.positions).toEqual(positions);
        expect(store.getTradingState().queries.account).toEqual(account);
        expect(store.getTradingState().queries.orders.error).toBeNull();
        expect(store.getTradingState().needsReconcile).toBe(true);
    });
    it('projects positions from reports while only orders are being queried', async () => {
        const pending = deferred<never[]>(); mocks.trades.mockImplementationOnce(() => pending.promise);
        vi.advanceTimersByTime(1500); let refresh!: Promise<void>;
        const positionCalls = mocks.positions.mock.calls.length;
        const fundsCalls = mocks.balance.mock.calls.length;
        await act(async () => { refresh = store.refreshTradingState('orders'); });
        await emit(order()); await emit(deal());
        expect(store.getTradingState().positions[0]!.quantity).toBe(2000);
        await act(async () => { pending.resolve([]); await refresh; });
        expect(store.getTradingState().positions[0]!.quantity).toBe(2000);
        expect(mocks.positions.mock.calls.length).toBe(positionCalls); expect(mocks.balance.mock.calls.length).toBe(fundsCalls);
    });
    it('coalesces same-scope requests and enforces its cooldown without queued work', async () => {
        const pending = deferred<never[]>(); mocks.trades.mockImplementationOnce(() => pending.promise);
        vi.advanceTimersByTime(1500); let first!: Promise<void>; let second!: Promise<void>;
        await act(async () => { first = store.refreshTradingState('orders'); second = store.refreshTradingState('orders'); });
        expect(first).toBe(second);
        expect(mocks.trades).toHaveBeenCalledTimes(2);
        await act(async () => { pending.resolve([]); await first; await store.refreshTradingState('orders'); vi.advanceTimersByTime(1499); await store.refreshTradingState('orders'); });
        expect(mocks.trades).toHaveBeenCalledTimes(2);
        await act(async () => { vi.advanceTimersByTime(1); await store.refreshTradingState('orders'); });
        expect(mocks.trades).toHaveBeenCalledTimes(3);
    });
    it.each(['order-first', 'order-after', 'response-after'])('replays all cold futures fills exactly once: %s', async path => {
        mocks.account.account_type = 'F';
        mocks.positions.mockResolvedValueOnce([]);
        mocks.margin.mockResolvedValue({ equity: 1000 });
        vi.advanceTimersByTime(1500);
        await act(async () => { await store.refreshTradingState(); });
        vi.advanceTimersByTime(1500);
        const metadata = deferred<{ code: string; multiplier: number }>();
        mocks.ensure.mockImplementation(() => metadata.promise); mocks.cached.mockReturnValue(undefined);
        const raw = order().raw as { data: { StockOrder: { order: Record<string, unknown>; status: Record<string, unknown>; contract: Record<string, unknown>; operation: unknown } } };
        const body = raw.data.StockOrder;
        const futuresOrder = normalizeOrderEvent({ state: 'FuturesOrder', data: { FuturesOrder: { ...body,
            order: { ...body.order, oc_type: 'New' },
            contract: { code: 'TXF', full_code: 'TXFI6', security_type: 'FUT', exchange: 'TAIFEX' },
        } } })!;
        if (path === 'order-first') await emit(futuresOrder);
        const counts = [mocks.positions.mock.calls.length, mocks.trades.mock.calls.length, mocks.margin.mock.calls.length, mocks.balance.mock.calls.length];
        const ensures = mocks.ensure.mock.calls.length;
        for (const seq of ['f1', 'f2']) await emit(normalizeOrderEvent({ state: 'FuturesDeal', data: { FuturesDeal: {
            trade_id: 'new', seqno: 'new', ordno: 'new', exchange_seq: seq, broker_id: 'fixture', account_id: 'a',
            code: 'TXF', full_code: 'TXFI6', action: 'Buy', price: 200, quantity: 1, ts: epoch + 4,
        } } })!);
        if (path === 'order-after') await emit(futuresOrder);
        if (path === 'response-after') {
            const { projectOrderReport } = await import('./order-projection');
            const trade = projectOrderReport([], futuresOrder, [mocks.account])![0]!;
            await act(async () => { mocks.response!({ trade, account: mocks.account }); vi.advanceTimersByTime(50); });
        }
        expect(mocks.ensure.mock.calls.length - ensures).toBe(1);
        expect(store.getTradingState().positions.filter(p => p.code === 'TXFI6')).toHaveLength(0);
        await act(async () => { mocks.cached.mockReturnValue({ code: 'TXFI6', multiplier: 200 }); metadata.resolve({ code: 'TXFI6', multiplier: 200 }); await metadata.promise; });
        const positions = store.getTradingState().positions.filter(p => p.code === 'TXFI6');
        expect(positions).toHaveLength(1); expect(positions[0]!.quantity).toBe(2);
        expect(store.getTradingState().trades.find(t => t.order.id === 'new')!.status.deal_quantity).toBe(2);
        expect([mocks.positions.mock.calls.length, mocks.trades.mock.calls.length, mocks.margin.mock.calls.length, mocks.balance.mock.calls.length]).toEqual(counts);
    });
    it('enriches futures metadata from a late HTTP response without reverting newer fills or querying', async () => {
        mocks.account.account_type = 'F';
        const event = normalizeOrderEvent({ state: 'FuturesOrder', data: { FuturesOrder: {
            operation: { op_type: 'New', op_code: '00', op_msg: '' },
            order: { id: 'future', seqno: 'future', ordno: 'future', account: mocks.account, action: 'Buy', price: 200, quantity: 2, price_type: 'MKT', order_type: 'IOC', oc_type: 'Auto' },
            status: { id: 'future', exchange_ts: epoch + 2, order_quantity: 2, cancel_quantity: 0, modified_price: 0 },
            contract: { code: 'TXF', full_code: 'TXFI6', security_type: 'FUT', exchange: 'TAIFEX' },
        } } })!;
        // The real 1.7.5 schema cannot provide this HTTP-only grid metadata.
        const futuresOrders = Object.entries(schema.schemas).filter(([name]) => /FuturesOrderDetail$/.test(name));
        expect(futuresOrders.length).toBeGreaterThan(0);
        for (const [, value] of futuresOrders) expect('properties' in value && 'custom_field' in value.properties).toBe(false);
        await emit(event);
        await emit(normalizeOrderEvent({ state: 'FuturesDeal', data: { FuturesDeal: {
            trade_id: 'future', seqno: 'future', ordno: 'future', exchange_seq: 'f-fill', broker_id: 'fixture', account_id: 'a',
            code: 'TXF', full_code: 'TXFI6', action: 'Buy', price: 201, quantity: 1, ts: epoch + 3,
        } } })!);
        const current = store.getTradingState().trades[0]!;
        expect(current.status.deal_quantity).toBe(1);
        const counts = [mocks.positions.mock.calls.length, mocks.trades.mock.calls.length, mocks.balance.mock.calls.length];
        await act(async () => {
            mocks.response!({ account: mocks.account, trade: { ...current,
                order: { ...current.order, price: 190, price_type: 'LMT', order_type: 'ROD', custom_field: 'grid' },
                status: { ...current.status, status: 'PendingSubmit', deal_quantity: 0, deals: [] },
            } });
            vi.advanceTimersByTime(50);
        });
        const enriched = store.getTradingState().trades[0]!;
        expect(enriched.order).toMatchObject({ custom_field: 'grid', price: 200, price_type: 'MKT', order_type: 'IOC' });
        expect(enriched.status).toMatchObject({ status: 'PartFilled', deal_quantity: 1 });
        expect(enriched.status.deals).toEqual(current.status.deals);
        expect([mocks.positions.mock.calls.length, mocks.trades.mock.calls.length, mocks.balance.mock.calls.length]).toEqual(counts);
    });
    it('loads once and makes no additional accounting queries in sixty idle seconds', async () => {
        expect(store.getTradingState()).toMatchObject({ loading: false, needsReconcile: false });
        expect(mocks.subscribe).toHaveBeenCalledOnce();
        expect(mocks.positions).toHaveBeenCalledOnce(); expect(mocks.trades).toHaveBeenCalledOnce(); expect(mocks.balance).toHaveBeenCalledOnce();
        await act(async () => { vi.advanceTimersByTime(60000); store.tradingActionObserved(); });
        expect(mocks.positions).toHaveBeenCalledOnce(); expect(mocks.trades).toHaveBeenCalledOnce(); expect(mocks.balance).toHaveBeenCalledOnce();
        expect(mocks.margin).not.toHaveBeenCalled();
    });
    it('shares manual refresh and preserves the previous snapshot on failure', async () => {
        const pending = deferred<ReturnType<typeof baseline>[]>();
        mocks.positions.mockImplementationOnce(() => pending.promise);
        vi.advanceTimersByTime(1500);
        let a!: Promise<void>; let b!: Promise<void>;
        await act(async () => { a = store.refreshTradingState(); b = store.refreshTradingState(); });
        expect(a).toBe(b); expect(mocks.positions).toHaveBeenCalledTimes(2);
        await act(async () => { pending.resolve([baseline()]); await a; });
        const previous = store.getTradingState().positions;
        mocks.positions.mockRejectedValueOnce(new Error('offline')); mocks.trades.mockRejectedValueOnce(new Error('offline'));
        vi.advanceTimersByTime(1500);
        await act(async () => { await store.refreshTradingState(); });
        expect(store.getTradingState().positions).toEqual(previous);
        expect(store.getTradingState()).toMatchObject({ needsReconcile: true, loading: false });
        expect(store.getTradingState().error).toContain('查詢失敗');
    });
    it('retains deal-before-order arriving during a query without double-counting the position', async () => {
        const pending = deferred<never[]>(); mocks.trades.mockImplementationOnce(() => pending.promise);
        vi.advanceTimersByTime(1500); let refresh!: Promise<void>;
        await act(async () => { refresh = store.refreshTradingState(); });
        await flush(); expect(mocks.trades).toHaveBeenCalledTimes(2);
        await emit(deal()); await emit(order()); await emit(deal());
        expect(store.getTradingState().positions[0]!.quantity).toBe(2000);
        expect(store.getTradingState().trades[0]!.status.deal_quantity).toBe(1);
        await act(async () => { pending.resolve([]); await refresh; });
        expect(store.getTradingState().positions[0]!.quantity).toBe(2000);
        expect(store.getTradingState().trades[0]!.status.deal_quantity).toBe(1);
        expect(store.getTradingState().needsReconcile).toBe(true);
    });
    it('ignores older order reports instead of rolling back the working price', async () => {
        await emit(order());
        await emit(order('new', 110, epoch + 10, 'UpdatePrice'));
        await emit(order('new', 90, epoch + 3, 'UpdatePrice'));
        expect(store.getTradingState().trades[0]!.order.price).toBe(110);
        expect(mocks.trades).toHaveBeenCalledOnce();
    });
    it('does not let a query overwrite live state after the report buffer overflows', async () => {
        const pending = deferred<never[]>(); mocks.trades.mockImplementationOnce(() => pending.promise);
        vi.advanceTimersByTime(1500); let refresh!: Promise<void>;
        await act(async () => { refresh = store.refreshTradingState(); });
        await act(async () => { for (let i = 0; i < 1001; i++) mocks.order!(order(`order-${i}`)); vi.advanceTimersByTime(50); });
        expect(store.getTradingState().trades).toHaveLength(1001);
        await act(async () => { pending.resolve([]); await refresh; });
        expect(store.getTradingState().trades).toHaveLength(1001);
        expect(store.getTradingState().needsReconcile).toBe(true);
        expect(store.getTradingState().error).toContain('回報過多');
    });
    it('keeps needsReconcile when the stream disconnects and recovers during a query', async () => {
        const pending = deferred<never[]>(); mocks.trades.mockImplementationOnce(() => pending.promise);
        vi.advanceTimersByTime(1500); let refresh!: Promise<void>;
        await act(async () => { refresh = store.refreshTradingState(); });
        await act(async () => { mocks.status = 'down'; mocks.statusChanged!(); mocks.status = 'live'; mocks.statusChanged!(); });
        await act(async () => { pending.resolve([]); await refresh; });
        expect(store.getTradingState()).toMatchObject({ needsReconcile: true, loading: false });
        expect(store.getTradingState().error).toContain('串流曾中斷');
        expect(mocks.trades).toHaveBeenCalledTimes(2);
    });
});
