// 重新讀取 (#340): explicit server re-reads of the 自選 lists — the panel
// button and the in-App event the Agent watchlist tools dispatch. No polling.
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    resolve: vi.fn(),
    info: vi.fn(),
    sync: vi.fn(),
    fetchLists: vi.fn(),
    notify: vi.fn(),
}));
vi.mock('../lib/shioaji', () => ({
    fetchWatchlists: mocks.fetchLists,
    resolveContract: mocks.resolve,
    fetchContractInfo: mocks.info,
    syncWatchlist: mocks.sync,
    createWatchlist: vi.fn(),
    renameWatchlist: vi.fn(),
    deleteWatchlist: vi.fn(),
    addWatchlistContracts: vi.fn(),
    removeWatchlistContracts: vi.fn(),
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
vi.mock('../lib/trade', () => ({ notify: mocks.notify }));

type Lists = { id: string; name: string; contracts: { code: string; security_type: string }[] }[];
let server: Lists = [];
const list = (id: string, name: string, codes: string[]) => ({
    id, name, contracts: codes.map((code) => ({ code, security_type: 'STK' })),
});

const { useWatchlist } = await import('./use-watchlist');
const { emitWatchlistChanged, watchlistChangedDetail, WATCHLIST_CHANGED_EVENT } = await import('../lib/watchlist-sync');
type State = ReturnType<typeof useWatchlist>;
let state!: State;
let root: ReactTestRenderer | undefined;
const data = new Map<string, string>();
const codes = () => state.items.map((item) => item.contract.code);

function Probe() {
    state = useWatchlist();
    return null;
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => void data.set(key, value),
        removeItem: (key: string) => void data.delete(key),
    });
    data.clear();
    const contract = async (code: string) => ({ code, security_type: 'STK', exchange: 'TSE', target_code: null });
    mocks.resolve.mockReset().mockImplementation(contract);
    mocks.info.mockReset().mockImplementation(contract);
    mocks.sync.mockReset().mockImplementation(async (id: string, contracts: { code: string }[]) => {
        server = server.map((l) => l.id === id ? list(l.id, l.name, contracts.map((c) => c.code)) : l);
    });
    mocks.notify.mockReset();
    server = [list('first', '我的自選', ['A', 'B', 'C']), list('second', '第二組', ['X'])];
    mocks.fetchLists.mockReset().mockImplementation(async () => server.map((l) => ({ ...l, contracts: [...l.contracts] })));
});

afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = undefined;
    vi.unstubAllGlobals();
});

async function mount() {
    await act(async () => { root = create(createElement(Probe)); });
    expect(codes()).toEqual(['A', 'B', 'C']);
}

it('normalizes the event detail other code dispatches by name', () => {
    expect(WATCHLIST_CHANGED_EVENT).toBe('sj-pro:watchlist-changed');
    expect(watchlistChangedDetail(null)).toEqual({});
    expect(watchlistChangedDetail({ select: 'x', source: 'agent', extra: 1 })).toEqual({ select: 'x', source: 'agent' });
    expect(watchlistChangedDetail({ select: 3, source: 'robot' })).toEqual({});
});

it('re-reads the server after an Agent change, even over this session\'s own committed order', async () => {
    await mount();
    // the user reorders locally; the session now overlays that order
    await act(async () => { state.reorderSymbol('A', 'C'); });
    expect(codes()).toEqual(['B', 'C', 'A']);
    // the Agent then rewrites the list on the server
    server = [list('first', '我的自選', ['C', 'D']), list('second', '第二組', ['X'])];
    await act(async () => { emitWatchlistChanged({ source: 'agent' }); });
    expect(codes()).toEqual(['C', 'D']);
    expect(state.serverLists.find((l) => l.id === 'first')?.contracts.map((c) => c.code)).toEqual(['C', 'D']);
    expect(mocks.notify).not.toHaveBeenCalled();
});

it('switches to the list an Agent selected', async () => {
    await mount();
    await act(async () => { emitWatchlistChanged({ source: 'agent', select: 'second' }); });
    expect(state.activeListId).toBe('second');
    expect(codes()).toEqual(['X']);
    expect(data.get('sj-pro-active-watchlist')).toBe('second');
});

it('falls back to the first list when the active one was deleted elsewhere', async () => {
    await mount();
    await act(async () => { state.setActiveList('second'); });
    server = [list('first', '我的自選', ['A'])];
    let outcome: string | undefined;
    await act(async () => { outcome = await state.reloadFromServer({ source: 'user' }); });
    expect(outcome).toBe('reloaded');
    expect(state.activeListId).toBe('first');
    expect(codes()).toEqual(['A']);
});

it('holds an Agent change while the user is arranging, then applies it', async () => {
    await mount();
    act(() => state.holdReload(true));
    server = [list('first', '我的自選', ['B', 'A']), list('second', '第二組', ['X'])];
    let outcome: string | undefined;
    await act(async () => { outcome = await state.reloadFromServer({ source: 'agent' }); });
    expect(outcome).toBe('deferred');
    expect(codes()).toEqual(['A', 'B', 'C']);
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'info', title: '自選清單已由 Agent 變更' }));
    await act(async () => { state.holdReload(false); });
    expect(codes()).toEqual(['B', 'A']);
});

it('waits for a pending save instead of overwriting it, then re-reads', async () => {
    await mount();
    let finishSave!: () => void;
    mocks.sync.mockImplementation((id: string, contracts: { code: string }[]) => new Promise<void>((resolve) => {
        finishSave = () => {
            server = server.map((l) => l.id === id ? list(l.id, l.name, [...contracts.map((c) => c.code), 'E']) : l);
            resolve();
        };
    }));
    await act(async () => { state.reorderSymbol('C', 'A'); });
    expect(codes()).toEqual(['C', 'A', 'B']);
    let outcome: string | undefined;
    await act(async () => { outcome = await state.reloadFromServer({ source: 'user' }); });
    expect(outcome).toBe('deferred');
    expect(codes()).toEqual(['C', 'A', 'B']);
    await act(async () => { finishSave(); });
    // the saved order stays and the outside addition (E) arrives
    expect(codes()).toEqual(['C', 'A', 'B', 'E']);
});

it('locks edits while a re-read is in flight so nothing mixes with the old snapshot', async () => {
    await mount();
    let release!: () => void;
    mocks.fetchLists.mockImplementationOnce(() => new Promise((resolve) => {
        release = () => resolve(server.map((l) => ({ ...l, contracts: [...l.contracts] })));
    }));
    let reload!: Promise<string>;
    await act(async () => { reload = state.reloadFromServer({ source: 'user' }); });
    expect(state.structureBusy).toBe(true);
    await act(async () => {
        await expect(state.addSymbol('2454')).rejects.toThrow();
    });
    await act(async () => { release(); await reload; });
    expect(state.structureBusy).toBe(false);
    expect(codes()).toEqual(['A', 'B', 'C']);
});

it('does not overwrite an outside add while arranging: the save is cancelled and the list re-read', async () => {
    await mount();
    act(() => state.holdReload(true)); // 調整順序 mode
    // the Agent adds D on the server; its re-read is held by the arrange mode
    server = [list('first', '我的自選', ['A', 'B', 'C', 'D']), list('second', '第二組', ['X'])];
    await act(async () => { await state.reloadFromServer({ source: 'agent' }); });
    expect(codes()).toEqual(['A', 'B', 'C']);
    // the stale panel moves a row: its PUT would drop D
    await act(async () => { state.reorderSymbol('A', 'B'); });
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(server[0]!.contracts.map((c) => c.code)).toEqual(['A', 'B', 'C', 'D']);
    expect(codes()).toEqual(['A', 'B', 'C', 'D']);
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ title: '自選清單已在其他地方變更' }));
    // after the re-read the user can arrange the fresh list
    await act(async () => { state.reorderSymbol('D', 'A'); });
    expect(server[0]!.contracts.map((c) => c.code)).toEqual(['D', 'A', 'B', 'C']);
});

it('cancels a save when the list was removed elsewhere and falls back on re-read', async () => {
    await mount();
    server = [list('second', '第二組', ['X'])];
    await act(async () => { state.reorderSymbol('A', 'C'); });
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(state.activeListId).toBe('second');
    expect(codes()).toEqual(['X']);
});

it('still saves when the server only lags behind this session\'s own add', async () => {
    const { serverMembershipChanged } = await import('./use-watchlist');
    const stk = (code: string) => ({ code, security_type: 'STK', exchange: 'TSE', target_code: null });
    const stale = list('first', '我的自選', ['A', 'B']);
    expect(serverMembershipChanged(stale, [stk('B'), stk('A'), stk('C')], new Map([['C', stk('C')]]))).toBe(false);
    expect(serverMembershipChanged(stale, [stk('B'), stk('A'), stk('C')])).toBe(true);
    expect(serverMembershipChanged(list('first', 'x', ['A', 'B', 'C']), [stk('A'), stk('C')], new Map([['B', null]]))).toBe(false);
    expect(serverMembershipChanged(stale, [stk('B'), stk('A')])).toBe(false);
});
