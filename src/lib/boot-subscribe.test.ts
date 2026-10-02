import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    accounts: vi.fn(), health: vi.fn(), subscribe: vi.fn(), notify: vi.fn(), snapshots: vi.fn(),
    simulation: undefined as boolean | undefined,
    version: 0,
    currentAccounts: [] as import('./types/portfolio').Account[],
    modeChanged: undefined as (() => void) | undefined,
}));
vi.mock('./server-info-store', () => ({
    getServerModeVersion: () => mocks.version,
    knownServerInfo: () => mocks.simulation === undefined ? undefined : { simulation: mocks.simulation },
    subscribeServerInfo: (listener: () => void) => { mocks.modeChanged = listener; return () => { mocks.modeChanged = undefined; }; },
}));
vi.mock('./features', () => ({ agentModule: null }));
vi.mock('./runtime', () => ({ EXPECTED_SERVER_VERSION: '', isTauri: false }));
vi.mock('./shioaji', () => ({
    fetchTradeCacheHealth: mocks.health,
    subscribeTradeEvents: mocks.subscribe,
}));
vi.mock('./account-store', () => ({
    loadAccountsShared: async () => { mocks.currentAccounts = await mocks.accounts(); return mocks.currentAccounts; },
    getAccountState: () => ({ accounts: mocks.currentAccounts }),
}));
vi.mock('./trading-state', () => ({ startTradingState: vi.fn(), refreshTradingStateForModeChange: mocks.snapshots }));
vi.mock('./trade', () => ({ notify: mocks.notify }));
vi.mock('./stream', () => ({}));
vi.mock('./tauri', () => ({}));
vi.mock('./window-role', () => ({}));

let subscribeTradeReports: typeof import('./boot').subscribeTradeReports;

const stock = { account_type: 'S', broker_id: 'fixture', account_id: 'stock', signed: true };
const futures = { account_type: 'F', broker_id: 'fixture', account_id: 'futures', signed: true };
const health = (reason?: string) => ({
    state: reason ? 'Unknown' : 'Healthy',
    reasons: reason ? [{ event_type: 'StockOrder', reason }] : [],
});
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
}

beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.simulation = undefined;
    mocks.version = 0;
    mocks.currentAccounts = [];
    mocks.modeChanged = undefined;
    ({ subscribeTradeReports } = await import('./boot'));
    mocks.accounts.mockResolvedValue([stock, futures]);
    mocks.health.mockResolvedValue(health());
    mocks.subscribe.mockResolvedValue(undefined);
});

describe('subscribeTradeReports', () => {
    it.each([true, false, undefined])('subscribes unsigned accounts only when simulation=%s (#228)', async simulation => {
        mocks.simulation = simulation;
        const unsigned = { ...stock, signed: false };
        mocks.accounts.mockResolvedValue([unsigned]);
        mocks.health.mockResolvedValue(health('NotSubscribed'));
        await subscribeTradeReports();
        expect(mocks.subscribe.mock.calls).toEqual(simulation === true ? [[unsigned]] : []);
        expect(unsigned.signed).toBe(false);
    });

    it('subscribes skipped unsigned accounts when unknown mode becomes simulation (#228)', async () => {
        const unsigned = { ...stock, signed: false };
        mocks.accounts.mockResolvedValue([unsigned]);
        mocks.health.mockResolvedValue(health('NotSubscribed'));
        await subscribeTradeReports();
        expect(mocks.subscribe).not.toHaveBeenCalled();
        mocks.simulation = true;
        mocks.version += 1;
        mocks.modeChanged!();
        await vi.waitFor(() => expect(mocks.subscribe.mock.calls).toEqual([[unsigned]]));
        expect(mocks.snapshots).toHaveBeenCalledOnce();
        mocks.modeChanged!(); // ordinary /info refresh does not resubscribe
        expect(mocks.accounts).toHaveBeenCalledTimes(2);
        expect(mocks.snapshots).toHaveBeenCalledOnce();
    });

    it.each([false, true])('rechecks reports and snapshots after mode %s → unknown → same mode', async simulation => {
        mocks.simulation = simulation;
        await subscribeTradeReports();
        mocks.simulation = undefined;
        mocks.version += 1;
        mocks.modeChanged!();
        await Promise.resolve();
        expect(mocks.accounts).toHaveBeenCalledOnce();
        expect(mocks.snapshots).not.toHaveBeenCalled();

        mocks.health.mockResolvedValue(health('NotSubscribed'));
        mocks.simulation = simulation;
        mocks.version += 1;
        mocks.modeChanged!();
        await vi.waitFor(() => expect(mocks.subscribe.mock.calls).toEqual([[stock], [futures]]));
        expect(mocks.accounts).toHaveBeenCalledTimes(2);
        expect(mocks.snapshots).toHaveBeenCalledOnce();
        mocks.modeChanged!();
        expect(mocks.accounts).toHaveBeenCalledTimes(2);
        expect(mocks.snapshots).toHaveBeenCalledOnce();
    });

    it('queues recovery when production reconnects during an old health read', async () => {
        mocks.simulation = false;
        await subscribeTradeReports();
        const pending = deferred();
        mocks.health.mockImplementationOnce(() => pending.promise.then(() => health('NotSubscribed')));
        const run = subscribeTradeReports();
        const discarded = expect(run).rejects.toThrow('模式已變更');
        await vi.waitFor(() => expect(mocks.health).toHaveBeenCalledTimes(3));
        mocks.simulation = undefined;
        mocks.version += 1;
        mocks.modeChanged!();
        mocks.simulation = false;
        mocks.version += 1;
        mocks.modeChanged!();
        mocks.health.mockResolvedValue(health('NotSubscribed'));
        pending.resolve();
        await discarded;
        await vi.waitFor(() => expect(mocks.subscribe.mock.calls).toEqual([[stock], [futures]]));
        expect(mocks.accounts).toHaveBeenCalledTimes(3);
        expect(mocks.snapshots).toHaveBeenCalledOnce();
    });

    it('rechecks a new mode version even when its available value stays production', async () => {
        mocks.simulation = false;
        await subscribeTradeReports();
        mocks.health.mockResolvedValue(health('NotSubscribed'));
        mocks.version += 1;
        mocks.modeChanged!();
        await vi.waitFor(() => expect(mocks.subscribe.mock.calls).toEqual([[stock], [futures]]));
        expect(mocks.snapshots).toHaveBeenCalledOnce();
    });

    it('revisits mode changes while a subscription check is in flight (#228)', async () => {
        const pending = deferred();
        const unsigned = { ...futures, signed: false };
        mocks.accounts.mockResolvedValue([stock, unsigned]);
        mocks.health.mockImplementationOnce(() => pending.promise.then(() => health()));
        const run = subscribeTradeReports();
        const discarded = expect(run).rejects.toThrow('模式已變更');
        await vi.waitFor(() => expect(mocks.health).toHaveBeenCalledOnce());
        mocks.simulation = true;
        mocks.version += 1;
        mocks.modeChanged!();
        mocks.health.mockResolvedValue(health('NotSubscribed'));
        pending.resolve();
        await discarded;
        await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledWith(unsigned));
        expect(unsigned.signed).toBe(false);
    });

    it.each(['production', 'unknown', 'roundtrip', 'removed'] as const)('does not apply stale health or subscribe from it after %s', async change => {
        mocks.simulation = true;
        const pending = deferred();
        mocks.health.mockImplementationOnce(() => pending.promise.then(() => health('NotSubscribed')));
        const run = subscribeTradeReports();
        const discarded = expect(run).rejects.toThrow('已丟棄回應');
        await vi.waitFor(() => expect(mocks.health).toHaveBeenCalledOnce());
        if (change === 'removed') mocks.currentAccounts = [];
        else {
            mocks.simulation = change === 'unknown' ? undefined : false;
            mocks.version += 1;
            if (change === 'roundtrip') { mocks.simulation = true; mocks.version += 1; }
        }
        pending.resolve();
        await discarded;
        expect(mocks.subscribe).not.toHaveBeenCalled();
        expect(mocks.health).toHaveBeenCalledOnce();
    });
    it('preserves existing subscriptions on cached login', async () => {
        await subscribeTradeReports();
        expect(mocks.health.mock.calls).toEqual([['S', stock], ['F', futures]]);
        expect(mocks.subscribe).not.toHaveBeenCalled();
    });

    it('subscribes only accounts with a NotSubscribed reason', async () => {
        mocks.health.mockResolvedValueOnce(health('NoBaseline'))
            .mockResolvedValueOnce(health('NotSubscribed'));
        await subscribeTradeReports();
        expect(mocks.subscribe.mock.calls).toEqual([[futures]]);
    });

    it('falls back to subscribe when health fails or the route is absent', async () => {
        mocks.health.mockRejectedValueOnce(new Error('404 Not Found'))
            .mockRejectedValueOnce(new Error('connection reset'));
        await subscribeTradeReports();
        expect(mocks.subscribe.mock.calls).toEqual([[stock], [futures]]);
    });

    it('checks and subscribes multiple accounts in sequence', async () => {
        const first = deferred();
        mocks.health.mockResolvedValue(health('NotSubscribed'));
        mocks.subscribe.mockImplementationOnce(() => first.promise);
        const run = subscribeTradeReports();
        await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));
        expect(mocks.health.mock.calls).toEqual([['S', stock]]);
        first.resolve();
        await run;
        expect(mocks.health.mock.calls).toEqual([['S', stock], ['F', futures]]);
        expect(mocks.subscribe.mock.calls).toEqual([[stock], [futures]]);
    });

    it('shares an in-flight check across callers', async () => {
        const first = deferred();
        mocks.health.mockResolvedValue(health('NotSubscribed'));
        mocks.subscribe.mockImplementationOnce(() => first.promise);
        const a = subscribeTradeReports();
        const b = subscribeTradeReports();
        expect(b).toBe(a);
        await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));
        first.resolve();
        await Promise.all([a, b]);
        expect(mocks.accounts).toHaveBeenCalledTimes(1);
        expect(mocks.subscribe).toHaveBeenCalledTimes(2);
    });
});
