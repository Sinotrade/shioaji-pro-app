import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from './types/portfolio';
import type { ServerInfo } from './shioaji';

const m = vi.hoisted(() => ({
    accounts: [] as Account[], nativeFetch: vi.fn(), loading: vi.fn(), desktop: true,
    register: vi.fn(), ensure: vi.fn(), place: vi.fn(),
    tick: undefined as ((tick: { code: string; close: number }) => void) | undefined,
}));
vi.mock('./runtime', () => ({ getApiBase: () => '', get isTauri() { return m.desktop; }, EXPECTED_SERVER_VERSION: '' }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => 'unowned') }));
vi.mock('./account-store', () => ({
    getAccountState: () => ({ accounts: m.accounts }), accountFor: () => m.accounts[0],
    loadAccountsShared: async () => m.accounts,
}));
vi.mock('./features', () => ({ agentModule: null }));
vi.mock('./trading-state', () => ({ refreshTradingStateForModeChange: vi.fn(), getTradingState: () => ({ positions: [] }) }));
vi.mock('./trade', () => ({ notify: vi.fn(), placeQuickOrder: m.place }));
vi.mock('./contracts-cache', () => ({ ensureContract: m.ensure, getCachedContract: () => undefined }));
vi.mock('./protection-env', () => ({
    currentProtectionEnv: () => {
        const simulation = info.knownServerInfo()?.simulation;
        return simulation === undefined ? null : `|${simulation ? 'simulation' : 'production'}`;
    },
    onProtectionEnvChange: (listener: () => void) => info.subscribeServerInfo(listener),
    envBase: (env: string) => env.slice(0, env.lastIndexOf('|')),
    reportEnvMatches: () => true,
    refreshProtectionEnv: async () => undefined, watchProtectionEnv: () => undefined,
}));
vi.mock('./stream', () => ({
    registerSubscription: m.register, unregisterSubscription: vi.fn(),
    getStreamStatus: () => 'live', isStreamOwner: () => true,
    subscribeStatusStore: () => () => undefined, subscribeStreamOwner: () => () => undefined,
    onOrderEvent: () => () => undefined, onOddLotTick: () => () => undefined, onStreamEvent: () => () => undefined,
    onAnyTick: (callback: typeof m.tick) => { m.tick = callback; return () => undefined; },
}));
vi.mock('./tauri', () => ({}));
vi.mock('./window-role', () => ({}));
vi.mock('./frontend-ready', () => ({}));

let api: typeof import('./api');
let shioaji: typeof import('./shioaji');
let info: typeof import('./server-info-store');
let release: () => void;
const mode = (simulation: boolean | undefined) => info.observeServerInfo(info.beginServerInfoRequest(),
    simulation === undefined ? undefined : { simulation } as ServerInfo);

beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    m.desktop = true;
    m.accounts = [{ account_type: 'F', broker_id: 'fixture', account_id: 'unsigned', signed: false, username: '', person_id: '' }];
    const ready = new Promise<void>(resolve => { release = resolve; });
    vi.doMock('@tauri-apps/plugin-http', async () => {
        m.loading();
        await ready;
        return { fetch: m.nativeFetch };
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    vi.stubGlobal('BroadcastChannel', undefined);
    api = await import('./api');
    shioaji = await import('./shioaji');
    info = await import('./server-info-store');
    mode(true);
    m.nativeFetch.mockImplementation(async () => new Response('{}'));
});
afterEach(() => vi.unstubAllGlobals());

it.each(['production', 'unknown', 'roundtrip', 'removed', 'unsigned'] as const)(
    'rejects a trade subscription after %s during native module loading', async change => {
        // A stale signed selector must never override the current account row.
        const captured = { ...m.accounts[0]!, signed: true };
        if (change === 'unsigned') { m.accounts[0]!.signed = true; mode(false); }
        const pending = shioaji.subscribeTradeEvents(captured);
        const rejected = expect(pending).rejects.toThrow(/已變更|不可用/);
        await vi.waitFor(() => expect(m.loading).toHaveBeenCalledOnce());
        if (change === 'removed') m.accounts = [];
        else if (change === 'unsigned') m.accounts[0]!.signed = false;
        else {
            mode(change === 'unknown' ? undefined : false);
            if (change === 'roundtrip') mode(true);
        }
        release();
        await rejected;
        expect(m.nativeFetch).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    },
);

it('keeps the boot health → subscription path guarded during native module loading', async () => {
    // Let health complete, then hold the subscription transport's await.
    const health = vi.spyOn(shioaji, 'fetchTradeCacheHealth').mockResolvedValue({
        reasons: [{ reason: 'NotSubscribed' }],
    } as Awaited<ReturnType<typeof shioaji.fetchTradeCacheHealth>>);
    const { subscribeTradeReports } = await import('./boot');
    const pending = subscribeTradeReports();
    const rejected = expect(pending).rejects.toThrow('已變更');
    await vi.waitFor(() => expect(m.loading).toHaveBeenCalledOnce());
    expect(health).toHaveBeenCalledOnce();
    mode(false);
    release();
    await rejected;
    expect(m.nativeFetch).not.toHaveBeenCalled();
});

it.each([true, false, undefined])('sends eligible trade subscriptions in mode %s', async simulation => {
    mode(simulation);
    m.accounts[0]!.signed = simulation !== true;
    const pending = shioaji.subscribeTradeEvents(m.accounts[0]!);
    await vi.waitFor(() => expect(m.loading).toHaveBeenCalledOnce());
    release();
    await pending;
    expect(m.nativeFetch).toHaveBeenCalledOnce();
    expect(JSON.parse(m.nativeFetch.mock.calls[0]![1].body)).toEqual({
        broker_id: 'fixture', account_id: 'unsigned', account_type: 'F',
    });
    expect(m.accounts[0]!.signed).toBe(simulation !== true);
});

const paths = [
    '/api/v1/auth/subscribe_trade', '/api/v1/stream/subscribe', '/api/v1/stream/unsubscribe',
    ...['calculated_index', 'index_contribution', 'industry_contribution', 'index_components', 'scanner']
        .flatMap(capability => ['subscribe', 'unsubscribe'].map(action => `/api/v1/stream/${action}/${capability}`)),
];
it('rechecks the mode at native dispatch for account-scoped trade subscriptions', async () => {
    const path = '/api/v1/auth/subscribe_trade';
    const pending = api.apiPost(path, {});
    const rejected = expect(pending).rejects.toThrow('已變更');
    await vi.waitFor(() => expect(m.loading).toHaveBeenCalledOnce());
    mode(false);
    mode(true); // Same final mode, different generation.
    release();
    await rejected;
    expect(m.nativeFetch).not.toHaveBeenCalled();
});

it('rechecks the mode after browser serialization for account-scoped trade subscriptions', async () => {
    const path = '/api/v1/auth/subscribe_trade';
    m.desktop = false;
    await expect(api.apiPost(path, { toJSON() { mode(false); return {}; } })).rejects.toThrow('已變更');
    expect(fetch).not.toHaveBeenCalled();
    expect(m.nativeFetch).not.toHaveBeenCalled();
});

it.each(paths.slice(1))('sends account-independent %s even if the mode changes during native loading', async path => {
    const pending = api.apiPost(path, {});
    await vi.waitFor(() => expect(m.loading).toHaveBeenCalledOnce());
    mode(false);
    mode(true);
    release();
    await pending;
    expect(m.nativeFetch).toHaveBeenCalledOnce();
});

it.each(paths.slice(1))('sends account-independent %s even if the mode changes during browser serialization', async path => {
    m.desktop = false;
    await api.apiPost(path, { toJSON() { mode(false); return {}; } });
    expect(fetch).toHaveBeenCalledOnce();
    expect(m.nativeFetch).not.toHaveBeenCalled();
});

it.each([true, false])('keeps a restored protection trigger Tick subscribed as unknown mode becomes %s', async simulation => {
    const contract = { code: 'TXFR1', target_code: 'TXFJ6', security_type: 'FUT', exchange: 'TAIFEX' };
    m.accounts[0]!.signed = true;
    const rows = new Map([['sj-pro-triggers', JSON.stringify([{
        id: 'restored-stop', code: contract.code, orderCode: contract.target_code,
        kind: 'stop', condition: 'below', price: 48000, action: 'Sell', quantity: 1,
        env: `|${simulation ? 'simulation' : 'production'}`, account: m.accounts[0],
    }])]]);
    vi.stubGlobal('localStorage', { getItem: (key: string) => rows.get(key) ?? null,
        setItem: (key: string, value: string) => { rows.set(key, value); } });
    vi.stubGlobal('navigator', {}); // main-window executor fallback; no App involved
    vi.stubGlobal('location', { search: '' });
    m.ensure.mockResolvedValue(contract);
    m.nativeFetch.mockImplementation(async () => new Response('{"success":true}'));
    m.place.mockImplementation(async (...args: unknown[]) => {
        (args[4] as { beforeSend?: () => void } | undefined)?.beforeSend?.();
        return { order: { id: 'exit' }, status: { status: 'PendingSubmit' } };
    });
    mode(undefined);
    const engine = await import('./trigger-engine');
    engine.startTriggerEngine();
    await vi.waitFor(() => expect(m.loading).toHaveBeenCalledOnce());
    mode(simulation); // syncQuotes sees an existing hold while native import waits
    release();
    await vi.waitFor(() => expect(m.register).toHaveBeenCalledOnce());
    expect(m.nativeFetch).toHaveBeenCalledOnce();
    expect(m.nativeFetch.mock.calls[0]![0]).toBe('/api/v1/stream/subscribe');
    expect(m.register.mock.calls[0]![0]).toMatchObject({ code: contract.code, quote_type: 'Tick' });
    m.tick!({ code: contract.code, close: 48300 });
    m.tick!({ code: contract.code, close: 47900 });
    await vi.waitFor(() => expect(m.place).toHaveBeenCalledOnce());
    expect(m.place.mock.calls[0]![0]).toMatchObject(contract);
});

it.each(['Tick', 'BidAsk', 'Quote'] as const)('subscribes and registers %s after mode discovery during native loading', async quoteType => {
    mode(undefined);
    const contract = { code: '2330', security_type: 'STK' as const, exchange: 'TSE' as const, target_code: null };
    m.nativeFetch.mockImplementation(async () => new Response('{"success":true}'));
    const pending = shioaji.subscribeQuote(contract, quoteType);
    await vi.waitFor(() => expect(m.loading).toHaveBeenCalledOnce());
    mode(true);
    release();
    await expect(pending).resolves.toEqual({ success: true });
    expect(m.nativeFetch).toHaveBeenCalledOnce();
    expect(m.register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: contract.code, quote_type: quoteType }));
});

it.each(paths)('sends a subscription request when the mode stays current for %s', async path => {
    const pending = api.apiPost(path, {});
    await vi.waitFor(() => expect(m.loading).toHaveBeenCalledOnce());
    release();
    await pending;
    expect(m.nativeFetch).toHaveBeenCalledOnce();
});
