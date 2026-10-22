import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ native: false, search: vi.fn(), fetch: vi.fn() }));
vi.mock('../lib/runtime', async importOriginal => ({
    ...await importOriginal<typeof import('../lib/runtime')>(),
    get isTauri() { return mocks.native; },
}));
vi.mock('../lib/product-search', () => ({ searchProducts: mocks.search }));
vi.mock('../lib/contracts-cache', () => ({ primeContract: vi.fn() }));
vi.mock('../lib/etf-runtime-catalog', () => ({ getEtfNamesVersion: () => 0, subscribeEtfNames: () => () => undefined }));
vi.mock('../lib/workspace', () => ({ BLOCK_META: {} }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => undefined }));
vi.mock('../lib/stream', () => ({ getQuote: () => undefined }));
vi.mock('../lib/limit-style-prefs', () => ({ useLimitStyle: () => 'none' }));
vi.mock('./sparkline', () => ({ Sparkline: () => null }));

import { isTauri } from '../lib/runtime';
import { CommandPalette } from './command-palette';
import { Watchlist } from './watchlist';

const NOTICE = '原生版官方名稱更新未啟用，使用券商與內建名稱';
const views: ReactTestRenderer[] = [];
const text = (node: ReactTestInstance | string): string => typeof node === 'string' ? node : node.children.map(text).join('');
beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null });
    vi.stubGlobal('fetch', mocks.fetch);
    mocks.fetch.mockClear();
    mocks.search.mockReset().mockResolvedValue([{ code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', detail: '股票' }]);
});
afterEach(() => {
    for (const view of views.splice(0)) act(() => view.unmount());
    vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe.each([false, true])('真入口 runtime isTauri=%s', native => {
    it.each([{ kind: 'palette', debounce: 120 }, { kind: 'watchlist', debounce: 150 }])('$kind 只在原生搜尋結果顯示可報讀的名稱來源提示', async ({ kind, debounce }) => {
        mocks.native = native;
        expect(isTauri).toBe(native);
        const submit = vi.fn(async () => undefined);
        let view!: ReactTestRenderer;
        act(() => {
            view = create(kind === 'palette'
                ? createElement(CommandPalette, { open: true, onClose: vi.fn(), onJump: submit })
                : createElement(Watchlist, {
                    items: [], selectedCode: null, onSelect: vi.fn(), onAdd: submit, onRemove: vi.fn(), onReorder: vi.fn(),
                    serverLists: [{ id: 'fixture', name: '測試', contracts: [] }], activeListId: 'fixture',
                    onSelectList: vi.fn(), onCreateList: vi.fn(async () => undefined), onRenameList: vi.fn(async () => true),
                    onDeleteList: vi.fn(async () => undefined), loading: false, structureBusy: false, loadError: false, onRetryLoad: vi.fn(),
                }));
        });
        views.push(view);
        const notices = () => view.root.findAll(node => typeof node.type === 'string' && node.props.role === 'status' && text(node) === NOTICE);
        expect(notices()).toHaveLength(0);
        act(() => view.root.findByType('input').props.onChange({ target: { value: '2330' } }));
        await act(async () => { await vi.advanceTimersByTimeAsync(debounce); });
        expect(notices()).toHaveLength(native ? 1 : 0);
        if (native) {
            expect(notices()[0]!.props['aria-hidden']).not.toBe(true);
            expect(notices()[0]!.findAllByType('button')).toHaveLength(0);
        }
        // The notice is a status next to the results, never an item of the listbox.
        const listbox = view.root.find(node => typeof node.type === 'string' && node.props.role === 'listbox');
        expect(listbox.findAll(node => node.props.role === 'status')).toHaveLength(0);
        expect(listbox.children.every(child => typeof child !== 'string' && child.props.role === 'option')).toBe(true);
        expect(view.root.findAllByType('button').some(node => text(node).includes('2330'))).toBe(true);
        expect(submit).not.toHaveBeenCalled();
        expect(mocks.fetch).not.toHaveBeenCalled();
        act(() => view.root.findByType('input').props.onChange({ target: { value: '' } }));
        expect(notices()).toHaveLength(0);
    });
});
