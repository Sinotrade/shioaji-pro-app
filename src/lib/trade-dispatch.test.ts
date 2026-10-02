import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from './types/portfolio';
import type { ContractBase } from './types/contract';
import type { ServerInfo } from './shioaji';

const m = vi.hoisted(() => ({
    accounts: [] as Account[], harness: false, desktop: true, loading: vi.fn(),
    nativeFetch: vi.fn(), invoke: vi.fn(),
}));
vi.mock('./runtime', () => ({ getApiBase: () => '', get isTauri() { return m.desktop; } }));
vi.mock('./account-store', () => ({ getAccountState: () => ({ accounts: m.accounts }) }));
vi.mock('./agent-harness-state', () => ({ isAgentHarnessEnabled: () => m.harness }));
vi.mock('./server-identity', () => ({ serverIdentityVerified: () => true }));
vi.mock('./stream', () => ({ getStreamStatus: () => 'live' }));
vi.mock('./activity', () => ({ trackActivity: vi.fn() }));
vi.mock('./risk', () => ({ checkOrderAllowed: () => null, getRiskSettings: () => ({ confirmManualOrders: false }) }));

let release: () => void;
let trade: typeof import('./trade');
let info: typeof import('./server-info-store');
const mode = (simulation: boolean) => info.observeServerInfo(info.beginServerInfoRequest(), { simulation } as ServerInfo);
const contract = { code: 'fixture', security_type: 'STK', exchange: 'TSE' } as ContractBase;

beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    m.desktop = true;
    m.harness = false;
    m.accounts = [{ account_type: 'S', broker_id: 'fixture', account_id: 'signed', signed: true, username: '', person_id: '' }];
    const ready = new Promise<void>(resolve => { release = resolve; });
    vi.doMock('@tauri-apps/plugin-http', async () => {
        m.loading();
        await ready;
        return { fetch: m.nativeFetch };
    });
    vi.doMock('@tauri-apps/api/core', async () => {
        m.loading();
        await ready;
        return { invoke: m.invoke };
    });
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('BroadcastChannel', undefined);
    trade = await import('./trade');
    info = await import('./server-info-store');
    mode(true);
    const body = JSON.stringify({ order: { id: 'fixture' }, status: { status: 'Submitted' } });
    m.nativeFetch.mockImplementation(async () => new Response(body));
    m.invoke.mockResolvedValue({ status: 200, body });
});
afterEach(() => vi.unstubAllGlobals());

it.each([false, true].flatMap(harness => ['Common', 'IntradayOdd', 'Futures'].flatMap(market =>
    ['mode', 'instance', 'account'].map(change => ({ harness, market, change })),
)))('refuses $market dispatch after $change changes while harness=$harness transport loads', async ({ harness, market, change }) => {
    m.harness = harness;
    const product = market === 'Futures' ? { ...contract, security_type: 'FUT', exchange: 'TAIFEX' } as ContractBase : contract;
    if (market === 'Futures') m.accounts[0]!.account_type = 'F';
    let instance = 'instance-A';
    const beforeSend = vi.fn(() => {
        if (info.knownServerInfo()?.simulation !== true) throw new Error('環境已切換');
        if (instance !== 'instance-A') throw new Error('伺服器身分已變更');
    });
    const pending = trade.placeQuickOrder(product, 'Buy', 100, 1, {
        account: m.accounts[0], source: 'auto', orderLot: market === 'IntradayOdd' ? 'IntradayOdd' : undefined, beforeSend,
    });
    const rejected = expect(pending).rejects.toMatchObject({
        mutationNotStarted: true,
        message: expect.stringContaining(change === 'mode' ? '環境已切換' : change === 'instance' ? '伺服器身分已變更' : '帳戶不可交易'),
    });
    await vi.waitFor(() => expect(m.loading).toHaveBeenCalledOnce());
    expect(beforeSend).not.toHaveBeenCalled();
    if (change === 'mode') mode(false); // Signed accounts remain eligible: the caller's environment guard must reject.
    else if (change === 'instance') instance = 'instance-B';
    else m.accounts = [];
    release();
    await rejected;
    expect(beforeSend).toHaveBeenCalledTimes(change === 'account' ? 0 : 1);
    expect(m.nativeFetch).not.toHaveBeenCalled();
    expect(m.invoke).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
});

it.each(['mode', 'instance'])('refuses browser dispatch after a serialized $0 change', async change => {
    m.desktop = false;
    let instance = 'instance-A';
    const account = m.accounts[0]!;
    Object.assign(account, { toJSON: () => {
        if (change === 'mode') mode(false);
        else instance = 'instance-B';
        return { ...account, toJSON: undefined };
    } });
    await expect(trade.placeQuickOrder(contract, 'Buy', 100, 1, {
        account, source: 'auto', beforeSend: () => {
            if (info.knownServerInfo()?.simulation !== true) throw new Error('環境已切換');
            if (instance !== 'instance-A') throw new Error('伺服器身分已變更');
        },
    })).rejects.toMatchObject({ mutationNotStarted: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(m.nativeFetch).not.toHaveBeenCalled();
    expect(m.invoke).not.toHaveBeenCalled();
});

it.each([false, true])('sends once with response headers when harness=%s and all guards stay valid', async harness => {
    m.harness = harness;
    const headers = { 'X-Shioaji-Instance': 'instance-A' };
    const body = JSON.stringify({ order: { id: 'fixture' }, status: { status: 'Submitted' } });
    m.nativeFetch.mockImplementation(async () => new Response(body, { headers }));
    m.invoke.mockResolvedValue({ status: 200, body, headers });
    const onResponse = vi.fn();
    const beforeSend = vi.fn();
    const pending = trade.placeQuickOrder(contract, 'Buy', 100, 1, {
        account: m.accounts[0], source: 'auto', beforeSend, onResponse,
    });
    await vi.waitFor(() => expect(m.loading).toHaveBeenCalledOnce());
    release();
    await expect(pending).resolves.toMatchObject({ order: { id: 'fixture' } });
    expect(harness ? m.invoke : m.nativeFetch).toHaveBeenCalledOnce();
    expect(beforeSend).toHaveBeenCalledOnce();
    expect(onResponse).toHaveBeenCalledOnce();
    expect(onResponse.mock.calls[0]![0].headers.get('X-Shioaji-Instance')).toBe('instance-A');
});
