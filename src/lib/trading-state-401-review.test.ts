import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeOrderEvent, type OrderEventReport } from './order-report';
import type { TradeObservation } from './trade-observations';
import type { Account } from './types/portfolio';

const mocks = vi.hoisted(() => ({
    extraAccounts: [] as Account[],
    status: 'live', order: null as ((r: OrderEventReport) => void) | null,
    statusChanged: null as (() => void) | null,
    tick: null as ((t: { code: string; close: string; simtrade?: boolean }) => void) | null,
    response: null as ((value: TradeObservation) => void) | null,
    ensure: vi.fn(), cached: vi.fn(),
    positions: vi.fn(), trades: vi.fn(), balance: vi.fn(), margin: vi.fn(), subscribe: vi.fn(), health: vi.fn(),
    account: { account_type: 'S', broker_id: 'fixture', account_id: 'a', person_id: 'fixture', signed: true, username: 'fixture' },
}));
vi.mock('./account-store', () => ({ useAccounts: () => ({ accounts: [mocks.account, ...mocks.extraAccounts], selectedStock: mocks.account, selectedFutures: null }), getAccountState: () => ({ accounts: [mocks.account, ...mocks.extraAccounts] }), refreshAccounts: vi.fn(), subscribeAccounts: () => () => undefined }));
vi.mock('./runtime', () => ({ getApiBase: () => 'http://fixture.invalid' }));
vi.mock('./boot', () => ({ subscribeTradeReports: mocks.subscribe }));
vi.mock('./trade-observations', () => ({ onTradeResponse: (cb: typeof mocks.response) => { mocks.response = cb; return vi.fn(); } }));
vi.mock('./contracts-cache', () => ({ ensureContract: mocks.ensure, getCachedContract: mocks.cached }));
vi.mock('./quote-ownership', () => ({ retainQuote: () => vi.fn() }));
vi.mock('./shioaji', () => ({ fetchPositions: mocks.positions, fetchTrades: mocks.trades, fetchAccountBalance: mocks.balance, fetchMargin: mocks.margin, fetchTradeCacheHealth: mocks.health }));
vi.mock('./stream', () => ({ ensureStream: vi.fn(), getStreamStatus: () => mocks.status, isStreamOwner: () => false,
    onOrderEvent: (cb: typeof mocks.order) => { mocks.order = cb; return vi.fn(); },
    onAnyTick: (cb: typeof mocks.tick) => { mocks.tick = cb; return vi.fn(); }, onOddLotTick: () => vi.fn(), onAnyBidAsk: () => vi.fn(), subscribeStatusStore: (cb: typeof mocks.statusChanged) => { mocks.statusChanged = cb; return vi.fn(); },
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
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
let root: ReactTestRenderer | undefined;
let store: typeof import('./trading-state');
async function emit(report: OrderEventReport) { await act(async () => { mocks.order!(report); vi.advanceTimersByTime(50); }); }
function stockFill(fields: Record<string, unknown> = {}) {
    return normalizeOrderEvent({ state: 'StockDeal', data: { StockDeal: {
        trade_id: 'new', seqno: 'new', ordno: 'new', exchange_seq: 'f1', broker_id: 'fixture', account_id: 'a',
        code: '2330', action: 'Buy', price: 101, quantity: 1, order_lot: 'Common', order_cond: 'Cash', ts: epoch + 10, ...fields,
    } } })!;
}
async function stockOrder(fields: Record<string, unknown> = {}) {
    const wire = order().raw as { data: { StockOrder: { order: Record<string, unknown> } } };
    Object.assign(wire.data.StockOrder.order, fields);
    await emit(normalizeOrderEvent(wire)!);
}
async function recovery() { await act(async () => { await vi.advanceTimersByTimeAsync(300); }); }
beforeEach(async () => {
    vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(epoch * 1000);
    vi.stubGlobal('navigator', { locks: { request: (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}) } });
    vi.stubGlobal('BroadcastChannel', undefined); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.status = 'live'; mocks.order = null; mocks.statusChanged = null; mocks.tick = null; mocks.response = null; mocks.account.account_type = 'S';
    mocks.account.account_id = 'a'; mocks.account.broker_id = 'fixture';
    mocks.account.signed = true;
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

// ---- Adversarial review of PR #411 (#401). Each test asserts the desired
// behavior; a failure demonstrates the finding. ----
const futOrder = async (id: string, action: string, oc_type: string) => {
    const old = (order().raw as { data: { StockOrder: Record<string, unknown> } }).data.StockOrder;
    await emit(normalizeOrderEvent({ state: 'FuturesOrder', data: { FuturesOrder: { ...old,
        order: { ...(old.order as object), id, seqno: id, ordno: id, action, oc_type, quantity: 5 },
        status: { exchange_ts: epoch + 2, order_quantity: 5, cancel_quantity: 0, modified_price: 0 },
        contract: { code: 'TXF', full_code: 'TXFI6', security_type: 'FUT', exchange: 'TAIFEX' },
    } } })!);
};
const futFill = (id: string, seq: string, action: string, ts: number, price: number, quantity = 1) => normalizeOrderEvent({ state: 'FuturesDeal', data: { FuturesDeal: {
    trade_id: id, seqno: id, ordno: id, exchange_seq: seq, broker_id: 'fixture', account_id: 'a',
    code: 'TXF', full_code: 'TXFI6', action, price, quantity, ts: epoch + ts,
} } })!;

describe('PR #411 review', () => {
    it('R1 futures market order filling at two prices in the same second still projects (no 待對帳 / no forced query)', async () => {
        mocks.account.account_type = 'F';
        mocks.positions.mockResolvedValue([]);
        mocks.cached.mockReturnValue({ code: 'TXFI6', multiplier: 200 });
        vi.advanceTimersByTime(1500);
        await act(async () => { await store.refreshTradingState('positions'); });
        await futOrder('mkt', 'Buy', 'New');
        // one MKT Buy 5 sweeps two price levels; deal ts is whole seconds
        await emit(futFill('mkt', '000001', 'Buy', 10, 100, 3));
        await emit(futFill('mkt', '000002', 'Buy', 10, 101, 2));
        const before = mocks.positions.mock.calls.length;
        expect(store.getTradingState().positions).toEqual([expect.objectContaining({ direction: 'Buy', quantity: 5 })]);
        expect(store.getTradingState().positions[0]).not.toHaveProperty('reconcileReason');
        await recovery();
        expect(mocks.positions.mock.calls.length).toBe(before);
    });

    it.each([1, 5])('only reconciles a later FIFO close when the tied opening prices affect the remaining cost (close %i)', async quantity => {
        mocks.account.account_type = 'F';
        mocks.positions.mockResolvedValue([]);
        mocks.cached.mockReturnValue({ code: 'TXFI6', multiplier: 200 });
        vi.advanceTimersByTime(1500);
        await act(async () => { await store.refreshTradingState('positions'); });
        await futOrder('open', 'Buy', 'New');
        await futOrder('close', 'Sell', 'Cover');
        await emit(futFill('open', 'a', 'Buy', 10, 100, 3));
        await emit(futFill('open', 'b', 'Buy', 10, 101, 2));
        const before = mocks.positions.mock.calls.length;
        await emit(futFill('close', 'c', 'Sell', 11, 102, quantity));
        if (quantity === 5) {
            expect(store.getTradingState().positions).toEqual([]);
            expect(store.getTradingState().queries.positions.needsReconcile).toBe(false);
            await recovery();
            expect(mocks.positions.mock.calls.length).toBe(before);
        } else {
            expect(store.getTradingState().positions[0]).toMatchObject({ quantity: 5, reconcileReason: expect.any(String) });
        }
    });

    it('a failed futures cover does not poison a later valid opening in the same book', async () => {
        mocks.account.account_type = 'F';
        mocks.positions.mockResolvedValue([]);
        mocks.cached.mockReturnValue({ code: 'TXFI6', multiplier: 200 });
        vi.advanceTimersByTime(1500);
        await act(async () => { await store.refreshTradingState('positions'); });
        await futOrder('bad', 'Sell', 'Cover');
        await futOrder('good', 'Buy', 'New');
        await emit(futFill('bad', 'a', 'Sell', 10, 100));
        await emit(futFill('good', 'b', 'Buy', 11, 101));
        expect(store.getTradingState().positions[0]).toMatchObject({ quantity: 1, direction: 'Buy', reconcileReason: expect.any(String) });
    });

    it('independent opposite New fills in the same second both open their own futures side', async () => {
        mocks.account.account_type = 'F';
        mocks.positions.mockResolvedValue([]);
        mocks.cached.mockReturnValue({ code: 'TXFI6', multiplier: 200 });
        vi.advanceTimersByTime(1500);
        await act(async () => { await store.refreshTradingState('positions'); });
        await futOrder('long', 'Buy', 'New');
        await futOrder('short', 'Sell', 'New');
        await emit(futFill('long', 'a', 'Buy', 10, 100));
        await emit(futFill('short', 'b', 'Sell', 10, 101));
        expect(store.getTradingState().positions.map(p => [p.direction, p.quantity])).toEqual([['Buy', 1], ['Sell', 1]]);
        expect(store.getTradingState().queries.positions.needsReconcile).toBe(false);
    });

    it('R2 a manual orders refresh is not swallowed by an in-flight position recovery read', async () => {
        vi.advanceTimersByTime(1500);
        await stockOrder({ action: 'Sell' });
        const pending = deferred<unknown[]>();
        mocks.positions.mockImplementationOnce(() => pending.promise);
        await emit(stockFill({ action: 'Sell' })); // day-short flag unknown -> recovery read
        await act(async () => { await vi.advanceTimersByTimeAsync(260); }); // recovery now in flight
        const tradesBefore = mocks.trades.mock.calls.length;
        let p!: Promise<void>;
        await act(async () => { p = store.refreshTradingState('orders'); });
        await act(async () => { pending.resolve([baseline()]); await p; });
        expect(mocks.trades.mock.calls.length).toBe(tradesBefore + 1);
    });

    it('merges concurrent orders/all requests behind recovery and honors each remaining scope once', async () => {
        vi.advanceTimersByTime(1500);
        await stockOrder({ action: 'Sell' });
        const pending = deferred<unknown[]>();
        mocks.positions.mockImplementationOnce(() => pending.promise);
        await emit(stockFill({ action: 'Sell' }));
        await act(async () => { await vi.advanceTimersByTimeAsync(260); });
        const before = [mocks.positions, mocks.trades, mocks.balance].map(fn => fn.mock.calls.length);
        const orders = store.refreshTradingState('orders');
        const all = store.refreshTradingState('all');
        await act(async () => { pending.resolve([baseline()]); await Promise.all([orders, all]); });
        expect([mocks.positions, mocks.trades, mocks.balance].map((fn, i) => fn.mock.calls.length - before[i]!)).toEqual([0, 1, 1]);
    });

    it('a partial-account recovery cannot swallow a manual positions refresh for all accounts', async () => {
        mocks.extraAccounts = [{ ...mocks.account, account_id: 'b' }];
        vi.advanceTimersByTime(1500);
        await act(async () => { await store.refreshTradingState('positions'); });
        vi.advanceTimersByTime(1500);
        await stockOrder({ action: 'Sell' });
        const pending = deferred<unknown[]>();
        mocks.positions.mockImplementationOnce(() => pending.promise);
        await emit(stockFill({ action: 'Sell' }));
        await act(async () => { await vi.advanceTimersByTimeAsync(260); });
        const before = mocks.positions.mock.calls.length;
        const refresh = store.refreshTradingState('positions');
        await act(async () => { pending.resolve([baseline()]); await refresh; });
        expect(mocks.positions.mock.calls.slice(before).map(c => c[1].account_id)).toEqual(['a', 'b']);
    });

    it('R3 a fill for a non-tradable (unsigned) account does not leave positions 待對帳 forever', async () => {
        mocks.extraAccounts = [{ ...mocks.account, account_id: 'u', signed: false }];
        vi.advanceTimersByTime(1500);
        await emit(stockFill({ account_id: 'u', trade_id: 'x', exchange_seq: 'u1' }));
        await recovery();
        vi.advanceTimersByTime(1500);
        await act(async () => { await store.refreshTradingState('positions'); });
        expect(store.getTradingState().queries.positions.needsReconcile).toBe(false);
    });

    it.each(['missing', 'unsigned', 'child'])('an unrepresented %s account does not race another account snapshot or trigger recovery', async kind => {
        mocks.extraAccounts = [{ ...mocks.account, account_id: 'u', signed: false }];
        const pending = deferred<unknown[]>();
        mocks.positions.mockImplementationOnce(() => pending.promise);
        vi.advanceTimersByTime(1500);
        let refresh!: Promise<void>;
        await act(async () => { refresh = store.refreshTradingState('positions'); });
        await emit(stockFill({ account_id: kind === 'child' ? 'a' : kind === 'unsigned' ? 'u' : 'missing',
            ...(kind === 'child' ? { subaccount: 'child' } : {}) }));
        await act(async () => { pending.resolve([baseline()]); await refresh; });
        expect(store.getTradingState().positions[0]).not.toHaveProperty('reconcileReason');
        expect(store.getTradingState().queries.positions.reasons).not.toContain('snapshot-boundary');
        const before = mocks.positions.mock.calls.length;
        await recovery();
        expect(mocks.positions.mock.calls.length).toBe(before);
        vi.advanceTimersByTime(1500);
        await act(async () => { await store.refreshTradingState('positions'); });
        expect(store.getTradingState().queries.positions.needsReconcile).toBe(kind === 'child');
        expect(store.getTradingState().positionIssues).toHaveLength(kind === 'child' ? 1 : 0);
    });

    it('R4 subaccount fills do not each spend a parent position query', async () => {
        mocks.account.account_type = 'F';
        mocks.positions.mockResolvedValue([]);
        mocks.cached.mockReturnValue({ code: 'TXFI6', multiplier: 200 });
        vi.advanceTimersByTime(1500);
        await act(async () => { await store.refreshTradingState('positions'); });
        const before = mocks.positions.mock.calls.length;
        for (let i = 0; i < 5; i++) {
            await emit(normalizeOrderEvent({ state: 'FuturesDeal', data: { FuturesDeal: {
                trade_id: `sub${i}`, exchange_seq: `s${i}`, broker_id: 'fixture', account_id: 'a', subaccount: 'child',
                code: 'TXF', full_code: 'TXFI6', action: 'Buy', price: 100, quantity: 1, ts: epoch + 10 + i,
            } } })!);
            await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
        }
        // a parent snapshot can never resolve a subaccount issue
        expect(mocks.positions.mock.calls.length).toBe(before);
    });

    it('R5 a day-short fill that arrives before the place_order response is not silently dropped by an early recovery snapshot', async () => {
        vi.advanceTimersByTime(1500);
        await stockOrder({ id: 'short', seqno: 'short', ordno: 'short', action: 'Sell' });
        // SSE deal before HTTP response: daytrade_short not yet recorded
        await emit(stockFill({ trade_id: 'short', seqno: 'short', ordno: 'short', action: 'Sell', exchange_seq: 's1' }));
        // broker accounting has not caught up yet when the 250 ms recovery reads
        mocks.positions.mockResolvedValueOnce([baseline()]);
        await recovery();
        // HTTP response arrives: the app records the request flags and replays
        const { noteStockOrderConditions } = await import('./stock-order-conditions');
        noteStockOrderConditions(mocks.account, { seqno: 'short', ordno: 'short' }, { order_cond: 'Cash', daytrade_short: true });
        const trade = store.getTradingState().trades.find(t => t.order.id === 'short')!;
        await act(async () => { mocks.response!({ trade, account: mocks.account }); vi.advanceTimersByTime(50); });
        const s = store.getTradingState();
        const short = s.positions.find(p => p.direction === 'Sell');
        // Either the short is shown, or the book is still visibly 待對帳.
        expect(!!short || s.positions.some(p => p.reconcileReason)).toBe(true);
        mocks.positions.mockResolvedValueOnce([baseline(), { ...baseline(), id: 2, direction: 'Sell' }]);
        const before = mocks.positions.mock.calls.length;
        await recovery();
        expect(mocks.positions.mock.calls.length).toBe(before + 1);
        expect(store.getTradingState().positions.find(p => p.direction === 'Sell')).toMatchObject({ quantity: 1000 });
        expect(store.getTradingState().queries.positions.needsReconcile).toBe(false);
    });

    it('does not retire a parked short when its flags arrive during the recovery request', async () => {
        vi.advanceTimersByTime(1500);
        await stockOrder({ action: 'Sell' });
        const pending = deferred<unknown[]>();
        mocks.positions.mockImplementationOnce(() => pending.promise);
        await emit(stockFill({ action: 'Sell' }));
        await act(async () => { await vi.advanceTimersByTimeAsync(260); });
        const { noteStockOrderConditions } = await import('./stock-order-conditions');
        noteStockOrderConditions(mocks.account, { seqno: 'new', ordno: 'new' }, { order_cond: 'Cash', daytrade_short: true });
        await act(async () => { mocks.response!({ trade: store.getTradingState().trades[0]!, account: mocks.account }); });
        await act(async () => { pending.resolve([baseline()]); });
        expect(store.getTradingState().positions.some(p => p.reconcileReason)).toBe(true);
        mocks.positions.mockResolvedValueOnce([baseline(), { ...baseline(), id: 2, direction: 'Sell' }]);
        const before = mocks.positions.mock.calls.length;
        await recovery();
        expect(mocks.positions.mock.calls.length).toBe(before + 1);
        expect(store.getTradingState().queries.positions.needsReconcile).toBe(false);
    });

    it('a New report after an early snapshot cannot retire a cash sell still awaiting request flags', async () => {
        await emit(stockFill({ action: 'Sell' })); // neither order nor flags yet
        await recovery();
        await stockOrder({ action: 'Sell' }); // wire New omits daytrade_short
        expect(store.getTradingState().positions[0]).toHaveProperty('reconcileReason');
        vi.advanceTimersByTime(1500);
        await act(async () => { await store.refreshTradingState('positions'); });
        expect(store.getTradingState().positions[0]).toHaveProperty('reconcileReason');
        const { noteStockOrderConditions } = await import('./stock-order-conditions');
        noteStockOrderConditions(mocks.account, { seqno: 'new', ordno: 'new' }, { order_cond: 'Cash', daytrade_short: true });
        await act(async () => { mocks.response!({ trade: store.getTradingState().trades[0]!, account: mocks.account }); });
        expect(store.getTradingState().positions[0]).toHaveProperty('reconcileReason');
        mocks.positions.mockResolvedValueOnce([baseline(), { ...baseline(), id: 2, direction: 'Sell' }]);
        await recovery();
        expect(store.getTradingState().positions.find(p => p.direction === 'Sell')).toMatchObject({ quantity: 1000 });
        expect(store.getTradingState().queries.positions.needsReconcile).toBe(false);
    });

    it('an unknown short does not prevent a subsequent valid buy from projecting before recovery', async () => {
        await stockOrder({ id: 'short', seqno: 'short', ordno: 'short', action: 'Sell' });
        await stockOrder();
        await emit(stockFill({ trade_id: 'short', seqno: 'short', ordno: 'short', action: 'Sell' }));
        await emit(stockFill({ exchange_seq: 'buy', ts: epoch + 11 }));
        expect(store.getTradingState().positions[0]).toMatchObject({ quantity: 2000, reconcileReason: expect.any(String) });
    });

    it.each(['missing', 'child'])('bounds %s position issues and their reason causes while keeping uncertainty visible', async kind => {
        const before = mocks.positions.mock.calls.length;
        for (let i = 0; i < 520; i++) mocks.order!(stockFill({ exchange_seq: `issue-${i}`,
            code: `issue-${i}`,
            account_id: kind === 'missing' ? `missing-${i}` : 'a', ...(kind === 'child' ? { subaccount: `child-${i}` } : {}) }));
        expect(store.getTradingState().positionIssues).toHaveLength(500);
        const error = store.getTradingState().queries.positions.error!;
        expect(error.match(/issue-\d+：/g)).toHaveLength(500);
        expect(store.getTradingState().queries.positions.reasons).toContain('overflow');
        await recovery();
        expect(mocks.positions.mock.calls.length).toBe(before);
        vi.advanceTimersByTime(1500);
        await act(async () => { await store.refreshTradingState('positions'); });
        expect(store.getTradingState().positionIssues).toHaveLength(kind === 'missing' ? 0 : 500);
        expect(store.getTradingState().queries.positions.needsReconcile).toBe(kind === 'child');
    });

    it('R6 client clock 3 s ahead of exchange: a fill right after a snapshot still projects locally', async () => {
        vi.advanceTimersByTime(1500);
        vi.setSystemTime((epoch + 13) * 1000); // client clock ahead
        await act(async () => { await store.refreshTradingState('positions'); });
        await stockOrder();
        const before = mocks.positions.mock.calls.length;
        await emit(stockFill({ ts: epoch + 11 })); // exchange time, after the snapshot in real time
        expect(store.getTradingState().positions[0]!.quantity).toBe(2000);
        await recovery();
        expect(mocks.positions.mock.calls.length).toBe(before);
    });
    it('R8 client clock 3 s behind exchange: a fill already in the snapshot but delivered after it is not double counted', async () => {
        vi.advanceTimersByTime(1500);
        vi.setSystemTime((epoch + 7) * 1000); // client clock behind; real time is ~epoch+10
        await stockOrder();
        // broker accounting already includes the fill at exchange time epoch+9
        mocks.positions.mockResolvedValueOnce([{ ...baseline(), quantity: 2000 }]);
        await act(async () => { await store.refreshTradingState('positions'); });
        await emit(stockFill({ ts: epoch + 9 })); // relay delivered it after the read finished
        const s = store.getTradingState();
        expect(s.positions[0]!.quantity === 2000 || !!s.positions[0]!.reconcileReason).toBe(true);
    });
    it('R9 perf: 999 partial fills in one book stay cheap', async () => {
        vi.advanceTimersByTime(1500);
        await stockOrder();
        const t0 = vi.getRealSystemTime();
        for (let i = 0; i < 999; i++) mocks.order!(stockFill({ exchange_seq: `p${i}`, ts: epoch + 10 + i, order_lot: 'Odd' }));
        const ms = vi.getRealSystemTime() - t0;
        expect(ms).toBeLessThan(500); expect(store.getTradingState().positions[0]!.quantity).toBe(1999);
    });
});
