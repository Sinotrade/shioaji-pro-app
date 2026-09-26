import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    resolve: vi.fn(),
    info: vi.fn(),
    sync: vi.fn(),
    fetchLists: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
    contractEvent: null as null | ((event: { base_changed: boolean; info_changed: boolean; security_type: string }) => void),
}));
vi.mock('../lib/shioaji', () => ({
    fetchWatchlists: mocks.fetchLists,
    resolveContract: mocks.resolve,
    fetchContractInfo: mocks.info,
    syncWatchlist: mocks.sync,
    createWatchlist: mocks.create,
    renameWatchlist: mocks.rename,
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
    onContractEvent: (handler: NonNullable<typeof mocks.contractEvent>) => {
        mocks.contractEvent = handler;
        return () => { if (mocks.contractEvent === handler) mocks.contractEvent = null; };
    },
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
    mocks.contractEvent = null;
    mocks.resolve.mockReset().mockImplementation(async (code: string) => ({
        code, security_type: 'STK', exchange: 'TSE', target_code: null,
    }));
    mocks.info.mockReset().mockImplementation(async (code: string) => ({
        code, security_type: 'STK', exchange: 'TSE', target_code: null,
    }));
    mocks.sync.mockReset().mockResolvedValue(undefined);
    mocks.create.mockReset().mockResolvedValue(undefined);
    mocks.rename.mockReset().mockResolvedValue(undefined);
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
    vi.useRealTimers();
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

it('keeps the final custom order on the server after rapid moves complete out of order', async () => {
    mocks.fetchLists.mockResolvedValue([
        { id: 'first', name: '我的自選', contracts: ['A', 'B', 'C'].map((code) => ({ code, security_type: 'STK' })) },
    ]);
    await act(async () => { root = create(createElement(Probe)); });

    let savedOrder = ['A', 'B', 'C'];
    const completeWrites: Array<() => void> = [];
    mocks.sync.mockImplementation((_id: string, contracts: Array<{ code: string }>) =>
        new Promise<void>((resolve) => {
            completeWrites.push(() => {
                savedOrder = contracts.map((contract) => contract.code);
                resolve();
            });
        }),
    );

    await act(async () => {
        state.reorderSymbol('A', 'C');
        state.reorderSymbol('B', 'C');
    });
    expect(state.items.map((item) => item.contract.code)).toEqual(['C', 'B', 'A']);
    expect(completeWrites).toHaveLength(1);
    await act(async () => { completeWrites[0]?.(); });
    expect(completeWrites).toHaveLength(2);
    await act(async () => { completeWrites[1]?.(); });
    expect(savedOrder).toEqual(state.items.map((item) => item.contract.code));
});

it('keeps a local move visible when a contract event arrives before its sync finishes', async () => {
    mocks.fetchLists.mockResolvedValue([
        { id: 'first', name: '我的自選', contracts: ['A', 'B', 'C'].map((code) => ({ code, security_type: 'STK' })) },
    ]);
    await act(async () => { root = create(createElement(Probe)); });
    mocks.sync.mockImplementation(() => new Promise(() => undefined));
    vi.useFakeTimers();

    await act(async () => { state.reorderSymbol('A', 'C'); });
    expect(state.items.map((item) => item.contract.code)).toEqual(['B', 'C', 'A']);
    await act(async () => {
        mocks.contractEvent?.({ base_changed: false, info_changed: true, security_type: 'STK' });
        await vi.advanceTimersByTimeAsync(300);
    });
    expect(state.items.map((item) => item.contract.code)).toEqual(['B', 'C', 'A']);
});

it('keeps the saved order visible while a contract-event refresh resolves out of order', async () => {
    mocks.fetchLists.mockResolvedValue([
        { id: 'first', name: '我的自選', contracts: ['A', 'B', 'C'].map((code) => ({ code, security_type: 'STK' })) },
    ]);
    await act(async () => { root = create(createElement(Probe)); });
    vi.useFakeTimers();
    mocks.info.mockImplementation((code: string) => code === 'B'
        ? Promise.resolve({ code, security_type: 'STK', exchange: 'TSE', target_code: null })
        : new Promise(() => undefined));

    await act(async () => {
        mocks.contractEvent?.({ base_changed: false, info_changed: true, security_type: 'STK' });
        await vi.advanceTimersByTimeAsync(300);
    });
    expect(state.items.map((item) => item.contract.code)).toEqual(['A', 'B', 'C']);
});

it('includes an add that completes before a queued reorder PUT', async () => {
    let serverOrder = ['A', 'B', 'C'];
    mocks.fetchLists.mockImplementation(async () => [
        { id: 'first', name: '我的自選', contracts: serverOrder.map((code) => ({ code, security_type: 'STK' })) },
    ]);
    await act(async () => { root = create(createElement(Probe)); });
    let finishAdd!: () => void;
    mocks.add.mockImplementation(() => new Promise<void>((resolve) => {
        finishAdd = () => { serverOrder.push('D'); resolve(); };
    }));
    mocks.sync.mockImplementation(async (_id: string, contracts: Array<{ code: string }>) => {
        serverOrder = contracts.map((contract) => contract.code);
    });

    let adding!: Promise<unknown>;
    await act(async () => { adding = state.addSymbol('D'); });
    expect(mocks.add).toHaveBeenCalledTimes(1);
    await act(async () => { state.reorderSymbol('A', 'C'); });
    expect(state.items.map((item) => item.contract.code)).toEqual(['B', 'C', 'A']);
    expect(mocks.sync).not.toHaveBeenCalled();
    await act(async () => { finishAdd(); await adding; });
    await vi.waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(1));
    expect(mocks.sync.mock.calls[0]?.[1].map((contract: { code: string }) => contract.code)).toEqual(['B', 'C', 'A', 'D']);
    expect(serverOrder).toEqual(['B', 'C', 'A', 'D']);
    expect(state.items.map((item) => item.contract.code)).toEqual(serverOrder);
});

it('does not restore a removed symbol through a queued reorder PUT', async () => {
    let serverOrder = ['A', 'B', 'C'];
    mocks.fetchLists.mockImplementation(async () => [
        { id: 'first', name: '我的自選', contracts: serverOrder.map((code) => ({ code, security_type: 'STK' })) },
    ]);
    await act(async () => { root = create(createElement(Probe)); });
    let finishRemove!: () => void;
    mocks.remove.mockImplementation(() => new Promise<void>((resolve) => {
        finishRemove = () => { serverOrder = serverOrder.filter((code) => code !== 'B'); resolve(); };
    }));
    mocks.sync.mockImplementation(async (_id: string, contracts: Array<{ code: string }>) => {
        serverOrder = contracts.map((contract) => contract.code);
    });

    let removing!: Promise<void>;
    await act(async () => { removing = state.removeSymbol('B'); });
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    await act(async () => { state.reorderSymbol('A', 'C'); });
    expect(mocks.sync).not.toHaveBeenCalled();
    await act(async () => { finishRemove(); await removing; });
    expect(serverOrder).toEqual(['C', 'A']);
    expect(state.items.map((item) => item.contract.code)).toEqual(serverOrder);
});

it('lets another list save while the first list has a pending PUT', async () => {
    mocks.fetchLists.mockResolvedValue([
        { id: 'first', name: '一', contracts: ['A', 'B'].map((code) => ({ code, security_type: 'STK' })) },
        { id: 'second', name: '二', contracts: ['X', 'Y'].map((code) => ({ code, security_type: 'STK' })) },
    ]);
    await act(async () => { root = create(createElement(Probe)); });
    let finishFirst!: () => void;
    mocks.sync.mockImplementation((id: string) => id === 'first'
        ? new Promise<void>((resolve) => { finishFirst = resolve; })
        : Promise.resolve());

    await act(async () => { state.reorderSymbol('A', 'B'); });
    await act(async () => { state.setActiveList('second'); });
    await act(async () => { state.reorderSymbol('X', 'Y'); });
    expect(mocks.sync.mock.calls.map(([id]) => id)).toEqual(['first', 'second']);
    await act(async () => { finishFirst(); });
});

it('keeps the desired order when switching away and back during a pending PUT', async () => {
    let firstOrder = ['A', 'B', 'C'];
    mocks.fetchLists.mockImplementation(async () => [
        { id: 'first', name: '一', contracts: firstOrder.map((code) => ({ code, security_type: 'STK' })) },
        { id: 'second', name: '二', contracts: [{ code: 'X', security_type: 'STK' }] },
    ]);
    await act(async () => { root = create(createElement(Probe)); });
    let finishSync!: () => void;
    mocks.sync.mockImplementation((_id: string, contracts: Array<{ code: string }>) =>
        new Promise<void>((resolve) => {
            finishSync = () => { firstOrder = contracts.map((contract) => contract.code); resolve(); };
        }));

    await act(async () => { state.reorderSymbol('A', 'C'); });
    await act(async () => { state.setActiveList('second'); });
    await act(async () => { state.setActiveList('first'); });
    expect(state.items.map((item) => item.contract.code)).toEqual(['B', 'C', 'A']);
    await act(async () => { finishSync(); });
    expect(firstOrder).toEqual(['B', 'C', 'A']);
    expect(state.items.map((item) => item.contract.code)).toEqual(firstOrder);
});

it('replays a deferred contract refresh after the reordered list is saved', async () => {
    let serverOrder = ['A', 'B', 'C'];
    mocks.fetchLists.mockImplementation(async () => [
        { id: 'first', name: '我的自選', contracts: serverOrder.map((code) => ({ code, security_type: 'STK' })) },
    ]);
    await act(async () => { root = create(createElement(Probe)); });
    let finishSync!: () => void;
    mocks.sync.mockImplementation((_id: string, contracts: Array<{ code: string }>) =>
        new Promise<void>((resolve) => {
            finishSync = () => { serverOrder = contracts.map((contract) => contract.code); resolve(); };
        }));
    mocks.info.mockImplementation(async (code: string) => ({
        code, name: '更新後', security_type: 'STK', exchange: 'TSE', target_code: null,
    }));
    vi.useFakeTimers();

    await act(async () => { state.reorderSymbol('A', 'C'); });
    await act(async () => {
        mocks.contractEvent?.({ base_changed: false, info_changed: true, security_type: 'STK' });
        await vi.advanceTimersByTimeAsync(300);
    });
    await act(async () => { finishSync(); });
    expect(state.items.map((item) => item.contract.code)).toEqual(['B', 'C', 'A']);
    expect(state.items.every((item) => (item.contract as { name?: string }).name === '更新後')).toBe(true);
});

it('does not let an older refresh from another list replace a newer saved order', async () => {
    let firstOrder = ['A', 'B'];
    let secondOrder = ['X', 'Y'];
    const snapshot = () => [
        { id: 'first', name: '一', contracts: firstOrder.map((code) => ({ code, security_type: 'STK' })) },
        { id: 'second', name: '二', contracts: secondOrder.map((code) => ({ code, security_type: 'STK' })) },
    ];
    let finishOldRefresh!: (lists: ReturnType<typeof snapshot>) => void;
    let fetchCount = 0;
    mocks.fetchLists.mockImplementation(() => {
        fetchCount += 1;
        if (fetchCount === 2) {
            const old = snapshot();
            return new Promise((resolve) => { finishOldRefresh = () => resolve(old); });
        }
        return Promise.resolve(snapshot());
    });
    mocks.sync.mockImplementation(async (id: string, contracts: Array<{ code: string }>) => {
        if (id === 'first') firstOrder = contracts.map(({ code }) => code);
        else secondOrder = contracts.map(({ code }) => code);
    });
    await act(async () => { root = create(createElement(Probe)); });
    await act(async () => { state.reorderSymbol('A', 'B'); });
    await vi.waitFor(() => expect(fetchCount).toBe(2));
    await act(async () => { state.setActiveList('second'); });
    await act(async () => { state.reorderSymbol('X', 'Y'); });
    await vi.waitFor(() => expect(fetchCount).toBe(3));
    await act(async () => { finishOldRefresh(snapshot()); });
    await act(async () => { state.setActiveList('first'); });
    await act(async () => { state.setActiveList('second'); });
    expect(secondOrder).toEqual(['Y', 'X']);
    expect(state.items.map(({ contract }) => contract.code)).toEqual(secondOrder);
});

it('uses an earlier saved-list response while a newer cross-list GET is pending', async () => {
    let firstOrder = ['A', 'B'];
    let secondOrder = ['X', 'Y'];
    const snapshot = () => [
        { id: 'first', name: '一', contracts: firstOrder.map((code) => ({ code, security_type: 'STK' })) },
        { id: 'second', name: '二', contracts: secondOrder.map((code) => ({ code, security_type: 'STK' })) },
    ];
    let finishFirstGet!: () => void;
    let finishSecondGet!: () => void;
    let fetchCount = 0;
    mocks.fetchLists.mockImplementation(() => {
        fetchCount += 1;
        const response = snapshot();
        if (fetchCount === 2) return new Promise((resolve) => { finishFirstGet = () => resolve(response); });
        if (fetchCount === 3) return new Promise((resolve) => { finishSecondGet = () => resolve(response); });
        return Promise.resolve(response);
    });
    mocks.sync.mockImplementation(async (id: string, contracts: Array<{ code: string }>) => {
        if (id === 'first') firstOrder = contracts.map(({ code }) => code);
        else secondOrder = contracts.map(({ code }) => code);
    });
    await act(async () => { root = create(createElement(Probe)); });
    await act(async () => { state.reorderSymbol('A', 'B'); });
    await vi.waitFor(() => expect(fetchCount).toBe(2));
    await act(async () => { state.setActiveList('second'); });
    await act(async () => { state.reorderSymbol('X', 'Y'); });
    await vi.waitFor(() => expect(fetchCount).toBe(3));
    await act(async () => { finishFirstGet(); });
    await act(async () => { state.setActiveList('first'); });
    expect(state.items.map(({ contract }) => contract.code)).toEqual(['B', 'A']);
    await act(async () => { finishSecondGet(); });
});

it('rolls back an unsaved move when a later add succeeds after its PUT fails', async () => {
    let serverOrder = ['A', 'B', 'C'];
    mocks.fetchLists.mockImplementation(async () => [
        { id: 'first', name: '一', contracts: serverOrder.map((code) => ({ code, security_type: 'STK' })) },
    ]);
    mocks.sync.mockRejectedValue(new Error('PUT failed'));
    mocks.add.mockImplementation(async (_id: string, contracts: Array<{ code: string }>) => {
        serverOrder.push(...contracts.map(({ code }) => code));
    });
    await act(async () => { root = create(createElement(Probe)); });
    await act(async () => {
        state.reorderSymbol('A', 'C');
        await state.addSymbol('D');
    });
    await vi.waitFor(() => expect(state.items.map(({ contract }) => contract.code)).toEqual(serverOrder));
    expect(serverOrder).toEqual(['A', 'B', 'C', 'D']);
    expect(state.loadError).toBe(false);
});

it('keeps a confirmed add made before a later reorder PUT fails', async () => {
    let serverOrder = ['A', 'B', 'C'];
    mocks.fetchLists.mockImplementation(async () => [
        { id: 'first', name: '一', contracts: ['A', 'B', 'C'].map((code) => ({ code, security_type: 'STK' })) },
    ]);
    mocks.add.mockImplementation(async (_id: string, contracts: Array<{ code: string }>) => {
        serverOrder.push(...contracts.map(({ code }) => code));
    });
    mocks.sync.mockRejectedValue(new Error('PUT failed'));
    await act(async () => { root = create(createElement(Probe)); });
    await act(async () => { await state.addSymbol('D'); });
    await act(async () => { state.reorderSymbol('A', 'C'); });
    await vi.waitFor(() => expect(state.items.map(({ contract }) => contract.code)).toEqual(serverOrder));
    expect(state.serverLists[0]?.contracts.map(({ code }) => code)).toEqual(serverOrder);
});

it('recovers to the last committed order when a later reorder PUT fails after stale GETs', async () => {
    let serverOrder = ['A', 'B', 'C'];
    mocks.fetchLists.mockImplementation(async () => [
        { id: 'first', name: '一', contracts: ['A', 'B', 'C'].map((code) => ({ code, security_type: 'STK' })) },
    ]);
    let writes = 0;
    mocks.sync.mockImplementation(async (_id: string, contracts: Array<{ code: string }>) => {
        writes += 1;
        if (writes === 2) throw new Error('second PUT failed');
        serverOrder = contracts.map(({ code }) => code);
    });
    await act(async () => { root = create(createElement(Probe)); });
    await act(async () => { state.reorderSymbol('A', 'C'); });
    await vi.waitFor(() => expect(serverOrder).toEqual(['B', 'C', 'A']));
    await act(async () => { state.reorderSymbol('C', 'A'); });
    await vi.waitFor(() => expect(writes).toBe(2));
    await vi.waitFor(() => expect(state.items.map(({ contract }) => contract.code)).toEqual(serverOrder));
    expect(state.serverLists[0]?.contracts.map(({ code }) => code)).toEqual(serverOrder);
});

it('uses raw failed-PUT recovery when another list commits during the recovery GET', async () => {
    let firstOrder = ['A', 'B', 'C'];
    let secondOrder = ['X', 'Y'];
    let reads = 0;
    let finishRecovery!: () => void;
    const snapshot = () => [
        { id: 'first', name: '一', contracts: firstOrder.map((code) => ({ code, security_type: 'STK' })) },
        { id: 'second', name: '二', contracts: secondOrder.map((code) => ({ code, security_type: 'STK' })) },
    ];
    mocks.fetchLists.mockImplementation(() => {
        reads += 1;
        if (reads === 3) return new Promise((resolve) => {
            const raw = snapshot();
            // Recovery reads an older successful snapshot that has not yet
            // observed the committed POST.
            raw[0]!.contracts = ['A', 'B', 'C'].map((code) => ({ code, security_type: 'STK' }));
            finishRecovery = () => resolve(raw);
        });
        return Promise.resolve(snapshot());
    });
    let failFirst!: () => void;
    mocks.sync.mockImplementation((id: string, contracts: Array<{ code: string }>) => {
        if (id === 'first') return new Promise<void>((_resolve, reject) => {
            failFirst = () => reject(new Error('PUT failed'));
        });
        secondOrder = contracts.map(({ code }) => code);
        return Promise.resolve();
    });
    mocks.add.mockImplementation(async (_id: string, contracts: Array<{ code: string }>) => {
        firstOrder.push(...contracts.map(({ code }) => code));
    });
    await act(async () => { root = create(createElement(Probe)); });
    let adding!: Promise<unknown>;
    await act(async () => {
        state.reorderSymbol('A', 'C');
        adding = state.addSymbol('D');
        await Promise.resolve();
        await Promise.resolve();
    });
    await act(async () => { failFirst(); await adding; });
    await vi.waitFor(() => expect(reads).toBe(3));
    await act(async () => { state.setActiveList('second'); });
    await act(async () => { state.reorderSymbol('X', 'Y'); });
    await vi.waitFor(() => expect(secondOrder).toEqual(['Y', 'X']));
    await act(async () => { finishRecovery(); });
    expect(state.serverLists.find((list) => list.id === 'first')?.contracts.map(({ code }) => code)).toEqual(firstOrder);
    expect(state.serverLists.find((list) => list.id === 'second')?.contracts.map(({ code }) => code)).toEqual(secondOrder);
    await act(async () => { state.setActiveList('first'); });
    expect(state.items.map(({ contract }) => contract.code)).toEqual(firstOrder);
});

it('keeps a committed move when its follow-up list GET fails', async () => {
    let serverOrder = ['A', 'B', 'C'];
    let fetchCount = 0;
    mocks.fetchLists.mockImplementation(async () => {
        fetchCount += 1;
        if (fetchCount === 2) throw new Error('GET failed after PUT');
        return [{ id: 'first', name: '一', contracts: serverOrder.map((code) => ({ code, security_type: 'STK' })) }];
    });
    let finishPut!: () => void;
    mocks.sync.mockImplementation((_id: string, contracts: Array<{ code: string }>) =>
        new Promise<void>((resolve) => {
            finishPut = () => { serverOrder = contracts.map(({ code }) => code); resolve(); };
        }));
    await act(async () => { root = create(createElement(Probe)); });
    vi.useFakeTimers();
    await act(async () => { state.reorderSymbol('A', 'C'); });
    await act(async () => {
        mocks.contractEvent?.({ base_changed: false, info_changed: true, security_type: 'STK' });
        await vi.advanceTimersByTimeAsync(300);
    });
    await act(async () => { finishPut(); });
    expect(serverOrder).toEqual(['B', 'C', 'A']);
    expect(state.items.map(({ contract }) => contract.code)).toEqual(serverOrder);
    expect(state.loadError).toBe(false);
});

it('keeps a committed order when its follow-up list GET returns a stale snapshot', async () => {
    let serverOrder = ['A', 'B'];
    mocks.fetchLists.mockImplementation(async () => [
        { id: 'first', name: '一', contracts: ['A', 'B'].map((code) => ({ code, security_type: 'STK' })) },
        { id: 'second', name: '二', contracts: [{ code: 'X', security_type: 'STK' }] },
    ]);
    mocks.sync.mockImplementation(async (_id: string, contracts: Array<{ code: string }>) => {
        serverOrder = contracts.map(({ code }) => code);
    });
    await act(async () => { root = create(createElement(Probe)); });
    await act(async () => { state.reorderSymbol('A', 'B'); });
    await vi.waitFor(() => expect(serverOrder).toEqual(['B', 'A']));
    await act(async () => { state.setActiveList('second'); });
    await act(async () => { state.setActiveList('first'); });
    expect(state.items.map(({ contract }) => contract.code)).toEqual(serverOrder);
    expect(state.serverLists[0]?.contracts.map(({ code }) => code)).toEqual(serverOrder);
});

it('keeps failed-save retry visible after switching away and back', async () => {
    let fetchCount = 0;
    mocks.fetchLists.mockImplementation(async () => {
        fetchCount += 1;
        if (fetchCount > 1) throw new Error('recovery GET failed');
        return [
            { id: 'first', name: '一', contracts: ['A', 'B'].map((code) => ({ code, security_type: 'STK' })) },
            { id: 'second', name: '二', contracts: [{ code: 'X', security_type: 'STK' }] },
        ];
    });
    mocks.sync.mockRejectedValue(new Error('PUT failed'));
    await act(async () => { root = create(createElement(Probe)); });
    await act(async () => { state.reorderSymbol('A', 'B'); });
    await vi.waitFor(() => expect(state.loadError).toBe(true));
    await act(async () => { state.setActiveList('second'); });
    await act(async () => { state.setActiveList('first'); });
    expect(state.loadError).toBe(true);
    expect(state.items.map(({ contract }) => contract.code)).toEqual(['B', 'A']);
});

it('renames from the server order when a preceding reorder PUT fails', async () => {
    let current = {
        id: 'first', name: '舊名',
        contracts: ['A', 'B'].map((code) => ({ code, security_type: 'STK' })),
    };
    mocks.fetchLists.mockImplementation(async () => [current]);
    mocks.sync.mockRejectedValue(new Error('PUT failed'));
    mocks.rename.mockImplementation(async (list: typeof current, name: string) => {
        current = { id: 'renamed', name, contracts: list.contracts };
        return current;
    });
    await act(async () => { root = create(createElement(Probe)); });
    let renamed!: Promise<boolean>;
    await act(async () => {
        state.reorderSymbol('A', 'B');
        renamed = state.renameCurrentList('新名');
    });
    await act(async () => { expect(await renamed).toBe(true); });
    expect(mocks.rename.mock.calls[0]?.[0].contracts.map((contract: { code: string }) => contract.code)).toEqual(['A', 'B']);
    expect(state.activeListId).toBe('renamed');
    expect(state.items.map(({ contract }) => contract.code)).toEqual(['A', 'B']);
});

it('renames with confirmed additions and order even when the pre-rename GET is stale', async () => {
    const stale = {
        id: 'first', name: '舊名',
        contracts: ['A', 'B'].map((code) => ({ code, security_type: 'STK' })),
    };
    mocks.fetchLists.mockResolvedValue([stale]);
    mocks.rename.mockImplementation(async (list: typeof stale, name: string) => ({
        ...list, id: 'renamed', name,
    }));
    await act(async () => { root = create(createElement(Probe)); });
    await act(async () => { await state.addSymbol('D'); });
    await act(async () => { state.reorderSymbol('A', 'B'); });
    await vi.waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(1));
    await act(async () => { expect(await state.renameCurrentList('新名')).toBe(true); });
    expect(mocks.rename.mock.calls[0]?.[0].contracts.map((contract: { code: string }) => contract.code)).toEqual(['B', 'A', 'D']);
});

it('disables add and remove while a rename is replacing the list id', async () => {
    let finishRename!: () => void;
    const oldList = {
        id: 'first', name: '舊名',
        contracts: ['A', 'B'].map((code) => ({ code, security_type: 'STK' })),
    };
    mocks.fetchLists.mockResolvedValue([
        oldList,
        { id: 'second', name: '另一組', contracts: [{ code: 'X', security_type: 'STK' }] },
    ]);
    mocks.rename.mockImplementation(() => new Promise((resolve) => {
        finishRename = () => resolve({ ...oldList, id: 'renamed', name: '新名' });
    }));
    await act(async () => { root = create(createElement(Probe)); });

    let renaming!: Promise<boolean>;
    await act(async () => { renaming = state.renameCurrentList('新名'); });
    expect(state.loading).toBe(true);
    await act(async () => {
        await expect(state.addSymbol('C')).rejects.toThrow('自選清單更新中');
        await state.removeSymbol('A');
        state.setActiveList('second');
    });
    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(state.activeListId).toBe('first');
    await act(async () => { finishRename(); await renaming; });
    expect(state.loading).toBe(false);
});

it('allows switching lists while an unrelated contract Info is still loading', async () => {
    mocks.fetchLists.mockResolvedValue([
        { id: 'first', name: '一', contracts: ['A', 'B'].map((code) => ({ code, security_type: 'STK' })) },
        { id: 'second', name: '二', contracts: [{ code: 'X', security_type: 'STK' }] },
    ]);
    mocks.info.mockImplementation((code: string) => code === 'B'
        ? new Promise(() => undefined)
        : Promise.resolve({ code, security_type: 'STK', exchange: 'TSE', target_code: null }));
    await act(async () => { root = create(createElement(Probe)); });
    expect(state.loading).toBe(true);
    expect(state.structureBusy).toBe(false);
    await act(async () => { state.setActiveList('second'); });
    expect(state.activeListId).toBe('second');
    expect(state.items.map(({ contract }) => contract.code)).toEqual(['X']);
});

it('rejects an add whose contract lookup completes after the list was renamed', async () => {
    const oldList = {
        id: 'first', name: '舊名',
        contracts: ['A', 'B'].map((code) => ({ code, security_type: 'STK' })),
    };
    mocks.fetchLists.mockResolvedValue([oldList]);
    mocks.rename.mockResolvedValue({ ...oldList, id: 'renamed', name: '新名' });
    let finishResolve!: () => void;
    mocks.resolve.mockImplementation((code: string) => code === 'C'
        ? new Promise((resolve) => {
            finishResolve = () => resolve({ code, security_type: 'STK', exchange: 'TSE', target_code: null });
        })
        : Promise.resolve({ code, security_type: 'STK', exchange: 'TSE', target_code: null }));
    await act(async () => { root = create(createElement(Probe)); });

    let adding!: Promise<unknown>;
    await act(async () => { adding = state.addSymbol('C'); });
    await act(async () => { expect(await state.renameCurrentList('新名')).toBe(true); });
    await act(async () => {
        finishResolve();
        await expect(adding).rejects.toThrow('自選清單已切換');
    });
    expect(mocks.add).not.toHaveBeenCalled();
});

it('keeps a completed rename when the follow-up list GET fails', async () => {
    const oldList = {
        id: 'first', name: '舊名',
        contracts: [{ code: 'A', security_type: 'STK' }],
    };
    let reads = 0;
    mocks.fetchLists.mockImplementation(async () => {
        reads += 1;
        if (reads === 3) throw new Error('GET failed');
        return [oldList];
    });
    mocks.rename.mockResolvedValue({ ...oldList, id: 'renamed', name: '新名' });
    await act(async () => { root = create(createElement(Probe)); });
    await act(async () => { expect(await state.renameCurrentList('新名')).toBe(true); });
    expect(state.activeListId).toBe('renamed');
    expect(state.serverLists.map((list) => list.id)).toEqual(['renamed']);
});

it('keeps a completed add when the follow-up list GET fails', async () => {
    const list = {
        id: 'first', name: '我的自選',
        contracts: [{ code: 'A', security_type: 'STK' }],
    };
    let reads = 0;
    mocks.fetchLists.mockImplementation(async () => {
        reads += 1;
        if (reads === 2) throw new Error('GET failed');
        return [list];
    });
    await act(async () => { root = create(createElement(Probe)); });
    await act(async () => { expect((await state.addSymbol('B')).code).toBe('B'); });
    expect(state.items.map(({ contract }) => contract.code)).toEqual(['A', 'B']);
    expect(state.serverLists[0]?.contracts.map(({ code }) => code)).toEqual(['A', 'B']);
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
