import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    resolve: vi.fn(),
    info: vi.fn(),
    sync: vi.fn(),
    fetchLists: vi.fn(),
    create: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
}));
vi.mock('../lib/shioaji', () => ({
    fetchWatchlists: mocks.fetchLists,
    resolveContract: mocks.resolve,
    fetchContractInfo: mocks.info,
    syncWatchlist: mocks.sync,
    createWatchlist: mocks.create,
    addWatchlistContracts: mocks.add,
    removeWatchlistContracts: mocks.remove,
    fetchSnapshots: async () => [],
}));
vi.mock('../lib/contracts-cache', () => ({
    ensureContract: mocks.resolve,
    primeContract: vi.fn(),
    refreshCachedContracts: vi.fn(),
}));
vi.mock('../lib/stream', () => ({
    onContractEvent: () => () => undefined,
    registerCodeAlias: vi.fn(),
}));
vi.mock('../lib/trade', () => ({ notify: vi.fn() }));

const { useWatchlist } = await import('./use-watchlist');
type State = ReturnType<typeof useWatchlist>;
let state!: State;
let root: ReactTestRenderer | undefined;
const data = new Map<string, string>();

function Probe() {
    state = useWatchlist();
    return null;
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => void data.set(key, value),
    });
    data.clear();
    mocks.resolve.mockReset().mockImplementation(async (code: string) => ({
        code, security_type: 'STK', exchange: 'TSE', target_code: null,
    }));
    mocks.info.mockReset().mockImplementation(async (code: string) => ({
        code, security_type: 'STK', exchange: 'TSE', target_code: null,
    }));
    mocks.sync.mockReset().mockResolvedValue(undefined);
    mocks.create.mockReset().mockResolvedValue(undefined);
    mocks.add.mockReset().mockResolvedValue(undefined);
    mocks.remove.mockReset().mockResolvedValue(undefined);
    mocks.fetchLists.mockReset().mockResolvedValue([
        { id: 'first', name: '我的自選', contracts: [{ code: '2330', security_type: 'STK' }] },
        { id: 'second', name: '第二組', contracts: [{ code: '2317', security_type: 'STK' }] },
    ]);
});

it('uses watchlist Base identity to request only Info for typed contracts', async () => {
    mocks.fetchLists.mockResolvedValue([
        { id: 'first', name: '我的自選', contracts: [
            { code: '2330', security_type: 'STK', exchange: 'TSE' },
            { code: 'TXFR1', security_type: 'FUT', exchange: 'TAIFEX' },
        ] },
    ]);
    mocks.info.mockImplementation(async (code: string, securityType: string) => ({
        code, security_type: securityType,
        exchange: securityType === 'FUT' ? 'TAIFEX' : 'TSE',
        target_code: securityType === 'FUT' ? 'TXFI6' : null,
    }));
    await act(async () => { root = create(createElement(Probe)); });
    expect(mocks.info.mock.calls.map(([code, type]) => [code, type])).toEqual([
        ['2330', 'STK'], ['TXFR1', 'FUT'],
    ]);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(state.items[1]?.contract.target_code).toBe('TXFI6');
});

it('keeps generic lookup for warrants whose Info requires an underlying shard', async () => {
    mocks.fetchLists.mockResolvedValue([
        { id: 'first', name: '我的自選', contracts: [
            { code: 'W123', security_type: 'WRT', exchange: 'TSE' },
        ] },
    ]);
    await act(async () => { root = create(createElement(Probe)); });
    expect(mocks.resolve).toHaveBeenCalledWith('W123', 'WRT');
    expect(mocks.info).not.toHaveBeenCalled();
});
afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = undefined;
    vi.unstubAllGlobals();
});

it('shows a retryable partial list without replacing unresolved server contracts', async () => {
    mocks.fetchLists.mockResolvedValue([
        { id: 'first', name: '我的自選', contracts: ['A', 'B', 'C'].map((code) => ({ code, security_type: 'STK' })) },
    ]);
    mocks.info.mockImplementation(async (code: string) => {
        if (code === 'C') throw new Error('broker unavailable');
        return { code, security_type: 'STK', exchange: 'TSE', target_code: null };
    });
    await act(async () => { root = create(createElement(Probe)); });
    expect(state).toMatchObject({ loading: false, loadError: true });
    expect(state.items.map((item) => item.contract.code)).toEqual(['A', 'B']);
    await act(async () => { state.reorderSymbol('A', 'B'); });
    expect(mocks.sync).not.toHaveBeenCalled();

    mocks.info.mockImplementation(async (code: string) => ({
        code, security_type: 'STK', exchange: 'TSE', target_code: null,
    }));
    await act(async () => { state.retryLoad(); });
    expect(state).toMatchObject({ loading: false, loadError: false });
    expect(state.items.map((item) => item.contract.code)).toEqual(['A', 'B', 'C']);
});

it('shows the first resolved product while another watchlist contract is still pending', async () => {
    let finishSlow!: (value: { code: string; security_type: string; exchange: string; target_code: null }) => void;
    mocks.fetchLists.mockResolvedValue([
        { id: 'first', name: '我的自選', contracts: ['A', 'B'].map((code) => ({ code, security_type: 'STK' })) },
    ]);
    mocks.info.mockImplementation((code: string) => {
        if (code === 'A') return Promise.resolve({ code, security_type: 'STK', exchange: 'TSE', target_code: null });
        return new Promise((resolve) => { finishSlow = resolve; });
    });

    await act(async () => { root = create(createElement(Probe)); });
    expect(state.loading).toBe(true);
    expect(state.items.map((item) => item.contract.code)).toEqual(['A']);
    expect(mocks.sync).not.toHaveBeenCalled();
    await act(async () => {
        await state.removeSymbol('A');
        await expect(state.addSymbol('C')).rejects.toThrow('自選清單載入中');
    });
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
    expect(state.items.map((item) => item.contract.code)).toEqual(['A']);

    await act(async () => { finishSlow({ code: 'B', security_type: 'STK', exchange: 'TSE', target_code: null }); });
    expect(state.loading).toBe(false);
    expect(state.items.map((item) => item.contract.code)).toEqual(['A', 'B']);
});

it('shows an available product when the first watchlist contract is slow', async () => {
    let finishFirst!: (value: { code: string; security_type: string; exchange: string; target_code: null }) => void;
    mocks.fetchLists.mockResolvedValue([
        { id: 'first', name: '我的自選', contracts: ['A', 'B'].map((code) => ({ code, security_type: 'STK' })) },
    ]);
    mocks.info.mockImplementation((code: string) => {
        if (code === 'A') return new Promise((resolve) => { finishFirst = resolve; });
        return Promise.resolve({ code, security_type: 'STK', exchange: 'TSE', target_code: null });
    });

    await act(async () => { root = create(createElement(Probe)); });
    expect(state.loading).toBe(true);
    expect(state.items.map((item) => item.contract.code)).toEqual(['B']);

    await act(async () => { finishFirst({ code: 'A', security_type: 'STK', exchange: 'TSE', target_code: null }); });
    expect(state.loading).toBe(false);
    expect(state.items.map((item) => item.contract.code)).toEqual(['A', 'B']);
});

it('shows an available product when the first watchlist contract fails', async () => {
    mocks.fetchLists.mockResolvedValue([
        { id: 'first', name: '我的自選', contracts: ['A', 'B'].map((code) => ({ code, security_type: 'STK' })) },
    ]);
    mocks.info.mockImplementation(async (code: string) => {
        if (code === 'A') throw new Error('broker unavailable');
        return { code, security_type: 'STK', exchange: 'TSE', target_code: null };
    });

    await act(async () => { root = create(createElement(Probe)); });
    expect(state).toMatchObject({ loading: false, loadError: true });
    expect(state.items.map((item) => item.contract.code)).toEqual(['B']);
    expect(mocks.sync).not.toHaveBeenCalled();
});

it('ends loading and exposes retry after migration sync fails during list switch', async () => {
    await act(async () => { root = create(createElement(Probe)); });
    mocks.info.mockImplementation(async (code: string) => ({
        code: code === '2317' ? '2317.TW' : code,
        security_type: 'STK', exchange: 'TSE', target_code: null,
    }));
    mocks.sync.mockRejectedValueOnce(new Error('server unavailable'));

    await act(async () => { state.setActiveList('second'); });
    expect(state).toMatchObject({ loading: false, loadError: true, activeListId: 'second' });
    expect(state.items.map((item) => item.contract.code)).toEqual(['2317.TW']);
});

it('does not create a truncated server list when legacy migration cannot resolve every contract', async () => {
    data.set('sj-pro-watchlist', JSON.stringify([{ code: 'C', type: 'STK' }]));
    mocks.fetchLists.mockResolvedValue([]);
    mocks.resolve.mockRejectedValueOnce(new Error('broker unavailable'));
    await act(async () => { root = create(createElement(Probe)); });
    expect(state).toMatchObject({ loading: false, loadError: true });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(data.get('sj-pro-watchlist')).toContain('C');
});
