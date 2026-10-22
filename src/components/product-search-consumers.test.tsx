import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductSuggestion } from '../lib/product-search';
import type { ContractInfo, SecurityType } from '../lib/types/contract';

const mocks = vi.hoisted(() => ({ search: vi.fn(), prime: vi.fn() }));
vi.mock('../lib/product-search', () => ({ searchProducts: mocks.search }));
vi.mock('../lib/contracts-cache', () => ({ primeContract: mocks.prime }));
vi.mock('../lib/workspace', () => ({
    BLOCK_META: { chart: { label: 'K 線圖', description: '價格圖表' } },
}));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => undefined }));
vi.mock('../lib/stream', () => ({ getQuote: () => undefined }));
vi.mock('../lib/limit-style-prefs', () => ({ useLimitStyle: () => 'none' }));
vi.mock('./sparkline', () => ({ Sparkline: () => null }));

import { CommandPalette } from './command-palette';
import { Watchlist } from './watchlist';

const otcIndex: ProductSuggestion = {
    code: 'IX0043', name: '櫃買指數', security_type: 'IND', exchange: 'OTC', detail: '指數',
};
const warrant: ContractInfo = {
    code: '123456', name: '台積電測試購', security_type: 'WRT', exchange: 'TSE', target_code: null,
    currency: 'TWD', reference: 1.2, limit_up: 0, limit_down: 0, day_trade: '', update_date: '',
    category: '', margin_trading_balance: 0, short_selling_balance: 0,
    underlying_code: '2330', expiry_date: '20261231', call_put: 'C', exercise_ratio: 0.01,
};
const warrantSuggestion: ProductSuggestion = {
    code: warrant.code, name: warrant.name, security_type: 'WRT', exchange: 'TSE', detail: '認購', contract: warrant,
};

let view: ReactTestRenderer | undefined;
const searchOptions = expect.objectContaining({ includeWarrants: true, signal: expect.any(AbortSignal), onUpdate: expect.any(Function) });
// The watchlist shows final rows only.
const watchSearchOptions = expect.objectContaining({ includeWarrants: true, signal: expect.any(AbortSignal) });

function text(node: ReactTestInstance | string): string {
    return typeof node === 'string' ? node : node.children.map(text).join('');
}

function button(label: string) {
    return view!.root.findAllByType('button').find((node) => text(node).includes(label))!;
}

async function query(value: string, debounce: number) {
    act(() => view!.root.findByType('input').props.onChange({ target: { value } }));
    await act(async () => { await vi.advanceTimersByTimeAsync(debounce); });
}

function renderPalette(onJump = vi.fn(async () => undefined), onClose = vi.fn()) {
    act(() => { view = create(createElement(CommandPalette, { open: true, onJump, onClose })); });
    return { onJump, onClose };
}

function renderWatchlist(onAdd = vi.fn(async (_code: string, _type?: SecurityType, _contract?: ContractInfo) => undefined)) {
    act(() => {
        view = create(createElement(Watchlist, {
            items: [], selectedCode: null, onSelect: vi.fn(), onAdd, onRemove: vi.fn(), onReorder: vi.fn(),
            serverLists: [{ id: 'test', name: '測試', contracts: [] }], activeListId: 'test',
            onSelectList: vi.fn(), onCreateList: vi.fn(async () => undefined), onRenameList: vi.fn(async () => true),
            onDeleteList: vi.fn(async () => undefined), loading: false, structureBusy: false, loadError: false, onRetryLoad: vi.fn(),
        }));
    });
    return { onAdd };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    mocks.search.mockReset().mockResolvedValue([]);
    mocks.prime.mockReset();
});

afterEach(() => {
    act(() => view?.unmount());
    view = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('命令面板商品搜尋', () => {
    it('保留 IND 型別供跳轉查詢，並明確開啟權證搜尋', async () => {
        mocks.search.mockResolvedValue([otcIndex]);
        const { onJump, onClose } = renderPalette();
        await query('櫃買', 120);
        expect(mocks.search).toHaveBeenCalledWith('櫃買', 8, searchOptions);
        await act(async () => { await button('IX0043').props.onClick(); });
        expect(onJump).toHaveBeenCalledWith('IX0043', 'IND');
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('完整權證合約先存入快取再傳 WRT 跳轉，不偽裝成股票', async () => {
        mocks.search.mockResolvedValue([warrantSuggestion]);
        const { onJump } = renderPalette(vi.fn(async () => {
            expect(mocks.prime).toHaveBeenCalledWith(warrant);
        }));
        await query('台積電', 120);
        await act(async () => { await button(warrant.code).props.onClick(); });
        expect(mocks.prime.mock.calls[0]?.[0]).toBe(warrant);
        expect(onJump).toHaveBeenCalledWith(warrant.code, 'WRT');
    });

    it('搜尋失敗和成功空結果不同，重試仍帶權證選項', async () => {
        mocks.search.mockRejectedValueOnce(new Error('來源讀取失敗')).mockResolvedValueOnce([]);
        renderPalette();
        await query('櫃買', 120);
        expect(text(view!.root)).toContain('搜尋失敗，可重試');
        expect(view!.root.findAll((node) => node.props.role === 'alert')).toHaveLength(1);
        act(() => button('重試').props.onClick());
        await act(async () => { await vi.advanceTimersByTimeAsync(120); });
        expect(mocks.search).toHaveBeenCalledTimes(2);
        expect(mocks.search).toHaveBeenLastCalledWith('櫃買', 8, searchOptions);
        expect(text(view!.root)).not.toContain('搜尋失敗');
        expect(view!.root.findAll((node) => node.props.role === 'alert')).toHaveLength(0);
    });

    it('保留方向鍵與 Enter 選擇，以及無建議時的直接代碼', async () => {
        mocks.search.mockResolvedValue([otcIndex, warrantSuggestion]);
        const { onJump } = renderPalette();
        await query('台積電', 120);
        act(() => view!.root.findByType('input').props.onKeyDown({ key: 'ArrowDown', preventDefault: vi.fn() }));
        await act(async () => { view!.root.findByType('input').props.onKeyDown({ key: 'Enter' }); });
        expect(onJump).toHaveBeenLastCalledWith(warrant.code, 'WRT');
        mocks.search.mockResolvedValue([]);
        await query('txfr1', 120);
        await act(async () => { view!.root.findByType('input').props.onKeyDown({ key: 'Enter' }); });
        expect(onJump).toHaveBeenLastCalledWith('TXFR1', undefined);
    });

    it('較舊查詢的失敗不可蓋掉較新查詢的結果', async () => {
        let rejectOld!: (reason: Error) => void;
        mocks.search.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }))
            .mockResolvedValueOnce([otcIndex]);
        renderPalette();
        await query('台積電', 120);
        await query('櫃買', 120);
        await act(async () => { rejectOld(new Error('舊請求失敗')); });
        expect(button('IX0043')).toBeDefined();
        expect(text(view!.root)).not.toContain('搜尋失敗');
    });

    it('輸入一改就移除舊結果，debounce 與新請求待決期間 Enter 不會選到舊商品', async () => {
        let finishNew!: (items: ProductSuggestion[]) => void;
        mocks.search.mockResolvedValueOnce([otcIndex, warrantSuggestion])
            .mockImplementationOnce(() => new Promise((resolve) => { finishNew = resolve; }));
        const { onJump } = renderPalette();
        await query('台積電', 120);
        act(() => view!.root.findByType('input').props.onKeyDown({ key: 'ArrowDown', preventDefault: vi.fn() }));
        act(() => view!.root.findByType('input').props.onChange({ target: { value: '櫃買' } }));
        expect(button(warrant.code)).toBeUndefined();
        expect(text(view!.root)).toContain('搜尋中…');
        await act(async () => { view!.root.findByType('input').props.onKeyDown({ key: 'Enter' }); });
        expect(onJump).not.toHaveBeenCalled();
        await act(async () => { await vi.advanceTimersByTimeAsync(120); });
        await act(async () => { view!.root.findByType('input').props.onKeyDown({ key: 'Enter' }); });
        expect(onJump).not.toHaveBeenCalled();
        await act(async () => { finishNew([otcIndex]); });
        await act(async () => { view!.root.findByType('input').props.onKeyDown({ key: 'Enter' }); });
        expect(onJump).toHaveBeenCalledExactlyOnceWith('IX0043', 'IND');
    });

    it('換成直接代碼後，即使名稱搜尋還在 debounce 也只查新代碼', async () => {
        mocks.search.mockResolvedValue([warrantSuggestion]);
        const { onJump } = renderPalette();
        await query('台積電', 120);
        act(() => view!.root.findByType('input').props.onChange({ target: { value: 'txfr1' } }));
        await act(async () => { view!.root.findByType('input').props.onKeyDown({ key: 'Enter' }); });
        expect(onJump).toHaveBeenCalledExactlyOnceWith('TXFR1', undefined);
        expect(mocks.prime).not.toHaveBeenCalled();
    });
});

describe('自選清單商品搜尋', () => {
    it('IND 結果的代碼及型別原樣交給新增流程', async () => {
        mocks.search.mockResolvedValue([otcIndex]);
        const { onAdd } = renderWatchlist();
        await query('櫃買', 150);
        expect(mocks.search).toHaveBeenCalledWith('櫃買', 10, watchSearchOptions);
        await act(async () => { await button('IX0043').props.onClick(); });
        expect(onAdd).toHaveBeenCalledWith('IX0043', 'IND', undefined);
    });

    it('新增權證保留完整合約及交易所，不額外解碼', async () => {
        mocks.search.mockResolvedValue([warrantSuggestion]);
        const { onAdd } = renderWatchlist();
        await query('台積電', 150);
        await act(async () => { await button(warrant.code).props.onClick(); });
        expect(onAdd).toHaveBeenCalledWith(warrant.code, 'WRT', warrant);
        expect(onAdd.mock.calls[0]?.[2]).toBe(warrant);
    });

    it('搜尋失敗提供重試，成功空結果不冒充讀取失敗', async () => {
        mocks.search.mockRejectedValueOnce(new Error('來源讀取失敗')).mockResolvedValueOnce([]);
        renderWatchlist();
        await query('櫃買', 150);
        expect(text(view!.root)).toContain('搜尋失敗，可重試');
        act(() => button('重試').props.onClick());
        await act(async () => { await vi.advanceTimersByTimeAsync(150); });
        expect(mocks.search).toHaveBeenCalledTimes(2);
        expect(text(view!.root)).not.toContain('搜尋失敗');
    });

    it('較舊查詢的結果不可蓋掉新結果', async () => {
        let finishOld!: (value: ProductSuggestion[]) => void;
        mocks.search.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
            .mockResolvedValueOnce([otcIndex]);
        renderWatchlist();
        await query('台積電', 150);
        await query('櫃買', 150);
        await act(async () => { finishOld([warrantSuggestion]); });
        expect(button('IX0043')).toBeDefined();
        expect(button(warrant.code)).toBeUndefined();
    });

    it('名稱變更立即移除舊列，debounce 與新請求待決時不新增舊商品', async () => {
        let finishNew!: (items: ProductSuggestion[]) => void;
        mocks.search.mockResolvedValueOnce([warrantSuggestion])
            .mockImplementationOnce(() => new Promise((resolve) => { finishNew = resolve; }));
        const { onAdd } = renderWatchlist();
        await query('台積電', 150);
        act(() => view!.root.findByType('input').props.onChange({ target: { value: '櫃買' } }));
        expect(button(warrant.code)).toBeUndefined();
        expect(text(view!.root)).toContain('搜尋中…');
        await act(async () => { view!.root.findByType('input').props.onKeyDown({ key: 'Enter' }); });
        expect(onAdd).not.toHaveBeenCalled();
        await act(async () => { await vi.advanceTimersByTimeAsync(150); });
        await act(async () => { await button('+').props.onClick(); });
        expect(onAdd).not.toHaveBeenCalled();
        await act(async () => { finishNew([otcIndex]); });
        await act(async () => { await button('IX0043').props.onClick(); });
        expect(onAdd).toHaveBeenCalledExactlyOnceWith('IX0043', 'IND', undefined);
    });

    it('直接代碼不必等待名稱搜尋且只新增本次輸入', async () => {
        mocks.search.mockResolvedValue([warrantSuggestion]);
        const { onAdd } = renderWatchlist();
        await query('台積電', 150);
        act(() => view!.root.findByType('input').props.onChange({ target: { value: 'txfr1' } }));
        await act(async () => { view!.root.findByType('input').props.onKeyDown({ key: 'Enter' }); });
        expect(onAdd).toHaveBeenCalledExactlyOnceWith('TXFR1');
    });
});
