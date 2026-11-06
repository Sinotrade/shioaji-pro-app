import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductSuggestion } from '../lib/product-search';
import type { ContractInfo } from '../lib/types/contract';

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

import {
    DEBOUNCE, input, key, kinds, render, row, searchLimit, searchOptionsFor, text, type as query, unmountAll,
} from './product-search.test-harness';

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

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    mocks.search.mockReset().mockResolvedValue([]);
    mocks.prime.mockReset();
});

afterEach(() => {
    unmountAll();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe.each(kinds)('$kind 商品搜尋', ({ kind }) => {
    const searchOptions = searchOptionsFor(kind);
    // The palette jumps by code and type; the watchlist also keeps the resolved contract.
    const submitted = (item: ProductSuggestion) => (kind === 'palette'
        ? [item.code, item.security_type] : [item.code, item.security_type, item.contract]);

    it('IND 結果的代碼及型別原樣交出，並明確開啟權證搜尋', async () => {
        mocks.search.mockResolvedValue([otcIndex]);
        const { view, submit, close } = render(kind);
        await query(view, '櫃買');
        expect(mocks.search).toHaveBeenCalledWith('櫃買', searchLimit(kind), searchOptions);
        await act(async () => { await row(view, 'IX0043')!.props.onClick(); });
        expect(submit).toHaveBeenCalledWith(...submitted(otcIndex));
        if (kind === 'palette') expect(close).toHaveBeenCalledOnce();
    });

    it('完整權證合約不額外解碼，不偽裝成股票', async () => {
        mocks.search.mockResolvedValue([warrantSuggestion]);
        const { view, submit } = render(kind, {
            // The palette stores the contract before it jumps.
            submitHandler: async () => { if (kind === 'palette') expect(mocks.prime).toHaveBeenCalledWith(warrant); },
        });
        await query(view, '台積電');
        await act(async () => { await row(view, warrant.code)!.props.onClick(); });
        expect(submit).toHaveBeenCalledWith(...submitted(warrantSuggestion));
        if (kind === 'palette') expect(mocks.prime.mock.calls[0]?.[0]).toBe(warrant);
        else expect((submit.mock.calls[0] as unknown[] | undefined)?.[2]).toBe(warrant);
    });

    it('搜尋失敗和成功空結果不同，重試仍帶權證選項', async () => {
        mocks.search.mockRejectedValueOnce(new Error('來源讀取失敗')).mockResolvedValueOnce([]);
        const { view } = render(kind);
        await query(view, '櫃買');
        expect(text(view.root)).toContain('搜尋失敗，可重試');
        expect(view.root.findAll((node) => node.props.role === 'alert')).toHaveLength(1);
        act(() => row(view, '重試')!.props.onClick());
        await act(async () => { await vi.advanceTimersByTimeAsync(DEBOUNCE); });
        expect(mocks.search).toHaveBeenCalledTimes(2);
        expect(mocks.search).toHaveBeenLastCalledWith('櫃買', searchLimit(kind), searchOptions);
        expect(text(view.root)).not.toContain('搜尋失敗');
        expect(view.root.findAll((node) => node.props.role === 'alert')).toHaveLength(0);
    });

    it.each(['失敗', '結果'] as const)('較舊查詢晚到的%s不可蓋掉較新查詢的結果', async (outcome) => {
        let rejectOld!: (reason: Error) => void;
        let finishOld!: (value: ProductSuggestion[]) => void;
        mocks.search.mockImplementationOnce(() => new Promise((resolve, reject) => { finishOld = resolve; rejectOld = reject; }))
            .mockResolvedValueOnce([otcIndex]);
        const { view } = render(kind);
        await query(view, '台積電');
        await query(view, '櫃買');
        await act(async () => { if (outcome === '失敗') rejectOld(new Error('舊請求失敗')); else finishOld([warrantSuggestion]); });
        expect(row(view, 'IX0043')).toBeDefined();
        expect(row(view, warrant.code)).toBeUndefined();
        expect(text(view.root)).not.toContain('搜尋失敗');
    });

    it('輸入一改就移除舊結果，debounce 與新請求待決期間不會選到舊商品', async () => {
        let finishNew!: (items: ProductSuggestion[]) => void;
        mocks.search.mockResolvedValueOnce([otcIndex, warrantSuggestion])
            .mockImplementationOnce(() => new Promise((resolve) => { finishNew = resolve; }));
        const { view, submit } = render(kind);
        await query(view, '台積電');
        act(() => key(view, 'ArrowDown'));
        act(() => input(view).props.onChange({ target: { value: '櫃買' } }));
        expect(row(view, warrant.code)).toBeUndefined();
        expect(text(view.root)).toContain('搜尋中…');
        await act(async () => { input(view).props.onKeyDown({ key: 'Enter' }); });
        expect(submit).not.toHaveBeenCalled();
        await act(async () => { await vi.advanceTimersByTimeAsync(DEBOUNCE); });
        await act(async () => { input(view).props.onKeyDown({ key: 'Enter' }); });
        // The watchlist's add button submits the same way.
        if (kind === 'watchlist') await act(async () => { await row(view, '+')!.props.onClick(); });
        expect(submit).not.toHaveBeenCalled();
        await act(async () => { finishNew([otcIndex]); });
        await act(async () => { input(view).props.onKeyDown({ key: 'Enter' }); });
        expect(submit).toHaveBeenCalledExactlyOnceWith(...submitted(otcIndex));
    });

    it('換成直接代碼後，即使名稱搜尋還在 debounce 也只送出新代碼', async () => {
        mocks.search.mockResolvedValue([warrantSuggestion]);
        const { view, submit } = render(kind);
        await query(view, '台積電');
        act(() => input(view).props.onChange({ target: { value: 'txfr1' } }));
        await act(async () => { input(view).props.onKeyDown({ key: 'Enter' }); });
        expect(submit).toHaveBeenCalledExactlyOnceWith(...(kind === 'palette' ? ['TXFR1', undefined] : ['TXFR1']));
        expect(mocks.prime).not.toHaveBeenCalled();
    });
});

it('命令面板保留方向鍵與 Enter 選擇，以及無建議時的直接代碼', async () => {
    mocks.search.mockResolvedValue([otcIndex, warrantSuggestion]);
    const { view, submit } = render('palette');
    await query(view, '台積電');
    act(() => key(view, 'ArrowDown'));
    await act(async () => { input(view).props.onKeyDown({ key: 'Enter' }); });
    expect(submit).toHaveBeenLastCalledWith(warrant.code, 'WRT');
    mocks.search.mockResolvedValue([]);
    await query(view, 'txfr1');
    await act(async () => { input(view).props.onKeyDown({ key: 'Enter' }); });
    expect(submit).toHaveBeenLastCalledWith('TXFR1', undefined);
});
