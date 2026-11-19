// 美股進自選：成員身分含 region（美股 T 與台股 T 不撞名）、還原不打 region=TW、
// 美股不查快照、新增送 region US 與實際交易所、第一次加美股提示一次。
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    info: vi.fn(),
    resolve: vi.fn(),
    ensure: vi.fn(),
    fetchLists: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
    sync: vi.fn(),
    snapshots: vi.fn(),
    notify: vi.fn(),
    loadUsInfo: vi.fn(),
    resolveUs: vi.fn(),
}));
vi.mock('../lib/shioaji', () => ({
    fetchWatchlists: mocks.fetchLists,
    resolveContract: mocks.resolve,
    fetchContractInfo: mocks.info,
    syncWatchlist: mocks.sync,
    createWatchlist: vi.fn(),
    renameWatchlist: vi.fn(),
    deleteWatchlist: vi.fn(),
    addWatchlistContracts: mocks.add,
    removeWatchlistContracts: mocks.remove,
    fetchSnapshots: mocks.snapshots,
}));
vi.mock('../lib/contracts-cache', () => ({
    ensureContract: mocks.ensure,
    primeContract: vi.fn(),
    refreshCachedContracts: vi.fn(),
}));
vi.mock('../lib/stream', () => ({
    onContractEvent: () => () => undefined,
    registerCodeAlias: vi.fn(),
}));
vi.mock('../lib/trade', () => ({ notify: mocks.notify }));
vi.mock('../lib/us/us-contracts', async (original) => ({
    ...await original<object>(),
    loadUsInfo: mocks.loadUsInfo,
    cachedUsInfo: () => undefined,
    resolveUsContract: mocks.resolveUs,
}));

type Member = { code: string; security_type: string; exchange: string; region?: string };
let server: { id: string; name: string; contracts: Member[] }[] = [];

const { useWatchlist, US_WATCHLIST_NOTICE_KEY, serverMembershipChanged } = await import('./use-watchlist');
const { toUsContractInfo } = await import('../lib/us/us-contracts');
let state!: ReturnType<typeof useWatchlist>;
let root: ReactTestRenderer | undefined;
const data = new Map<string, string>();
const keys = () => state.items.map((item) => item.contract.region === 'US' ? `US:${item.contract.code}` : item.contract.code);

function Probe() {
    state = useWatchlist();
    return null;
}

const usInfo = (code: string, exchange: string, reference: string) => ({
    code, exchange, name: `${code} Inc.`, reference, referenceDate: '2026-11-17', fetchedOn: '2026-11-18',
});

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => void data.set(key, value),
        removeItem: (key: string) => void data.delete(key),
    });
    data.clear();
    const tw = async (code: string) => ({ code, security_type: 'STK', exchange: 'TSE', target_code: null, region: 'TW', name: code });
    mocks.info.mockReset().mockImplementation(tw);
    mocks.resolve.mockReset().mockImplementation(tw);
    mocks.ensure.mockReset().mockImplementation(async (code: string) => {
        if (code.startsWith('US:')) {
            const c = code.slice(3);
            return toUsContractInfo(c, usInfo(c, c === 'AAPL' ? 'NASDAQ' : 'NYSE', '100.5'));
        }
        return tw(code);
    });
    mocks.loadUsInfo.mockReset().mockImplementation(async (code: string) => usInfo(code, 'NYSE', '24.1'));
    mocks.resolveUs.mockReset().mockImplementation(async (code: string) => toUsContractInfo(code, usInfo(code, 'NASDAQ', '1')));
    mocks.snapshots.mockReset().mockResolvedValue([]);
    mocks.add.mockReset().mockImplementation(async (id: string, contracts: Member[]) => {
        server = server.map((l) => l.id === id ? { ...l, contracts: [...l.contracts, ...contracts.map((c) => ({
            code: c.code, security_type: c.security_type, exchange: c.exchange ?? '', ...(c.region === 'US' ? { region: 'US' } : {}),
        }))] } : l);
    });
    mocks.remove.mockReset().mockImplementation(async (id: string, contracts: Member[]) => {
        const gone = new Set(contracts.map((c) => `${c.region === 'US' ? 'US:' : ''}${c.code}`));
        server = server.map((l) => l.id === id ? { ...l, contracts: l.contracts.filter((c) =>
            !gone.has(`${c.region === 'US' ? 'US:' : ''}${c.code}`)) } : l);
    });
    mocks.sync.mockReset().mockImplementation(async (id: string, contracts: Member[]) => {
        server = server.map((l) => l.id === id ? { ...l, contracts: contracts.map((c) => ({
            code: c.code, security_type: c.security_type, exchange: c.exchange ?? '', ...(c.region === 'US' ? { region: 'US' } : {}),
        })) } : l);
    });
    mocks.notify.mockReset();
    // 假設台股也有一檔代碼 T：和美股 T（NYSE）必須是兩個不同成員
    server = [{ id: 'w', name: '我的自選', contracts: [
        { code: 'T', security_type: 'STK', exchange: 'TSE' },
        { code: 'T', security_type: 'STK', exchange: 'NYSE', region: 'US' },
    ] }];
    mocks.fetchLists.mockReset().mockImplementation(async () => server.map((l) => ({ ...l, contracts: [...l.contracts] })));
});

afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = undefined;
    vi.unstubAllGlobals();
});

async function mount() {
    await act(async () => { root = create(createElement(Probe)); });
}

it('restores a US member from US contract info, never a region=TW lookup', async () => {
    await mount();
    expect(keys()).toEqual(['T', 'US:T']);
    const us = state.items[1]!.contract;
    expect(us).toMatchObject({ region: 'US', exchange: 'NYSE', currency: 'USD', us_reference: '24.1', name: 'T Inc.' });
    expect(mocks.loadUsInfo).toHaveBeenCalledWith('T');
    // 台股 T 走台股 Info；美股 T 不走任何台股查詢
    expect(mocks.info).toHaveBeenCalledTimes(1);
    expect(mocks.info).toHaveBeenCalledWith('T', 'STK');
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
});

it('falls back to the stored exchange when US info cannot be read', async () => {
    mocks.loadUsInfo.mockRejectedValue(new Error('offline'));
    await mount();
    expect(state.items[1]!.contract).toMatchObject({ region: 'US', code: 'T', exchange: 'NYSE' });
    expect(state.loadError).toBe(false);
});

it('never asks for snapshots of US members', async () => {
    await mount();
    expect(mocks.snapshots).toHaveBeenCalled();
    for (const [contracts] of mocks.snapshots.mock.calls) {
        expect((contracts as Member[]).every((c) => c.region !== 'US')).toBe(true);
    }
});

it('removes and reorders by link key, so US T and TW T stay distinct', async () => {
    await mount();
    await act(async () => { state.reorderSymbol('US:T', 'T'); });
    expect(keys()).toEqual(['US:T', 'T']);
    expect(mocks.sync.mock.calls.at(-1)![1].map((c: Member) => [c.code, c.region ?? 'TW', c.exchange]))
        .toEqual([['T', 'US', 'NYSE'], ['T', 'TW', 'TSE']]);
    await act(async () => { await state.removeSymbol('US:T'); });
    expect(keys()).toEqual(['T']);
    expect(mocks.remove).toHaveBeenCalledWith('w', [expect.objectContaining({ code: 'T', region: 'US', exchange: 'NYSE' })]);
    expect(server[0]!.contracts).toEqual([{ code: 'T', security_type: 'STK', exchange: 'TSE' }]);
});

it('adds a US symbol with region US and its real exchange, notifying once', async () => {
    server = [{ id: 'w', name: '我的自選', contracts: [{ code: 'T', security_type: 'STK', exchange: 'TSE' }] }];
    await mount();
    await act(async () => { await state.addSymbol('US:AAPL'); });
    expect(mocks.add).toHaveBeenCalledWith('w', [expect.objectContaining({ code: 'AAPL', region: 'US', exchange: 'NASDAQ' })]);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(keys()).toEqual(['T', 'US:AAPL']);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify.mock.calls[0]![0]).toMatchObject({ kind: 'info' });
    expect(mocks.notify.mock.calls[0]![0].body).toContain('1.8.0b1');
    expect(data.get(US_WATCHLIST_NOTICE_KEY)).toBe('1');
    // 第二檔美股、重複加入都不再提示
    await act(async () => { await state.addSymbol('US:MSFT'); });
    await act(async () => { await state.addSymbol('US:AAPL'); });
    expect(mocks.add).toHaveBeenCalledTimes(2);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
});

it('adding the US twin of a TW code is not treated as a duplicate', async () => {
    server = [{ id: 'w', name: '我的自選', contracts: [{ code: 'T', security_type: 'STK', exchange: 'TSE' }] }];
    await mount();
    const usT = toUsContractInfo('T', usInfo('T', 'NYSE', '24.1'));
    await act(async () => { await state.addSymbol('US:T', undefined, usT); });
    expect(keys()).toEqual(['T', 'US:T']);
    expect(mocks.add).toHaveBeenCalledWith('w', [expect.objectContaining({ code: 'T', region: 'US', exchange: 'NYSE' })]);
});

it('refuses a US contract without an exchange instead of storing a broken member', async () => {
    server = [{ id: 'w', name: '我的自選', contracts: [] }];
    await mount();
    mocks.resolveUs.mockRejectedValue(new Error('offline'));
    const bare = toUsContractInfo('ZZZ');
    await act(async () => {
        await expect(state.addSymbol('US:ZZZ', undefined, bare)).rejects.toThrow('交易所');
    });
    expect(mocks.add).not.toHaveBeenCalled();
});

it('membership comparison is region-aware', () => {
    const tw = { code: 'T', security_type: 'STK' };
    const us = { code: 'T', security_type: 'STK', region: 'US' };
    expect(serverMembershipChanged({ contracts: [tw] }, [us])).toBe(true);
    expect(serverMembershipChanged({ contracts: [tw, us] }, [us, tw])).toBe(false);
});

it('keeps the newer US snapshot when an older response arrives late', async () => {
    const { isNewerUsSnapshot } = await import('./use-watchlist');
    const snap = (ts: number | null) => ({ code: 'AAPL', exchange: 'NASDAQ', ts, tradeDate: '2026-11-19', open: 0, high: 0, low: 0, close: 1, reference: 1, changePrice: 0, changeRate: 0, totalVolume: 0, buyPrice: null, sellPrice: null, session: null, lastPrice: null });
    expect(isNewerUsSnapshot(snap(100), undefined)).toBe(true);
    expect(isNewerUsSnapshot(snap(100), snap(200))).toBe(false);
    expect(isNewerUsSnapshot(snap(200), snap(100))).toBe(true);
    expect(isNewerUsSnapshot(snap(null), snap(100))).toBe(false);
    expect(isNewerUsSnapshot(snap(100), snap(null))).toBe(true);
});
