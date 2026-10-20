import { createElement, type ReactElement } from 'react';
import { readFileSync } from 'node:fs';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductSuggestion } from '../lib/product-search';
import type { QuoteState } from '../lib/stream';

const mocks = vi.hoisted(() => ({
    search: vi.fn(), prime: vi.fn(), rowRender: vi.fn(),
    quotes: new Map<string, QuoteState>(), quoteListeners: new Map<string, Set<() => void>>(),
    etfVersion: 0, etfListeners: new Set<() => void>(),
}));
vi.mock('../lib/etf-runtime-catalog', () => ({
    getEtfNamesVersion: () => mocks.etfVersion,
    subscribeEtfNames: (listener: () => void) => {
        mocks.etfListeners.add(listener);
        return () => { mocks.etfListeners.delete(listener); };
    },
}));
vi.mock('../lib/product-search', () => ({ searchProducts: mocks.search }));
vi.mock('../lib/contracts-cache', () => ({ primeContract: mocks.prime }));
vi.mock('../lib/workspace', () => ({ BLOCK_META: { chart: { label: '圖表', description: '台積電' } } }));
vi.mock('../hooks/use-stream', async () => {
    const { useSyncExternalStore } = await import('react');
    return { useQuote: (code: string) => {
        mocks.rowRender(code);
        return useSyncExternalStore((listener) => {
            const listeners = mocks.quoteListeners.get(code) ?? new Set<() => void>();
            mocks.quoteListeners.set(code, listeners);
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        }, () => mocks.quotes.get(code));
    } };
});
vi.mock('../lib/stream', () => ({ getQuote: (code: string) => mocks.quotes.get(code) }));
vi.mock('../lib/limit-style-prefs', () => ({ useLimitStyle: () => 'none' }));
vi.mock('./sparkline', () => ({ Sparkline: () => null }));

import { CommandPalette } from './command-palette';
import { Watchlist } from './watchlist';
import * as paletteStyles from './command-palette.css';
import { invalidateProductCatalog } from '../lib/product-catalog-version';
import * as watchStyles from './watchlist.css';
import { ProductBadge } from './product-badge';
import type { ContractInfo } from '../lib/types/contract';

interface Session {
    signal: AbortSignal;
    onUpdate: (rows: ProductSuggestion[]) => void;
    resolve: (rows: ProductSuggestion[]) => void;
    reject: (error: Error) => void;
}
const stock: ProductSuggestion = { code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', detail: '股票' };
const future: ProductSuggestion = { code: 'CDFR1', name: '台積電期貨', security_type: 'FUT', exchange: 'TAIFEX', detail: '近月' };
const warrant: ProductSuggestion = { code: '200001', name: '台積電測試購', security_type: 'WRT', exchange: 'TSE', detail: '認購' };
const sessions: Session[] = [];
const views: ReactTestRenderer[] = [];

function text(node: ReactTestInstance | string): string {
    return typeof node === 'string' ? node : node.children.map(text).join('');
}
function row(view: ReactTestRenderer, value: string) {
    return view.root.findAllByType('button').find((node) => text(node).includes(value));
}
const input = (view: ReactTestRenderer) => view.root.findByType('input');
function activeText(view: ReactTestRenderer) {
    return text(view.root.findAllByType('button').find((node) => node.props.className === paletteStyles.resultActive)!);
}
function render(kind: 'palette' | 'watchlist', withCommands = false, submitHandler: () => Promise<unknown> = async () => undefined,
    watchOverrides: Partial<Parameters<typeof Watchlist>[0]> = {}, createNodeMock?: (element: ReactElement) => unknown) {
    const submit = vi.fn(submitHandler);
    const close = vi.fn();
    const addPanel = vi.fn();
    const watchProps = {
        items: [], selectedCode: null, onSelect: vi.fn(), onAdd: submit, onRemove: vi.fn(), onReorder: vi.fn(),
        serverLists: [{ id: 'fixture', name: '測試', contracts: [] }], activeListId: 'fixture',
        onSelectList: vi.fn(), onCreateList: vi.fn(async () => undefined), onRenameList: vi.fn(async () => true),
        onDeleteList: vi.fn(async () => undefined), loading: false, structureBusy: false, loadError: false, onRetryLoad: vi.fn(),
        ...watchOverrides,
    } satisfies Parameters<typeof Watchlist>[0];
    let view!: ReactTestRenderer;
    act(() => {
        view = create(kind === 'palette'
            ? createElement(CommandPalette, { open: true, onClose: close, onJump: submit, onAddPanel: withCommands ? addPanel : undefined })
            : createElement(Watchlist, watchProps), createNodeMock ? { createNodeMock } : undefined);
    });
    views.push(view);
    return { view, submit, close, addPanel, watchProps };
}
async function start(view: ReactTestRenderer, debounce: number, value = '台積電') {
    act(() => input(view).props.onChange({ target: { value } }));
    await act(async () => { await vi.advanceTimersByTimeAsync(debounce); });
    return sessions.at(-1)!;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    sessions.length = 0;
    mocks.prime.mockReset();
    mocks.rowRender.mockReset();
    mocks.quotes.clear();
    mocks.etfVersion = 0;
    mocks.quoteListeners.clear();
    mocks.search.mockReset().mockImplementation((_query: string, _limit: number, options: Pick<Session, 'signal' | 'onUpdate'>) => new Promise((resolve, reject) => {
        sessions.push({ ...options, resolve, reject });
    }));
});

it.each(['palette', 'watchlist'] as const)('%s 統一等待100ms且連續輸入只查最後字串，查詢中換字即刻取消舊輪', async kind => {
    const { view } = render(kind);
    for (const value of ['2', '23', '233']) {
        act(() => input(view).props.onChange({ target: { value } }));
        await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    }
    act(() => input(view).props.onChange({ target: { value: '2330' } }));
    await act(async () => { await vi.advanceTimersByTimeAsync(99); });
    expect(mocks.search).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(mocks.search.mock.calls[0]![0]).toBe('2330');
    const old = sessions[0]!;
    act(() => input(view).props.onChange({ target: { value: '00981' } }));
    expect(old.signal.aborted).toBe(true);
    await act(async () => old.resolve([stock]));
    expect(row(view, '2330')).toBeUndefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(mocks.search).toHaveBeenCalledTimes(2);
    expect(mocks.search.mock.calls[1]![0]).toBe('00981');
});

it.each(['palette', 'watchlist'] as const)('%s 按鍵間隔110ms時每個前綴各查一次且換字即刻取消，舊輪亂序進度或完成不得回填，只顯示最後一輪結果', async kind => {
    const { view } = render(kind);
    const values = ['2', '23', '233', '2330'];
    for (const value of values) {
        const calls = mocks.search.mock.calls.length;
        act(() => input(view).props.onChange({ target: { value } }));
        expect(sessions.every(session => session.signal.aborted)).toBe(true);
        expect(mocks.search).toHaveBeenCalledTimes(calls);
        await act(async () => { await vi.advanceTimersByTimeAsync(110); });
        expect(mocks.search).toHaveBeenCalledTimes(calls + 1);
    }
    expect(mocks.search.mock.calls.map(call => call[0])).toEqual(values);
    expect(sessions.map(session => session.signal.aborted)).toEqual([true, true, true, false]);
    const first = sessions[0]!;
    const second = sessions[1]!;
    const lastCanceled = sessions[2]!;
    const latest = sessions[3]!;

    await act(async () => { lastCanceled.onUpdate([warrant]); first.resolve([future]); });
    expect(row(view, '200001')).toBeUndefined();
    expect(row(view, 'CDFR1')).toBeUndefined();

    await act(async () => latest.onUpdate([stock]));
    expect(row(view, '2330')).toBeDefined();

    await act(async () => { lastCanceled.resolve([warrant]); second.onUpdate([future]); second.reject(new Error('stale')); });
    expect(row(view, '2330')).toBeDefined();
    expect(row(view, '200001')).toBeUndefined();
    expect(row(view, 'CDFR1')).toBeUndefined();

    await act(async () => latest.resolve([stock]));
    await act(async () => { lastCanceled.onUpdate([warrant]); latest.onUpdate([future]); });
    expect(row(view, '2330')).toBeDefined();
    expect(row(view, '200001')).toBeUndefined();
    expect(row(view, 'CDFR1')).toBeUndefined();
});

it('命令面板展開資訊或縮放後保留原選取列可見，不需要再按方向鍵且不改焦點', async () => {
    const focus = vi.fn();
    const rowFocus = vi.fn();
    const order = [stock.code, future.code, warrant.code];
    const container = { clientTop: 0, clientHeight: 112, scrollTop: 0, getBoundingClientRect: () => ({ top: 100 }) };
    const listeners = new Map<string, () => void>();
    vi.stubGlobal('window', {
        addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
        removeEventListener: (type: string, listener: () => void) => { if (listeners.get(type) === listener) listeners.delete(type); },
    });
    const nodeMock = (element: ReactElement) => {
        const props = element.props as Record<string, unknown>;
        if (element.type === 'input') return { focus };
        if (element.type === 'div' && props.className === paletteStyles.results) return container;
        if (element.type === 'button' && [paletteStyles.result, paletteStyles.resultActive].includes(String(props.className))) {
            const code = ((props.children as ReactElement[])[0]!.props as { children: string }).children;
            return { focus: rowFocus, getBoundingClientRect: () => {
                const top = 100 + order.indexOf(code) * 56 - container.scrollTop;
                return { top, bottom: top + 56 };
            } };
        }
        return null;
    };
    const { view, submit } = render('palette', false, async () => undefined, {}, nodeMock);
    const session = await start(view, 120);
    act(() => session.onUpdate([stock, future, warrant]));
    act(() => key(view, 'ArrowUp'));
    expect(container.scrollTop).toBe(56);
    const selected = activeText(view);
    const focusCalls = focus.mock.calls.length;
    container.clientHeight = 56;
    act(() => view.root.findByType('details').props.onToggle?.({ currentTarget: { open: true } }));
    expect(container.scrollTop).toBe(112);
    expect(activeText(view)).toBe(selected);
    container.scrollTop = 0;
    act(() => listeners.get('resize')?.());
    expect(container.scrollTop).toBe(112);
    expect(focus).toHaveBeenCalledTimes(focusCalls);
    expect(rowFocus).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    act(() => view.unmount());
    expect(listeners.has('resize')).toBe(false);
});

it.each([{ kind: 'palette' as const, debounce: 120 }, { kind: 'watchlist' as const, debounce: 150 }])(
    '$kind 已完成的結果在同 URL 商品異動後重查，舊 click handler 也不得送出', async ({ kind, debounce }) => {
        const { view, submit } = render(kind);
        const old = await start(view, debounce, '2330');
        await act(async () => old.resolve([stock]));
        const oldClick = row(view, '2330')!.props.onClick;
        act(() => invalidateProductCatalog({ region: 'TW', base_changed: true, info_changed: false }));
        await act(async () => oldClick());
        expect(submit).not.toHaveBeenCalled();
        expect(row(view, '2330')).toBeUndefined();
        await act(async () => { await vi.advanceTimersByTimeAsync(debounce); });
        const next = sessions.at(-1)!;
        expect(next).not.toBe(old);
        act(() => old.onUpdate([stock]));
        expect(row(view, '2330')).toBeUndefined();
        await act(async () => next.resolve([{ ...stock, name: '異動後商品名稱' }]));
        expect(text(row(view, '2330')!)).toContain('異動後商品名稱');
    },
);

it.each([{ kind: 'palette' as const, debounce: 120 }, { kind: 'watchlist' as const, debounce: 150 }])(
    '$kind 已完成的結果在 ETF 名稱權威切換後自動重新組裝，不等使用者改字', async ({ kind, debounce }) => {
        const { view, submit } = render(kind);
        const old = await start(view, debounce, '2330');
        await act(async () => old.resolve([stock]));
        const oldClick = row(view, '2330')!.props.onClick;
        act(() => {
            mocks.etfVersion++;
            for (const listener of mocks.etfListeners) listener();
        });
        await act(async () => oldClick());
        expect(submit).not.toHaveBeenCalled();
        await act(async () => { await vi.advanceTimersByTimeAsync(debounce); });
        const next = sessions.at(-1)!;
        expect(next).not.toBe(old);
        await act(async () => next.resolve([{ ...stock, name: '官方更新名稱' }]));
        expect(text(row(view, '2330')!)).toContain('官方更新名稱');
    },
);
afterEach(() => {
    for (const view of views.splice(0)) act(() => view.unmount());
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe.each([{ kind: 'palette' as const, debounce: 120 }, { kind: 'watchlist' as const, debounce: 150 }])('$kind 分段搜尋', ({ kind, debounce }) => {
    it.each(['台積電', '2330'])('輸入 %s：主商品先可見，再補期貨／權證，最終 Promise 完成才結束補齊狀態', async (query) => {
        const { view, submit, close } = render(kind);
        const session = await start(view, debounce, query);
        expect(session.signal).toBeInstanceOf(AbortSignal);
        expect(session.signal.aborted).toBe(false);
        act(() => session.onUpdate([stock]));
        expect(row(view, '2330')).toBeDefined();
        expect(text(view.root)).toContain('正在補齊關聯商品');
        act(() => session.onUpdate([stock, future]));
        expect(row(view, 'CDFR1')).toBeDefined();
        act(() => session.onUpdate([stock, future, warrant]));
        expect(row(view, '200001')).toBeDefined();
        await act(async () => session.resolve([stock, future, warrant]));
        expect(text(view.root)).not.toContain('正在補齊關聯商品');
        expect(row(view, '2330')).toBeDefined();
        expect(submit).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
    });

    it('ETF 代碼同樣保留主商品並等待背景補齊，不會自動送出', async () => {
        const { view, submit } = render(kind);
        const session = await start(view, debounce, '00679B');
        const etf = { ...stock, code: '00679B', exchange: 'OTC', name: '元大美債20年', detail: 'ETF' };
        // This related product is synthetic: the consumer only renders the core's verified rows.
        const related = { ...future, code: 'SYNTH-ETF-FUT', name: '合成 ETF 關聯期貨' };
        act(() => session.onUpdate([etf]));
        expect(row(view, '00679B')).toBeDefined();
        expect(session.signal.aborted).toBe(false);
        act(() => session.onUpdate([etf, related]));
        expect(row(view, 'SYNTH-ETF-FUT')).toBeDefined();
        await act(async () => session.resolve([etf, related]));
        expect(submit).not.toHaveBeenCalled();
        expect(row(view, '00679B')).toBeDefined();
    });

    it('換字當下 abort 舊輪，即使舊來源違約繼續回填也不採用', async () => {
        const { view } = render(kind);
        const old = await start(view, debounce);
        act(() => old.onUpdate([stock]));
        act(() => input(view).props.onChange({ target: { value: '新商品' } }));
        expect(old.signal.aborted).toBe(true);
        act(() => old.onUpdate([future]));
        await act(async () => old.resolve([future]));
        expect(row(view, 'CDFR1')).toBeUndefined();
        await act(async () => { await vi.advanceTimersByTimeAsync(debounce); });
        expect(sessions).toHaveLength(2);
        expect(sessions[1]!.signal.aborted).toBe(false);
        act(() => sessions[1]!.onUpdate([warrant]));
        expect(row(view, '200001')).toBeDefined();
    });

    it('組字當下 abort，結束組字後才建立新的搜尋', async () => {
        const { view, submit } = render(kind);
        const old = await start(view, debounce);
        act(() => input(view).props.onCompositionStart());
        expect(old.signal.aborted).toBe(true);
        act(() => old.onUpdate([stock]));
        await act(async () => input(view).props.onKeyDown({ key: 'Enter' }));
        expect(submit).not.toHaveBeenCalled();
        expect(row(view, '2330')).toBeUndefined();
        act(() => input(view).props.onCompositionEnd({ currentTarget: { value: '完整商品名' } }));
        await act(async () => { await vi.advanceTimersByTimeAsync(debounce); });
        expect(sessions).toHaveLength(2);
        expect(sessions[1]!.signal.aborted).toBe(false);
    });

    it('partial 可立即選取，選取後 abort 且晚到結果不能重開清單', async () => {
        const { view, submit } = render(kind);
        const session = await start(view, debounce);
        act(() => session.onUpdate([stock]));
        await act(async () => { await row(view, '2330')!.props.onClick(); });
        expect(session.signal.aborted).toBe(true);
        expect(submit).toHaveBeenCalledWith(...(kind === 'palette' ? ['2330', 'STK'] : ['2330', 'STK', undefined]));
        act(() => session.onUpdate([future, warrant]));
        await act(async () => session.resolve([future, warrant]));
        expect(row(view, 'CDFR1')).toBeUndefined();
        expect(row(view, '200001')).toBeUndefined();
        expect(text(view.root)).not.toContain('正在補齊關聯商品');
    });

    it('Escape 即刻 abort，之後 onUpdate 與 final 都不再回填', async () => {
        const { view, close } = render(kind);
        const session = await start(view, debounce);
        act(() => session.onUpdate([stock]));
        act(() => input(view).props.onKeyDown({ key: 'Escape' }));
        expect(session.signal.aborted).toBe(true);
        if (kind === 'palette') expect(close).toHaveBeenCalledOnce();
        act(() => session.onUpdate([future]));
        await act(async () => session.resolve([future]));
        expect(row(view, 'CDFR1')).toBeUndefined();
        if (kind === 'watchlist') expect(row(view, '2330')).toBeUndefined();
    });

    it('卸載取消自己的 signal', async () => {
        const { view } = render(kind);
        const session = await start(view, debounce);
        act(() => view.unmount());
        views.splice(views.indexOf(view), 1);
        expect(session.signal.aborted).toBe(true);
        await act(async () => session.resolve([stock]));
    });

    it('debounce 期間 Escape 會直接移除計時器，不呼叫核心搜尋', async () => {
        const { view } = render(kind);
        act(() => input(view).props.onChange({ target: { value: '台積電' } }));
        act(() => input(view).props.onKeyDown({ key: 'Escape' }));
        await act(async () => { await vi.advanceTimersByTimeAsync(debounce); });
        expect(mocks.search).not.toHaveBeenCalled();
    });

    it('最終 Promise 完成後不再接受來源違約的額外 onUpdate', async () => {
        const { view } = render(kind);
        const session = await start(view, debounce);
        await act(async () => session.resolve([stock]));
        act(() => session.onUpdate([future]));
        expect(row(view, '2330')).toBeDefined();
        expect(row(view, 'CDFR1')).toBeUndefined();
    });

    it('一般來源失敗由核心 resolve 可用 partial，不能當作致命搜尋錯誤', async () => {
        const { view } = render(kind);
        const session = await start(view, debounce);
        act(() => session.onUpdate([stock]));
        // searchProducts handles individual source failures and resolves the usable rows.
        await act(async () => session.resolve([stock]));
        expect(row(view, '2330')).toBeDefined();
        expect(text(view.root)).not.toContain('搜尋失敗');
        expect(text(view.root)).not.toContain('正在補齊');
    });

    it('核心致命 reject 清除已發布 partial，重試成功後才能重新選取', async () => {
        const { view } = render(kind);
        const session = await start(view, debounce);
        act(() => session.onUpdate([stock]));
        await act(async () => session.reject(new Error('商品搜尋期間伺服器已切換，請重新搜尋')));
        expect(row(view, '2330')).toBeUndefined();
        expect(text(view.root)).toContain('搜尋失敗，可重試');
        act(() => session.onUpdate([future]));
        expect(row(view, 'CDFR1')).toBeUndefined();
        act(() => row(view, '重試')!.props.onClick());
        expect(session.signal.aborted).toBe(true);
        await act(async () => { await vi.advanceTimersByTimeAsync(debounce); });
        expect(sessions).toHaveLength(2);
        await act(async () => sessions[1]!.resolve([stock, future]));
        expect(row(view, 'CDFR1')).toBeDefined();
        expect(text(view.root)).not.toContain('搜尋失敗');
    });

    it('舊提交較晚完成不會關閉或清空後來的新查詢', async () => {
        let complete!: () => void;
        const { view, close } = render(kind, false, () => new Promise<void>((resolve) => { complete = resolve; }));
        const first = await start(view, debounce, '2330');
        act(() => { input(view).props.onKeyDown({ key: 'Enter' }); });
        expect(first.signal.aborted).toBe(true);
        const next = await start(view, debounce, '新商品');
        await act(async () => complete());
        expect(input(view).props.value).toBe('新商品');
        expect(next.signal.aborted).toBe(false);
        expect(close).not.toHaveBeenCalled();
    });
});

it('命令面板由父層關閉時也取消搜尋，晚到結果不可回填', async () => {
    const { view, close, submit } = render('palette');
    const session = await start(view, 120);
    act(() => view.update(createElement(CommandPalette, { open: false, onClose: close, onJump: submit })));
    expect(session.signal.aborted).toBe(true);
    act(() => session.onUpdate([stock]));
    await act(async () => session.resolve([stock]));
    expect(view.toJSON()).toBeNull();
});

it('鍵盤選取以身分維持，partial 插入與 final 重排都不改成其他商品', async () => {
    const { view, submit } = render('palette');
    const session = await start(view, 120);
    act(() => session.onUpdate([stock, future]));
    act(() => input(view).props.onKeyDown({ key: 'ArrowDown', preventDefault: vi.fn() }));
    expect(activeText(view)).toContain('CDFR1');
    act(() => session.onUpdate([warrant, stock, future]));
    expect(activeText(view)).toContain('CDFR1');
    await act(async () => session.resolve([stock, future, warrant]));
    expect(activeText(view)).toContain('CDFR1');
    await act(async () => input(view).props.onKeyDown({ key: 'Enter' }));
    expect(submit).toHaveBeenCalledExactlyOnceWith('CDFR1', 'FUT');
});

it('滑鼠選取身分包含型別與交易所，同碼商品插入後仍選原列', async () => {
    const { view } = render('palette');
    const session = await start(view, 120);
    const otc = { ...stock, exchange: 'OTC', name: 'OTC 同碼股票' };
    const index = { ...stock, security_type: 'IND' as const, exchange: 'OTC', name: 'OTC 同碼指數' };
    act(() => session.onUpdate([stock, otc]));
    act(() => row(view, 'OTC 同碼股票')!.props.onMouseMove({ clientX: 20, clientY: 30 }));
    act(() => session.onUpdate([index, stock, otc]));
    expect(activeText(view)).toContain('OTC 同碼股票');
    expect(activeText(view)).not.toContain('OTC 同碼指數');
});

it('已選列被名額截掉時安全回首項', async () => {
    const { view, submit } = render('palette');
    const session = await start(view, 120);
    act(() => session.onUpdate([stock, future]));
    act(() => row(view, 'CDFR1')!.props.onMouseMove({ clientX: 20, clientY: 30 }));
    act(() => session.onUpdate([warrant, stock]));
    expect(activeText(view)).toContain('200001');
    await act(async () => input(view).props.onKeyDown({ key: 'Enter' }));
    expect(submit).toHaveBeenCalledExactlyOnceWith('200001', 'WRT');
});

it('面板命令也保留身分，不因背景商品補入而被替換', async () => {
    const { view, submit, addPanel } = render('palette', true);
    const session = await start(view, 120);
    act(() => row(view, '新增面板')!.props.onMouseMove({ clientX: 20, clientY: 30 }));
    act(() => session.onUpdate([stock, future]));
    expect(activeText(view)).toContain('新增面板');
    await act(async () => session.resolve([stock, future, warrant]));
    expect(activeText(view)).toContain('新增面板');
    await act(async () => input(view).props.onKeyDown({ key: 'Enter' }));
    expect(addPanel).toHaveBeenCalledExactlyOnceWith('chart');
    expect(submit).not.toHaveBeenCalled();
    expect(session.signal.aborted).toBe(true);
});

it('未明確選取面板時，首批商品回來後預設選取應回到第一個商品', async () => {
    const { view, submit, addPanel } = render('palette', true);
    const session = await start(view, 120);
    // Before products arrive, the matching panel is only an implicit default.
    expect(activeText(view)).toContain('新增面板');
    act(() => session.onUpdate([stock]));
    expect(activeText(view)).toContain('2330');
    await act(async () => input(view).props.onKeyDown({ key: 'Enter' }));
    expect(submit).toHaveBeenCalledExactlyOnceWith('2330', 'STK');
    expect(addPanel).not.toHaveBeenCalled();
});

it('兩入口 signal 獨立，一方換字／取消不妨礙另一方補齊與選取', async () => {
    const palette = render('palette');
    const watchlist = render('watchlist');
    const first = await start(palette.view, 120);
    const second = await start(watchlist.view, 150);
    expect(first.signal).not.toBe(second.signal);
    act(() => input(palette.view).props.onChange({ target: { value: '另一個商品' } }));
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    act(() => second.onUpdate([stock, future]));
    expect(row(watchlist.view, 'CDFR1')).toBeDefined();
    await act(async () => { await row(watchlist.view, 'CDFR1')!.props.onClick(); });
    expect(watchlist.submit).toHaveBeenCalledExactlyOnceWith('CDFR1', 'FUT', undefined);
    expect(palette.submit).not.toHaveBeenCalled();
});

it('Watchlist 名稱 pending 時 Enter 不送出，也不清除已出現的 partial', async () => {
    const { view, submit } = render('watchlist');
    const session = await start(view, 150);
    act(() => session.onUpdate([stock]));
    await act(async () => input(view).props.onKeyDown({ key: 'Enter' }));
    expect(submit).not.toHaveBeenCalled();
    expect(session.signal.aborted).toBe(false);
    expect(row(view, '2330')).toBeDefined();
    expect(text(view.root)).toContain('正在補齊');
    await act(async () => session.resolve([stock, future]));
    expect(row(view, 'CDFR1')).toBeDefined();
});

it('partial 跳轉失敗可重新搜尋，清掉未完成舊列並重新補齊', async () => {
    const { view, submit } = render('palette', false, async () => { throw new Error('測試跳轉失敗'); });
    const session = await start(view, 120);
    act(() => session.onUpdate([stock]));
    await act(async () => input(view).props.onKeyDown({ key: 'Enter' }));
    expect(submit).toHaveBeenCalledOnce();
    expect(session.signal.aborted).toBe(true);
    expect(text(view.root)).toContain('找不到此商品代碼');
    expect(row(view, '重新搜尋')).toBeDefined();
    act(() => row(view, '重新搜尋')!.props.onClick());
    expect(row(view, '2330')).toBeUndefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(120); });
    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.signal.aborted).toBe(false);
    act(() => session.onUpdate([warrant]));
    expect(row(view, '200001')).toBeUndefined();
    await act(async () => sessions[1]!.resolve([stock, future]));
    expect(row(view, 'CDFR1')).toBeDefined();
    expect(text(view.root)).not.toContain('找不到此商品代碼');
});

it.each(['換字', '組字', '關閉'] as const)('舊跳轉失敗在%s後不能顯示重試或覆蓋新狀態', async (change) => {
    let fail!: (error: Error) => void;
    const { view, close, submit } = render('palette', false, () => new Promise((_resolve, reject) => { fail = reject; }));
    const session = await start(view, 120, '2330');
    act(() => session.onUpdate([stock]));
    act(() => { input(view).props.onKeyDown({ key: 'Enter' }); });
    if (change === '換字') act(() => input(view).props.onChange({ target: { value: '新商品' } }));
    if (change === '組字') act(() => input(view).props.onCompositionStart());
    if (change === '關閉') act(() => view.update(createElement(CommandPalette, { open: false, onClose: close, onJump: submit })));
    await act(async () => fail(new Error('舊提交失敗')));
    if (change === '關閉') {
        expect(view.toJSON()).toBeNull();
        act(() => view.update(createElement(CommandPalette, { open: true, onClose: close, onJump: submit })));
    }
    expect(row(view, '重新搜尋')).toBeUndefined();
    expect(text(view.root)).not.toContain('找不到此商品代碼');
    if (change === '換字') expect(input(view).props.value).toBe('新商品');
});

it('父層關閉後，舊跳轉成功也不能再次呼叫 onClose', async () => {
    let complete!: () => void;
    const { view, close, submit } = render('palette', false, () => new Promise<void>((resolve) => { complete = resolve; }));
    await start(view, 120, '2330');
    act(() => { input(view).props.onKeyDown({ key: 'Enter' }); });
    act(() => view.update(createElement(CommandPalette, { open: false, onClose: close, onJump: submit })));
    await act(async () => complete());
    expect(close).not.toHaveBeenCalled();
});

it('游標未移動時，補入商品產生的 hover 或同座標 mousemove 不能取代鍵盤選取', async () => {
    const { view } = render('palette');
    const session = await start(view, 120);
    act(() => session.onUpdate([stock, future]));
    const overlay = view.root.find((node) => node.type === 'div' && node.props.className === paletteStyles.overlay);
    act(() => overlay.props.onMouseMove({ clientX: 30, clientY: 40 }));
    act(() => input(view).props.onKeyDown({ key: 'ArrowDown', preventDefault: vi.fn() }));
    expect(activeText(view)).toContain('CDFR1');
    act(() => session.onUpdate([warrant, stock, future]));
    expect(row(view, '200001')!.props.onMouseEnter).toBeUndefined();
    act(() => row(view, '200001')!.props.onMouseMove({ clientX: 30, clientY: 40 }));
    expect(activeText(view)).toContain('CDFR1');
    act(() => row(view, '200001')!.props.onMouseMove({ clientX: 31, clientY: 40 }));
    expect(activeText(view)).toContain('200001');
});

function watchItems(count = 50): Parameters<typeof Watchlist>[0]['items'] {
    return Array.from({ length: count }, (_, index) => ({ contract: {
        code: String(1000 + index), name: `合成商品 ${index}`, exchange: 'TSE', security_type: 'STK', target_code: null,
        currency: 'TWD', reference: 100, limit_up: 110, limit_down: 90, day_trade: 'Yes', update_date: '', category: '',
        margin_trading_balance: 0, short_selling_balance: 0,
    } }));
}
const watchRow = (view: ReactTestRenderer, code: string) => view.root.find((node) => node.type === 'div' && node.props['data-code'] === code);
function publishQuote(code: string, close: number) {
    const quote: QuoteState = {
        tick: { code, date: '2026-10-17', time: '10:00:00', open: '100', high: String(close), low: '100', close: String(close),
            volume: 1, total_volume: 1, tick_type: 1, price_chg: String(close - 100) },
        seq: 1, flashSeq: 0, lastDir: 0,
    };
    act(() => {
        mocks.quotes.set(code, quote);
        for (const listener of mocks.quoteListeners.get(code) ?? []) listener();
    });
}

it('固定 50 列搜尋分段不重繪 WatchRow，但 quote 訂閱可獨立更新最新價格', async () => {
    const { view } = render('watchlist', false, async () => undefined, { items: watchItems() });
    const session = await start(view, 150);
    for (const rows of [[stock], [stock, future]]) {
        mocks.rowRender.mockClear();
        act(() => session.onUpdate(rows));
        expect(mocks.rowRender).not.toHaveBeenCalled();
    }
    mocks.rowRender.mockClear();
    await act(async () => session.resolve([stock, future, warrant]));
    expect(mocks.rowRender).not.toHaveBeenCalled();
    publishQuote('1000', 103);
    expect(mocks.rowRender).toHaveBeenCalledExactlyOnceWith('1000');
    expect(text(watchRow(view, '1000'))).toContain('103');
    expect(text(watchRow(view, '1000'))).toContain('+3.00%');
});

it('穩定 callback 保留點選、同 frame 拖放、上下移及拖曳取消行為', async () => {
    const { view, watchProps } = render('watchlist', false, async () => undefined, { items: watchItems(3) });
    act(() => watchRow(view, '1000').props.onClick());
    expect(watchProps.onSelect).toHaveBeenCalledWith(watchProps.items[0]!.contract);
    const arrange = () => view.root.findAllByType('button').find((node) => String(node.props.title).startsWith('調整順序'))!;
    act(() => arrange().props.onClick());
    expect(watchRow(view, '1000').props.draggable).toBe(true);
    vi.mocked(watchProps.onSelect).mockClear();
    act(() => {
        watchRow(view, '1000').props.onClick();
        watchRow(view, '1000').props.onDragStart({ dataTransfer: {} });
        watchRow(view, '1002').props.onDragOver({ preventDefault: vi.fn() });
        watchRow(view, '1002').props.onDrop({ preventDefault: vi.fn() });
    });
    expect(watchProps.onSelect).not.toHaveBeenCalled();
    expect(watchProps.onReorder).toHaveBeenCalledExactlyOnceWith('1000', '1002');
    act(() => watchRow(view, '1001').findAllByType('button').find((node) => node.props.title === '上移')!.props.onClick({ stopPropagation: vi.fn() }));
    expect(watchProps.onReorder).toHaveBeenLastCalledWith('1001', '1000');
    vi.mocked(watchProps.onReorder).mockClear();
    act(() => {
        watchRow(view, '1000').props.onDragStart({ dataTransfer: {} });
        watchRow(view, '1002').props.onDragOver({ preventDefault: vi.fn() });
        watchRow(view, '1000').props.onDragEnd();
        watchRow(view, '1002').props.onDrop({ preventDefault: vi.fn() });
    });
    expect(watchProps.onReorder).not.toHaveBeenCalled();
});

it('callback 不凍結新 onReorder，漲跌排序及選取狀態仍隨 props 和 quote 更新', async () => {
    const { view, watchProps } = render('watchlist', false, async () => undefined, { items: watchItems(2) });
    const nextReorder = vi.fn();
    act(() => view.update(createElement(Watchlist, { ...watchProps, selectedCode: '1001', onReorder: nextReorder })));
    expect(watchRow(view, '1001').props.className).not.toBe(watchRow(view, '1000').props.className);
    act(() => view.root.findAllByType('button').find((node) => node.props.title === '依漲跌幅排序')!.props.onClick());
    publishQuote('1001', 105);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(view.root.findAll((node) => node.type === 'div' && node.props['data-code']).map((node) => node.props['data-code'])).toEqual(['1001', '1000']);
    act(() => view.root.findAllByType('button').find((node) => String(node.props.title).startsWith('漲幅在前'))!.props.onClick());
    act(() => view.root.findAllByType('button').find((node) => String(node.props.title).startsWith('跌幅在前'))!.props.onClick());
    act(() => view.root.findAllByType('button').find((node) => String(node.props.title).startsWith('調整順序'))!.props.onClick());
    act(() => {
        watchRow(view, '1000').props.onDragStart({ dataTransfer: {} });
        watchRow(view, '1001').props.onDragOver({ preventDefault: vi.fn() });
        watchRow(view, '1001').props.onDrop({ preventDefault: vi.fn() });
    });
    expect(nextReorder).toHaveBeenCalledExactlyOnceWith('1000', '1001');
    expect(watchProps.onReorder).not.toHaveBeenCalled();
});

it('一般模式不接外部拖放，換清單會退出排序並清除上一清單的 drag refs', async () => {
    const { view, watchProps } = render('watchlist', false, async () => undefined, { items: watchItems(2) });
    const preventDefault = vi.fn();
    act(() => {
        watchRow(view, '1000').props.onDragStart({ dataTransfer: {} });
        watchRow(view, '1001').props.onDragOver({ preventDefault });
        watchRow(view, '1001').props.onDrop({ preventDefault });
    });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(watchProps.onReorder).not.toHaveBeenCalled();
    act(() => view.root.findAllByType('button').find((node) => String(node.props.title).startsWith('調整順序'))!.props.onClick());
    act(() => {
        watchRow(view, '1000').props.onDragStart({ dataTransfer: {} });
        watchRow(view, '1001').props.onDragOver({ preventDefault });
    });
    act(() => view.update(createElement(Watchlist, { ...watchProps, activeListId: '另一清單' })));
    expect(watchRow(view, '1000').props.draggable).toBe(false);
    act(() => view.root.findAllByType('button').find((node) => String(node.props.title).startsWith('調整順序'))!.props.onClick());
    act(() => watchRow(view, '1001').props.onDrop({ preventDefault }));
    expect(watchProps.onReorder).not.toHaveBeenCalled();
});

const activeWatchText = (view: ReactTestRenderer) => text(view.root.findAllByType('button').find(node => node.props.className === watchStyles.suggestActive)!);
const key = (view: ReactTestRenderer, name: string) => input(view).props.onKeyDown({ key: name, preventDefault: vi.fn() });

describe.each([{ kind: 'palette' as const, debounce: 120 }, { kind: 'watchlist' as const, debounce: 150 }])('$kind 快速代碼 Enter 反例', ({ kind, debounce }) => {
    it.each([
        ['2330', 'debounce 前'], ['TXFR1', 'debounce 前'],
        ['2330', 'Promise pending'], ['TXFR1', 'Promise pending'],
    ])('%s 在 %s 使用最新 DOM handler 仍可提交', async (code, phase) => {
        const { view, submit } = render(kind);
        act(() => input(view).props.onChange({ target: { value: code } }));
        await act(async () => { await vi.advanceTimersByTimeAsync(phase === 'debounce 前' ? 50 : debounce + 50); });
        expect(sessions).toHaveLength(phase === 'debounce 前' ? 0 : 1);
        expect(row(view, code)).toBeUndefined();
        await act(async () => key(view, 'Enter'));
        if (kind === 'palette') expect(submit).toHaveBeenCalledExactlyOnceWith(code, undefined);
        else expect(submit).toHaveBeenCalledExactlyOnceWith(code);
        if (phase === 'Promise pending') expect(sessions[0]!.signal.aborted).toBe(true);
    });

    it('同一 act 輸入加 Enter 的舊 handler 必須阻擋，新 DOM handler 才可提交新碼', async () => {
        const { view, submit } = render(kind);
        const session = await start(view, debounce, '台積電');
        await act(async () => session.resolve([stock]));
        const oldEnter = input(view).props.onKeyDown;
        act(() => {
            input(view).props.onChange({ target: { value: 'TXFR1' } });
            oldEnter({ key: 'Enter', preventDefault: vi.fn() });
        });
        expect(submit).not.toHaveBeenCalled();
        await act(async () => key(view, 'Enter'));
        if (kind === 'palette') expect(submit).toHaveBeenCalledExactlyOnceWith('TXFR1', undefined);
        else expect(submit).toHaveBeenCalledExactlyOnceWith('TXFR1');
    });
});

it.each([['ArrowDown', stock], ['ArrowUp', warrant]] as const)('Watchlist pending 中文未明確選取不畫 active，首次 %s 選取邊界列後才可提交', async (direction, expected) => {
    const { view, submit } = render('watchlist');
    const session = await start(view, 150);
    act(() => session.onUpdate([stock, future, warrant]));
    expect(view.root.findAllByType('button').filter(node => node.props.className === watchStyles.suggestActive)).toHaveLength(0);
    await act(async () => key(view, 'Enter'));
    expect(submit).not.toHaveBeenCalled();
    expect(input(view).props.value).toBe('台積電');
    expect(row(view, stock.code)).toBeDefined();
    expect(session.signal.aborted).toBe(false);
    act(() => key(view, direction));
    expect(activeWatchText(view)).toContain(expected.code);
    await act(async () => key(view, 'Enter'));
    expect(submit).toHaveBeenCalledExactlyOnceWith(expected.code, expected.security_type, undefined);
});

it('Watchlist 完成名稱搜尋後 Enter 預設加入首筆 code/type，不提交中文原字串', async () => {
    const { view, submit } = render('watchlist');
    const session = await start(view, 150, '台積電');
    await act(async () => session.resolve([stock, future]));
    expect(activeWatchText(view)).toContain(stock.code);
    await act(async () => key(view, 'Enter'));
    expect(submit).toHaveBeenCalledExactlyOnceWith('2330', 'STK', undefined);
    expect(input(view).props.value).toBe('');
});

it('Watchlist 上下鍵循環，名稱 pending 明確選取後才傳完整合約', async () => {
    const { view, submit } = render('watchlist');
    const resolved: ContractInfo = { ...watchItems(1)[0]!.contract, code: future.code, security_type: 'FUT', exchange: 'TAIFEX' };
    const picked = { ...future, contract: resolved };
    const session = await start(view, 150);
    act(() => session.onUpdate([stock, picked, warrant]));
    await act(async () => key(view, 'Enter'));
    expect(submit).not.toHaveBeenCalled();
    act(() => key(view, 'ArrowUp'));
    expect(activeWatchText(view)).toContain(warrant.code);
    act(() => key(view, 'ArrowDown'));
    expect(activeWatchText(view)).toContain(stock.code);
    act(() => key(view, 'ArrowDown'));
    expect(activeWatchText(view)).toContain(picked.code);
    await act(async () => key(view, 'Enter'));
    expect(submit).toHaveBeenCalledExactlyOnceWith(future.code, 'FUT', resolved);
    expect((submit.mock.calls[0] as unknown[] | undefined)?.[2]).toBe(resolved);
    expect(session.signal.aborted).toBe(true);
});

it('Watchlist 明確選取以 type/exchange/code 維持，插列與 final 重排不換商品', async () => {
    const { view, submit } = render('watchlist');
    const otc = { ...stock, exchange: 'OTC', name: 'OTC 同碼股票' };
    const index = { ...otc, security_type: 'IND' as const, name: 'OTC 同碼指數' };
    const session = await start(view, 150);
    act(() => session.onUpdate([stock, otc]));
    act(() => key(view, 'ArrowDown'));
    act(() => key(view, 'ArrowDown'));
    act(() => session.onUpdate([index, stock, otc]));
    expect(activeWatchText(view)).toContain('OTC 同碼股票');
    await act(async () => session.resolve([otc, index, stock]));
    expect(activeWatchText(view)).toContain('OTC 同碼股票');
    await act(async () => key(view, 'Enter'));
    expect(submit).toHaveBeenCalledExactlyOnceWith(otc.code, 'STK', undefined);
});

it('Watchlist 已選身分消失後，pending 名稱 Enter 不會提交隱性新首列', async () => {
    const { view, submit } = render('watchlist');
    const session = await start(view, 150);
    act(() => session.onUpdate([stock, future]));
    act(() => key(view, 'ArrowDown'));
    act(() => key(view, 'ArrowDown'));
    act(() => session.onUpdate([warrant, stock]));
    expect(view.root.findAllByType('button').filter(node => node.props.className === watchStyles.suggestActive)).toHaveLength(0);
    await act(async () => key(view, 'Enter'));
    expect(submit).not.toHaveBeenCalled();
    await act(async () => session.resolve([warrant, stock]));
    await act(async () => key(view, 'Enter'));
    expect(submit).toHaveBeenCalledExactlyOnceWith(warrant.code, 'WRT', undefined);
});

it('Watchlist 完成且空結果時，只有正規代碼能 fallback', async () => {
    const { view, submit } = render('watchlist');
    const session = await start(view, 150, '不存在的商品');
    await act(async () => session.resolve([]));
    await act(async () => key(view, 'Enter'));
    expect(submit).not.toHaveBeenCalled();
    act(() => input(view).props.onChange({ target: { value: 'txfr1' } }));
    await act(async () => key(view, 'Enter'));
    expect(submit).toHaveBeenCalledExactlyOnceWith('TXFR1');
});

it.each(['換字', '組字', '換清單'] as const)('Watchlist %s後的舊 click 不可再提交', async change => {
    const { view, submit, watchProps } = render('watchlist');
    const session = await start(view, 150);
    act(() => session.onUpdate([stock]));
    const oldClick = row(view, stock.code)!.props.onClick;
    if (change === '換字') act(() => input(view).props.onChange({ target: { value: '新商品' } }));
    if (change === '組字') act(() => input(view).props.onCompositionStart());
    if (change === '換清單') act(() => view.update(createElement(Watchlist, { ...watchProps, activeListId: 'new-list' })));
    await act(async () => oldClick());
    expect(submit).not.toHaveBeenCalled();
});

it('命令面板同 scope 換字後，舊 click 也不可 prime 或提交', async () => {
    const { view, submit } = render('palette');
    const session = await start(view, 120);
    act(() => session.onUpdate([stock]));
    const oldClick = row(view, stock.code)!.props.onClick;
    act(() => input(view).props.onChange({ target: { value: '新商品' } }));
    await act(async () => oldClick());
    expect(submit).not.toHaveBeenCalled();
    expect(mocks.prime).not.toHaveBeenCalled();
});

it.each(['click', 'Enter'] as const)('Watchlist %s新增失敗保留文字，可重新搜尋並重試', async method => {
    let calls = 0;
    const { view, submit } = render('watchlist', false, async () => { if (++calls === 1) throw new Error('加入失敗'); });
    const session = await start(view, 150);
    await act(async () => session.resolve([stock]));
    await act(async () => method === 'click' ? row(view, stock.code)!.props.onClick() : key(view, 'Enter'));
    expect(input(view).props.value).toBe('台積電');
    expect(text(view.root)).toContain('加入自選失敗，可重新搜尋');
    act(() => row(view, '重新搜尋')!.props.onClick());
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    await act(async () => sessions.at(-1)!.resolve([stock]));
    await act(async () => key(view, 'Enter'));
    expect(submit).toHaveBeenCalledTimes(2);
    expect(input(view).props.value).toBe('');
    expect(text(view.root)).not.toContain('加入自選失敗');
});

it('Watchlist busy 同 frame 重複 click 只送一次，晚到失敗不覆蓋新輸入', async () => {
    let reject!: (reason: Error) => void;
    const { view, submit } = render('watchlist', false, () => new Promise((_resolve, no) => { reject = no; }));
    const session = await start(view, 150);
    act(() => session.onUpdate([stock]));
    const click = row(view, stock.code)!.props.onClick;
    act(() => { void click(); void click(); });
    expect(submit).toHaveBeenCalledOnce();
    act(() => input(view).props.onChange({ target: { value: '新輸入' } }));
    await act(async () => reject(new Error('舊加入失敗')));
    expect(input(view).props.value).toBe('新輸入');
    expect(text(view.root)).not.toContain('加入自選失敗');
});

it.each([{ kind: 'palette' as const, debounce: 120 }, { kind: 'watchlist' as const, debounce: 150 }])(
    '$kind 的 Badge 只看型別，不解析 detail，完整代碼／名稱／日期警告都留在 DOM', async ({ kind, debounce }) => {
        const { view } = render(kind);
        const session = await start(view, debounce);
        const etf: ProductSuggestion = { ...stock, code: '0050', name: '元大台灣50', kind: 'ETF', detail: '任意補充內容' };
        const long: ProductSuggestion = { ...warrant, code: 'LONGWARRANT1234', name: '完整權證商品名稱', detail: '2027-04-07 · 交易日期待確認' };
        await act(async () => session.resolve([etf, { ...stock, detail: 'ETF 字串不得改股票分類' }, long]));
        expect(view.root.findAllByType(ProductBadge).map(node => node.findByType('span').children.join(''))).toEqual(['ETF', '股票', '權證']);
        expect(text(row(view, long.code)!.children[0] as ReactTestInstance)).toBe(long.code);
        expect(text(row(view, long.code)!.children[1] as ReactTestInstance)).toBe(long.name);
        expect(row(view, long.code)!.props.title).toBe(`${long.name} · ${long.code} · 權證 · ${long.detail}`);
        expect(text(row(view, long.code)!)).toContain(long.detail);
    },
);

it.each([{ kind: 'palette' as const, debounce: 120 }, { kind: 'watchlist' as const, debounce: 150 }])(
    '$kind 的 Badge 與 detail 去重只作用於顯示，月份與警告保留', async ({ kind, debounce }) => {
        const { view } = render(kind);
        const session = await start(view, debounce);
        const etf: ProductSuggestion = { ...stock, kind: 'ETF', detail: 'ETF' };
        const dated: ProductSuggestion = { ...future, detail: '期貨 · 近月' };
        const warned: ProductSuggestion = { ...warrant, detail: '認購 · 2027-04-07 · 交易日期待確認' };
        await act(async () => session.resolve([etf, dated, warned]));
        const detailClass = kind === 'palette' ? paletteStyles.resultType : watchStyles.suggestCat;
        const details = view.root.findAllByType('span').filter(node => node.props.className === detailClass).map(node => text(node));
        expect(details).toEqual(['近月', warned.detail]);
        expect([etf.detail, dated.detail]).toEqual(['ETF', '期貨 · 近月']);
        expect(view.root.findAllByType(ProductBadge).map(node => node.props.security_type)).toEqual(['STK', 'FUT', 'WRT']);
    },
);

it.each([{ kind: 'palette' as const, debounce: 120 }, { kind: 'watchlist' as const, debounce: 150 }])(
    '$kind 單行 DOM 依序 code／name／badge／detail，完整摘要只放列 title，窄版仍可讀日期警告', async ({ kind, debounce }) => {
        const { view } = render(kind);
        const session = await start(view, debounce);
        const values: ProductSuggestion[] = [
            { ...future, code: 'LONGFUTURECONTRACTR1', name: '完整且很長的期貨商品名稱近月', detail: '期貨 · 近月' },
            { ...warrant, code: 'LONGWARRANTCONTRACT1234', name: '完整且很長的權證商品名稱', detail: '認購 · 2027-04-07 · 交易日期待確認' },
        ];
        await act(async () => session.resolve(values));
        for (const item of values) {
            const button = row(view, item.code)!;
            const children = button.children as ReactTestInstance[];
            expect(children).toHaveLength(3);
            expect(children.map(node => node.type)).toEqual(['span', 'span', 'span']);
            expect(button.props.title).toBe(`${item.name} · ${item.code} · ${item.security_type === 'FUT' ? '期貨 · 近月' : `權證 · ${item.detail}`}`);
            expect(button.props['aria-label']).toBeUndefined();
            expect(button.findAllByType('span').filter(node => node.props.title !== undefined)).toHaveLength(0);
            expect(text(children[0]!)).toBe(item.code);
            expect(text(children[1]!)).toBe(item.name);
            const meta = children[2]!;
            expect(meta.props.className).toBe(kind === 'palette' ? paletteStyles.resultMeta : watchStyles.suggestMeta);
            expect(meta.props.title).toBeUndefined();
            expect(meta.props['aria-hidden']).not.toBe(true);
            expect((meta.children[0] as ReactTestInstance).type).toBe(ProductBadge);
            const detail = meta.children[1] as ReactTestInstance;
            expect(detail.type).toBe('span');
            expect(detail.props['aria-hidden']).not.toBe(true);
            expect(text(detail)).toBe(item.security_type === 'FUT' ? '近月' : item.detail);
        }
    },
);

it.each([
    ['command-palette.css.ts', 'resultBase', 'resultCode', 'resultName', 'resultMeta', 'resultType'],
    ['watchlist.css.ts', 'suggestRowBase', 'suggestCode', 'suggestName', 'suggestMeta', 'suggestCat'],
])('%s 單行 CSS 結構不換行，欄位可收縮且 metadata 有比例上限', (file, rowName, codeName, nameName, metaName, detailName) => {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    const rule = (name: string) => {
        const match = source.match(new RegExp(`(?:export )?const ${name} = (?:style\\()?\\{([\\s\\S]*?)\\n\\}`));
        expect(match, name).not.toBeNull();
        return match![1]!;
    };
    expect(rule(rowName!)).toContain("display: 'flex'");
    expect(rule(rowName!)).toContain("flexWrap: 'nowrap'");
    expect(rule(rowName!)).not.toContain('gridTemplateColumns');
    const meta = rule(metaName!);
    expect(meta).toContain("flexWrap: 'nowrap'");
    expect(meta).toContain("maxWidth: '42%'");
    expect(meta).toContain('minWidth: 0');
    expect(meta).toContain("overflow: 'hidden'");
    expect(meta).not.toContain('gridColumn');
    for (const name of [codeName, nameName, detailName]) {
        const value = rule(name!);
        expect(value).toContain('minWidth: 0');
        expect(value).toContain("overflow: 'hidden'");
        expect(value).toContain("textOverflow: 'ellipsis'");
        expect(value).toContain("whiteSpace: 'nowrap'");
        expect(value).not.toContain("overflowWrap: 'anywhere'");
    }
    expect(rule(detailName!)).toContain('color: vars.color.foreground');
    // Component width, including a narrow desktop panel, controls the presentation.
    expect(source).toContain("containerType: 'inline-size'");
    expect(source).toContain('containerName: searchContainer');
    expect(source).toContain('`${searchContainer} (max-width: 360px)`');
    // Accessibility media may change colors, but layout must depend on the container.
    for (const name of [codeName, nameName, metaName]) expect(rule(name!)).not.toContain('@media');
    expect(rule(nameName!)).toContain("flex: '1 1 10em'");
    expect(meta).toContain("flex: '0 4 auto'");
    expect(rule(nameName!)).toContain("[narrowSearch]: { flex: '1 1 0', fontWeight: 600 }");
    // Visual order follows the existing code/name DOM at every container width.
    expect(rule(nameName!)).not.toMatch(/\border\s*:/);
    expect(rule(codeName!)).not.toMatch(/\border\s*:/);
    expect(rule(codeName!)).toContain("[narrowSearch]: { flex: '0 1 auto', maxWidth: '34%', fontWeight: 400 }");
    expect(meta).toContain("position: 'absolute', width: 1, height: 1");
    expect(meta).toContain("clipPath: 'inset(50%)'");
    expect(meta).not.toContain("display: 'none'");
    expect(meta).not.toContain("visibility: 'hidden'");
});

it('palette 面板命令描述也維持單行結構與完整 title', async () => {
    const { view } = render('palette', true);
    const session = await start(view, 120);
    await act(async () => session.resolve([]));
    const command = row(view, '新增面板：圖表')!;
    expect(command.children).toHaveLength(3);
    const icon = command.children[0] as ReactTestInstance;
    const name = command.children[1] as ReactTestInstance;
    expect(icon.props.className).toBe(paletteStyles.panelIcon);
    expect(text(icon)).toBe('＋');
    expect(name.props.className).toBe(paletteStyles.panelName);
    expect(text(name)).toBe('新增面板：圖表');
    const description = command.children[2] as ReactTestInstance;
    expect(description.props.className).toBe(paletteStyles.resultMeta);
    expect(description.props.title).toBeUndefined();
    const inner = description.children[0] as ReactTestInstance;
    expect(inner.props.className).toBe(paletteStyles.resultType);
    expect(inner.props.title).toBeUndefined();
    expect(command.props.title).toBe('新增面板：圖表 · 台積電');
    expect(text(description)).toBe('台積電');
});

it('palette 面板命令的圖示與名稱不套商品窄版重排，始終維持 icon／name 順序', () => {
    const source = readFileSync(new URL('./command-palette.css.ts', import.meta.url), 'utf8');
    for (const name of ['panelIcon', 'panelName']) {
        const match = source.match(new RegExp(`export const ${name} = style\\(\\{([\\s\\S]*?)\\n\\}`));
        expect(match, name).not.toBeNull();
        expect(match![1]).not.toContain('order:');
        expect(match![1]).not.toContain('@container');
    }
});

it.each([{ kind: 'palette' as const, debounce: 120 }, { kind: 'watchlist' as const, debounce: 150 }])(
    '$kind 只有目前 active 商品的獨立原生 disclosure，切換／清空不保留舊警告且不提交', async ({ kind, debounce }) => {
        const { view, submit, close } = render(kind);
        const session = await start(view, debounce);
        const warned = { ...warrant, detail: '認購 · 2027-04-07 · 交易日期待確認' };
        await act(async () => session.resolve([stock, warned]));
        expect(view.root.findAllByType('details')).toHaveLength(1);
        expect(text(view.root.findByType('details'))).toContain(stock.code);
        act(() => key(view, 'ArrowDown'));
        const details = view.root.findByType('details');
        expect(text(details)).toContain(warned.code);
        expect(text(details)).toContain(warned.detail);
        expect(text(details.findByType('summary'))).toBe('完整資訊（到期 1、警告 1）');
        for (let parent = details.parent; parent; parent = parent.parent) expect(parent.type).not.toBe('button');
        expect(details.findAllByType('button')).toHaveLength(0);
        expect(details.findByType('summary').props.onKeyDown).toBeUndefined();
        expect(details.findByType('summary').props.onClick).toBeUndefined();
        expect(submit).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
        act(() => input(view).props.onChange({ target: { value: '' } }));
        expect(view.root.findAllByType('details')).toHaveLength(0);
    },
);

it.each([{ kind: 'palette' as const, debounce: 120 }, { kind: 'watchlist' as const, debounce: 150 }])(
    '$kind 精確去重後空 detail 不生成空 span，完整列 title 類別不重複、非空 detail 不遺失', async ({ kind, debounce }) => {
        const { view } = render(kind);
        const session = await start(view, debounce);
        const etf: ProductSuggestion = { ...stock, code: '0050', name: '元大台灣50', kind: 'ETF', detail: 'ETF' };
        const dated: ProductSuggestion = { ...future, detail: '期貨 · 近月' };
        await act(async () => session.resolve([stock, etf, dated]));
        for (const item of [stock, etf]) {
            const button = row(view, item.code)!;
            const meta = button.children[2] as ReactTestInstance;
            expect(meta.children).toHaveLength(1);
            expect((meta.children[0] as ReactTestInstance).type).toBe(ProductBadge);
            expect(button.findAllByType('span').filter(node => node.props.title === item.detail)).toHaveLength(0);
            expect(button.props.title).toBe(`${item.name} · ${item.code} · ${item.detail}`);
        }
        const button = row(view, dated.code)!;
        expect(button.props.title).toBe(`${dated.name} · ${dated.code} · 期貨 · 近月`);
        expect(button.findAllByType('span').filter(node => node.props.title !== undefined)).toHaveLength(0);
        expect(text(button)).toContain('近月');
    },
);

it.each([{ kind: 'palette' as const, debounce: 120 }, { kind: 'watchlist' as const, debounce: 150 }])(
    '$kind 只捲動建議容器的 nearest 距離，插列後仍捲原選取，焦點不移動', async ({ kind, debounce }) => {
        const focus = vi.fn();
        const rowFocus = vi.fn();
        const scrollIntoView = vi.fn();
        const order = [stock.code, future.code, warrant.code];
        const container = { clientTop: 0, clientHeight: 112, scrollTop: 0, getBoundingClientRect: () => ({ top: 100, bottom: 212 }) };
        const nodeMock = (element: ReactElement) => {
            const props = element.props as Record<string, unknown>;
            if (element.type === 'input') return { focus };
            if (element.type === 'div' && [paletteStyles.results, watchStyles.suggestBox].includes(String(props.className))) return container;
            if (element.type === 'button' && [paletteStyles.result, paletteStyles.resultActive, watchStyles.suggestRow, watchStyles.suggestActive].includes(String(props.className))) {
                const first = (props.children as ReactElement[])[0]!;
                const code = (first.props as { children: string }).children;
                return { focus: rowFocus, scrollIntoView, getBoundingClientRect: () => {
                    const top = 100 + order.indexOf(code) * 56 - container.scrollTop;
                    return { top, bottom: top + 56 };
                } };
            }
            return null;
        };
        const { view } = render(kind, false, async () => undefined, {}, nodeMock);
        const session = await start(view, debounce);
        act(() => session.onUpdate([stock, future, warrant]));
        const initialFocusCount = focus.mock.calls.length;
        act(() => key(view, 'ArrowUp'));
        expect(container.scrollTop).toBe(56);
        act(() => key(view, 'ArrowDown'));
        expect(container.scrollTop).toBe(0);
        act(() => key(view, 'ArrowDown'));
        order.unshift('NEW');
        act(() => session.onUpdate([{ ...stock, code: 'NEW' }, stock, future, warrant]));
        expect(container.scrollTop).toBe(56);
        expect(focus).toHaveBeenCalledTimes(initialFocusCount);
        expect(rowFocus).not.toHaveBeenCalled();
        expect(scrollIntoView).not.toHaveBeenCalled();
        expect(kind === 'palette' ? activeText(view) : activeWatchText(view)).toContain(future.code);
    },
);

describe('Watchlist 浮層可視裁切幾何', () => {
    function fixture(popout = false) {
        const listeners = new Map<string, Set<(event: Event) => void>>();
        const viewport = {
            innerWidth: 1910, innerHeight: 872, scrollY: 0, document: {},
            getComputedStyle: vi.fn((node: { overflowY?: string }) => ({ overflowY: node.overflowY ?? 'visible', borderTopWidth: '1px', borderBottomWidth: '1px' })),
            addEventListener: vi.fn((type: string, listener: (event: Event) => void) => {
                const group = listeners.get(type) ?? new Set(); group.add(listener); listeners.set(type, group);
            }),
            removeEventListener: vi.fn((type: string, listener: (event: Event) => void) => { listeners.get(type)?.delete(listener); }),
        };
        const grid = { parentElement: null, top: 80, clientTop: 2, clientHeight: 700, overflowY: 'auto', getBoundingClientRect() { return { top: this.top }; } };
        const panel = { parentElement: grid, top: -16.16, clientTop: 1, clientHeight: 500, overflowY: 'hidden', hasAttribute: (name: string) => name === 'data-block-id', getBoundingClientRect() { return { top: this.top }; } };
        const anchor = { parentElement: popout ? null : panel, top: 433.945, height: 35, getBoundingClientRect() { return { top: this.top, bottom: this.top + this.height }; } };
        const style: Record<string, string> = {};
        const values = Array.from({ length: 10 }, (_, index) => ({ ...stock, code: `S${index}`, name: `商品 ${index}` }));
        const popup = {
            style, clientTop: 1, scrollTop: 0,
            get clientHeight() { return this.height - 2; },
            get height() {
                const available = Number(style.maxHeight?.match(/(\d+)px\)$/)?.[1] ?? Infinity);
                return Math.max(2, Math.min(values.length * 56 + 2, 384, viewport.innerHeight / 2, available));
            },
            getBoundingClientRect() { return { top: anchor.top - this.height, bottom: anchor.top }; },
        };
        const observers: { update: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
        const createObserver = vi.fn(function (update: () => void) {
            const observer = { update, observe: vi.fn(), disconnect: vi.fn() }; observers.push(observer); return observer;
        });
        vi.stubGlobal('window', viewport);
        vi.stubGlobal('ResizeObserver', createObserver);
        const rowFocus = vi.fn();
        const focus = vi.fn();
        const rowRects = new Map<string, () => { top: number; bottom: number }>();
        const nodeMock = (element: ReactElement) => {
            const props = element.props as Record<string, unknown>;
            if (element.type === 'input') return { focus };
            if (element.type === 'div' && props.className === watchStyles.addRow) return anchor;
            if (element.type === 'div' && props.className === watchStyles.suggestBox) return popup;
            if (element.type === 'button' && [watchStyles.suggestRow, watchStyles.suggestActive].includes(String(props.className))) {
                const code = ((props.children as ReactElement[])[0]!.props as { children: string }).children;
                const getBoundingClientRect = () => {
                    const top = popup.getBoundingClientRect().top + popup.clientTop + values.findIndex(item => item.code === code) * 56 - popup.scrollTop;
                    return { top, bottom: top + 56 };
                };
                rowRects.set(code, getBoundingClientRect);
                return { focus: rowFocus, getBoundingClientRect };
            }
            return null;
        };
        const rendered = render('watchlist', false, async () => undefined, {}, nodeMock);
        const emit = (type: string, target: unknown = viewport) => act(() => {
            for (const listener of listeners.get(type) ?? []) listener({ target } as Event);
        });
        const activeFullyVisible = (code: string) => {
            const rect = rowRects.get(code)!();
            const top = popup.getBoundingClientRect().top + popup.clientTop;
            expect(rect.top).toBeGreaterThanOrEqual(top);
            expect(rect.bottom).toBeLessThanOrEqual(top + popup.clientHeight);
        };
        return { ...rendered, viewport, grid, panel, anchor, popup, style, values, observers, createObserver, listeners, emit, activeFullyVisible, focus, rowFocus };
    }

    it('1910×872 已內捲動的 workspace：以祖先 client box 限高，首尾列都在 viewport 與 header 下方', async () => {
        const state = fixture();
        const session = await start(state.view, 150);
        act(() => session.onUpdate(state.values));
        expect(state.style).toMatchObject({ maxHeight: 'min(24rem, 50vh, 343px)', boxSizing: 'border-box', visibility: 'visible' });
        expect(state.popup.height).toBeLessThanOrEqual(343);
        expect(state.popup.getBoundingClientRect().top).toBeGreaterThanOrEqual(state.grid.top + state.grid.clientTop + 8);
        expect(state.popup.getBoundingClientRect().bottom).toBeLessThanOrEqual(state.viewport.innerHeight);
        act(() => key(state.view, 'ArrowDown'));
        state.activeFullyVisible('S0');
        act(() => key(state.view, 'ArrowUp'));
        state.activeFullyVisible('S9');
        expect(state.viewport.scrollY).toBe(0);
        expect(state.focus).not.toHaveBeenCalled();
        expect(state.rowFocus).not.toHaveBeenCalled();
        expect(state.createObserver).toHaveBeenCalledTimes(1);
        expect(state.observers[0]!.observe.mock.calls.map(call => call[0])).toEqual([state.anchor, state.panel, state.grid]);
    });

    it('只處理祖先 capture scroll，非 window 捲動也重算並保留 active；忽略 popup 自身與其他面板', async () => {
        const state = fixture();
        const session = await start(state.view, 150);
        act(() => session.onUpdate(state.values));
        act(() => key(state.view, 'ArrowUp'));
        state.anchor.top = 180;
        state.emit('scroll', state.grid);
        expect(state.style.maxHeight).toBe('min(24rem, 50vh, 90px)');
        state.activeFullyVisible('S9');
        expect(activeWatchText(state.view)).toContain('S9');
        expect(state.viewport.scrollY).toBe(0);
        const reads = state.viewport.getComputedStyle.mock.calls.length;
        state.emit('scroll', state.popup);
        state.emit('scroll', {});
        expect(state.viewport.getComputedStyle).toHaveBeenCalledTimes(reads);
        expect(state.viewport.addEventListener).toHaveBeenCalledWith('scroll', expect.any(Function), true);
    });

    it('只監看所在面板 transform 的 style/class 變更，拖動時重算，關閉後不再寫入', async () => {
        const mutations: { update: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
        const createMutation = vi.fn(function (update: () => void) {
            const observer = { update, observe: vi.fn(), disconnect: vi.fn() }; mutations.push(observer); return observer;
        });
        vi.stubGlobal('MutationObserver', createMutation);
        const state = fixture();
        const session = await start(state.view, 150);
        await act(async () => session.resolve(state.values));
        expect(createMutation).toHaveBeenCalledTimes(1);
        expect(mutations[0]!.observe).toHaveBeenCalledExactlyOnceWith(state.panel, { attributes: true, attributeFilter: ['style', 'class'] });
        state.popup.scrollTop = 93.5;
        const previousHeight = state.popup.clientHeight;
        state.anchor.top += 10;
        state.grid.top += 10;
        act(() => mutations[0]!.update());
        expect(state.popup.clientHeight).toBe(previousHeight);
        expect(state.popup.scrollTop).toBe(93.5);
        state.anchor.top = 180;
        state.grid.top = 80;
        act(() => mutations[0]!.update());
        expect(state.style.maxHeight).toBe('min(24rem, 50vh, 90px)');
        act(() => key(state.view, 'Escape'));
        expect(mutations[0]!.disconnect).toHaveBeenCalledTimes(1);
        const previous = { ...state.style };
        state.anchor.top = 300;
        act(() => mutations[0]!.update());
        expect(state.style).toEqual(previous);
    });

    it.each(['resize', '祖先平移', 'ResizeObserver'] as const)('%s 沒有改變可視高度時，不拉回使用者手動捲動位置', async trigger => {
        const state = fixture();
        const session = await start(state.view, 150);
        await act(async () => session.resolve(state.values));
        state.popup.scrollTop = 93.5;
        const previousHeight = state.popup.clientHeight;
        if (trigger === 'resize') { state.viewport.innerHeight = 900; state.emit('resize'); }
        if (trigger === '祖先平移') { state.anchor.top += 10; state.grid.top += 10; state.emit('scroll', state.grid); }
        if (trigger === 'ResizeObserver') act(() => state.observers[0]!.update());
        expect(state.popup.clientHeight).toBe(previousHeight);
        expect(state.popup.scrollTop).toBe(93.5);
        expect(activeWatchText(state.view)).toContain('S0');
        act(() => key(state.view, 'ArrowDown'));
        state.activeFullyVisible('S1');
    });

    it('maxHeight 改變但實際 clientHeight 仍受原上限約束時，也保留手動捲動', async () => {
        const state = fixture();
        state.viewport.innerHeight = 1200;
        state.panel.clientHeight = 1000;
        state.grid.clientHeight = 1000;
        state.anchor.top = 600;
        const session = await start(state.view, 150);
        await act(async () => session.resolve(state.values));
        state.popup.scrollTop = 93.5;
        const height = state.popup.clientHeight;
        const maxHeight = state.style.maxHeight;
        state.anchor.top = 650;
        state.emit('scroll', state.grid);
        expect(state.style.maxHeight).not.toBe(maxHeight);
        expect(state.popup.clientHeight).toBe(height);
        expect(state.popup.scrollTop).toBe(93.5);
    });

    it.each(['pending', 'completed'] as const)('hidden 浮層的 %s 中文 Enter 不提交隱性首筆，保留輸入及建議', async phase => {
        const state = fixture();
        const session = await start(state.view, 150);
        if (phase === 'pending') act(() => session.onUpdate(state.values));
        else await act(async () => session.resolve(state.values));
        state.anchor.top = 90;
        state.emit('resize');
        expect(state.style.visibility).toBe('hidden');
        await act(async () => key(state.view, 'Enter'));
        expect(state.submit).not.toHaveBeenCalled();
        expect(input(state.view).props.value).toBe('台積電');
        expect(row(state.view, 'S0')).toBeDefined();
        expect(session.signal.aborted).toBe(false);
        state.anchor.top = 433.945;
        state.emit('scroll', state.grid);
        expect(state.style.visibility).toBe('visible');
        if (phase === 'completed') {
            state.activeFullyVisible('S0');
            await act(async () => key(state.view, 'Enter'));
            expect(state.submit).toHaveBeenCalledExactlyOnceWith('S0', 'STK', undefined);
        }
    });

    it.each(['hidden Arrow', '可見時已選取', 'captured click', 'Plus'] as const)('hidden 中文查詢不能以 %s 繞過不可見 guard', async action => {
        const state = fixture();
        const session = await start(state.view, 150);
        await act(async () => session.resolve(state.values));
        if (action === '可見時已選取') act(() => key(state.view, 'ArrowDown'));
        const click = row(state.view, 'S1')!.props.onClick;
        state.anchor.top = 90;
        state.emit('resize');
        expect(state.style.visibility).toBe('hidden');
        if (action === 'hidden Arrow') act(() => key(state.view, 'ArrowDown'));
        await act(async () => {
            if (action === 'captured click') await click();
            else if (action === 'Plus') state.view.root.findAllByType('button').find(node => text(node) === '+')!.props.onClick();
            else key(state.view, 'Enter');
        });
        expect(state.submit).not.toHaveBeenCalled();
        expect(input(state.view).props.value).toBe('台積電');
        expect(row(state.view, 'S1')).toBeDefined();
        expect(session.signal.aborted).toBe(false);
    });

    it('可見時明確選取仍提交完整 typed contract，不受 hidden 預設首筆 guard 影響', async () => {
        const state = fixture();
        const resolved = { code: future.code, security_type: 'FUT', exchange: 'TAIFEX', target_code: 'TARGET' } as ContractInfo;
        state.values[1] = { ...future, contract: resolved };
        const session = await start(state.view, 150);
        await act(async () => session.resolve(state.values));
        act(() => key(state.view, 'ArrowDown'));
        state.activeFullyVisible(future.code);
        await act(async () => key(state.view, 'Enter'));
        expect(state.submit).toHaveBeenCalledExactlyOnceWith(future.code, 'FUT', resolved);
    });

    it.each(['debounce', 'pending', 'completed', 'explicit mismatch'] as const)('hidden 時純代碼 %s 仍走輸入碼，不提交別筆 hidden suggestion', async phase => {
        const state = fixture();
        act(() => input(state.view).props.onChange({ target: { value: '2330' } }));
        if (phase !== 'debounce') {
            await act(async () => { await vi.advanceTimersByTimeAsync(150); });
            const session = sessions.at(-1)!;
            if (phase === 'pending') act(() => session.onUpdate(state.values));
            else await act(async () => session.resolve(state.values));
            if (phase === 'explicit mismatch') act(() => key(state.view, 'ArrowDown'));
        }
        state.anchor.top = 90;
        state.emit('resize');
        expect(state.style.visibility).toBe('hidden');
        await act(async () => key(state.view, 'Enter'));
        expect(state.submit).toHaveBeenCalledExactlyOnceWith('2330');
    });

    it.each([
        ['異型別', 'Enter'], ['異型別', 'Plus'], ['異交易所', 'Enter'], ['異交易所', 'Plus'],
    ] as const)('hidden 同碼 %s 的 ArrowDown→%s 只能送 raw code，不送不可見 typed contract', async (difference, action) => {
        const state = fixture();
        const first = { ...stock, code: 'X1', name: '同碼股票' };
        const second: ProductSuggestion = difference === '異型別'
            ? { ...future, code: 'X1', name: '同碼期貨' }
            : { ...first, exchange: 'OTC', name: '同碼上櫃股票' };
        const resolved = { code: second.code, security_type: second.security_type, exchange: second.exchange } as ContractInfo;
        state.values[0] = first;
        state.values[1] = { ...second, contract: resolved };
        const session = await start(state.view, 150, 'X1');
        await act(async () => session.resolve(state.values));
        state.anchor.top = 90;
        state.emit('resize');
        expect(state.style.visibility).toBe('hidden');
        act(() => key(state.view, 'ArrowDown'));
        expect(activeWatchText(state.view)).toContain(second.name);
        await act(async () => {
            if (action === 'Enter') key(state.view, 'Enter');
            else state.view.root.findAllByType('button').find(node => text(node) === '+')!.props.onClick();
        });
        expect(state.submit).toHaveBeenCalledExactlyOnceWith('X1');
    });

    it.each(['Enter', 'Plus'] as const)('hidden 時唯一同碼建議以 %s 保留原 typed/full-contract 參數', async action => {
        const state = fixture();
        const resolved = { code: 'S0', security_type: 'STK', exchange: 'TSE' } as ContractInfo;
        state.values[0] = { ...state.values[0]!, contract: resolved };
        const session = await start(state.view, 150, 'S0');
        await act(async () => session.resolve(state.values));
        state.anchor.top = 90;
        state.emit('resize');
        await act(async () => {
            if (action === 'Enter') key(state.view, 'Enter');
            else state.view.root.findAllByType('button').find(node => text(node) === '+')!.props.onClick();
        });
        expect(state.submit).toHaveBeenCalledExactlyOnceWith('S0', 'STK', resolved);
    });

    it.each([
        ['異型別', '插入同碼'], ['異型別', '替換唯一列'], ['異交易所', '插入同碼'], ['異交易所', '替換唯一列'],
    ] as const)('hidden captured click 在同一 query phase %s／%s 後不可保留舊 typed contract', async (difference, change) => {
        const state = fixture();
        const first = { ...stock, code: 'X1', name: '舊同碼股票' };
        const second: ProductSuggestion = difference === '異型別'
            ? { ...future, code: 'X1', name: '新同碼期貨' }
            : { ...first, exchange: 'OTC', name: '新同碼上櫃股票' };
        const session = await start(state.view, 150, 'X1');
        act(() => session.onUpdate([first]));
        const oldClick = row(state.view, 'X1')!.props.onClick;
        act(() => session.onUpdate(change === '插入同碼' ? [first, second] : [second]));
        state.anchor.top = 90;
        state.emit('resize');
        expect(state.style.visibility).toBe('hidden');
        await act(async () => oldClick());
        expect(state.submit).toHaveBeenCalledExactlyOnceWith('X1');
    });

    it('hidden captured click 即使身分相同，也不沿用已被目前唯一列替換的舊 full-contract 物件', async () => {
        const state = fixture();
        const oldContract = { code: 'X1', security_type: 'STK', exchange: 'TSE', name: '舊合約' } as ContractInfo;
        const first: ProductSuggestion = { ...stock, code: 'X1', contract: oldContract };
        const session = await start(state.view, 150, 'X1');
        act(() => session.onUpdate([first]));
        const oldClick = row(state.view, 'X1')!.props.onClick;
        act(() => session.onUpdate([{ ...first, contract: { ...oldContract, name: '新合約' } }]));
        state.anchor.top = 90;
        state.emit('resize');
        await act(async () => oldClick());
        expect(state.submit).toHaveBeenCalledExactlyOnceWith('X1');
    });

    it('window resize 與裁切祖先 ResizeObserver 都重算，clamp 後選中列仍 fully visible', async () => {
        const state = fixture();
        const session = await start(state.view, 150);
        act(() => session.onUpdate(state.values));
        act(() => key(state.view, 'ArrowUp'));
        state.viewport.innerHeight = 300;
        state.anchor.top = 230;
        state.emit('resize');
        expect(state.style.maxHeight).toBe('min(24rem, 50vh, 140px)');
        state.activeFullyVisible('S9');
        state.viewport.innerHeight = 872;
        state.anchor.top = 433.945;
        state.grid.top = 160;
        act(() => state.observers[0]!.update());
        expect(state.style.maxHeight).toBe('min(24rem, 50vh, 263px)');
        state.activeFullyVisible('S9');
        expect(state.createObserver).toHaveBeenCalledTimes(1);
    });

    it('無 header／裁切祖先的 popout 直接用 viewport，而非硬編 header 高度', async () => {
        const state = fixture(true);
        state.anchor.top = 200;
        const session = await start(state.view, 150);
        act(() => session.onUpdate(state.values));
        expect(state.style.maxHeight).toBe('min(24rem, 50vh, 192px)');
        expect(state.style.visibility).toBe('visible');
        expect(state.observers[0]!.observe.mock.calls.map(call => call[0])).toEqual([state.anchor]);
    });

    it.each(['零空間', '不足 border', 'anchor 在裁切上方', 'anchor 在裁切下方', 'viewport 縮到 anchor 外'] as const)('%s 時隱藏，空間恢復後顯示且不丟明確身分', async condition => {
        const state = fixture();
        const session = await start(state.view, 150);
        act(() => session.onUpdate(state.values));
        act(() => key(state.view, 'ArrowUp'));
        if (condition === '零空間') state.anchor.top = 90;
        if (condition === '不足 border') state.anchor.top = 91;
        if (condition === 'anchor 在裁切上方') state.anchor.top = 0;
        if (condition === 'anchor 在裁切下方') state.anchor.top = 500;
        if (condition === 'viewport 縮到 anchor 外') state.viewport.innerHeight = 300;
        state.emit('resize');
        expect(state.style.visibility).toBe('hidden');
        expect(state.submit).not.toHaveBeenCalled();
        state.anchor.top = 433.945;
        state.viewport.innerHeight = 872;
        state.emit('scroll', state.grid);
        expect(state.style.visibility).toBe('visible');
        expect(activeWatchText(state.view)).toContain('S9');
        state.activeFullyVisible('S9');
    });

    it.each(['Escape', '清空', '提交', '卸載'] as const)('%s 關閉後移除 listeners／observer，已排入的 callback 不再寫入 style', async action => {
        const state = fixture();
        const session = await start(state.view, 150);
        await act(async () => session.resolve(state.values));
        const observer = state.observers[0]!;
        if (action === 'Escape') act(() => key(state.view, 'Escape'));
        if (action === '清空') act(() => input(state.view).props.onChange({ target: { value: '' } }));
        if (action === '提交') await act(async () => key(state.view, 'Enter'));
        if (action === '卸載') act(() => state.view.unmount());
        expect(observer.disconnect).toHaveBeenCalledTimes(1);
        expect(state.listeners.get('scroll')?.size).toBe(0);
        expect(state.listeners.get('resize')?.size).toBe(0);
        const lastStyle = { ...state.style };
        state.anchor.top = 120;
        act(() => observer.update());
        expect(state.style).toEqual(lastStyle);
        if (action === 'Escape') {
            act(() => input(state.view).props.onChange({ target: { value: '新搜尋' } }));
            expect(state.createObserver).toHaveBeenCalledTimes(2);
            expect(state.style.visibility).toBe('visible');
            expect(state.listeners.get('scroll')?.size).toBe(1);
            expect(state.listeners.get('resize')?.size).toBe(1);
        }
    });
});
