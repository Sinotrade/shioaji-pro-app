import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from './types/contract';

const mocks = vi.hoisted(() => ({
    catalog: vi.fn(), futures: vi.fn(), futureRoots: vi.fn(), options: vi.fn(), optionRoots: vi.fn(),
    warrants: vi.fn(), resolve: vi.fn(), info: vi.fn(), prime: vi.fn(), fetchLists: vi.fn(),
    add: vi.fn(), remove: vi.fn(), sync: vi.fn(), createList: vi.fn(), rename: vi.fn(),
}));
vi.mock('./runtime', () => ({ getApiBase: () => 'http://127.0.0.1:21323' }));
vi.mock('./utils/date', () => ({ todayStr: () => '2026-10-17' }));
vi.mock('./shioaji', async (original) => ({
    ...await original<object>(),
    fetchFutures: mocks.futures, fetchFuturesRoots: mocks.futureRoots,
    fetchOptionRoots: mocks.optionRoots, fetchOptions: mocks.options, fetchWarrants: mocks.warrants,
    resolveContract: mocks.resolve, fetchContractInfo: mocks.info,
    fetchWatchlists: mocks.fetchLists, addWatchlistContracts: mocks.add, removeWatchlistContracts: mocks.remove,
    syncWatchlist: mocks.sync, createWatchlist: mocks.createList, renameWatchlist: mocks.rename,
    fetchSnapshots: async () => [],
}));
vi.mock('./stock-index', async (original) => ({ ...await original<object>(), loadStockCatalog: mocks.catalog }));
vi.mock('./contracts-cache', () => ({
    ensureContract: mocks.resolve, primeContract: mocks.prime, refreshCachedContracts: vi.fn(),
}));
vi.mock('./stream', () => ({ onContractEvent: () => () => undefined, registerCodeAlias: vi.fn() }));
vi.mock('./trade', () => ({ notify: vi.fn() }));

import { useWatchlist } from '../hooks/use-watchlist';
import { CommandPalette } from '../components/command-palette';
import { searchProducts } from './product-search';

const index: ContractInfo = {
    code: 'IX0043', name: '櫃買指數', security_type: 'IND', exchange: 'OTC', target_code: null,
    currency: 'TWD', reference: 280, limit_up: 0, limit_down: 0, day_trade: '', update_date: '',
    category: '', margin_trading_balance: 0, short_selling_balance: 0,
};
const warrant: ContractInfo = {
    ...index, code: '123456', name: '台積電測試購', security_type: 'WRT', exchange: 'TSE',
    underlying_code: '2330', expiry_date: '2026-12-31', last_trading_date: '2026-12-24',
    call_put: 'C', exercise_ratio: 0.01, reference: 1.2,
};
const stock = { code: '2330', name: '台積電', exchange: 'TSE', category: '' };
let root: ReactTestRenderer | undefined;
let state!: ReturnType<typeof useWatchlist>;
let saved: Array<Pick<ContractInfo, 'code' | 'security_type' | 'exchange'>>;
const storage = new Map<string, string>();

function WatchlistProbe() {
    state = useWatchlist();
    return null;
}

async function mountWatchlist() {
    await act(async () => { root = create(createElement(WatchlistProbe)); });
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value); },
    });
    storage.clear();
    saved = [];
    vi.clearAllMocks();
    mocks.catalog.mockReset().mockResolvedValue([stock]);
    mocks.futures.mockReset().mockResolvedValue([]);
    mocks.futureRoots.mockReset().mockResolvedValue([]);
    mocks.options.mockReset().mockResolvedValue([]);
    mocks.optionRoots.mockReset().mockResolvedValue([]);
    mocks.warrants.mockReset().mockResolvedValue([]);
    mocks.resolve.mockReset().mockImplementation(async (code: string) => {
        if (code === index.code) return index;
        if (code === warrant.code) {
            // 現行 WRT generic resolver 只提供 Base 身分，不把它當完整權證 Info。
            return { ...warrant, name: warrant.code, reference: 0, underlying_code: undefined };
        }
        throw Object.assign(new Error('Contract not found'), { status: 404 });
    });
    mocks.info.mockReset().mockResolvedValue(index);
    mocks.fetchLists.mockReset().mockImplementation(async () => [{ id: 'review', name: '驗收自選', contracts: [...saved] }]);
    mocks.add.mockReset().mockImplementation(async (_id: string, contracts: ContractInfo[]) => {
        saved.push(...contracts.map(({ code, security_type, exchange }) => ({ code, security_type, exchange })));
    });
});

afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = undefined;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('獨立搜尋整合驗收', () => {
    it('根商品來源失敗時回報失敗，恢復後重新查詢而不是快取失敗空清單', async () => {
        mocks.futureRoots.mockRejectedValueOnce(new Error('503 root metadata'));
        await expect(searchProducts('驗收期貨', 8)).rejects.toThrow('商品搜尋暫時無法完成');
        mocks.futureRoots.mockResolvedValue([{ root: 'QAT', name: '驗收期貨' }]);
        mocks.futures.mockResolvedValue([{ ...index, code: 'QATR1', name: '驗收期貨近月',
            security_type: 'FUT', exchange: 'TAIFEX', target_code: 'QATJ6', root: 'QAT' }]);
        const rows = await searchProducts('驗收期貨', 8);
        expect(rows[0]).toMatchObject({ code: 'QATR1', security_type: 'FUT', contract: { target_code: 'QATJ6' } });
        expect(mocks.futureRoots).toHaveBeenCalledTimes(2);
    });

    it.each(['臺指選擇權波動率指數', '台指選擇權波動率指數'])('完整指數名稱 %s 不被拆成選擇權查詢', async (query) => {
        const rows = await searchProducts(query, 8, { includeWarrants: true });
        expect(rows[0]).toMatchObject({ code: 'TAIWANVIX', security_type: 'IND', exchange: 'TAIFEX' });
        expect(mocks.options).not.toHaveBeenCalled();
    });

    it('以股票代碼加選擇權字尾，仍能找到名稱相同的每個選擇權 root', async () => {
        mocks.optionRoots.mockResolvedValue([{ root: 'CDA', name: '台積電選擇權' }, { root: 'CDO', name: '台積電選擇權' }]);
        mocks.options.mockImplementation(async (optionRoot: string) => [{
            ...index, code: `${optionRoot}O6`, name: '測試選擇權', security_type: 'OPT', exchange: 'TAIFEX',
            root: optionRoot, underlying_code: '2330', delivery_month: '202610', strike_price: 2000,
        }]);
        const rows = await searchProducts('2330選擇權', 8, { includeWarrants: true });
        expect(rows.filter(row => row.security_type === 'OPT').map(row => row.contract?.root).sort()).toEqual(['CDA', 'CDO']);
    });

    it('新 query 輸入當下就撤除舊商品，待決期間 Enter 不誤選舊列', async () => {
        const onJump = vi.fn(async () => undefined);
        await act(async () => { root = create(createElement(CommandPalette, { open: true, onClose: vi.fn(), onJump })); });
        act(() => root!.root.findByType('input').props.onChange({ target: { value: '櫃買' } }));
        await act(async () => { await vi.advanceTimersByTimeAsync(120); });
        expect(root!.root.findAllByType('button').some(button => button.children.some(child => typeof child !== 'string' && child.children.includes('IX0043')))).toBe(true);

        mocks.catalog.mockReturnValueOnce(new Promise(() => undefined));
        act(() => root!.root.findByType('input').props.onChange({ target: { value: '台積電' } }));
        expect(root!.root.findAllByType('button').some(button => button.children.some(child => typeof child !== 'string' && child.children.includes('IX0043')))).toBe(false);
        await act(async () => { root!.root.findByType('input').props.onKeyDown({ key: 'Enter' }); });
        expect(onJump).not.toHaveBeenCalled();
    });
});

describe('獨立自選新增與重載驗收（全為 mock，不操作伺服器）', () => {
    it('櫃買指數新增儲存 OTC 身分，重掛載只使用 typed Info 且仍為 OTC', async () => {
        await mountWatchlist();
        await act(async () => { await state.addSymbol('IX0043', 'IND'); });
        expect(mocks.resolve).toHaveBeenCalledWith('IX0043', 'IND');
        expect(mocks.add).toHaveBeenCalledWith('review', [index]);
        expect(saved).toEqual([{ code: 'IX0043', security_type: 'IND', exchange: 'OTC' }]);
        await act(async () => { root?.unmount(); });
        mocks.resolve.mockClear();
        await mountWatchlist();
        expect(mocks.info).toHaveBeenCalledWith('IX0043', 'IND');
        expect(mocks.resolve).not.toHaveBeenCalled();
        expect(state.items[0]?.contract).toMatchObject({ code: 'IX0043', security_type: 'IND', exchange: 'OTC' });
        expect(state.loadError).toBe(false);
    });

    it('完整權證新增不重新解碼；重載失敗可重試，恢復後仍是 WRT 而非 STK', async () => {
        await mountWatchlist();
        await act(async () => { await state.addSymbol(warrant.code, 'WRT', warrant); });
        expect(mocks.resolve).not.toHaveBeenCalled();
        expect(mocks.add).toHaveBeenCalledWith('review', [warrant]);
        expect(mocks.prime).toHaveBeenCalledWith(warrant);
        expect(state.items[0]?.contract).toBe(warrant);

        await act(async () => { root?.unmount(); });
        mocks.resolve.mockRejectedValueOnce(new Error('暫時無法取得權證 Base'));
        await mountWatchlist();
        expect(state.loadError).toBe(true);
        expect(mocks.info).not.toHaveBeenCalled();
        await act(async () => { state.retryLoad(); });
        expect(state.loadError).toBe(false);
        expect(state.items[0]?.contract).toMatchObject({ code: warrant.code, security_type: 'WRT', exchange: 'TSE' });
        expect(mocks.resolve).toHaveBeenCalledWith(warrant.code, 'WRT');
        expect(mocks.add).toHaveBeenCalledTimes(1);
        expect(mocks.sync).not.toHaveBeenCalled();
    });
});
