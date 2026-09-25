import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeOrderEvent, type OrderEventReport } from './order-report';
import schema from './fixtures/order-callback-openapi-1.7.5.json';
import type { TradeObservation } from './trade-observations';
import type { Account } from './types/portfolio';

const mocks = vi.hoisted(() => ({
    extraAccounts: [] as Account[],
    status: 'live', order: null as ((r: OrderEventReport) => void) | null,
    statusChanged: null as (() => void) | null,
    response: null as ((value: TradeObservation) => void) | null,
    ensure: vi.fn(), cached: vi.fn(),
    positions: vi.fn(), trades: vi.fn(), balance: vi.fn(), margin: vi.fn(), subscribe: vi.fn(), health: vi.fn(),
    account: { account_type: 'S', broker_id: 'fixture', account_id: 'a', person_id: 'fixture', signed: true, username: 'fixture' },
}));
vi.mock('./account-store', () => ({ useAccounts: () => ({ accounts: [mocks.account, ...mocks.extraAccounts], selectedStock: mocks.account, selectedFutures: null }), getAccountState: () => ({ accounts: [mocks.account, ...mocks.extraAccounts] }), refreshAccounts: vi.fn() }));
vi.mock('./runtime', () => ({ getApiBase: () => 'http://fixture.invalid' }));
vi.mock('./boot', () => ({ subscribeTradeReports: mocks.subscribe }));
vi.mock('./trade-observations', () => ({ onTradeResponse: (cb: typeof mocks.response) => { mocks.response = cb; return vi.fn(); } }));
vi.mock('./contracts-cache', () => ({ ensureContract: mocks.ensure, getCachedContract: mocks.cached }));
vi.mock('./quote-ownership', () => ({ retainQuote: () => vi.fn() }));
vi.mock('./shioaji', () => ({ fetchPositions: mocks.positions, fetchTrades: mocks.trades, fetchAccountBalance: mocks.balance, fetchMargin: mocks.margin, fetchTradeCacheHealth: mocks.health }));
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
    vi.stubGlobal('navigator', { locks: { request: (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}) } });
    vi.stubGlobal('BroadcastChannel', undefined); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.status = 'live'; mocks.order = null; mocks.statusChanged = null; mocks.response = null; mocks.account.account_type = 'S';
    mocks.account.account_id = 'a'; mocks.account.broker_id = 'fixture';
    mocks.extraAccounts = [];
    mocks.positions.mockReset().mockImplementation(async () => [baseline()]);
    mocks.trades.mockReset().mockResolvedValue([]); mocks.balance.mockReset().mockResolvedValue({ acc_balance: 100, date: '2026-09-12', errmsg: '' });
    mocks.subscribe.mockReset().mockResolvedValue(undefined);
    mocks.health.mockReset().mockResolvedValue({ state: 'Healthy', reasons: [] });
    mocks.ensure.mockReset().mockResolvedValue({ code: '2330', security_type: 'STK' });
    mocks.cached.mockReset().mockReturnValue({ code: '2330', security_type: 'STK' });
    store = await import('./trading-state');
    function Consumer() { store.useTradingState(); return null; }
    await act(async () => { root = create(createElement(Consumer)); });
});
afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('shared trading state with isolated broker fixtures', () => {
    it('startTradingState outside React is idempotent with the hook (#142)', async () => {
        const calls = mocks.positions.mock.calls.length;
        await act(async () => { store.startTradingState(); store.startTradingState(); });
        await flush();
        expect(mocks.positions.mock.calls.length).toBe(calls); // no second initial read
    });

    it('caps concurrent account reads at ACCOUNT_READ_CONCURRENCY (broker rate limit)', async () => {
        mocks.extraAccounts = ['b', 'c', 'd', 'e'].map(id => ({ ...mocks.account, account_id: id }));
        let inFlight = 0, max = 0;
        const slow = async <T,>(value: T) => { inFlight++; max = Math.max(max, inFlight); await new Promise(r => setTimeout(r, 10)); inFlight--; return value; };
        mocks.positions.mockClear();
        mocks.positions.mockImplementation(() => slow([baseline()]));
        mocks.trades.mockImplementation(() => slow([]));
        mocks.balance.mockImplementation(() => slow({ acc_balance: 1, date: '2026-09-25', errmsg: '' }));
        vi.advanceTimersByTime(1500);
        await act(async () => { const run = store.refreshTradingState('all'); await vi.advanceTimersByTimeAsync(1000); await run; });
        expect(max).toBe(store.ACCOUNT_READ_CONCURRENCY);
        expect(mocks.positions).toHaveBeenCalledTimes(5);
        expect(store.getTradingState().funds!.map(f => f.account.account_id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('one account failing while another succeeds: keeps the good one, flags the failure', async () => {
        mocks.extraAccounts = [{ ...mocks.account, account_id: 'b' }];
        mocks.positions.mockImplementation(async (_t: string, a: Account) => { if (a.account_id === 'b') throw new Error('503'); return [baseline()]; });
        mocks.trades.mockClear();
        mocks.trades.mockImplementation(async (_t: string, a: Account) => { if (a.account_id === 'a') throw new Error('503'); return []; });
        vi.advanceTimersByTime(1500);
        await act(async () => { await store.refreshTradingState('all'); });
        const st = store.getTradingState();
        expect(st.positions.map(p => p.account?.account_id)).toEqual(['a']);
        expect(st.queries.positions.needsReconcile).toBe(true);
        expect(st.queries.orders.needsReconcile).toBe(true);
        expect(mocks.trades).toHaveBeenCalledTimes(2);
    });

    it('reads every account concurrently, keeping each account\'s positions → orders order (#142)', async () => {
        mocks.extraAccounts = [{ ...mocks.account, account_id: 'b' }];
        const gates = new Map<string, ReturnType<typeof deferred<ReturnType<typeof baseline>[]>>>();
        const calls: string[] = [];
        mocks.positions.mockImplementation((_t: string, a: Account) => {
            calls.push(`positions:${a.account_id}`);
            const d = deferred<ReturnType<typeof baseline>[]>();
            gates.set(a.account_id, d);
            return d.promise;
        });
        mocks.trades.mockImplementation(async (_t: string, a: Account) => { calls.push(`orders:${a.account_id}`); return []; });
        vi.advanceTimersByTime(1500);
        let done = false;
        const run = store.refreshTradingState('all').then(() => { done = true; });
        await flush(); await flush();
        // both accounts' positions are in flight before either answers
        expect(calls).toEqual(['positions:a', 'positions:b']);
        await act(async () => { gates.get('b')!.resolve([{ ...baseline(), id: 2, code: '2317' }]); });
        await flush();
        expect(calls).toEqual(['positions:a', 'positions:b', 'orders:b']);
        expect(done).toBe(false);
        await act(async () => { gates.get('a')!.resolve([baseline()]); await run; });
        expect(calls.slice(-1)).toEqual(['orders:a']);
        const positions = store.getTradingState().positions;
        expect(positions.map(p => `${p.account?.account_id}:${p.code}`).sort()).toEqual(['a:2330', 'b:2317']);
        expect(store.getTradingState().queries.positions.updatedAt).not.toBeNull();
    });

    it('reads funds for every signed account and preserves only the failed account snapshot', async () => {
        mocks.extraAccounts = [{ ...mocks.account, account_id: 'b' }, { ...mocks.account, account_id: 'f', account_type: 'F' }];
        mocks.balance.mockImplementation(async (a: Account) => ({ acc_balance: a.account_id === 'b' ? 200 : 100, date: '2026-09-15', errmsg: '' }));
        mocks.margin.mockResolvedValue({ equity: 300 });
        vi.advanceTimersByTime(1500);
        await act(async () => { await store.refreshTradingState('account'); });
        const before = store.getTradingState().funds!;
        expect(before.map(f => f.account.account_id)).toEqual(['a', 'b', 'f']);
        expect(before.map(f => f.balance?.acc_balance ?? f.margin?.equity)).toEqual([100, 200, 300]);
        const queries = [mocks.positions.mock.calls.length, mocks.trades.mock.calls.length];
        mocks.balance.mockImplementation(async (a: Account) => ({ acc_balance: a.account_id === 'b' ? 0 : 110, date: '2026-09-15', errmsg: a.account_id === 'b' ? 'upstream error' : '' }));
        vi.advanceTimersByTime(1500);
        await act(async () => { await store.refreshTradingState('account'); });
        const after = store.getTradingState().funds!;
        expect(after[0]!.balance!.acc_balance).toBe(110);
        expect(after[1]!.balance!.acc_balance).toBe(200);
        expect(after[1]!.error).toBeTruthy();
        expect(after[1]!.updatedAt).toBe(before[1]!.updatedAt);
        expect(store.getTradingState().queries.account.needsReconcile).toBe(true);
        expect([mocks.positions.mock.calls.length, mocks.trades.mock.calls.length]).toEqual(queries);
        const calls = mocks.balance.mock.calls.length;
        vi.advanceTimersByTime(60000);
        expect(mocks.balance.mock.calls.length).toBe(calls);
    });
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

it('applies a confirmed cancellation response without SSE or accounting queries', async () => {
    await emit(order());
    const old = store.getTradingState().trades[0]!;
    const counts = [mocks.trades.mock.calls.length, mocks.positions.mock.calls.length, mocks.balance.mock.calls.length];
    const { observeTradeMutation } = await import('./trade-mutations');
    await act(async () => {
        await observeTradeMutation(old.order.id, async () => ({ ...old, status: { ...old.status, status: 'Cancelled', cancel_quantity: 3 } }));
        vi.advanceTimersByTime(50);
    });
    expect(store.getTradingState().trades[0]!.status.status).toBe('Cancelled');
    expect([mocks.trades.mock.calls.length, mocks.positions.mock.calls.length, mocks.balance.mock.calls.length]).toEqual(counts);
});
it('preserves newer SSE when a late cancellation response arrives', async () => {
    await emit(order()); const old = store.getTradingState().trades[0]!;
    const { observeTradeMutation } = await import('./trade-mutations');
    const delayed = deferred<typeof old>();
    const request = observeTradeMutation(old.order.id, () => delayed.promise);
    await emit(deal());
    const newer = store.getTradingState().trades[0]!;
    await act(async () => { delayed.resolve({ ...old, status: { ...old.status, status: 'Cancelled', cancel_quantity: 3 } }); await request; });
    expect(store.getTradingState().trades[0]).toBe(newer);
    expect(store.getTradingState().queries.orders.needsReconcile).toBe(true);
});
it('rejects a mismatched account response for display and does not query automatically', async () => {
    await emit(order()); const old = store.getTradingState().trades[0]!;
    const { observeTradeMutation } = await import('./trade-mutations');
    await act(async () => { await observeTradeMutation(old.order.id, async () => ({ ...old,
        order: { ...old.order, account: { ...mocks.account, account_id: 'other' } },
        status: { ...old.status, status: 'Cancelled', cancel_quantity: 3 } })); });
    expect(store.getTradingState().trades[0]).toBe(old);
    expect(store.getTradingState().queries.orders.needsReconcile).toBe(true);
});
it('marks positions stale when cancellation HTTP reports a fill missing from SSE', async () => {
    await emit(order()); const old = store.getTradingState().trades[0]!;
    const positions = store.getTradingState().positions;
    const { observeTradeMutation } = await import('./trade-mutations');
    await act(async () => { await observeTradeMutation(old.order.id, async () => ({ ...old,
        status: { ...old.status, status: 'Cancelled', deal_quantity: 1, cancel_quantity: 2 } })); });
    expect(store.getTradingState().trades[0]!.status.deal_quantity).toBe(1);
    expect(store.getTradingState().positions).toBe(positions);
    expect(store.getTradingState().queries.positions.needsReconcile).toBe(true);
    expect(store.getTradingState().queries.positions.error).toContain('新增成交');
});
describe('read-back confirmed cancellation (#120 / #116)', () => {
    const reasons = (scope: 'orders' | 'positions') => store.getTradingState().queries[scope].reasons;
    const cancelled = (old: ReturnType<typeof store.getTradingState>['trades'][number], status: Record<string, unknown> = {}) =>
        ({ ...old, status: { ...old.status, status: 'Cancelled' as const, cancel_quantity: 3, order_quantity: 0, ...status } });
    it('does not raise 改刪待確認 when the Cancel report landed while the cancel was being confirmed', async () => {
        await emit(order()); const old = store.getTradingState().trades[0]!;
        const { observeTradeMutation, markConfirmedCancellation } = await import('./trade-mutations');
        const delayed = deferred<typeof old>();
        const request = observeTradeMutation(old.order.id, () => delayed.promise);
        await emit(order('new', 100, epoch + 3, 'Cancel'));
        await act(async () => { delayed.resolve(markConfirmedCancellation(cancelled(old))); await request; vi.advanceTimersByTime(50); });
        expect(reasons('orders')).not.toContain('mutation-outcome');
        expect(store.getTradingState().trades[0]!.status.status).toBe('Cancelled');
    });
    it('applies a confirmed cancellation even after unrelated reports, keeping the local order quantity', async () => {
        await emit(order()); const old = store.getTradingState().trades[0]!;
        const { observeTradeMutation, markConfirmedCancellation } = await import('./trade-mutations');
        const delayed = deferred<typeof old>();
        const request = observeTradeMutation(old.order.id, () => delayed.promise);
        await emit(order('other'));
        const queries = mocks.trades.mock.calls.length;
        await act(async () => { delayed.resolve(markConfirmedCancellation(cancelled(old))); await request; vi.advanceTimersByTime(50); });
        const row = store.getTradingState().trades.find(t => t.order.id === 'new')!;
        expect(row.status).toMatchObject({ status: 'Cancelled', cancel_quantity: 3, order_quantity: 3 });
        expect(row.order.quantity).toBe(3);
        expect(reasons('orders')).not.toContain('mutation-outcome');
        expect(mocks.trades.mock.calls.length).toBe(queries);
    });
    it('applies a confirmed zero-remaining Submitted read-back (Shioaji#234 pattern) without 改刪待確認', async () => {
        await emit(order()); const old = store.getTradingState().trades[0]!;
        const { observeTradeMutation, markConfirmedCancellation } = await import('./trade-mutations');
        await act(async () => { await observeTradeMutation(old.order.id, async () => markConfirmedCancellation(
            { ...old, status: { ...old.status, status: 'Submitted' as const, cancel_quantity: 3 } })); vi.advanceTimersByTime(50); });
        const row = store.getTradingState().trades[0]!;
        expect(row.status).toMatchObject({ status: 'Submitted', cancel_quantity: 3 });
        expect(reasons('orders')).not.toContain('mutation-outcome');
        const { remainingWorkingOrderQuantity } = await import('./working-order-quantity');
        expect(remainingWorkingOrderQuantity(row)).toBe(0);
    });
    it('falls back to 改刪待確認 when the local row already knows more fills than the read-back', async () => {
        await emit(order()); const old = store.getTradingState().trades[0]!;
        const { observeTradeMutation, markConfirmedCancellation } = await import('./trade-mutations');
        const delayed = deferred<typeof old>();
        const request = observeTradeMutation(old.order.id, () => delayed.promise);
        await emit(deal());
        await act(async () => { delayed.resolve(markConfirmedCancellation(cancelled(old))); await request; vi.advanceTimersByTime(50); });
        expect(store.getTradingState().trades[0]!.status.deal_quantity).toBe(1);
        expect(reasons('orders')).toContain('mutation-outcome');
    });
    it('an unconfirmed cancel (rejected CANCEL_UNCONFIRMED) keeps 改刪待確認', async () => {
        await emit(order()); const old = store.getTradingState().trades[0]!;
        const { observeTradeMutation } = await import('./trade-mutations');
        await act(async () => { await observeTradeMutation(old.order.id, async () => { throw Object.assign(new Error('unconfirmed'), { code: 'CANCEL_UNCONFIRMED', mutationOutcomeUnknown: true }); }).catch(() => undefined); vi.advanceTimersByTime(50); });
        expect(reasons('orders')).toContain('mutation-outcome');
        expect(store.getTradingState().trades[0]).toBe(old);
    });
});
it('replays sanitized native New with empty full_code after matching PendingSubmit HTTP metadata', async () => {
    const fixture = (await import('./fixtures/native-simulation-order-1.7.5.json')).default;
    mocks.account.account_type = 'F'; mocks.account.account_id = 'fixture'; mocks.account.broker_id = 'fixture';
    const report = normalizeOrderEvent(fixture[0])!;
    await emit(report);
    expect(store.getTradingState().trades).toHaveLength(0);
    const body = fixture[0]!.data.FuturesOrder;
    const response = { contract: {code:body.contract.code,security_type:'FUT',exchange:'TAIFEX',target_code:null},
        order: {...body.order, account:mocks.account, octype:body.order.oc_type},
        status: {id:body.order.id,status:'PendingSubmit',status_code:'',msg:'',order_quantity:body.order.quantity,
            deal_quantity:0,cancel_quantity:0,modified_price:0,deals:[]} } as import('./types/order').Trade;
    await act(async () => { mocks.response!({trade:response,account:mocks.account}); });
    expect(store.getTradingState().trades[0]!.status.status).toBe('Submitted');
    expect(store.getTradingState().trades[0]!.contract.code).toBe(body.contract.code);
    // Restore mutable fixture identity for the existing suite's next test.
    mocks.account.account_id='a'; mocks.account.broker_id='fixture';
});

// ---- Shioaji 1.7.6 event_id / trade cache health (#85 #86) ----
// Real-shape payloads captured from a 1.7.6 simulation sidecar and
// de-identified (fixtures/native-simulation-event-id-1.7.6.json).
describe('Shioaji 1.7.6 report identity and cache health', () => {
    type Wire = (typeof import('./fixtures/native-simulation-event-id-1.7.6.json'))['events'][number];
    let wire: Wire[];
    const stock = { account_type: 'S', broker_id: 'fixture', account_id: 'fixture-stock', person_id: 'fixture', signed: true, username: '' };
    const futures = { ...stock, account_type: 'F', account_id: 'fixture-futures' };
    const byId = (id: string) => wire.find(e => (e.data as unknown as Record<string, { event_id: string }>)[e.state]!.event_id === id)!;
    const body = (e: Wire) => (e.data as unknown as Record<string, Record<string, unknown>>)[e.state]!;
    // Mirrors stream.ts: admit through the ledger, drop duplicates, fan out.
    async function deliver(e: Wire | object, eventId?: string) {
        const { reportLedger } = await import('./report-ledger');
        const report = normalizeOrderEvent(e)!;
        if (eventId !== undefined) report.eventId = eventId;
        if (reportLedger.admit({ base: 'http://fixture.invalid' }, report.eventId, report.kind).duplicate) return false;
        await emit(report);
        return true;
    }
    function response(e: Wire, account: typeof stock) {
        const b = body(e) as { order: Record<string, unknown>; contract: { code: string; security_type: string; exchange: string } };
        return { account, trade: { contract: { code: b.contract.code, security_type: b.contract.security_type, exchange: b.contract.exchange, target_code: null },
            order: { ...b.order, account, octype: b.order.oc_type }, status: { id: b.order.id, status: 'PendingSubmit', status_code: '', msg: '',
                order_quantity: b.order.quantity, deal_quantity: 0, cancel_quantity: 0, modified_price: 0, deals: [] } } as unknown as import('./types/order').Trade };
    }
    const reasons = (scope: 'orders' | 'positions' | 'account') => store.getTradingState().queries[scope].reasons;
    beforeEach(async () => {
        wire = (await import('./fixtures/native-simulation-event-id-1.7.6.json')).default.events;
        Object.assign(mocks.account, stock);
        mocks.extraAccounts = [futures];
        mocks.cached.mockImplementation((code: string) => code.startsWith('TXF') ? { code, multiplier: 200 } : { code, security_type: 'STK' });
        mocks.positions.mockReset().mockResolvedValue([]);
        vi.advanceTimersByTime(1500);
        // Establish snapshots for both fixture accounts (authoritative read).
        await act(async () => { await store.refreshTradingState(); });
        mocks.trades.mockClear(); mocks.health.mockClear(); mocks.subscribe.mockClear(); mocks.positions.mockClear();
    });

    it('projects the captured reduce-then-cancel once and drops redelivered event_ids', async () => {
        await act(async () => { mocks.response!(response(byId('v1:FO:FSTREAM:RESET1:9'), futures)); });
        for (const id of [9, 10, 11]) expect(await deliver(byId(`v1:FO:FSTREAM:RESET1:${id}`))).toBe(true);
        const settled = store.getTradingState().trades.find(t => t.order.id === 'fx04')!;
        expect(settled.status).toMatchObject({ status: 'Cancelled', cancel_quantity: 2, deal_quantity: 0 });
        expect(settled.order.quantity).toBe(2);
        for (const id of [9, 10, 11]) expect(await deliver(byId(`v1:FO:FSTREAM:RESET1:${id}`))).toBe(false);
        expect(store.getTradingState().trades.find(t => t.order.id === 'fx04')).toBe(settled);
        expect(reasons('orders')).toEqual([]);
        expect(mocks.trades).not.toHaveBeenCalled(); expect(mocks.health).not.toHaveBeenCalled();
    });

    it('applies futures New/Cover fills once by event_id, with exchange_seq as the fallback identity', async () => {
        for (const id of [12, 13]) await act(async () => { mocks.response!(response(byId(`v1:FO:FSTREAM:RESET1:${id}`), futures)); });
        await deliver(byId('v1:FO:FSTREAM:RESET1:12'));
        await deliver(byId('v1:FD:FSTREAM:RESET1:8'));
        const open = () => store.getTradingState().positions.filter(p => p.code === 'TXFJ6');
        expect(open()).toHaveLength(1); expect(open()[0]).toMatchObject({ quantity: 1, direction: 'Buy', price: 48284 });
        // Same event_id again: dropped at admission.
        expect(await deliver(byId('v1:FD:FSTREAM:RESET1:8'))).toBe(false);
        // Different event_id, same fill (exchange_seq + trade): not applied twice.
        expect(await deliver(byId('v1:FD:FSTREAM:RESET1:8'), 'v1:FD:FSTREAM:RESET1:99')).toBe(true);
        // Empty historical ID: no ID dedup, the exchange_seq path still holds.
        expect(await deliver(byId('v1:FD:FSTREAM:RESET1:8'), '')).toBe(true);
        expect(open()[0]!.quantity).toBe(1);
        expect(store.getTradingState().trades.find(t => t.order.id === 'fx05')!.status).toMatchObject({ status: 'Filled', deal_quantity: 1 });
        await deliver(byId('v1:FO:FSTREAM:RESET1:13'));
        await deliver(byId('v1:FD:FSTREAM:RESET1:9'));
        expect(open()).toHaveLength(0);
        expect(reasons('positions')).not.toContain('unknown-fill');
    });

    it('keeps deal-before-order as metadata-missing and clears only that reason on replay', async () => {
        await deliver({ state: 'StockOrder', data: { StockOrder: { ...body(byId('v1:SO:SSTREAM:RESET1:1')), event_id: 'opaque-report' } } });
        expect(reasons('orders')).toEqual(expect.arrayContaining(['untrackable-event']));
        await deliver(byId('v1:SD:SSTREAM:RESET1:3'));
        expect(reasons('orders')).toContain('metadata-missing');
        await deliver(byId('v1:SO:SSTREAM:RESET1:3'));
        expect(reasons('orders')).not.toContain('metadata-missing');
        expect(reasons('orders')).toContain('untrackable-event');
        expect(store.getTradingState().positions.find(p => p.code === '2890')).toMatchObject({ quantity: 1000 });
    });

    it('waits for a late report before calling a gap, without any query', async () => {
        await act(async () => { mocks.response!(response(byId('v1:FO:FSTREAM:RESET1:9'), futures)); });
        await deliver(byId('v1:FO:FSTREAM:RESET1:9'));
        await deliver(byId('v1:FO:FSTREAM:RESET1:11'));
        await deliver(byId('v1:FO:FSTREAM:RESET1:10'));
        await act(async () => { vi.advanceTimersByTime(2000); });
        expect(reasons('orders')).not.toContain('sequence-gap');
        expect(mocks.health).not.toHaveBeenCalled();
    });

    it('surfaces a persistent gap, reads cache health once, and resyncs orders cache-only when Healthy', async () => {
        await act(async () => { mocks.response!(response(byId('v1:FO:FSTREAM:RESET1:9'), futures)); });
        await deliver(byId('v1:FO:FSTREAM:RESET1:9'));
        await deliver(byId('v1:FO:FSTREAM:RESET1:11')); // UpdateQty 10 missing
        expect(reasons('orders')).toContain('projection-failed');
        // Server cache already projected all three (observed 1.7.6 cache row).
        const cached = { ...store.getTradingState().trades.find(t => t.order.id === 'fx04')!, account: undefined };
        mocks.trades.mockImplementation(async (type: string) => type === 'F' ? [{ ...cached, order: { ...cached.order, account: futures },
            status: { ...cached.status, status: 'Cancelled', order_quantity: 0, cancel_quantity: 2 } }] : []);
        await act(async () => { vi.advanceTimersByTime(1500); });
        await act(async () => { await Promise.resolve(); await Promise.resolve(); vi.advanceTimersByTime(50); });
        await vi.waitFor(() => expect(reasons('orders')).toEqual([]));
        expect(mocks.health).toHaveBeenCalledTimes(2);
        expect(mocks.trades.mock.calls.map(c => c[2])).toEqual([{ refresh: false }, { refresh: false }]);
        expect(store.getTradingState().trades.find(t => t.order.id === 'fx04')!.status).toMatchObject({ status: 'Cancelled', cancel_quantity: 2 });
        expect(mocks.positions).not.toHaveBeenCalled();
    });

    it('maps Degraded reasons per tab; a manual orders reconcile clears orders only', async () => {
        mocks.health.mockResolvedValue({ state: 'Degraded', reasons: [{ event_type: 'FuturesDeal', reason: 'SequenceGap' }, { event_type: 'StockOrder', reason: 'PendingReport' }] });
        await act(async () => { await store.checkTradeCacheHealth('gap'); });
        expect(reasons('orders')).toEqual(['sequence-gap', 'pending-report']);
        expect(reasons('positions')).toEqual(['sequence-gap']);
        expect(mocks.trades).not.toHaveBeenCalled(); // Degraded: no cache resync
        mocks.health.mockResolvedValue({ state: 'Healthy', reasons: [] });
        vi.advanceTimersByTime(1500);
        await act(async () => { await store.refreshTradingState('orders'); });
        expect(mocks.trades.mock.calls.map(c => c[2])).toEqual([{ refresh: true }, { refresh: true }]);
        expect(reasons('orders')).toEqual([]);
        expect(reasons('positions')).toEqual(['sequence-gap']);
        expect(mocks.health).toHaveBeenCalledTimes(4); // (gap + post-manual check) × 2 accounts
    });

    it('cancel confirmation stops trusting the cache when the stream goes stale, like down', async () => {
        expect(store.cancelCacheTrusted()).toBe(true);
        await act(async () => { mocks.status = 'stale'; mocks.statusChanged!(); });
        expect(store.cancelCacheTrusted()).toBe(false);
        await act(async () => { mocks.status = 'down'; mocks.statusChanged!(); });
        expect(store.cancelCacheTrusted()).toBe(false);
    });

    it('a confirmed cancel clears that order\'s earlier 改刪待確認 cause and nothing else', async () => {
        await act(async () => { mocks.response!(response(byId('v1:FO:FSTREAM:RESET1:9'), futures)); });
        await deliver(byId('v1:FO:FSTREAM:RESET1:9'));
        const { observeTradeMutation, markConfirmedCancellation } = await import('./trade-mutations');
        const known = () => store.getTradingState().trades.find(t => t.order.id === 'fx04')!;
        const unconfirmed = async (id: string) => act(async () => {
            await observeTradeMutation(id, async () => { throw new Error('timeout'); }).catch(() => undefined); vi.advanceTimersByTime(50); });
        const confirmFx04 = async () => act(async () => {
            const k = known();
            await observeTradeMutation('fx04', async () => markConfirmedCancellation({ ...k, status: { ...k.status, status: 'Cancelled' as const, cancel_quantity: k.order.quantity } }));
            vi.advanceTimersByTime(50); });
        await unconfirmed('fx04');
        expect(reasons('orders')).toContain('mutation-outcome');
        // A price-change intent for fx04 (as broadcast from a popout) is also dropped.
        const intents = await import('./mutation-intent');
        intents.noteMutationIntent('fx04', { kind: 'price', price: 1 });
        await confirmFx04();
        expect(intents.takeMutationIntent('fx04')).toBeUndefined();
        expect(known().status.status).toBe('Cancelled');
        expect(reasons('orders')).not.toContain('mutation-outcome');
        // Another order's open cause is untouched by fx04's confirmation.
        await unconfirmed('other-order');
        await confirmFx04();
        expect(reasons('orders')).toContain('mutation-outcome');
    });

    it('after a reconnect on the same sidecar, clears the orders disconnect cache-only and keeps positions/account', async () => {
        await act(async () => { mocks.status = 'down'; mocks.statusChanged!(); });
        for (const scope of ['orders', 'positions', 'account'] as const) expect(reasons(scope)).toContain('disconnect');
        expect(store.tradeCacheContinuous()).toBe(false);
        await act(async () => { mocks.status = 'live'; mocks.statusChanged!(); });
        await vi.waitFor(() => expect(reasons('orders')).not.toContain('disconnect'));
        expect(reasons('positions')).toContain('disconnect');
        expect(reasons('account')).toContain('disconnect');
        expect(mocks.subscribe).not.toHaveBeenCalled();
        expect(mocks.trades.mock.calls.map(c => c[2])).toEqual([{ refresh: false }, { refresh: false }]);
        expect(mocks.positions).not.toHaveBeenCalled();
        expect(store.tradeCacheContinuous()).toBe(true);
    });

    it('reconnect after a restart subscribes exactly once, also with a confirmed cancel and a stale phase in between', async () => {
        await act(async () => { mocks.response!(response(byId('v1:FO:FSTREAM:RESET1:9'), futures)); });
        await deliver(byId('v1:FO:FSTREAM:RESET1:9'));
        mocks.subscribe.mockClear();
        mocks.health.mockResolvedValue({ state: 'Unknown', reasons: [{ event_type: 'FuturesOrder', reason: 'NotSubscribed' }] });
        await act(async () => { mocks.status = 'stale'; mocks.statusChanged!(); });
        await act(async () => { mocks.status = 'down'; mocks.statusChanged!(); });
        const { observeTradeMutation, markConfirmedCancellation } = await import('./trade-mutations');
        const k = store.getTradingState().trades.find(t => t.order.id === 'fx04')!;
        await act(async () => { mocks.status = 'live'; mocks.statusChanged!(); });
        await act(async () => {
            await observeTradeMutation('fx04', async () => markConfirmedCancellation({ ...k, status: { ...k.status, status: 'Cancelled' as const, cancel_quantity: k.order.quantity } }));
            await vi.advanceTimersByTimeAsync(30_000);
        });
        expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    });

    it('treats a lost subscription after reconnect as a restarted sidecar: resubscribe, no cache resync', async () => {
        mocks.health.mockResolvedValue({ state: 'Unknown', reasons: [{ event_type: 'FuturesOrder', reason: 'NotSubscribed' }] });
        await act(async () => { mocks.status = 'down'; mocks.statusChanged!(); });
        await act(async () => { mocks.status = 'live'; mocks.statusChanged!(); });
        await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce());
        expect(mocks.trades).not.toHaveBeenCalled();
        expect(reasons('orders')).toContain('disconnect');
        // Later Healthy (baselines rebuilt by new reports) must not trust a
        // cache that never saw update_status on this instance.
        mocks.health.mockResolvedValue({ state: 'Healthy', reasons: [] });
        await act(async () => { vi.advanceTimersByTime(3000); await store.checkTradeCacheHealth('gap'); });
        expect(mocks.trades).not.toHaveBeenCalled();
        expect(store.tradeCacheContinuous()).toBe(false);
        expect(reasons('orders')).toContain('disconnect');
    });

    it('keeps unresolved reasons when a refresh kept the old view because reports raced it', async () => {
        await act(async () => { mocks.response!(response(byId('v1:FO:FSTREAM:RESET1:9'), futures)); });
        await deliver(byId('v1:FO:FSTREAM:RESET1:9'));
        const { observeTradeMutation } = await import('./trade-mutations');
        const known = store.getTradingState().trades.find(t => t.order.id === 'fx04')!;
        await act(async () => { await observeTradeMutation('fx04', async () => ({ ...known, status: { ...known.status, status: 'Submitted' } })); vi.advanceTimersByTime(50); });
        expect(reasons('orders')).toContain('mutation-outcome');
        const pending = deferred<never[]>();
        mocks.trades.mockImplementation(() => pending.promise);
        vi.advanceTimersByTime(1500);
        let refresh!: Promise<void>;
        await act(async () => { refresh = store.refreshTradingState('orders'); });
        // An order response lands mid-read: the merge is not applied.
        await act(async () => { mocks.response!(response(byId('v1:FO:FSTREAM:RESET1:12'), futures)); });
        await act(async () => { pending.resolve([]); await refresh; });
        expect(reasons('orders')).toEqual(expect.arrayContaining(['mutation-outcome', 'overflow']));
        expect(store.tradeCacheContinuous()).toBe(true); // baseline from beforeEach, not from this kept read
    });

    it('does not let an App replay clear a server-reported cause of the same reason', async () => {
        mocks.health.mockResolvedValue({ state: 'Degraded', reasons: [{ event_type: 'FuturesOrder', reason: 'PendingReport' }] });
        await act(async () => { await store.checkTradeCacheHealth('gap'); });
        await deliver(byId('v1:FO:FSTREAM:RESET1:12')); // New with empty full_code, unknown order
        expect(store.getTradingState().queries.orders.error).toContain('尚無對應委託');
        await act(async () => { mocks.response!(response(byId('v1:FO:FSTREAM:RESET1:12'), futures)); vi.advanceTimersByTime(50); });
        expect(store.getTradingState().queries.orders.error).not.toContain('尚無對應委託');
        expect(reasons('orders')).toContain('pending-report'); // the server cause remains
    });

    it('stops trusting the cache and resubscribes when the reconnect health read fails', async () => {
        mocks.health.mockRejectedValue(new Error('sidecar booting'));
        await act(async () => { mocks.status = 'down'; mocks.statusChanged!(); });
        await act(async () => { mocks.status = 'live'; mocks.statusChanged!(); });
        await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce());
        expect(store.tradeCacheContinuous()).toBe(false);
        mocks.health.mockResolvedValue({ state: 'Healthy', reasons: [] });
        await act(async () => { vi.advanceTimersByTime(3000); await store.checkTradeCacheHealth('gap'); });
        expect(mocks.trades).not.toHaveBeenCalled();
        expect(reasons('orders')).toContain('disconnect');
    });

    // Review findings on PR #128 (head 2b8bd09), turned into regressions.
    it('an orders-only refresh inside the grace window still flags a deal-stream gap on positions', async () => {
        vi.advanceTimersByTime(1500);
        await deliver(byId('v1:SD:SSTREAM:RESET1:1'));
        await deliver(byId('v1:SD:SSTREAM:RESET1:3')); // SD:2 missing -> deal gap
        await act(async () => { await store.refreshTradingState('orders'); });
        await act(async () => { vi.advanceTimersByTime(5000); });
        expect(reasons('positions')).toContain('sequence-gap');
        expect(reasons('orders')).not.toContain('sequence-gap'); // update_status covered it
    });
    it('without a refresh the deal gap flags positions after the grace window', async () => {
        await deliver(byId('v1:SD:SSTREAM:RESET1:1'));
        await deliver(byId('v1:SD:SSTREAM:RESET1:3'));
        await act(async () => { vi.advanceTimersByTime(5000); });
        expect(reasons('positions')).toContain('sequence-gap');
    });
    it('treats NoBaseline after reconnect as a restart and never drops a working order on a later cache resync', async () => {
        await act(async () => { mocks.response!(response(byId('v1:FO:FSTREAM:RESET1:9'), futures)); });
        await deliver(byId('v1:FO:FSTREAM:RESET1:9'));
        expect(store.getTradingState().trades.some(t => t.order.id === 'fx04')).toBe(true);
        // Sidecar restarted outside the App; another client re-subscribed first.
        mocks.health.mockResolvedValue({ state: 'Unknown', reasons: [{ event_type: 'FuturesOrder', reason: 'NoBaseline' }] });
        await act(async () => { mocks.status = 'down'; mocks.statusChanged!(); });
        await act(async () => { mocks.status = 'live'; mocks.statusChanged!(); });
        await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce());
        expect(store.hasOrdersBaseline()).toBe(false);
        // Later Healthy reconnect with an empty fresh cache: no cache resync.
        mocks.health.mockResolvedValue({ state: 'Healthy', reasons: [] });
        mocks.trades.mockResolvedValue([]);
        await act(async () => { mocks.status = 'down'; mocks.statusChanged!(); });
        await act(async () => { mocks.status = 'live'; mocks.statusChanged!(); });
        await act(async () => { await Promise.resolve(); await Promise.resolve(); vi.advanceTimersByTime(50); });
        expect(mocks.trades).not.toHaveBeenCalled();
        expect(store.getTradingState().trades.some(t => t.order.id === 'fx04')).toBe(true);
        expect(store.tradeCacheContinuous()).toBe(false);
        expect(reasons('orders')).toContain('disconnect');
    });
    it('a cache resync only adds/updates rows: a working order missing from the cache is kept and flagged', async () => {
        await act(async () => { mocks.response!(response(byId('v1:FO:FSTREAM:RESET1:9'), futures)); });
        await deliver(byId('v1:FO:FSTREAM:RESET1:9'));
        mocks.trades.mockResolvedValue([]); // cache lacks fx04 although baseline looked continuous
        await act(async () => { mocks.status = 'down'; mocks.statusChanged!(); });
        await act(async () => { mocks.status = 'live'; mocks.statusChanged!(); });
        await vi.waitFor(() => expect(mocks.trades).toHaveBeenCalled());
        await act(async () => { await Promise.resolve(); vi.advanceTimersByTime(50); });
        expect(mocks.trades.mock.calls.every(c => c[2]?.refresh === false)).toBe(true);
        const kept = store.getTradingState().trades.find(t => t.order.id === 'fx04')!;
        expect(kept.status.status).toBe('Submitted');
        expect(reasons('orders')).toEqual(expect.arrayContaining(['disconnect', 'projection-failed']));
        expect(store.hasOrdersBaseline()).toBe(false);
        expect(store.tradeCacheContinuous()).toBe(false);
    });
    it('backs off gap-triggered health reads while every cache stays Healthy', async () => {
        mocks.health.mockResolvedValue({ state: 'Healthy', reasons: [] });
        const waits: number[] = [];
        for (let i = 0; i < 4; i++) {
            const calls = mocks.health.mock.calls.length;
            let waited = 0;
            await act(async () => {
                const run = store.checkTradeCacheHealth('gap');
                while (mocks.health.mock.calls.length === calls) { vi.advanceTimersByTime(500); waited += 500; await Promise.resolve(); }
                await run;
            });
            waits.push(waited);
        }
        // First read waits out the base interval; each further Healthy result doubles it.
        expect(waits[1]).toBeGreaterThanOrEqual(6000);
        expect(waits[2]).toBeGreaterThan(waits[1]!);
        expect(waits[3]).toBeGreaterThan(waits[2]!);
        mocks.health.mockResolvedValue({ state: 'Degraded', reasons: [{ event_type: 'FuturesOrder', reason: 'SequenceGap' }] });
        await act(async () => { const run = store.checkTradeCacheHealth('reconnect'); await run; });
        const calls = mocks.health.mock.calls.length; let waited = 0;
        await act(async () => { const run = store.checkTradeCacheHealth('gap'); while (mocks.health.mock.calls.length === calls) { vi.advanceTimersByTime(500); waited += 500; await Promise.resolve(); } await run; });
        expect(waited).toBeLessThanOrEqual(3000); // streak reset by a non-gap read
    });

    it('a STALE stream (watchdog) raises possible-missed-report reasons and reconnects through the health path', async () => {
        await act(async () => { mocks.status = 'stale'; mocks.statusChanged!(); });
        for (const scope of ['orders', 'positions'] as const) {
            expect(reasons(scope)).toContain('disconnect');
            expect(store.getTradingState().queries[scope].error).toContain('可能漏收回報');
        }
        expect(store.tradeCacheContinuous()).toBe(false);
        expect(mocks.health).not.toHaveBeenCalled(); expect(mocks.trades).not.toHaveBeenCalled(); expect(mocks.positions).not.toHaveBeenCalled();
        // Restarted sidecar: reconnect sees NoBaseline -> restart handling, no cache resync.
        mocks.health.mockResolvedValue({ state: 'Unknown', reasons: [{ event_type: 'FuturesOrder', reason: 'NoBaseline' }] });
        await act(async () => { mocks.status = 'live'; mocks.statusChanged!(); });
        await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledOnce());
        expect(mocks.health).toHaveBeenCalled();
        expect(store.hasOrdersBaseline()).toBe(false);
        expect(mocks.trades).not.toHaveBeenCalled();
        expect(reasons('orders')).toContain('disconnect'); // not silently continuous
        expect(reasons('positions')).toContain('disconnect');
    });

    describe('change confirmed by a later report for the same order', () => {
        async function mutate(call: () => Promise<unknown>) {
            await act(async () => { await call(); vi.advanceTimersByTime(50); });
        }
        async function working() {
            await act(async () => { mocks.response!(response(byId('v1:FO:FSTREAM:RESET1:9'), futures)); });
            await deliver(byId('v1:FO:FSTREAM:RESET1:9'));
            return store.getTradingState().trades.find(t => t.order.id === 'fx04')!;
        }
        const reply = (t: import('./types/order').AccountedTrade) => ({ ...t, status: { ...t.status, status: 'PendingSubmit' as const } });
        it('clears 改刪待確認 for that order only when the UpdateQty report carries the requested reduction', async () => {
            const known = await working();
            const { observeTradeMutation } = await import('./trade-mutations');
            const { noteMutationIntent } = await import('./mutation-intent');
            await mutate(() => observeTradeMutation('fx04', async () => { noteMutationIntent('fx04', { kind: 'qty', quantity: 1 }); return reply(known); }));
            // A second, unrelated order also waits.
            await mutate(() => observeTradeMutation('other', async () => { noteMutationIntent('other', { kind: 'price', price: 1 }); return reply({ ...known, order: { ...known.order, id: 'other' } }); }));
            expect(reasons('orders')).toContain('mutation-outcome');
            await deliver(byId('v1:FO:FSTREAM:RESET1:10')); // UpdateQty cancel_quantity 1
            expect(reasons('orders')).toContain('mutation-outcome'); // 'other' still unconfirmed
        });
        it('clears the reason when the only unconfirmed change is confirmed', async () => {
            const known = await working();
            const { observeTradeMutation } = await import('./trade-mutations');
            const { noteMutationIntent } = await import('./mutation-intent');
            await mutate(() => observeTradeMutation('fx04', async () => { noteMutationIntent('fx04', { kind: 'qty', quantity: 1 }); return reply(known); }));
            expect(reasons('orders')).toContain('mutation-outcome');
            await deliver(byId('v1:FO:FSTREAM:RESET1:10'));
            expect(reasons('orders')).not.toContain('mutation-outcome');
        });
        it('confirms when the matching report arrived before the HTTP reply', async () => {
            const known = await working();
            const { observeTradeMutation } = await import('./trade-mutations');
            const { noteMutationIntent } = await import('./mutation-intent');
            await mutate(() => observeTradeMutation('fx04', async () => {
                noteMutationIntent('fx04', { kind: 'qty', quantity: 1 });
                await deliver(byId('v1:FO:FSTREAM:RESET1:10')); // report beats the reply
                return reply(known);
            }));
            expect(reasons('orders')).not.toContain('mutation-outcome');
        });
        it('does not confirm from a report that predates the mutation', async () => {
            const known = await working();
            await deliver(byId('v1:FO:FSTREAM:RESET1:10')); // an earlier reduction by 1
            const { observeTradeMutation } = await import('./trade-mutations');
            const { noteMutationIntent } = await import('./mutation-intent');
            const current = store.getTradingState().trades.find(t => t.order.id === 'fx04') ?? known;
            await mutate(() => observeTradeMutation('fx04', async () => { noteMutationIntent('fx04', { kind: 'qty', quantity: 1 }); return reply(current); }));
            expect(reasons('orders')).toContain('mutation-outcome');
        });
        it('keeps the reason when the report does not match the request', async () => {
            const known = await working();
            const { observeTradeMutation } = await import('./trade-mutations');
            const { noteMutationIntent } = await import('./mutation-intent');
            await mutate(() => observeTradeMutation('fx04', async () => { noteMutationIntent('fx04', { kind: 'qty', quantity: 2 }); return reply(known); }));
            await deliver(byId('v1:FO:FSTREAM:RESET1:10')); // reduced by 1, not 2
            expect(reasons('orders')).toContain('mutation-outcome');
        });
        it('confirms a price change from UpdatePrice modified_price', async () => {
            const known = await working();
            const { observeTradeMutation } = await import('./trade-mutations');
            const { noteMutationIntent } = await import('./mutation-intent');
            await mutate(() => observeTradeMutation('fx04', async () => { noteMutationIntent('fx04', { kind: 'price', price: 46990 }); return reply(known); }));
            const body = byId('v1:FO:FSTREAM:RESET1:7').data as unknown as { FuturesOrder: Record<string, Record<string, unknown>> };
            const b = body.FuturesOrder;
            await deliver({ state: 'FuturesOrder', data: { FuturesOrder: { ...b, event_id: 'v1:FO:FSTREAM:RESET1:30',
                order: { ...b.order, id: 'fx04', seqno: 'fx04', ordno: (known.order.ordno), quantity: 2 },
                status: { ...b.status, id: 'fx04', order_quantity: 2, exchange_ts: (b.status!.exchange_ts as number) + 100 } } } });
            expect(store.getTradingState().trades.find(t => t.order.id === 'fx04')!.status.modified_price).toBe(46990);
            expect(reasons('orders')).not.toContain('mutation-outcome');
        });
    });

    it('never polls health or trades on a timer', async () => {
        await act(async () => { vi.advanceTimersByTime(120000); });
        expect(mocks.health).not.toHaveBeenCalled(); expect(mocks.trades).not.toHaveBeenCalled();
    });
});
