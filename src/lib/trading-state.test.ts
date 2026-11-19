import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeOrderEvent, type OrderEventReport } from './order-report';
import schema from './fixtures/order-callback-openapi-1.7.5.json';
import type { TradeObservation } from './trade-observations';
import type { Account } from './types/portfolio';
import { remainingWorkingOrderQuantity } from './working-order-quantity';

const mocks = vi.hoisted(() => ({
    extraAccounts: [] as Account[],
    accountsLoaded: true,
    accountsChanged: new Set<() => void>(),
    status: 'live', order: null as ((r: OrderEventReport) => void) | null,
    statusChanged: null as (() => void) | null,
    tick: null as ((t: { code: string; close: string; simtrade?: boolean }) => void) | null,
    response: null as ((value: TradeObservation) => void) | null,
    ensure: vi.fn(), cached: vi.fn(),
    positions: vi.fn(), trades: vi.fn(), balance: vi.fn(), margin: vi.fn(), subscribe: vi.fn(), health: vi.fn(),
    account: { account_type: 'S', broker_id: 'fixture', account_id: 'a', person_id: 'fixture', signed: true, username: 'fixture' },
}));
vi.mock('./account-store', () => ({ useAccounts: () => ({ accounts: [mocks.account, ...mocks.extraAccounts], selectedStock: mocks.account, selectedFutures: null }), getAccountState: () => ({ accounts: mocks.accountsLoaded ? [mocks.account, ...mocks.extraAccounts] : [], loaded: mocks.accountsLoaded }), refreshAccounts: vi.fn(), subscribeAccounts: (listener: () => void) => { mocks.accountsChanged.add(listener); return () => mocks.accountsChanged.delete(listener); } }));
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
    mocks.status = 'live'; mocks.order = null; mocks.statusChanged = null; mocks.tick = null; mocks.response = null; mocks.account.account_type = 'S';
    mocks.account.account_id = 'a'; mocks.account.broker_id = 'fixture';
    mocks.account.signed = true;
    mocks.extraAccounts = [];
    mocks.accountsLoaded = true;
    mocks.accountsChanged.clear();
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

it('revokes a popout trading snapshot when the main window announces pagehide', async () => {
    const channels: Array<{ name: string; fire: (data: unknown) => void }> = [];
    class Channel {
        listener?: (event: { data: unknown }) => void;
        constructor(public name: string) { channels.push(this); }
        addEventListener(_name: string, listener: (event: { data: unknown }) => void) { this.listener = listener; }
        postMessage(_data: unknown) { /* main is supplied by the fixture */ }
        fire(data: unknown) { this.listener?.({ data }); }
    }
    vi.resetModules();
    vi.stubGlobal('location', { search: '?popout=ticket' });
    vi.stubGlobal('BroadcastChannel', Channel);
    const lease = await import('./trading-mirror-lease');
    await import('./trading-state');
    const channel = channels.find(candidate => candidate.name.startsWith('sj-trading-state:'))!;
    channel.fire({ kind: 'state', state: { positions: [], trades: [] }, cacheContinuous: true });
    expect(lease.getTradingMirrorFresh()).toBe(true);
    channel.fire({ kind: 'main-gone' });
    expect(lease.getTradingMirrorFresh()).toBe(false);
});

it('mode discovery rereads positions, orders and funds despite the initial snapshot cooldown', async () => {
    const calls = [mocks.positions, mocks.trades, mocks.balance].map(fn => fn.mock.calls.length);
    await act(async () => { await store.refreshTradingStateForModeChange(); });
    expect([mocks.positions, mocks.trades, mocks.balance].map(fn => fn.mock.calls.length)).toEqual(calls.map(n => n + 1));
});

describe('orders snapshot environment provenance', () => {
    async function mirrorFixture() {
        const channels: Array<{ name: string; fire: (data: unknown) => void }> = [];
        class Channel {
            listener?: (event: { data: unknown }) => void;
            constructor(public name: string) { channels.push(this); }
            addEventListener(_name: string, listener: (event: { data: unknown }) => void) { this.listener = listener; }
            postMessage(_data: unknown) { /* supplied by this fixture */ }
            fire(data: unknown) { this.listener?.({ data }); }
        }
        vi.resetModules();
        vi.stubGlobal('location', { search: '?popout=chart' });
        vi.stubGlobal('BroadcastChannel', Channel);
        const mirror = await import('./trading-state');
        const info = await import('./server-info-store');
        const channel = channels.find(candidate => candidate.name.startsWith('sj-trading-state:'))!;
        const observe = (simulation: boolean) => info.observeServerInfo(info.beginServerInfoRequest(), { simulation } as import('./shioaji').ServerInfo);
        const frame = (updatedAt: number) => ({ kind: 'state', state: { ...store.getTradingState(),
            ordersSnapshotEnv: 'http://fixture.invalid|simulation',
            queries: { ...store.getTradingState().queries, orders: { ...store.getTradingState().queries.orders, updatedAt } },
        } });
        return { mirror, info, channel, observe, frame };
    }

    it.each(['mode round trip', 'unknown mode', 'main gone', 'account change'] as const)('rejects delayed mirror provenance after %s and accepts a newer authoritative read', async cause => {
        const { mirror, info, channel, observe, frame } = await mirrorFixture();
        observe(true);
        await Promise.resolve(); // 得知模式那一輪通知結束：之後的帳戶變化是另一件事
        const old = frame(Date.now());
        channel.fire(old);
        expect(mirror.getTradingState().ordersSnapshotEnv).toBe('http://fixture.invalid|simulation');
        vi.advanceTimersByTime(10);
        if (cause === 'main gone') channel.fire({ kind: 'main-gone' });
        else if (cause === 'account change') {
            mocks.extraAccounts = [{ ...mocks.account, account_id: 'b' }];
            mocks.accountsChanged.forEach(listener => listener());
        } else {
            if (cause === 'unknown mode') info.forgetServerInfo('http://fixture.invalid');
            else observe(false);
            observe(true);
        }
        channel.fire(old);
        expect(mirror.getTradingState().ordersSnapshotEnv).toBeNull();
        channel.fire(frame(Date.now())); // same-millisecond completion is ambiguous
        expect(mirror.getTradingState().ordersSnapshotEnv).toBeNull();
        vi.advanceTimersByTime(1);
        channel.fire(frame(Date.now()));
        expect(mirror.getTradingState().ordersSnapshotEnv).toBe('http://fixture.invalid|simulation');
    });

    it.each([false, true])('a mirror that re-learns its mode after the main window re-read keeps accepting that read (accounts change too: %s)', async accountsToo => {
        const { mirror, info, channel, observe, frame } = await mirrorFixture();
        observe(true);
        channel.fire(frame(Date.now()));
        vi.advanceTimersByTime(10);
        info.forgetServerInfo('http://fixture.invalid'); // stream lost: mode unknown here
        vi.advanceTimersByTime(10);
        const reread = frame(Date.now()); // the main window's authoritative read after the reconnect
        vi.advanceTimersByTime(10);
        observe(true); // this window's /info answers later than the main window's read
        if (accountsToo) {
            mocks.extraAccounts = [{ ...mocks.account, account_id: 'b' }];
            mocks.accountsChanged.forEach(listener => listener());
        }
        await Promise.resolve();
        channel.fire(reread);
        expect(mirror.getTradingState().ordersSnapshotEnv).toBe('http://fixture.invalid|simulation');
    });

    it('accepts an existing snapshot when a new mirror first discovers its mode and accounts', async () => {
        mocks.accountsLoaded = false;
        const { mirror, channel, observe, frame } = await mirrorFixture();
        const old = frame(Date.now() - 1000);
        channel.fire(old);
        observe(true);
        mocks.accountsLoaded = true;
        mocks.accountsChanged.forEach(listener => listener());
        channel.fire(old);
        expect(mirror.getTradingState().ordersSnapshotEnv).toBe('http://fixture.invalid|simulation');
    });

    it('after the first discovery, a later change of the eligible accounts revokes the mirror snapshot', async () => {
        mocks.accountsLoaded = false;
        const { mirror, channel, observe, frame } = await mirrorFixture();
        const old = frame(Date.now() - 1000);
        channel.fire(old);
        observe(true);
        mocks.accountsLoaded = true;
        mocks.accountsChanged.forEach(listener => listener()); // first discovery keeps the main window's snapshot
        channel.fire(old);
        expect(mirror.getTradingState().ordersSnapshotEnv).toBe('http://fixture.invalid|simulation');
        mocks.extraAccounts = [{ ...mocks.account, account_id: 'b' }];
        mocks.accountsChanged.forEach(listener => listener()); // from now on the account list is known: any change revokes
        expect(mirror.getTradingState().ordersSnapshotEnv).toBeNull();
    });

    it('tells subscribers at the moment the provenance is revoked (so a chart hides stale fills immediately)', async () => {
        const info = await import('./server-info-store');
        await act(async () => { info.observeServerInfo(info.beginServerInfoRequest(), { simulation: true } as import('./shioaji').ServerInfo); });
        await act(async () => { await store.refreshTradingStateForModeChange(); });
        expect(store.getTradingState().ordersSnapshotEnv).toBe('http://fixture.invalid|simulation');
        const seen: Array<string | null | undefined> = [];
        const stop = store.subscribeTradingState(() => seen.push(store.getTradingState().ordersSnapshotEnv));
        await act(async () => { info.observeServerInfo(info.beginServerInfoRequest(), { simulation: false } as import('./shioaji').ServerInfo); });
        expect(seen).toContain(null);
        stop();
    });

    it('invalidates retained simulation rows when an unqueried account becomes eligible in production', async () => {
        const info = await import('./server-info-store');
        info.observeServerInfo(info.beginServerInfoRequest(), { simulation: true } as import('./shioaji').ServerInfo);
        await emit(order()); await emit(deal());
        const b = { ...mocks.account, account_id: 'b', signed: false };
        const old = store.getTradingState().trades[0]!;
        const simB = { ...old, account: b, order: { ...old.order, account: b } };
        mocks.extraAccounts = [b];
        mocks.accountsChanged.forEach(listener => listener());
        mocks.trades.mockImplementation(async (_type: string, account: Account) => account.account_id === 'b' ? [simB] : []);
        await act(async () => { await store.refreshTradingStateForModeChange(); });
        info.observeServerInfo(info.beginServerInfoRequest(), { simulation: false } as import('./shioaji').ServerInfo);
        mocks.trades.mockResolvedValue([]);
        await act(async () => { await store.refreshTradingStateForModeChange(); });
        expect(store.getTradingState().ordersSnapshotEnv).toBe('http://fixture.invalid|production');
        const retained = store.getTradingState().trades;
        expect(retained.some(t => t.account?.account_id === 'b')).toBe(true);
        mocks.extraAccounts = [{ ...b, signed: true }];
        await act(async () => { mocks.accountsChanged.forEach(listener => listener()); });
        expect(store.getTradingState().ordersSnapshotEnv).toBeNull();
        expect(store.getTradingState().trades).toBe(retained);
        await act(async () => { await store.refreshTradingStateForModeChange(); });
        expect(store.getTradingState().ordersSnapshotEnv).toBe('http://fixture.invalid|production');
        expect(store.getTradingState().trades).toEqual([]);
    });

    it('keeps provenance for selection or account-label updates with the same eligible identities', async () => {
        const info = await import('./server-info-store');
        info.observeServerInfo(info.beginServerInfoRequest(), { simulation: false } as import('./shioaji').ServerInfo);
        await act(async () => { await store.refreshTradingStateForModeChange(); });
        await act(async () => { mocks.accountsChanged.forEach(listener => listener()); });
        expect(store.getTradingState().ordersSnapshotEnv).toBe('http://fixture.invalid|production');
    });

    it('stamps the snapshot with currentProtectionEnv() itself, so the chart comparison cannot drift from a second key builder', async () => {
        vi.resetModules();
        vi.doMock('./protection-env', async (importOriginal) => ({
            ...await importOriginal<typeof import('./protection-env')>(),
            currentProtectionEnv: () => 'sentinel-env',
        }));
        try {
            const info = await import('./server-info-store');
            const fresh = await import('./trading-state');
            info.observeServerInfo(info.beginServerInfoRequest(), { simulation: false } as import('./shioaji').ServerInfo);
            await act(async () => { await fresh.refreshTradingStateForModeChange(); });
            expect(fresh.getTradingState().ordersSnapshotEnv).toBe('sentinel-env');
        } finally { vi.doUnmock('./protection-env'); }
    });

    it('does not restamp a snapshot when its eligible-account scope changes during the read', async () => {
        const info = await import('./server-info-store');
        info.observeServerInfo(info.beginServerInfoRequest(), { simulation: false } as import('./shioaji').ServerInfo);
        const pending = deferred<[]>();
        mocks.trades.mockImplementationOnce(() => pending.promise);
        let run!: Promise<void>;
        await act(async () => { run = store.refreshTradingStateForModeChange(); });
        mocks.extraAccounts = [{ ...mocks.account, account_id: 'b' }];
        mocks.accountsChanged.forEach(listener => listener());
        pending.resolve([]);
        await act(async () => { await run; });
        expect(store.getTradingState().ordersSnapshotEnv).toBeNull();
    });

    it('invalidates retained fills immediately across mode changes and only restamps a successful authoritative snapshot', async () => {
        const info = await import('./server-info-store');
        await act(async () => { info.observeServerInfo(info.beginServerInfoRequest(), { simulation: true } as import('./shioaji').ServerInfo); });
        await emit(order());
        await emit(deal());
        const simulated = store.getTradingState().trades;
        mocks.trades.mockResolvedValue(simulated);
        await act(async () => { await store.refreshTradingStateForModeChange(); });
        expect(store.getTradingState().ordersSnapshotEnv).toBe('http://fixture.invalid|simulation');
        // LiveCandleChart compares this stamp with currentProtectionEnv(); the two builders must never drift apart.
        expect(store.getTradingState().ordersSnapshotEnv).toBe((await import('./protection-env')).currentProtectionEnv());

        const retained = store.getTradingState().trades;
        await act(async () => { info.observeServerInfo(info.beginServerInfoRequest(), { simulation: false } as import('./shioaji').ServerInfo); });
        expect(store.getTradingState().ordersSnapshotEnv).toBeNull();
        expect(store.getTradingState().trades).toBe(retained);
        mocks.trades.mockRejectedValue(new Error('orders unavailable'));
        await act(async () => { await store.refreshTradingStateForModeChange(); });
        expect(store.getTradingState().ordersSnapshotEnv).toBeNull();
        expect(store.getTradingState().trades).toBe(retained);

        await act(async () => { info.observeServerInfo(info.beginServerInfoRequest(), { simulation: true } as import('./shioaji').ServerInfo); });
        expect(store.getTradingState().ordersSnapshotEnv).toBeNull();
        mocks.trades.mockResolvedValue(simulated);
        await act(async () => { await store.refreshTradingStateForModeChange(); });
        expect(store.getTradingState().ordersSnapshotEnv).toBe('http://fixture.invalid|simulation');
        await act(async () => { info.forgetServerInfo('http://fixture.invalid'); });
        expect(store.getTradingState().ordersSnapshotEnv).toBeNull();
    });

    it.each(['positions', 'account'] as const)('does not establish orders provenance after refreshing only %s', async scope => {
        const info = await import('./server-info-store');
        await act(async () => { info.observeServerInfo(info.beginServerInfoRequest(), { simulation: false } as import('./shioaji').ServerInfo); });
        vi.advanceTimersByTime(1600);
        await act(async () => { await store.refreshTradingState(scope); });
        expect(store.getTradingState().ordersSnapshotEnv).toBeNull();
    });

    it('does not stamp an unknown-mode or partly failed multi-account orders snapshot', async () => {
        expect(store.getTradingState().ordersSnapshotEnv).toBeNull();
        const info = await import('./server-info-store');
        await act(async () => { info.observeServerInfo(info.beginServerInfoRequest(), { simulation: false } as import('./shioaji').ServerInfo); });
        mocks.extraAccounts = [{ ...mocks.account, account_id: 'b' }];
        mocks.trades.mockImplementation(async (_type: string, account: Account) => {
            if (account.account_id === 'b') throw new Error('second account unavailable');
            return [];
        });
        vi.advanceTimersByTime(1600);
        await act(async () => { await store.refreshTradingState('orders'); });
        expect(store.getTradingState().queries.orders.reasons).toContain('query-failed');
        expect(store.getTradingState().ordersSnapshotEnv).toBeNull();
        mocks.trades.mockResolvedValue([]);
        vi.advanceTimersByTime(1600);
        await act(async () => { await store.refreshTradingState('orders'); });
        expect(store.getTradingState().ordersSnapshotEnv).toBe('http://fixture.invalid|production');
    });

    it('does not stamp orders whose snapshot has a disconnect problem', async () => {
        const info = await import('./server-info-store');
        await act(async () => { info.observeServerInfo(info.beginServerInfoRequest(), { simulation: false } as import('./shioaji').ServerInfo); });
        mocks.status = 'stale';
        vi.advanceTimersByTime(1600);
        await act(async () => { await store.refreshTradingState('orders'); });
        expect(store.getTradingState().queries.orders.reasons).toContain('disconnect');
        expect(store.getTradingState().ordersSnapshotEnv).toBeNull();
    });

    it('cache-only upsert cannot restore provenance lost on a mode change', async () => {
        const info = await import('./server-info-store');
        await act(async () => { info.observeServerInfo(info.beginServerInfoRequest(), { simulation: true } as import('./shioaji').ServerInfo); });
        await act(async () => { await store.refreshTradingStateForModeChange(); });
        expect(store.getTradingState().ordersSnapshotEnv).toBe('http://fixture.invalid|simulation');
        await act(async () => { info.observeServerInfo(info.beginServerInfoRequest(), { simulation: false } as import('./shioaji').ServerInfo); });
        mocks.trades.mockClear();
        await act(async () => { mocks.status = 'stale'; mocks.statusChanged!(); });
        await act(async () => { mocks.status = 'live'; mocks.statusChanged!(); });
        await flush();
        expect(mocks.trades).toHaveBeenCalledWith('S', mocks.account, { refresh: false });
        expect(store.getTradingState().ordersSnapshotEnv).toBeNull();
    });

    it('invalidates mirrored provenance on a mode change even before the mirror starts', async () => {
        const channels: Array<{ name: string; fire: (data: unknown) => void }> = [];
        class Channel {
            listener?: (event: { data: unknown }) => void;
            constructor(public name: string) { channels.push(this); }
            addEventListener(_name: string, listener: (event: { data: unknown }) => void) { this.listener = listener; }
            postMessage(_data: unknown) { /* owner state is supplied below */ }
            fire(data: unknown) { this.listener?.({ data }); }
        }
        vi.resetModules();
        vi.stubGlobal('location', { search: '?popout=chart' });
        vi.stubGlobal('BroadcastChannel', Channel);
        const mirror = await import('./trading-state');
        const info = await import('./server-info-store');
        info.observeServerInfo(info.beginServerInfoRequest(), { simulation: true } as import('./shioaji').ServerInfo);
        const channel = channels.find(candidate => candidate.name.startsWith('sj-trading-state:'))!;
        channel.fire({ kind: 'state', state: { ...store.getTradingState(), ordersSnapshotEnv: 'http://fixture.invalid|simulation' } });
        expect(mirror.getTradingState().ordersSnapshotEnv).toBe('http://fixture.invalid|simulation');
        info.observeServerInfo(info.beginServerInfoRequest(), { simulation: false } as import('./shioaji').ServerInfo);
        expect(mirror.getTradingState().ordersSnapshotEnv).toBeNull();
        info.observeServerInfo(info.beginServerInfoRequest(), { simulation: true } as import('./shioaji').ServerInfo);
        expect(mirror.getTradingState().ordersSnapshotEnv).toBeNull();
    });
});

it('retries a mode-change snapshot if production reconnects while it is still reading', async () => {
    const info = await import('./server-info-store');
    info.observeServerInfo(info.beginServerInfoRequest(), { simulation: false } as import('./shioaji').ServerInfo);
    const calls = [mocks.positions, mocks.trades, mocks.balance].map(fn => fn.mock.calls.length);
    const pending = deferred<ReturnType<typeof baseline>[]>();
    mocks.positions.mockImplementationOnce(() => pending.promise);
    let run!: Promise<void>;
    await act(async () => { run = store.refreshTradingStateForModeChange(); });
    await flush();
    info.forgetServerInfo('http://fixture.invalid');
    info.observeServerInfo(info.beginServerInfoRequest(), { simulation: false } as import('./shioaji').ServerInfo);
    expect(store.refreshTradingStateForModeChange()).toBe(run);
    pending.resolve([baseline()]);
    await act(async () => { await run; });
    expect(mocks.positions).toHaveBeenCalledTimes(calls[0]! + 2);
    expect(mocks.trades).toHaveBeenCalledTimes(calls[1]! + 1);
    expect(mocks.balance).toHaveBeenCalledTimes(calls[2]! + 1);
    expect(store.getTradingState().queries.positions.needsReconcile).toBe(false);
});

it('mode discovery during an initial read waits for it and then queries newly tradable accounts', async () => {
    vi.advanceTimersByTime(1600);
    const pending = deferred<ReturnType<typeof baseline>[]>();
    mocks.positions.mockImplementationOnce(() => pending.promise);
    const initial = store.refreshTradingState();
    await flush();
    const additional = { ...mocks.account, account_type: 'F', account_id: 'late', signed: false };
    mocks.extraAccounts = [additional];
    const info = await import('./server-info-store');
    info.observeServerInfo(info.beginServerInfoRequest(), { simulation: true } as import('./shioaji').ServerInfo);
    const followup = store.refreshTradingStateForModeChange();
    expect(store.refreshTradingStateForModeChange()).toBe(followup);
    pending.resolve([baseline()]);
    await act(async () => { await Promise.all([initial, followup]); });
    expect(mocks.positions).toHaveBeenCalledWith('F', additional);
    expect(mocks.trades).toHaveBeenCalledWith('F', additional, { refresh: true });
    expect(mocks.margin).toHaveBeenCalledWith(additional);
});

it('#287 first mode discovery during the boot subscribe rereads instead of failing positions/orders', async () => {
    // v0.1.52 boot: the early stream starts the first snapshot before boot's
    // own /info check; the first known mode then lands while subscribe is in
    // flight, so every account read was dropped in 0 ms and the startup
    // timing settled as `failed: positions-loaded`.
    const timing = await import('./startup-timing');
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.advanceTimersByTime(1600);
    const subscribed = deferred<undefined>();
    mocks.subscribe.mockReturnValueOnce(subscribed.promise);
    mocks.positions.mockClear(); mocks.trades.mockClear(); mocks.balance.mockClear();
    const before = store.getTradingState().queries.positions.updatedAt;
    timing.beginTiming('restart', { replace: true });
    let run!: Promise<void>;
    await act(async () => { run = store.refreshTradingState(); });
    const info = await import('./server-info-store');
    // boot's own mode listener is mocked away: trading-state must reread itself
    info.observeServerInfo(info.beginServerInfoRequest(), { simulation: false } as import('./shioaji').ServerInfo);
    vi.advanceTimersByTime(10);
    subscribed.resolve(undefined);
    await act(async () => { await run; });
    for (let i = 0; i < 10; i++) await flush();
    const state = store.getTradingState();
    for (const scope of ['positions', 'orders', 'account'] as const) {
        expect(state.queries[scope].reasons).not.toContain('query-failed');
        expect(state.queries[scope].error).toBeNull();
    }
    expect(state.queries.positions.updatedAt).not.toBe(before);
    expect(mocks.positions).toHaveBeenCalledOnce();
    expect(mocks.trades).toHaveBeenCalledOnce();
    expect(mocks.balance).toHaveBeenCalledOnce();
    const reads = timing.getActiveTiming()!.marks.filter(m => m.stage === 'account-read').map(m => m.detail ?? '');
    expect(reads.join(' ')).not.toContain('failed');
    expect(reads).toEqual(expect.arrayContaining(['S1 positions 0ms superseded', 'S1 positions 0ms']));
    timing.endTiming('ok');
});

it.each(['ok', 'reread-fails'] as const)('#287 cold boot: positions-loaded waits for the reread instead of settling failed (%s)', async outcome => {
    // fresh module graph, no snapshot yet (updatedAt === null)
    vi.resetModules();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const subscribed = deferred<undefined>();
    mocks.subscribe.mockReset().mockReturnValueOnce(subscribed.promise).mockResolvedValue(undefined);
    mocks.positions.mockClear();
    if (outcome === 'reread-fails') mocks.positions.mockReset().mockRejectedValue(new Error('500 broker'));
    const cold = await import('./trading-state');
    const timing = await import('./startup-timing');
    const ready = await import('./frontend-ready');
    const info = await import('./server-info-store');
    expect(cold.getTradingState().queries.positions.updatedAt).toBeNull();
    timing.beginTiming('restart', { replace: true });
    const runId = timing.peekActiveTiming()!.id;
    const positionsSignal = ready.appReadySignals().find(s => s.stage === 'positions-loaded')!;
    ready.watchFrontendReady(runId, [positionsSignal]);
    let run!: Promise<void>;
    await act(async () => { run = cold.refreshTradingState(); });
    // boot's listener and trading-state's own reread must coalesce into one
    info.observeServerInfo(info.beginServerInfoRequest(), { simulation: false } as import('./shioaji').ServerInfo);
    const bootReread = cold.refreshTradingStateForModeChange();
    subscribed.resolve(undefined);
    await act(async () => { await run; });
    await act(async () => { await bootReread; });
    for (let i = 0; i < 5; i++) await flush();
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(mocks.positions).toHaveBeenCalledOnce();
    const ended = timing.getTimingHistory()[0]!;
    expect(ended.id).toBe(runId);
    if (outcome === 'ok') expect(ended.outcome).toBe('ok');
    else {
        expect(ended.outcome).toBe('partial');
        expect(ended.detail).toContain('failed: positions-loaded');
    }
});

it('#287 a boot subscribe dropped by the first mode discovery is resubscribed, not 回報未訂閱', async () => {
    vi.advanceTimersByTime(1600);
    let rejectSubscribe!: (e: Error) => void;
    mocks.subscribe.mockReturnValueOnce(new Promise<undefined>((_, reject) => { rejectSubscribe = reject; }));
    mocks.positions.mockClear();
    let run!: Promise<void>;
    await act(async () => { run = store.refreshTradingState(); });
    const info = await import('./server-info-store');
    info.observeServerInfo(info.beginServerInfoRequest(), { simulation: false } as import('./shioaji').ServerInfo);
    rejectSubscribe(new Error('訂閱期間伺服器模式已變更，未送出請求；請重新訂閱'));
    await act(async () => { await run; });
    for (let i = 0; i < 10; i++) await flush();
    const state = store.getTradingState();
    expect(state.queries.positions.reasons).not.toContain('not-subscribed');
    expect(state.queries.orders.reasons).not.toContain('not-subscribed');
    expect(mocks.subscribe).toHaveBeenCalledTimes(3); // mount, dropped, reread
    expect(mocks.positions).toHaveBeenCalledOnce();
});

it('a known-mode change during a read still records query-failed (only first discovery rereads)', async () => {
    const info = await import('./server-info-store');
    info.observeServerInfo(info.beginServerInfoRequest(), { simulation: true } as import('./shioaji').ServerInfo);
    vi.advanceTimersByTime(1600);
    const subscribed = deferred<undefined>();
    mocks.subscribe.mockReturnValueOnce(subscribed.promise);
    mocks.positions.mockClear();
    let run!: Promise<void>;
    await act(async () => { run = store.refreshTradingState(); });
    info.observeServerInfo(info.beginServerInfoRequest(), { simulation: false } as import('./shioaji').ServerInfo);
    subscribed.resolve(undefined);
    await act(async () => { await run; });
    for (let i = 0; i < 10; i++) await flush();
    expect(store.getTradingState().queries.positions.reasons).toContain('query-failed');
    expect(mocks.positions).not.toHaveBeenCalled();
});

it.each(['positions', 'orders', 'balance', 'margin'] as const)('discards an unsigned account %s response and stops later reads after a mode change', async stage => {
    const info = await import('./server-info-store');
    for (const change of ['production', 'unknown', 'roundtrip'] as const) {
        info.observeServerInfo(info.beginServerInfoRequest(), { simulation: true } as import('./shioaji').ServerInfo);
        mocks.account.signed = false;
        mocks.account.account_type = stage === 'margin' ? 'F' : 'S';
        const reads = [mocks.positions, mocks.trades, mocks.balance, mocks.margin];
        reads.forEach(read => read.mockClear());
        const pending = deferred<unknown>();
        const read = stage === 'positions' ? mocks.positions : stage === 'orders' ? mocks.trades : mocks[stage];
        read.mockReturnValueOnce(pending.promise);
        vi.advanceTimersByTime(1600);
        let run!: Promise<void>;
        await act(async () => { run = store.refreshTradingState(); });
        expect(read).toHaveBeenCalledOnce();
        const before = store.getTradingState();
        if (change === 'unknown') info.forgetServerInfo('http://fixture.invalid');
        else info.observeServerInfo(info.beginServerInfoRequest(), { simulation: false } as import('./shioaji').ServerInfo);
        if (change === 'roundtrip') info.observeServerInfo(info.beginServerInfoRequest(), { simulation: true } as import('./shioaji').ServerInfo);
        pending.resolve(stage === 'positions' ? [{ ...baseline(), quantity: 9999 }]
            : stage === 'orders' ? [{ order: { id: 'stale-mode' }, status: { status: 'Submitted' } }]
            : stage === 'balance' ? { acc_balance: 9999, date: '2026-09-12', errmsg: '' } : { equity: 9999 });
        await act(async () => { await run; });
        const after = store.getTradingState();
        if (stage === 'positions') {
            expect(after.positions).toBe(before.positions);
            expect(mocks.trades).not.toHaveBeenCalled();
        }
        if (stage === 'positions' || stage === 'orders') {
            expect(after.trades).toBe(before.trades);
            expect(mocks.balance).not.toHaveBeenCalled();
            expect(mocks.margin).not.toHaveBeenCalled();
        }
        expect(after.funds).toBe(before.funds);
        const scope = stage === 'balance' || stage === 'margin' ? 'account' : stage;
        expect(after.queries[scope].updatedAt).toBe(before.queries[scope].updatedAt);
        expect(after.queries[scope].reasons).toContain('query-failed');
        expect(after.loading).toBe(false);
    }
});

it('revalidates the current account row before each query and before applying its response', async () => {
    const info = await import('./server-info-store');
    info.observeServerInfo(info.beginServerInfoRequest(), { simulation: false } as import('./shioaji').ServerInfo);
    const pending = deferred<ReturnType<typeof baseline>[]>();
    mocks.positions.mockImplementationOnce(() => pending.promise);
    mocks.trades.mockClear(); mocks.balance.mockClear(); mocks.margin.mockClear();
    vi.advanceTimersByTime(1600);
    let run!: Promise<void>;
    await act(async () => { run = store.refreshTradingState(); });
    const before = store.getTradingState();
    // Same identity, but a new row has lost its signed qualification.
    mocks.account = { ...mocks.account, signed: false };
    pending.resolve([{ ...baseline(), quantity: 9999 }]);
    await act(async () => { await run; });
    expect(store.getTradingState().positions).toBe(before.positions);
    expect(mocks.trades).not.toHaveBeenCalledWith('S', mocks.account, { refresh: true });
    expect(mocks.balance).not.toHaveBeenCalled();
});

it('does not query queued accounts after the mode changes while the concurrency slots are occupied', async () => {
    const info = await import('./server-info-store');
    info.observeServerInfo(info.beginServerInfoRequest(), { simulation: true } as import('./shioaji').ServerInfo);
    mocks.extraAccounts = ['b', 'c'].map(account_id => ({ ...mocks.account, account_id, signed: false }));
    const pending = deferred<ReturnType<typeof baseline>[]>();
    mocks.positions.mockReset().mockReturnValue(pending.promise);
    mocks.trades.mockClear(); mocks.balance.mockClear();
    vi.advanceTimersByTime(1600);
    let run!: Promise<void>;
    await act(async () => { run = store.refreshTradingState(); });
    expect(mocks.positions).toHaveBeenCalledTimes(store.ACCOUNT_READ_CONCURRENCY);
    const before = store.getTradingState();
    info.forgetServerInfo('http://fixture.invalid');
    pending.resolve([baseline()]);
    await act(async () => { await run; });
    expect(mocks.positions).toHaveBeenCalledTimes(store.ACCOUNT_READ_CONCURRENCY);
    expect(mocks.trades).not.toHaveBeenCalled();
    expect(mocks.balance).not.toHaveBeenCalled();
    expect(store.getTradingState().positions).toBe(before.positions);
});

it('discards buffered funds if mode changes while another account is still waiting', async () => {
    const info = await import('./server-info-store');
    info.observeServerInfo(info.beginServerInfoRequest(), { simulation: true } as import('./shioaji').ServerInfo);
    mocks.extraAccounts = [{ ...mocks.account, account_type: 'F', account_id: 'f', signed: false }];
    mocks.balance.mockResolvedValue({ acc_balance: 9999, date: '2026-09-12', errmsg: '' });
    const pending = deferred<{ equity: number }>();
    mocks.margin.mockReturnValueOnce(pending.promise);
    vi.advanceTimersByTime(1600);
    const before = store.getTradingState();
    let run!: Promise<void>;
    await act(async () => { run = store.refreshTradingState('account'); });
    info.forgetServerInfo('http://fixture.invalid');
    pending.resolve({ equity: 9999 });
    await act(async () => { await run; });
    expect(store.getTradingState().funds).toBe(before.funds);
    expect(store.getTradingState().queries.account.updatedAt).toBe(before.queries.account.updatedAt);
});

it.each(['health', 'cache', 'buffered-cache'] as const)('guards cache resync across mode/account changes while waiting for %s', async stage => {
    const info = await import('./server-info-store');
    for (const change of ['production', 'unknown', 'roundtrip', 'account'] as const) {
        info.observeServerInfo(info.beginServerInfoRequest(), { simulation: true } as import('./shioaji').ServerInfo);
        mocks.account.signed = false;
        mocks.extraAccounts = [{ ...mocks.account, account_id: 'b' }];
        mocks.health.mockResolvedValue({ state: 'Healthy', reasons: [] });
        mocks.trades.mockResolvedValue([]);
        vi.advanceTimersByTime(1600);
        await act(async () => { await store.refreshTradingState(); });
        await emit(order());
        await act(async () => { mocks.status = 'down'; mocks.statusChanged!(); });
        mocks.status = 'live';
        const before = store.getTradingState();
        const cached = { ...before.trades[0]!, status: { ...before.trades[0]!.status, status: 'Cancelled' as const, cancel_quantity: 3 } };
        const health = deferred<{ state: string; reasons: never[] }>();
        const cache = deferred<typeof cached[]>();
        mocks.health.mockClear(); mocks.trades.mockClear();
        if (stage === 'health') mocks.health.mockReturnValue(health.promise);
        else mocks.trades.mockImplementation((_type: string, account: Account) =>
            stage === 'buffered-cache' && account.account_id === 'a' ? Promise.resolve([cached]) : cache.promise);
        let run!: Promise<void>;
        await act(async () => { run = store.checkTradeCacheHealth('reconnect'); });
        expect(mocks.health).toHaveBeenCalledTimes(2);
        if (stage !== 'health') expect(mocks.trades).toHaveBeenCalledTimes(2);
        if (change === 'account') mocks.account = { ...mocks.account, account_id: 'removed' };
        else if (change === 'unknown') info.forgetServerInfo('http://fixture.invalid');
        else {
            info.observeServerInfo(info.beginServerInfoRequest(), { simulation: false } as import('./shioaji').ServerInfo);
            if (change === 'roundtrip') info.observeServerInfo(info.beginServerInfoRequest(), { simulation: true } as import('./shioaji').ServerInfo);
        }
        health.resolve({ state: 'Healthy', reasons: [] });
        cache.resolve([cached]);
        await act(async () => { await run; });
        if (stage === 'health') expect(mocks.trades).not.toHaveBeenCalled();
        expect(store.getTradingState().trades).toBe(before.trades);
        expect(store.getTradingState().queries.orders).toBe(before.queries.orders);
        expect(store.hasOrdersBaseline()).toBe(true);
        mocks.account.account_id = 'a';
    }
});

describe('shared trading state with isolated broker fixtures', () => {
    it('marks each accounting read of a refresh with its duration, accounts by type/order only (#142)', async () => {
        const timing = await import('./startup-timing');
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
        mocks.extraAccounts = [{ ...mocks.account, account_id: 'f', account_type: 'F' }];
        mocks.margin.mockResolvedValue({ equity: 1 });
        mocks.positions.mockImplementation(async () => { await new Promise(r => setTimeout(r, 120)); return [baseline()]; });
        timing.beginTiming('restart', { replace: true });
        vi.advanceTimersByTime(1500);
        await act(async () => { const run = store.refreshTradingState('all'); await vi.advanceTimersByTimeAsync(500); await run; });
        const reads = timing.getActiveTiming()!.marks.filter(m => m.stage === 'account-read').map(m => m.detail);
        expect(reads).toEqual(expect.arrayContaining(['subscribe 0ms', 'S1 positions 120ms', 'F1 positions 120ms', 'S1 orders 0ms', 'F1 orders 0ms', 'S1 balance 0ms', 'F1 margin 0ms']));
        expect(reads.join(' ')).not.toContain(mocks.account.account_id + ' ');
        timing.endTiming('ok');
    });

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
    it('a confirmed read-back without deals leaves the row a deals array', async () => {
        await emit(order()); const old = store.getTradingState().trades[0]!;
        const { observeTradeMutation, markConfirmedCancellation } = await import('./trade-mutations');
        await act(async () => { await observeTradeMutation(old.order.id, async () => markConfirmedCancellation(cancelled(old, { deals: undefined }))); vi.advanceTimersByTime(50); });
        expect(store.getTradingState().trades[0]!.status).toMatchObject({ status: 'Cancelled', deals: [] });
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

    it('a background-engine order (no HTTP response, native New without full_code) applies with the engine\'s code hint (QA 10/12)', async () => {
        const hints = await import('./order-code-hints');
        hints.setOrderCodeHint((id, account) => id === 'fx05' && account?.account_id === 'fixture-futures' ? 'TXFJ6' : null);
        try {
            await deliver(byId('v1:FO:FSTREAM:RESET1:12'));
            await deliver(byId('v1:FD:FSTREAM:RESET1:8'));
            expect(store.getTradingState().positions.filter(p => p.code === 'TXFJ6')[0]).toMatchObject({ quantity: 1, direction: 'Buy' });
            expect(reasons('positions')).not.toContain('metadata-missing');
            expect(reasons('orders')).not.toContain('pending-report');
            expect(mocks.trades).not.toHaveBeenCalled();
        } finally { hints.setOrderCodeHint(null); }
    });

    it('a New parked before the engine named its order id is replayed once it does, with its deal', async () => {
        const hints = await import('./order-code-hints');
        try {
            await deliver(byId('v1:FO:FSTREAM:RESET1:12'));
            await deliver(byId('v1:FD:FSTREAM:RESET1:8'));
            expect(reasons('orders')).toContain('pending-report');
            expect(reasons('positions')).toContain('metadata-missing');
            hints.setOrderCodeHint(id => id === 'fx05' ? 'TXFJ6' : null);
            await act(async () => { hints.orderCodeHintsChanged(); vi.advanceTimersByTime(50); });
            expect(store.getTradingState().positions.filter(p => p.code === 'TXFJ6')[0]).toMatchObject({ quantity: 1 });
            expect(reasons('orders')).not.toContain('pending-report');
            expect(reasons('positions')).not.toContain('metadata-missing');
        } finally { hints.setOrderCodeHint(null); }
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
    // The cache may hold the order but not its deals; a cache-only resync must not
    // silently drop fills the App already projected from SSE (that empties the list).
    async function cacheResyncAfterDrop() {
        await act(async () => { mocks.status = 'down'; mocks.statusChanged!(); });
        await act(async () => { mocks.status = 'live'; mocks.statusChanged!(); });
        await vi.waitFor(() => expect(mocks.trades).toHaveBeenCalledWith('S', expect.anything(), { refresh: false }));
        await act(async () => { await Promise.resolve(); vi.advanceTimersByTime(50); });
    }
    async function observeSimulation() {
        const info = await import('./server-info-store');
        info.observeServerInfo(info.beginServerInfoRequest(), { simulation: true } as import('./shioaji').ServerInfo);
    }
    // The resync completed (it resolved the drop) and kept the simulation snapshot.
    function expectCleanResync() {
        expect(reasons('orders')).toEqual([]);
        expect(store.getTradingState().queries.orders.needsReconcile).toBe(false);
        expect(store.getTradingState().ordersSnapshotEnv).toBe('http://fixture.invalid|simulation');
    }
    // deal() is fixed to account 'a'; this describe's stock account differs.
    const stockDeal = (seq: string) => normalizeOrderEvent({ state: 'StockDeal', data: { StockDeal: {
        trade_id: 'new', seqno: 'new', ordno: 'new', exchange_seq: seq, broker_id: mocks.account.broker_id, account_id: mocks.account.account_id,
        action: 'Buy', code: '2330', price: 101, quantity: 1, order_lot: 'Common', order_cond: 'Cash', ts: epoch + 2,
    } } })!;
    it('a cache-only resync keeps fills the App already holds when the cache row omits their deals', async () => {
        await observeSimulation();
        await emit(order());
        const held = () => store.getTradingState().trades.find(t => t.order.id === 'new')!;
        // The App holds the fill from an authoritative read; the cache later omits its deals.
        const filled = { seq: 'fill-1', price: 101, quantity: 1, ts: epoch + 2 };
        const reported = { ...held(), status: { ...held().status, status: 'PartFilled', deal_quantity: 1, deals: [filled] } };
        mocks.trades.mockResolvedValue([reported]);
        vi.advanceTimersByTime(60_000);
        await act(async () => { await store.refreshTradingState('orders'); });
        expect(held().status.deals.map(d => d.seq)).toEqual(['fill-1']);
        mocks.trades.mockResolvedValue([{ ...reported, status: { ...reported.status, deals: [] } }]);
        await cacheResyncAfterDrop();
        expect(held().status.deals.map(d => d.seq)).toEqual(['fill-1']);
        expectCleanResync();
    });
    it('a cache row without a deals key still applies its status and keeps the held fill', async () => {
        await observeSimulation();
        await emit(order());
        const held = () => store.getTradingState().trades.find(t => t.order.id === 'new')!;
        const filled = { seq: 'fill-1', price: 101, quantity: 1, ts: epoch + 2 };
        const reported = { ...held(), status: { ...held().status, status: 'PartFilled', deal_quantity: 1, deals: [filled] } };
        mocks.trades.mockResolvedValue([reported]);
        vi.advanceTimersByTime(60_000);
        await act(async () => { await store.refreshTradingState('orders'); });
        // Without a deals array the merge must still complete: status moves, the fill stays.
        mocks.trades.mockResolvedValue([{ ...reported, status: { ...reported.status, status: 'Filled', deals: undefined } }]);
        await cacheResyncAfterDrop();
        expect(held().status.status).toBe('Filled');
        expect(held().status.deals.map(d => d.seq)).toEqual(['fill-1']);
        expectCleanResync();
    });
    // The chart checks deal_quantity against deals itself; the store raises no
    // global cause for it (only an authoritative read could clear one).
    it('a cache row that reports filled quantity without any deals raises no cause; an authoritative read later adds the fill', async () => {
        await observeSimulation();
        await emit(order());
        const held = () => store.getTradingState().trades.find(t => t.order.id === 'new')!;
        const reported = { ...held(), status: { ...held().status, status: 'PartFilled', deal_quantity: 1, deals: [] } };
        mocks.trades.mockResolvedValue([reported]);
        await cacheResyncAfterDrop();
        expect(held().status.deal_quantity).toBe(1);
        expect(held().status.deals).toEqual([]);
        expect(reasons('orders')).toEqual([]);
        mocks.trades.mockResolvedValue([{ ...reported, status: { ...reported.status, deals: [{ seq: 'fill-1', price: 101, quantity: 1, ts: epoch + 2 }] } }]);
        vi.advanceTimersByTime(60_000);
        await act(async () => { await store.refreshTradingState('orders'); });
        expect(held().status.deals.map(d => d.seq)).toEqual(['fill-1']);
        expect(reasons('orders')).toEqual([]);
    });
    it('rows without deals (cache known/new row, authoritative read) store an empty array, so a later SSE deal still projects', async () => {
        await emit(order());
        const row = (id: string) => store.getTradingState().trades.find(t => t.order.id === id)!;
        const bare = (id: string) => ({ ...row('new'), order: { ...row('new').order, id }, status: { ...row('new').status, id, deals: undefined } });
        mocks.trades.mockResolvedValue([bare('new'), bare('cache-only')]);
        await cacheResyncAfterDrop();
        expect(row('new').status.deals).toEqual([]);
        expect(row('cache-only').status.deals).toEqual([]);
        expect(reasons('orders')).toEqual([]);
        mocks.trades.mockResolvedValue([bare('new')]);
        vi.advanceTimersByTime(60_000);
        await act(async () => { await store.refreshTradingState('orders'); });
        expect(row('new').status.deals).toEqual([]);
        await emit(stockDeal('000001'));
        expect(row('new').status.deals.map(d => d.seq)).toEqual(['000001']);
    });
    it('an order response row without deals still takes a later SSE deal', async () => {
        await act(async () => { mocks.response!({ account: stock, trade: { contract: { code: '2330', security_type: 'STK', exchange: 'TSE', target_code: null },
            order: { id: 'new', seqno: 'new', ordno: 'new', account: stock, action: 'Buy', price: 100, quantity: 3 },
            status: { id: 'new', status: 'Submitted', status_code: '', msg: '', order_quantity: 3, deal_quantity: 0, cancel_quantity: 0, modified_price: 0 } } as unknown as import('./types/order').Trade }); });
        await emit(stockDeal('000001'));
        expect(store.getTradingState().trades.find(t => t.order.id === 'new')!.status.deals.map(d => d.seq)).toEqual(['000001']);
    });
    it('a cache row repeating a fill SSE already projected keeps it once', async () => {
        await emit(order());
        await emit(stockDeal('000001'));
        const held = () => store.getTradingState().trades.find(t => t.order.id === 'new')!;
        expect(held().status.deals.map(d => d.seq)).toEqual(['000001']);
        mocks.trades.mockResolvedValue([held()]);
        await cacheResyncAfterDrop();
        expect(held().status.deals.map(d => d.seq)).toEqual(['000001']);
        expect(held().status.deal_quantity).toBe(1);
        expect(reasons('orders')).toEqual([]);
    });
    // REST and the cache may spell one fill's seq differently: the row's deals
    // already cover deal_quantity, so the held spelling is not added again.
    it('a cache row whose deals already cover deal_quantity is not padded with a differently keyed held fill', async () => {
        await emit(order());
        const held = () => store.getTradingState().trades.find(t => t.order.id === 'new')!;
        const fill = (seq: string) => ({ seq, price: 101, quantity: 1, ts: epoch + 2 });
        const reported = { ...held(), status: { ...held().status, status: 'PartFilled', deal_quantity: 1, deals: [fill('rest-1')] } };
        mocks.trades.mockResolvedValue([reported]);
        vi.advanceTimersByTime(60_000);
        await act(async () => { await store.refreshTradingState('orders'); });
        expect(held().status.deals.map(d => d.seq)).toEqual(['rest-1']);
        mocks.trades.mockResolvedValue([{ ...reported, status: { ...reported.status, deals: [fill('sse-1')] } }]);
        await cacheResyncAfterDrop();
        expect(held().status.deals.map(d => d.seq)).toEqual(['sse-1']);
        expect(reasons('orders')).toEqual([]);
    });
    it('a cache row with only part of its deals is filled up to deal_quantity from held fills', async () => {
        await emit(order());
        const held = () => store.getTradingState().trades.find(t => t.order.id === 'new')!;
        const fill = (seq: string, price: number) => ({ seq, price, quantity: 1, ts: epoch + 2 });
        const reported = { ...held(), status: { ...held().status, status: 'PartFilled', deal_quantity: 2, deals: [fill('a', 101), fill('b', 102)] } };
        mocks.trades.mockResolvedValue([reported]);
        vi.advanceTimersByTime(60_000);
        await act(async () => { await store.refreshTradingState('orders'); });
        mocks.trades.mockResolvedValue([{ ...reported, status: { ...reported.status, deals: [fill('a', 101)] } }]);
        await cacheResyncAfterDrop();
        expect(held().status.deals.map(d => d.seq)).toEqual(['a', 'b']);
        expect(reasons('orders')).toEqual([]);
    });
    it('one fill spelled with another seq (REST vs SSE) is not added twice; the fill really missing still is', async () => {
        await emit(order());
        const held = () => store.getTradingState().trades.find(t => t.order.id === 'new')!;
        const reported = { ...held(), status: { ...held().status, status: 'PartFilled', deal_quantity: 2,
            deals: [{ seq: '1', price: 101, quantity: 1, ts: epoch + 2.004 }, { seq: '2', price: 102, quantity: 1, ts: epoch + 5 }] } };
        mocks.trades.mockResolvedValue([reported]);
        vi.advanceTimersByTime(60_000);
        await act(async () => { await store.refreshTradingState('orders'); });
        // The cache lists the first fill under its own seq spelling and lacks the second.
        mocks.trades.mockResolvedValue([{ ...reported, status: { ...reported.status, deals: [{ seq: '000001', price: 101, quantity: 1, ts: epoch + 2 }] } }]);
        await cacheResyncAfterDrop();
        expect(held().status.deals.map(d => d.seq)).toEqual(['000001', '2']);
    });
    it('two fills that cannot be told apart leave the gap open rather than guess (the chart then reports missing deals)', async () => {
        await emit(order());
        const held = () => store.getTradingState().trades.find(t => t.order.id === 'new')!;
        const fill = (seq: string) => ({ seq, price: 101, quantity: 1, ts: epoch + 2 });
        const reported = { ...held(), status: { ...held().status, status: 'PartFilled', deal_quantity: 2, deals: [fill('a'), fill('b')] } };
        mocks.trades.mockResolvedValue([reported]);
        vi.advanceTimersByTime(60_000);
        await act(async () => { await store.refreshTradingState('orders'); });
        mocks.trades.mockResolvedValue([{ ...reported, status: { ...reported.status, deals: [fill('a')] } }]);
        await cacheResyncAfterDrop();
        expect(held().status.deals.map(d => d.seq)).toEqual(['a']);
        expect(held().status.deal_quantity).toBe(2);
        expect(reasons('orders')).toEqual([]);
    });
    // An order placed in another window or the desktop App: this window never sees its HTTP
    // response, and a simulation New carries no full_code, so the report is parked.
    const otherWindowFill = () => {
        const fill = body(byId('v1:FD:FSTREAM:RESET1:8')) as { exchange_seq: string; price: number; quantity: number; ts: number };
        const row = response(byId('v1:FO:FSTREAM:RESET1:12'), futures).trade;
        return { ...row, status: { ...row.status, status: 'Filled', deal_quantity: 1, deals: [{ seq: fill.exchange_seq, price: fill.price, quantity: 1, ts: fill.ts }] } };
    };
    it('an order placed in another window is resolved from the cache shortly after, without a manual update', async () => {
        await deliver(byId('v1:FO:FSTREAM:RESET1:12'));
        await deliver(byId('v1:FD:FSTREAM:RESET1:8'));
        expect(reasons('orders')).toEqual(expect.arrayContaining(['pending-report']));
        expect(reasons('orders')).not.toContain('sequence-gap');
        mocks.trades.mockClear().mockImplementation(async (type: string) => type === 'F' ? [otherWindowFill()] : []);
        mocks.health.mockClear();
        await act(async () => { vi.advanceTimersByTime(1500); });
        await act(async () => { await Promise.resolve(); await Promise.resolve(); vi.advanceTimersByTime(50); });
        await vi.waitFor(() => expect(reasons('orders')).toEqual([]));
        expect(mocks.health).toHaveBeenCalled();
        expect(mocks.trades.mock.calls.every(c => c[2]?.refresh === false)).toBe(true);
        const row = store.getTradingState().trades.find(t => t.order.id === 'fx05')!;
        expect(row.status.deals.map(d => d.seq)).toEqual(['000001']);
        expect(row.status.deal_quantity).toBe(1);
    });
    // Review repro: a 2-lot order from another window, its first 1-lot fill arrives before the
    // order is known. The automatic cache read must never count that fill twice, whatever the
    // cache already shows (it reached the cache before or after the read).
    it.each([
        ['the cache counts the fill without its detail', 1, false],
        ['the cache lists the fill (real shape)', 1, true],
        ['the cache has not seen the fill yet', 0, false],
    ] as const)('another window, fill before order: the automatic read counts it once when %s', async (_label, cacheDq, listed) => {
        const fill = body(byId('v1:FD:FSTREAM:RESET1:8')) as { exchange_seq: string; price: number; quantity: number; ts: number };
        const row = response(byId('v1:FO:FSTREAM:RESET1:12'), futures).trade;
        const cacheRow = { ...row, order: { ...row.order, quantity: 2 }, status: { ...row.status, status: cacheDq ? 'PartFilled' : 'Submitted', order_quantity: 2,
            deal_quantity: cacheDq, deals: listed ? [{ seq: fill.exchange_seq, price: fill.price, quantity: 1, ts: fill.ts }] : [] } };
        mocks.trades.mockClear().mockImplementation(async (type: string) => type === 'F' ? [cacheRow] : []);
        mocks.health.mockClear();
        await deliver(byId('v1:FO:FSTREAM:RESET1:12'));
        await deliver(byId('v1:FD:FSTREAM:RESET1:8'));
        await act(async () => { vi.advanceTimersByTime(1500); });
        for (let i = 0; i < 10; i += 1) await act(async () => { await Promise.resolve(); vi.advanceTimersByTime(50); });
        await vi.waitFor(() => expect(reasons('orders')).toEqual([]));
        const traded = store.getTradingState().trades.find(t => t.order.id === 'fx05')!;
        expect(traded.status).toMatchObject({ deal_quantity: 1, status: 'PartFilled' });
        expect(traded.status.deals.map(d => d.seq)).toEqual(['000001']);
        expect(mocks.trades.mock.calls.every(c => c[2]?.refresh === false)).toBe(true);
    });
    it('a parked report this window resolves itself (its own order response) triggers no read', async () => {
        await deliver(byId('v1:FO:FSTREAM:RESET1:12'));
        expect(reasons('orders')).toContain('pending-report');
        await act(async () => { mocks.response!(response(byId('v1:FO:FSTREAM:RESET1:12'), futures)); });
        expect(reasons('orders')).not.toContain('pending-report');
        mocks.health.mockClear(); mocks.trades.mockClear();
        await act(async () => { vi.advanceTimersByTime(1600); });
        expect(mocks.health).not.toHaveBeenCalled();
        expect(mocks.trades).not.toHaveBeenCalled();
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

// #85 review P1-2: a cached tick may mark a fill only while it is newer than
// the row's mark source; snapshot refresh, reconnect and age retire it.
describe('fill mark uses only a fresh cached tick', () => {
    const tick = async (close: number) => { await act(async () => { mocks.tick!({ code: '2330', close: String(close) }); }); };
    const buy = async () => { await emit(order()); await emit(deal()); };
    const row = () => store.getTradingState().positions.find(p => p.code === '2330')!;

    it('a newer snapshot mark wins over an older cached tick', async () => {
        vi.advanceTimersByTime(500); await tick(105);
        expect(row().last_price).toBe(105);
        vi.advanceTimersByTime(1000);
        await act(async () => { await store.refreshTradingState('positions'); }); // snapshot marks 100
        await buy();
        expect(row()).toMatchObject({ quantity: 2000, last_price: 100, pnl: -1000 });
    });
    it('a tick after the snapshot marks a new holding', async () => {
        mocks.positions.mockReset().mockResolvedValue([]);
        vi.advanceTimersByTime(1500);
        await act(async () => { await store.refreshTradingState('positions'); });
        vi.advanceTimersByTime(100); await tick(105);
        await buy();
        expect(row()).toMatchObject({ quantity: 1000, price: 101, last_price: 105, pnl: 4000 });
    });
    it('a reconnect retires the cached tick', async () => {
        mocks.positions.mockReset().mockResolvedValue([]);
        vi.advanceTimersByTime(1500);
        await act(async () => { await store.refreshTradingState('positions'); });
        vi.advanceTimersByTime(100); await tick(105);
        await act(async () => { mocks.status = 'down'; mocks.statusChanged!(); mocks.status = 'live'; mocks.statusChanged!(); });
        await buy();
        expect(row()).toMatchObject({ last_price: 101, pnl: 0 });
    });
    it('an aged cached tick is not used', async () => {
        mocks.positions.mockReset().mockResolvedValue([]);
        vi.advanceTimersByTime(1500);
        await act(async () => { await store.refreshTradingState('positions'); });
        vi.advanceTimersByTime(100); await tick(105);
        vi.advanceTimersByTime(61_000);
        await buy();
        expect(row()).toMatchObject({ last_price: 101, pnl: 0 });
    });
});

// #85 review P1-1: position_unit rows are aggregates; a partial close cannot
// know which lot's price FIFO consumed, so positions go 待對帳 (成本估算).
async function aggregatePartialClose() {
    mocks.account.account_type = 'F';
    mocks.margin.mockResolvedValue({ equity: 1000 });
    mocks.cached.mockReturnValue({ code: 'TXFI6', multiplier: 200 });
    mocks.positions.mockReset().mockResolvedValue([{ id: 1, code: 'TXFI6', direction: 'Buy', quantity: 2, price: 110, last_price: 110, pnl: 0 }]);
    vi.advanceTimersByTime(1500);
    await act(async () => { await store.refreshTradingState(); });
    expect(store.getTradingState().queries.positions.reasons ?? []).not.toContain('cost-estimate');
    const raw = order().raw as { data: { StockOrder: { order: Record<string, unknown>; status: Record<string, unknown>; contract: Record<string, unknown>; operation: unknown } } };
    const body = raw.data.StockOrder;
    await emit(normalizeOrderEvent({ state: 'FuturesOrder', data: { FuturesOrder: { ...body,
        order: { ...body.order, action: 'Sell', oc_type: 'Cover' },
        contract: { code: 'TXF', full_code: 'TXFI6', security_type: 'FUT', exchange: 'TAIFEX' },
    } } })!);
    await coverDeal('c1');
    const p = store.getTradingState().positions.find(r => r.code === 'TXFI6')!;
    expect(p).toMatchObject({ quantity: 1, price: 110, costUncertain: true });
    const q = store.getTradingState().queries.positions;
    expect(q.needsReconcile).toBe(true);
    expect(q.reasons).toContain('cost-estimate');
}
async function coverDeal(seq: string) {
    await emit(normalizeOrderEvent({ state: 'FuturesDeal', data: { FuturesDeal: {
        trade_id: 'new', seqno: 'new', ordno: 'new', exchange_seq: seq, broker_id: 'fixture', account_id: 'a',
        code: 'TXF', full_code: 'TXFI6', action: 'Sell', price: 110, quantity: 1, ts: epoch + 4,
    } } })!);
}
const costReasons = () => store.getTradingState().queries.positions.reasons ?? [];
it('flags a partial futures close of an aggregate snapshot row as a cost estimate', async () => {
    await aggregatePartialClose();
    // The next authoritative snapshot replaces the row and clears the reason.
    mocks.positions.mockResolvedValue([{ id: 1, code: 'TXFI6', direction: 'Buy', quantity: 1, price: 120, last_price: 110, pnl: -2000 }]);
    vi.advanceTimersByTime(1500);
    await act(async () => { await store.refreshTradingState('positions'); });
    expect(costReasons()).not.toContain('cost-estimate');
    expect(store.getTradingState().positions.find(r => r.code === 'TXFI6')).not.toHaveProperty('costUncertain');
});
it('clears the cost estimate once the flagged holding goes flat', async () => {
    await aggregatePartialClose();
    await coverDeal('c2');
    expect(store.getTradingState().positions.find(r => r.code === 'TXFI6')).toBeUndefined();
    expect(costReasons()).not.toContain('cost-estimate');
});
it('keeps the cost estimate when a racing report makes the refresh skip the snapshot', async () => {
    await aggregatePartialClose();
    const pending = deferred<unknown[]>();
    mocks.positions.mockImplementationOnce(() => pending.promise);
    vi.advanceTimersByTime(1500);
    let refresh!: Promise<void>;
    await act(async () => { refresh = store.refreshTradingState('positions'); });
    await flush();
    await emit(order('other', 100, epoch + 5)); // a report during the read
    await act(async () => { pending.resolve([{ id: 1, code: 'TXFI6', direction: 'Buy', quantity: 1, price: 120, last_price: 110, pnl: -2000 }]); await refresh; });
    expect(store.getTradingState().positions.find(r => r.code === 'TXFI6')).toMatchObject({ costUncertain: true });
    expect(costReasons()).toContain('cost-estimate');
});

// review P2: one account's refresh must not retire another account's fresh tick.
it('an account refresh does not discard a fresh tick for another account', async () => {
    mocks.extraAccounts = [{ ...mocks.account, account_id: 'b' }];
    mocks.positions.mockReset().mockImplementation(async (_t: string, a: Account) => a.account_id === 'a' ? [baseline()] : []);
    vi.advanceTimersByTime(1500);
    await act(async () => { await store.refreshTradingState('positions'); });
    vi.advanceTimersByTime(100);
    await act(async () => { mocks.tick!({ code: '2330', close: '105' }); });
    // b's read fails: only a's snapshot is refreshed.
    mocks.positions.mockImplementation(async (_t: string, a: Account) => { if (a.account_id === 'b') throw new Error('503'); return [baseline()]; });
    vi.advanceTimersByTime(1500);
    await act(async () => { await store.refreshTradingState('positions'); });
    await emit(normalizeOrderEvent({ state: 'StockDeal', data: { StockDeal: {
        trade_id: 'bb', seqno: 'bb', ordno: 'bb', exchange_seq: 'fill-b', broker_id: 'fixture', account_id: 'b',
        action: 'Buy', code: '2330', price: 101, quantity: 1, order_lot: 'Common', order_cond: 'Cash', ts: epoch + 4,
    } } })!);
    const b = store.getTradingState().positions.find(p => p.account?.account_id === 'b')!;
    expect(b).toMatchObject({ quantity: 1000, price: 101, last_price: 105, pnl: 4000 });
    // a was re-marked by its own snapshot (100), newer than the tick.
    expect(store.getTradingState().positions.find(p => p.account?.account_id === 'a')).toMatchObject({ last_price: 100 });
});

// A deal that beat its order is parked in pendingDeals. A later read-back row
// (cache resync, update_status, HTTP response) can already count that fill in
// deal_quantity without listing it in status.deals; replaying the parked fill
// must then only add its detail, never count it again.
describe('parked deal-before-order replayed onto a read-back row', () => {
    const fill = (seq: string) => normalizeOrderEvent({ state: 'StockDeal', data: { StockDeal: {
        trade_id: 'new', seqno: 'new', ordno: 'new', exchange_seq: seq, broker_id: 'fixture', account_id: 'a',
        action: 'Buy', code: '2330', price: 101, quantity: 1, order_lot: 'Common', order_cond: 'Cash', ts: epoch + 2,
    } } })!;
    const detail = (seq: string) => ({ seq, ts: epoch + 2, quantity: 1, price: 101 });
    const readRow = (quantity: number, dealQuantity: number, deals: ReturnType<typeof detail>[] = []) => ({
        contract: { code: '2330', security_type: 'STK', exchange: 'TSE', target_code: null },
        order: { id: 'new', seqno: 'new', ordno: 'new', action: 'Buy', price: 100, quantity, account: mocks.account },
        status: { id: 'new', status: dealQuantity >= quantity ? 'Filled' : dealQuantity ? 'PartFilled' : 'Submitted', status_code: '', msg: '',
            order_quantity: quantity, deal_quantity: dealQuantity, cancel_quantity: 0, modified_price: 0, deals },
    }) as unknown as import('./types/order').Trade;
    const row = () => store.getTradingState().trades.find(t => t.order.id === 'new')!;
    const seqs = () => row().status.deals.map(d => d.seq);
    const held = (code = '2330') => store.getTradingState().positions.find(p => p.code === code)?.quantity;
    const reasons = () => [...store.getTradingState().queries.orders.reasons, ...store.getTradingState().queries.positions.reasons];
    const futuresFill = (id: string, seq: string) => normalizeOrderEvent({ state: 'FuturesDeal', data: { FuturesDeal: {
        trade_id: id, seqno: id, ordno: id, exchange_seq: seq, broker_id: 'fixture', account_id: 'a',
        code: 'TXF', full_code: 'TXFI6', action: 'Buy', price: 200, quantity: 1, ts: epoch + 4,
    } } })!;

    it.each([
        // review repro: quantity 2, the cache row counts the parked fill (dq 1) with deals []
        { name: 'counted without detail (review repro)', quantity: 2, parked: ['000001'], readDq: 1, listed: [] as string[], status: 'PartFilled', dq: 1 },
        { name: 'not counted yet', quantity: 2, parked: ['000001'], readDq: 0, listed: [], status: 'PartFilled', dq: 1 },
        { name: 'detail already listed', quantity: 2, parked: ['000001'], readDq: 1, listed: ['000001'], status: 'PartFilled', dq: 1 },
        { name: 'partial: two parked, one counted', quantity: 3, parked: ['000001', '000002'], readDq: 1, listed: [], status: 'PartFilled', dq: 2 },
        { name: 'filled row without details', quantity: 2, parked: ['000001', '000002'], readDq: 2, listed: [], status: 'Filled', dq: 2 },
    ])('cache resync: $name', async ({ quantity, parked, readDq, listed, status, dq }) => {
        for (const seq of parked) await emit(fill(seq));
        expect(reasons()).toContain('metadata-missing');
        expect(held()).toBe(1000 + 1000 * parked.length); // stock fills hold at once
        mocks.trades.mockResolvedValue([readRow(quantity, readDq, listed.map(detail))]);
        await act(async () => { await store.checkTradeCacheHealth('gap'); vi.advanceTimersByTime(50); });
        expect(mocks.trades).toHaveBeenLastCalledWith('S', mocks.account, { refresh: false });
        expect(row().status).toMatchObject({ status, deal_quantity: dq });
        expect(seqs()).toEqual(parked);
        expect(remainingWorkingOrderQuantity(row())).toBe(quantity - dq);
        expect(held()).toBe(1000 + 1000 * parked.length);
        expect(reasons()).toEqual([]);
    });

    it('a live fill still adds to a read-back row whose deal_quantity exceeds its details', async () => {
        mocks.trades.mockResolvedValue([readRow(2, 1)]);
        vi.advanceTimersByTime(1500);
        await act(async () => { await store.refreshTradingState('orders'); });
        await emit(fill('000002'));
        expect(row().status).toMatchObject({ status: 'Filled', deal_quantity: 2 });
        expect(seqs()).toEqual(['000002']);
        expect(remainingWorkingOrderQuantity(row())).toBe(0);
        expect(held()).toBe(2000);
        expect(reasons()).toEqual([]);
    });

    it('order response: a parked fill the response row already counts only adds its detail', async () => {
        await emit(fill('000001'));
        await act(async () => { mocks.response!({ trade: readRow(2, 1), account: mocks.account }); vi.advanceTimersByTime(50); });
        expect(row().status).toMatchObject({ status: 'PartFilled', deal_quantity: 1 });
        expect(seqs()).toEqual(['000001']);
        expect(remainingWorkingOrderQuantity(row())).toBe(1);
        expect(held()).toBe(2000);
        expect(reasons()).toEqual([]);
    });

    it('order report after update_status: a parked fill the read counted only adds its detail', async () => {
        await emit(fill('000001'));
        mocks.trades.mockResolvedValue([readRow(3, 1)]);
        vi.advanceTimersByTime(1500);
        await act(async () => { await store.refreshTradingState('orders'); });
        expect(seqs()).toEqual([]); // the authoritative read itself does not replay parked fills
        await emit(order('new', 105, epoch + 3, 'UpdatePrice'));
        expect(row().status).toMatchObject({ status: 'PartFilled', deal_quantity: 1 });
        expect(seqs()).toEqual(['000001']);
        expect(remainingWorkingOrderQuantity(row())).toBe(2);
        expect(held()).toBe(2000);
        expect(reasons()).toEqual([]);
    });

    it('contract metadata replay: a parked futures fill counted by a read-back row adds its detail and holds once', async () => {
        mocks.account.account_type = 'F';
        mocks.positions.mockResolvedValueOnce([]); mocks.margin.mockResolvedValue({ equity: 1000 });
        vi.advanceTimersByTime(1500);
        await act(async () => { await store.refreshTradingState(); });
        const metadata = deferred<{ code: string; multiplier: number }>();
        mocks.ensure.mockImplementation(() => metadata.promise); mocks.cached.mockReturnValue(undefined);
        await emit(futuresFill('new', 'f1')); // order unknown: parked, not held yet
        expect(held('TXFI6')).toBeUndefined();
        // orders-only update_status: the row counts f1 without its detail
        const read = readRow(2, 1);
        mocks.trades.mockResolvedValue([{ ...read, contract: { code: 'TXFI6', security_type: 'FUT', exchange: 'TAIFEX', target_code: null },
            order: { ...read.order, octype: 'New' } }]);
        vi.advanceTimersByTime(1500);
        await act(async () => { await store.refreshTradingState('orders'); });
        // another order's fill on the same contract starts the metadata lookup
        const body = (order('other').raw as { data: { StockOrder: Record<string, Record<string, unknown>> } }).data.StockOrder;
        await emit(normalizeOrderEvent({ state: 'FuturesOrder', data: { FuturesOrder: { ...body, order: { ...body.order, oc_type: 'New' },
            contract: { code: 'TXF', full_code: 'TXFI6', security_type: 'FUT', exchange: 'TAIFEX' } } } })!);
        await emit(futuresFill('other', 'f2'));
        expect(mocks.ensure).toHaveBeenCalledWith('TXFI6');
        await act(async () => { mocks.cached.mockReturnValue({ code: 'TXFI6', multiplier: 200 }); metadata.resolve({ code: 'TXFI6', multiplier: 200 }); await metadata.promise; });
        expect(row().status).toMatchObject({ status: 'PartFilled', deal_quantity: 1 });
        expect(remainingWorkingOrderQuantity(row())).toBe(1);
        expect(seqs()).toEqual(['f1']);
        expect(held('TXFI6')).toBe(2); // f1 and f2, each once
        expect(reasons()).toEqual([]);
    });

    it('code hints: a parked New re-projected onto a read-back row replays the parked fill as detail only', async () => {
        mocks.account.account_type = 'F';
        mocks.positions.mockResolvedValueOnce([]); mocks.margin.mockResolvedValue({ equity: 1000 });
        vi.advanceTimersByTime(1500);
        await act(async () => { await store.refreshTradingState(); });
        mocks.cached.mockReturnValue({ code: 'TXFI6', multiplier: 200 });
        const hints = await import('./order-code-hints');
        try {
            // a background engine's New without full_code: no code hint yet, so it is parked
            const body = (order('new').raw as { data: { StockOrder: Record<string, Record<string, unknown>> } }).data.StockOrder;
            await emit(normalizeOrderEvent({ state: 'FuturesOrder', data: { FuturesOrder: { ...body, order: { ...body.order, oc_type: 'New' },
                contract: { code: 'TXF', security_type: 'FUT', exchange: 'TAIFEX' } } } })!);
            expect(reasons()).toContain('pending-report');
            await emit(futuresFill('new', 'f1')); // order unknown: parked
            const read = readRow(3, 1);
            mocks.trades.mockResolvedValue([{ ...read, contract: { code: 'TXFI6', security_type: 'FUT', exchange: 'TAIFEX', target_code: null },
                order: { ...read.order, octype: 'New' } }]);
            vi.advanceTimersByTime(1500);
            await act(async () => { await store.refreshTradingState('orders'); });
            expect(seqs()).toEqual([]);
            hints.setOrderCodeHint(id => id === 'new' ? 'TXFI6' : null);
            await act(async () => { hints.orderCodeHintsChanged(); vi.advanceTimersByTime(50); });
            expect(seqs()).toEqual(['f1']);
            expect(row().status).toMatchObject({ status: 'PartFilled', deal_quantity: 1 });
            expect(remainingWorkingOrderQuantity(row())).toBe(2);
        } finally { hints.setOrderCodeHint(null); }
    });
});
