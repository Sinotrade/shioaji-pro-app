import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductSuggestion } from '../lib/product-search';

const mocks = vi.hoisted(() => ({ search: vi.fn(), prime: vi.fn() }));
vi.mock('../lib/product-search', () => ({ searchProducts: mocks.search }));
vi.mock('../lib/contracts-cache', () => ({ primeContract: mocks.prime }));
vi.mock('../lib/workspace', () => ({ BLOCK_META: {} }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => undefined }));
vi.mock('../lib/stream', () => ({ getQuote: () => undefined }));
vi.mock('../lib/limit-style-prefs', () => ({ useLimitStyle: () => 'none' }));
vi.mock('./sparkline', () => ({ Sparkline: () => null }));

import { CommandPalette } from './command-palette';
import { Watchlist } from './watchlist';

const suggestion: ProductSuggestion = {
    code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', detail: '股票',
};
let view: ReactTestRenderer | undefined;

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    mocks.search.mockReset().mockResolvedValue([suggestion]);
    mocks.prime.mockReset();
});
afterEach(() => {
    act(() => view?.unmount());
    view = undefined;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

function input() {
    return view!.root.findByType('input');
}

function render(kind: 'palette' | 'watchlist') {
    const submit = vi.fn(async () => undefined);
    const close = vi.fn();
    act(() => {
        view = create(kind === 'palette'
            ? createElement(CommandPalette, { open: true, onClose: close, onJump: submit })
            : createElement(Watchlist, {
                items: [], selectedCode: null, onSelect: vi.fn(), onAdd: submit, onRemove: vi.fn(), onReorder: vi.fn(),
                serverLists: [{ id: 'fixture', name: '測試', contracts: [] }], activeListId: 'fixture',
                onSelectList: vi.fn(), onCreateList: vi.fn(async () => undefined), onRenameList: vi.fn(async () => true),
                onDeleteList: vi.fn(async () => undefined), loading: false, structureBusy: false, loadError: false, onRetryLoad: vi.fn(),
            }));
    });
    return { submit, close };
}

describe.each([
    { kind: 'palette' as const, debounce: 120 },
    { kind: 'watchlist' as const, debounce: 150 },
])('$kind 中文輸入法與查詢取消', ({ kind, debounce }) => {
    it.each([
        { nativeEvent: { isComposing: true }, keyCode: 13 },
        { nativeEvent: { isComposing: false }, keyCode: 229 },
    ])('不以組字 Enter 提交商品：%j', async (flags) => {
        const { submit } = render(kind);
        act(() => input().props.onChange({ target: { value: '2330' } }));
        await act(async () => { await vi.advanceTimersByTimeAsync(debounce); });
        await act(async () => { input().props.onKeyDown({ key: 'Enter', ...flags }); });
        expect(submit).not.toHaveBeenCalled();
        await act(async () => { input().props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: false }, keyCode: 13 }); });
        expect(submit).toHaveBeenCalledOnce();
    });

    it('composition ref 也阻擋無旗標的 Enter，結束組字後只搜尋完成文字', async () => {
        const { submit } = render(kind);
        act(() => input().props.onChange({ target: { value: '2330' } }));
        act(() => input().props.onCompositionStart());
        await act(async () => { await vi.advanceTimersByTimeAsync(debounce); });
        expect(mocks.search).not.toHaveBeenCalled();
        await act(async () => { input().props.onKeyDown({ key: 'Enter' }); });
        expect(submit).not.toHaveBeenCalled();
        act(() => input().props.onCompositionEnd({ currentTarget: { value: '台積電' } }));
        await act(async () => { await vi.advanceTimersByTimeAsync(debounce); });
        expect(mocks.search).toHaveBeenCalledExactlyOnceWith('台積電', kind === 'palette' ? 8 : 10, { includeWarrants: true });
    });

    it('組字開始取消先前在途查詢，其結果不得回填或被選取', async () => {
        let finishOld!: (items: ProductSuggestion[]) => void;
        mocks.search.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
            .mockResolvedValueOnce([]);
        const { submit } = render(kind);
        act(() => input().props.onChange({ target: { value: '舊商品' } }));
        await act(async () => { await vi.advanceTimersByTimeAsync(debounce); });
        act(() => input().props.onCompositionStart());
        act(() => input().props.onChange({ target: { value: '新商品' } }));
        await act(async () => { finishOld([suggestion]); });
        expect(view!.root.findAllByType('span').some((node) => node.children.includes('2330'))).toBe(false);
        await act(async () => { input().props.onKeyDown({ key: 'Enter' }); });
        expect(submit).not.toHaveBeenCalled();
        act(() => input().props.onCompositionEnd({ currentTarget: { value: '新商品' } }));
        await act(async () => { await vi.advanceTimersByTimeAsync(debounce); });
        expect(mocks.search).toHaveBeenLastCalledWith('新商品', kind === 'palette' ? 8 : 10, { includeWarrants: true });
    });

    it('卸載取消尚未發出的 debounce', async () => {
        render(kind);
        act(() => input().props.onChange({ target: { value: '台積電' } }));
        act(() => { view!.unmount(); view = undefined; });
        await act(async () => { await vi.advanceTimersByTimeAsync(debounce); });
        expect(mocks.search).not.toHaveBeenCalled();
    });
});

it('命令面板組字時方向鍵與 Escape 不控制搜尋面板', async () => {
    const { close, submit } = render('palette');
    act(() => input().props.onChange({ target: { value: '2330' } }));
    await act(async () => { await vi.advanceTimersByTimeAsync(120); });
    const preventDefault = vi.fn();
    act(() => input().props.onKeyDown({ key: 'ArrowDown', nativeEvent: { isComposing: true }, preventDefault }));
    act(() => input().props.onKeyDown({ key: 'Escape', keyCode: 229 }));
    expect(preventDefault).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
});
