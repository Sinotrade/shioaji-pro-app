import { createElement, type ReactElement } from 'react';
import { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductSuggestion } from '../lib/product-search';
import type { QuoteState } from '../lib/stream';

const mocks = vi.hoisted(() => ({
    search: vi.fn(), prime: vi.fn(), rowRender: vi.fn(),
    quotes: new Map<string, QuoteState>(), quoteListeners: new Map<string, Set<() => void>>(),
    etfVersion: 0, etfListeners: new Set<() => void>(),
    equityVersion: 0, equityListeners: new Set<() => void>(),
}));
vi.mock('../lib/stock-runtime-catalog', () => ({
    getEquityNamesVersion: () => mocks.equityVersion,
    subscribeEquityNames: (listener: () => void) => {
        mocks.equityListeners.add(listener);
        return () => { mocks.equityListeners.delete(listener); };
    },
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
import { optionText, resultDetail, resultMeta } from './search-surface.css';
import type { ContractInfo } from '../lib/types/contract';
import {
    activeText, DEBOUNCE, escape, forget, future, hostChildren, input, key, kinds, listbox, optionNodes, render, row,
    rowCode, rowParts, rowText, searchLimit, searchOptionsFor, stock, text, unmountAll, warrant,
} from './product-search.test-harness';

interface Session {
    signal: AbortSignal;
    /** False when the consumer shows final rows only; onUpdate is then a no-op. */
    progressive: boolean;
    onUpdate: (rows: ProductSuggestion[]) => void;
    resolve: (rows: ProductSuggestion[]) => void;
    reject: (error: Error) => void;
}
const sessions: Session[] = [];

async function start(view: ReactTestRenderer, value = '台積電') {
    act(() => input(view).props.onChange({ target: { value } }));
    await act(async () => { await vi.advanceTimersByTimeAsync(DEBOUNCE); });
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
    mocks.equityVersion = 0;
    mocks.search.mockReset().mockImplementation((_query: string, _limit: number, options: { signal: AbortSignal; onUpdate?: Session['onUpdate'] }) => new Promise((resolve, reject) => {
        sessions.push({ signal: options.signal, progressive: !!options.onUpdate, onUpdate: options.onUpdate ?? (() => undefined), resolve, reject });
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

    await act(async () => (kind === 'palette' ? latest.onUpdate : latest.resolve)([stock]));
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

// Option rows record every reveal; nothing else gets a DOM node.
function revealMock() {
    const focus = vi.fn();
    const rowFocus = vi.fn();
    const revealed: [string, unknown][] = [];
    const createNodeMock = (element: ReactElement) => {
        const props = element.props as Record<string, unknown>;
        if (element.type === 'input') return { focus };
        if (element.type === 'button' && props.role === 'option') {
            const code = rowCode(props);
            return { focus: rowFocus, scrollIntoView: (options: unknown) => revealed.push([code, options]) };
        }
        return null;
    };
    return { focus, rowFocus, revealed, createNodeMock };
}

it('命令面板展開資訊或縮放後保留原選取列可見，不需要再按方向鍵且不改焦點', async () => {
    const { focus, rowFocus, revealed, createNodeMock } = revealMock();
    const listeners = new Map<string, () => void>();
    vi.stubGlobal('window', {
        addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
        removeEventListener: (type: string, listener: () => void) => { if (listeners.get(type) === listener) listeners.delete(type); },
    });
    const { view, submit } = render('palette', { createNodeMock });
    const session = await start(view);
    act(() => session.onUpdate([stock, future, warrant]));
    act(() => key(view, 'ArrowUp'));
    expect(revealed.at(-1)).toEqual([warrant.code, { block: 'nearest' }]);
    const selected = activeText(view);
    const focusCalls = focus.mock.calls.length;
    revealed.length = 0;
    act(() => view.root.findByType('details').props.onToggle?.({ currentTarget: { open: true } }));
    expect(revealed).toEqual([[warrant.code, { block: 'nearest' }]]);
    expect(activeText(view)).toBe(selected);
    act(() => listeners.get('resize')?.());
    expect(revealed).toEqual([[warrant.code, { block: 'nearest' }], [warrant.code, { block: 'nearest' }]]);
    expect(focus).toHaveBeenCalledTimes(focusCalls);
    expect(rowFocus).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    act(() => view.unmount());
    forget(view);
    expect(listeners.has('resize')).toBe(false);
});

it.each(kinds)(
    '$kind 已完成的結果在同 URL 商品異動後重查，舊 click handler 也不得送出', async ({ kind }) => {
        const { view, submit } = render(kind);
        const old = await start(view, '2330');
        await act(async () => old.resolve([stock]));
        const oldClick = row(view, '2330')!.props.onClick;
        act(() => invalidateProductCatalog({ region: 'TW', base_changed: true, info_changed: false }));
        await act(async () => oldClick());
        expect(submit).not.toHaveBeenCalled();
        expect(row(view, '2330')).toBeUndefined();
        await act(async () => { await vi.advanceTimersByTimeAsync(DEBOUNCE); });
        const next = sessions.at(-1)!;
        expect(next).not.toBe(old);
        act(() => old.onUpdate([stock]));
        expect(row(view, '2330')).toBeUndefined();
        await act(async () => next.resolve([{ ...stock, name: '異動後商品名稱' }]));
        expect(text(row(view, '2330')!)).toContain('異動後商品名稱');
    },
);

it.each([
    { kind: 'palette' as const, source: 'ETF' as const },
    { kind: 'watchlist' as const, source: 'ETF' as const },
    { kind: 'palette' as const, source: '一般股' as const },
    { kind: 'watchlist' as const, source: '一般股' as const },
])(
    '$kind 已完成的結果在 $source 名稱權威切換後自動重新組裝，不等使用者改字', async ({ kind, source }) => {
        const { view, submit } = render(kind);
        const old = await start(view, '2330');
        await act(async () => old.resolve([stock]));
        const oldClick = row(view, '2330')!.props.onClick;
        act(() => {
            if (source === 'ETF') mocks.etfVersion++;
            else mocks.equityVersion++;
            for (const listener of source === 'ETF' ? mocks.etfListeners : mocks.equityListeners) listener();
        });
        await act(async () => oldClick());
        expect(submit).not.toHaveBeenCalled();
        await act(async () => { await vi.advanceTimersByTimeAsync(DEBOUNCE); });
        const next = sessions.at(-1)!;
        expect(next).not.toBe(old);
        await act(async () => next.resolve([{ ...stock, name: '官方更新名稱' }]));
        expect(text(row(view, '2330')!)).toContain('官方更新名稱');
    },
);
afterEach(() => {
    unmountAll();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('palette 分段搜尋', () => {
    const kind = 'palette' as const;
    it.each(['台積電', '2330'])('輸入 %s：主商品先可見，再補期貨／權證，最終 Promise 完成才結束補齊狀態', async (query) => {
        const { view, submit, close } = render(kind);
        const session = await start(view, query);
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
        const session = await start(view, '00679B');
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

    it('partial 可立即選取，選取後 abort 且晚到結果不能重開清單', async () => {
        const { view, submit } = render(kind);
        const session = await start(view);
        act(() => session.onUpdate([stock]));
        await act(async () => { await row(view, '2330')!.props.onClick(); });
        expect(session.signal.aborted).toBe(true);
        expect(submit).toHaveBeenCalledWith('2330', 'STK');
        act(() => session.onUpdate([future, warrant]));
        await act(async () => session.resolve([future, warrant]));
        expect(row(view, 'CDFR1')).toBeUndefined();
        expect(row(view, '200001')).toBeUndefined();
        expect(text(view.root)).not.toContain('正在補齊關聯商品');
    });

    it('最終 Promise 完成後不再接受來源違約的額外 onUpdate', async () => {
        const { view } = render(kind);
        const session = await start(view);
        await act(async () => session.resolve([stock]));
        act(() => session.onUpdate([future]));
        expect(row(view, '2330')).toBeDefined();
        expect(row(view, 'CDFR1')).toBeUndefined();
    });
});

it('自選不訂閱分段結果：補齊期間只顯示搜尋中，最終結果一次出現，已顯示的列不會位移', async () => {
    const { view } = render('watchlist');
    const session = await start(view);
    expect(session.progressive).toBe(false);
    expect(mocks.search.mock.calls[0]![2]).not.toHaveProperty('onUpdate');
    expect(text(view.root)).toContain('搜尋中…');
    expect(text(view.root)).not.toContain('正在補齊');
    expect(row(view, '2330')).toBeUndefined();
    await act(async () => session.resolve([stock, future, warrant]));
    expect(optionNodes(view).map((node) => rowCode(node.props))).toEqual([stock.code, future.code, warrant.code]);
    expect(text(view.root)).not.toContain('搜尋中');
});

describe.each(kinds)('$kind 分段搜尋', ({ kind }) => {
    it('Escape 即刻 abort，之後 onUpdate 與 final 都不再回填', async () => {
        const { view, close } = render(kind);
        const session = await start(view);
        act(() => session.onUpdate([stock]));
        act(() => { escape(view, kind); });
        expect(session.signal.aborted).toBe(true);
        if (kind === 'palette') expect(close).toHaveBeenCalledOnce();
        act(() => session.onUpdate([future]));
        await act(async () => session.resolve([future]));
        expect(row(view, 'CDFR1')).toBeUndefined();
        if (kind === 'watchlist') expect(row(view, '2330')).toBeUndefined();
    });

    it('卸載取消自己的 signal', async () => {
        const { view } = render(kind);
        const session = await start(view);
        act(() => view.unmount());
        forget(view);
        expect(session.signal.aborted).toBe(true);
        await act(async () => session.resolve([stock]));
    });

    it('debounce 期間 Escape 會直接移除計時器，不呼叫核心搜尋', async () => {
        const { view } = render(kind);
        act(() => input(view).props.onChange({ target: { value: '台積電' } }));
        act(() => { escape(view, kind); });
        await act(async () => { await vi.advanceTimersByTimeAsync(DEBOUNCE); });
        expect(mocks.search).not.toHaveBeenCalled();
    });

    it('一般來源失敗由核心 resolve 可用 partial，不能當作致命搜尋錯誤', async () => {
        const { view } = render(kind);
        const session = await start(view);
        act(() => session.onUpdate([stock]));
        // searchProducts handles individual source failures and resolves the usable rows.
        await act(async () => session.resolve([stock]));
        expect(row(view, '2330')).toBeDefined();
        expect(text(view.root)).not.toContain('搜尋失敗');
        expect(text(view.root)).not.toContain('正在補齊');
    });

    it('核心致命 reject 清除已發布 partial，重試成功後才能重新選取', async () => {
        const { view } = render(kind);
        const session = await start(view);
        act(() => session.onUpdate([stock]));
        await act(async () => session.reject(new Error('商品搜尋期間伺服器已切換，請重新搜尋')));
        expect(row(view, '2330')).toBeUndefined();
        expect(text(view.root)).toContain('搜尋失敗，可重試');
        act(() => session.onUpdate([future]));
        expect(row(view, 'CDFR1')).toBeUndefined();
        act(() => row(view, '重試')!.props.onClick());
        expect(session.signal.aborted).toBe(true);
        await act(async () => { await vi.advanceTimersByTimeAsync(DEBOUNCE); });
        expect(sessions).toHaveLength(2);
        await act(async () => sessions[1]!.resolve([stock, future]));
        expect(row(view, 'CDFR1')).toBeDefined();
        expect(text(view.root)).not.toContain('搜尋失敗');
    });

    it('舊提交較晚完成不會關閉或清空後來的新查詢', async () => {
        let complete!: () => void;
        const { view, close } = render(kind, { submitHandler: () => new Promise<void>((resolve) => { complete = resolve; }) });
        const first = await start(view, '2330');
        act(() => { input(view).props.onKeyDown({ key: 'Enter' }); });
        expect(first.signal.aborted).toBe(true);
        const next = await start(view, '新商品');
        await act(async () => complete());
        expect(input(view).props.value).toBe('新商品');
        expect(next.signal.aborted).toBe(false);
        expect(close).not.toHaveBeenCalled();
    });
});

it('命令面板由父層關閉時也取消搜尋，晚到結果不可回填', async () => {
    const { view, close, submit } = render('palette');
    const session = await start(view);
    act(() => view.update(createElement(CommandPalette, { open: false, onClose: close, onJump: submit })));
    expect(session.signal.aborted).toBe(true);
    act(() => session.onUpdate([stock]));
    await act(async () => session.resolve([stock]));
    expect(view.toJSON()).toBeNull();
});

it('鍵盤選取以身分維持，partial 插入與 final 重排都不改成其他商品', async () => {
    const { view, submit } = render('palette');
    const session = await start(view);
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
    const session = await start(view);
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
    const session = await start(view);
    act(() => session.onUpdate([stock, future]));
    act(() => row(view, 'CDFR1')!.props.onMouseMove({ clientX: 20, clientY: 30 }));
    act(() => session.onUpdate([warrant, stock]));
    expect(activeText(view)).toContain('200001');
    await act(async () => input(view).props.onKeyDown({ key: 'Enter' }));
    expect(submit).toHaveBeenCalledExactlyOnceWith('200001', 'WRT');
});

it('面板命令也保留身分，不因背景商品補入而被替換', async () => {
    const { view, submit, addPanel } = render('palette', { withCommands: true });
    const session = await start(view);
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
    const { view, submit, addPanel } = render('palette', { withCommands: true });
    const session = await start(view);
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
    const first = await start(palette.view);
    const second = await start(watchlist.view);
    expect(first.signal).not.toBe(second.signal);
    act(() => input(palette.view).props.onChange({ target: { value: '另一個商品' } }));
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    await act(async () => second.resolve([stock, future]));
    expect(row(watchlist.view, 'CDFR1')).toBeDefined();
    await act(async () => { await row(watchlist.view, 'CDFR1')!.props.onClick(); });
    expect(watchlist.submit).toHaveBeenCalledExactlyOnceWith('CDFR1', 'FUT', undefined);
    expect(palette.submit).not.toHaveBeenCalled();
});

it('Watchlist 名稱 pending 時 Enter 不送出也不中斷搜尋，完成後才出現結果', async () => {
    const { view, submit } = render('watchlist');
    const session = await start(view);
    await act(async () => input(view).props.onKeyDown({ key: 'Enter' }));
    expect(submit).not.toHaveBeenCalled();
    expect(session.signal.aborted).toBe(false);
    expect(text(view.root)).toContain('搜尋中…');
    await act(async () => session.resolve([stock, future]));
    expect(row(view, 'CDFR1')).toBeDefined();
});

it('partial 跳轉失敗可重新搜尋，清掉未完成舊列並重新補齊', async () => {
    const { view, submit } = render('palette', { submitHandler: async () => { throw new Error('測試跳轉失敗'); } });
    const session = await start(view);
    act(() => session.onUpdate([stock]));
    await act(async () => input(view).props.onKeyDown({ key: 'Enter' }));
    expect(submit).toHaveBeenCalledOnce();
    expect(session.signal.aborted).toBe(true);
    expect(text(view.root)).toContain('找不到此商品代碼');
    expect(row(view, '重新搜尋')).toBeDefined();
    act(() => row(view, '重新搜尋')!.props.onClick());
    expect(row(view, '2330')).toBeUndefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(DEBOUNCE); });
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
    const { view, close, submit } = render('palette', { submitHandler: () => new Promise((_resolve, reject) => { fail = reject; }) });
    const session = await start(view, '2330');
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
    const { view, close, submit } = render('palette', { submitHandler: () => new Promise<void>((resolve) => { complete = resolve; }) });
    await start(view, '2330');
    act(() => { input(view).props.onKeyDown({ key: 'Enter' }); });
    act(() => view.update(createElement(CommandPalette, { open: false, onClose: close, onJump: submit })));
    await act(async () => complete());
    expect(close).not.toHaveBeenCalled();
});

it('游標未移動時，補入商品產生的 hover 或同座標 mousemove 不能取代鍵盤選取', async () => {
    const { view } = render('palette');
    const session = await start(view);
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
    const { view } = render('watchlist', { watchOverrides: { items: watchItems() } });
    const session = await start(view);
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
    const { view, watchProps } = render('watchlist', { watchOverrides: { items: watchItems(3) } });
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
    const { view, watchProps } = render('watchlist', { watchOverrides: { items: watchItems(2) } });
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
    const { view, watchProps } = render('watchlist', { watchOverrides: { items: watchItems(2) } });
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


describe.each(kinds)('$kind 快速代碼 Enter 反例', ({ kind }) => {
    it.each([
        ['2330', 'debounce 前'], ['TXFR1', 'debounce 前'],
        ['2330', 'Promise pending'], ['TXFR1', 'Promise pending'],
    ])('%s 在 %s 使用最新 DOM handler 仍可提交', async (code, phase) => {
        const { view, submit } = render(kind);
        act(() => input(view).props.onChange({ target: { value: code } }));
        await act(async () => { await vi.advanceTimersByTimeAsync(phase === 'debounce 前' ? 50 : DEBOUNCE + 50); });
        expect(sessions).toHaveLength(phase === 'debounce 前' ? 0 : 1);
        expect(row(view, code)).toBeUndefined();
        await act(async () => key(view, 'Enter'));
        if (kind === 'palette') expect(submit).toHaveBeenCalledExactlyOnceWith(code, undefined);
        else expect(submit).toHaveBeenCalledExactlyOnceWith(code);
        if (phase === 'Promise pending') expect(sessions[0]!.signal.aborted).toBe(true);
    });

    it('同一 act 輸入加 Enter 的舊 handler 必須阻擋，新 DOM handler 才可提交新碼', async () => {
        const { view, submit } = render(kind);
        const session = await start(view, '台積電');
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

it('Watchlist 完成名稱搜尋後 Enter 預設加入首筆 code/type，不提交中文原字串', async () => {
    const { view, submit } = render('watchlist');
    const session = await start(view, '台積電');
    await act(async () => session.resolve([stock, future]));
    expect(activeText(view)).toContain(stock.code);
    await act(async () => key(view, 'Enter'));
    expect(submit).toHaveBeenCalledExactlyOnceWith('2330', 'STK', undefined);
    expect(input(view).props.value).toBe('');
});

it('Watchlist 上下鍵循環，明確選取後傳完整合約', async () => {
    const { view, submit } = render('watchlist');
    const resolved: ContractInfo = { ...watchItems(1)[0]!.contract, code: future.code, security_type: 'FUT', exchange: 'TAIFEX' };
    const picked = { ...future, contract: resolved };
    const session = await start(view);
    await act(async () => session.resolve([stock, picked, warrant]));
    act(() => key(view, 'ArrowUp'));
    expect(activeText(view)).toContain(warrant.code);
    act(() => key(view, 'ArrowDown'));
    expect(activeText(view)).toContain(stock.code);
    act(() => key(view, 'ArrowDown'));
    expect(activeText(view)).toContain(picked.code);
    await act(async () => key(view, 'Enter'));
    expect(submit).toHaveBeenCalledExactlyOnceWith(future.code, 'FUT', resolved);
    expect((submit.mock.calls[0] as unknown[] | undefined)?.[2]).toBe(resolved);
    expect(session.signal.aborted).toBe(true);
});

it('Watchlist 同碼商品以 type/exchange/code 區分，Enter 送出所選那一筆', async () => {
    const { view, submit } = render('watchlist');
    const otc = { ...stock, exchange: 'OTC', name: 'OTC 同碼股票' };
    const index = { ...otc, security_type: 'IND' as const, name: 'OTC 同碼指數' };
    const session = await start(view);
    await act(async () => session.resolve([stock, otc, index]));
    act(() => key(view, 'ArrowDown'));
    expect(activeText(view)).toContain('OTC 同碼股票');
    await act(async () => key(view, 'Enter'));
    expect(submit).toHaveBeenCalledExactlyOnceWith(otc.code, 'STK', undefined);
});

it('Watchlist 完成且空結果時，只有正規代碼能 fallback', async () => {
    const { view, submit } = render('watchlist');
    const session = await start(view, '不存在的商品');
    await act(async () => session.resolve([]));
    await act(async () => key(view, 'Enter'));
    expect(submit).not.toHaveBeenCalled();
    act(() => input(view).props.onChange({ target: { value: 'txfr1' } }));
    await act(async () => key(view, 'Enter'));
    expect(submit).toHaveBeenCalledExactlyOnceWith('TXFR1');
});

it.each(['換字', '組字', '換清單'] as const)('Watchlist %s後的舊 click 不可再提交', async change => {
    const { view, submit, watchProps } = render('watchlist');
    const session = await start(view);
    await act(async () => session.resolve([stock]));
    const oldClick = row(view, stock.code)!.props.onClick;
    if (change === '換字') act(() => input(view).props.onChange({ target: { value: '新商品' } }));
    if (change === '組字') act(() => input(view).props.onCompositionStart());
    if (change === '換清單') act(() => view.update(createElement(Watchlist, { ...watchProps, activeListId: 'new-list' })));
    await act(async () => oldClick());
    expect(submit).not.toHaveBeenCalled();
});

it('命令面板同 scope 換字後，舊 click 也不可 prime 或提交', async () => {
    const { view, submit } = render('palette');
    const session = await start(view);
    act(() => session.onUpdate([stock]));
    const oldClick = row(view, stock.code)!.props.onClick;
    act(() => input(view).props.onChange({ target: { value: '新商品' } }));
    await act(async () => oldClick());
    expect(submit).not.toHaveBeenCalled();
    expect(mocks.prime).not.toHaveBeenCalled();
});

it.each(['click', 'Enter'] as const)('Watchlist %s新增失敗保留文字，可重新搜尋並重試', async method => {
    let calls = 0;
    const { view, submit } = render('watchlist', { submitHandler: async () => { if (++calls === 1) throw new Error('加入失敗'); } });
    const session = await start(view);
    await act(async () => session.resolve([stock]));
    await act(async () => method === 'click' ? row(view, stock.code)!.props.onClick() : key(view, 'Enter'));
    expect(input(view).props.value).toBe('台積電');
    expect(text(view.root)).toContain('加入自選失敗，可重新搜尋');
    act(() => row(view, '重新搜尋')!.props.onClick());
    await act(async () => { await vi.advanceTimersByTimeAsync(DEBOUNCE); });
    await act(async () => sessions.at(-1)!.resolve([stock]));
    await act(async () => key(view, 'Enter'));
    expect(submit).toHaveBeenCalledTimes(2);
    expect(input(view).props.value).toBe('');
    expect(text(view.root)).not.toContain('加入自選失敗');
});

it('Watchlist busy 同 frame 重複 click 只送一次，晚到失敗不覆蓋新輸入', async () => {
    let reject!: (reason: Error) => void;
    const { view, submit } = render('watchlist', { submitHandler: () => new Promise((_resolve, no) => { reject = no; }) });
    const session = await start(view);
    await act(async () => session.resolve([stock]));
    const click = row(view, stock.code)!.props.onClick;
    act(() => { void click(); void click(); });
    expect(submit).toHaveBeenCalledOnce();
    act(() => input(view).props.onChange({ target: { value: '新輸入' } }));
    await act(async () => reject(new Error('舊加入失敗')));
    expect(input(view).props.value).toBe('新輸入');
    expect(text(view.root)).not.toContain('加入自選失敗');
});

it.each(kinds)(
    '$kind 的 Badge 只看型別，不解析 detail，完整代碼／名稱／日期警告都留在 DOM', async ({ kind }) => {
        const { view } = render(kind);
        const session = await start(view);
        const etf: ProductSuggestion = { ...stock, code: '0050', name: '元大台灣50', kind: 'ETF', detail: '任意補充內容' };
        const long: ProductSuggestion = { ...warrant, code: 'LONGWARRANT1234', name: '完整權證商品名稱', detail: '2027-04-07 · 交易日期待確認' };
        await act(async () => session.resolve([etf, { ...stock, detail: 'ETF 字串不得改股票分類' }, long]));
        expect(view.root.findAllByType(ProductBadge).map(node => node.findByType('span').children.join(''))).toEqual(['ETF', '股票', '權證']);
        expect(text(rowParts(row(view, long.code)!)[0]!)).toBe(long.code);
        expect(text(rowParts(row(view, long.code)!)[1]!)).toBe(long.name);
        expect(rowText(row(view, long.code)!).props.title).toBe(`${long.name} · ${long.code} · 權證 · ${long.detail}`);
        expect(text(row(view, long.code)!)).toContain(long.detail);
    },
);

it.each(kinds)(
    '$kind 的 Badge 與 detail 去重只作用於顯示，月份與警告保留', async ({ kind }) => {
        const { view } = render(kind);
        const session = await start(view);
        const etf: ProductSuggestion = { ...stock, kind: 'ETF', detail: 'ETF' };
        const dated: ProductSuggestion = { ...future, detail: '期貨 · 近月' };
        const warned: ProductSuggestion = { ...warrant, detail: '認購 · 2027-04-07 · 交易日期待確認' };
        await act(async () => session.resolve([etf, dated, warned]));
        const details = view.root.findAllByType('span').filter(node => node.props.className === resultDetail).map(node => text(node));
        expect(details).toEqual(['近月', warned.detail]);
        expect([etf.detail, dated.detail]).toEqual(['ETF', '期貨 · 近月']);
        expect(view.root.findAllByType(ProductBadge).map(node => node.props.security_type)).toEqual(['STK', 'FUT', 'WRT']);
    },
);

it.each(kinds)(
    '$kind 單行 DOM 依序 code／name／badge／detail，完整摘要放在列內的 hover 元素，窄版仍可讀日期警告', async ({ kind }) => {
        const { view } = render(kind);
        const session = await start(view);
        const values: ProductSuggestion[] = [
            { ...future, code: 'LONGFUTURECONTRACTR1', name: '完整且很長的期貨商品名稱近月', detail: '期貨 · 近月' },
            { ...warrant, code: 'LONGWARRANTCONTRACT1234', name: '完整且很長的權證商品名稱', detail: '認購 · 2027-04-07 · 交易日期待確認' },
        ];
        await act(async () => session.resolve(values));
        for (const item of values) {
            const button = row(view, item.code)!;
            expect(button.children).toHaveLength(1);
            const wrapper = rowText(button);
            expect(wrapper.props.className).toBe(optionText);
            const children = rowParts(button);
            expect(children).toHaveLength(3);
            expect(children.map(node => node.type)).toEqual(['span', 'span', 'span']);
            // A title on the option itself would be read again as its description.
            expect(button.props.title).toBeUndefined();
            expect(wrapper.props.title).toBe(`${item.name} · ${item.code} · ${item.security_type === 'FUT' ? '期貨 · 近月' : `權證 · ${item.detail}`}`);
            expect(button.props['aria-label']).toBeUndefined();
            expect(button.findAllByType('span').filter(node => node.props.title !== undefined)).toEqual([wrapper]);
            expect(text(children[0]!)).toBe(item.code);
            expect(text(children[1]!)).toBe(item.name);
            const meta = children[2]!;
            expect(meta.props.className).toBe(resultMeta);
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

it('palette 面板命令描述也維持單行結構與完整 title', async () => {
    const { view } = render('palette', { withCommands: true });
    const session = await start(view);
    await act(async () => session.resolve([]));
    const command = row(view, '新增面板：圖表')!;
    expect(rowParts(command)).toHaveLength(3);
    const [icon, name] = rowParts(command) as [ReactTestInstance, ReactTestInstance];
    expect(icon.props.className).toBe(paletteStyles.panelIcon);
    expect(text(icon)).toBe('＋');
    expect(icon.props['aria-hidden']).toBe(true);
    expect(name.props.className).toBe(paletteStyles.panelName);
    expect(text(name)).toBe('新增面板：圖表');
    const description = rowParts(command)[2]!;
    expect(description.props.className).toBe(resultMeta);
    expect(description.props.title).toBeUndefined();
    const inner = description.children[0] as ReactTestInstance;
    expect(inner.props.className).toBe(resultDetail);
    expect(inner.props.title).toBeUndefined();
    expect(command.props.title).toBeUndefined();
    expect(rowText(command).props.title).toBe('新增面板：圖表 · 台積電');
    expect(text(description)).toBe('台積電');
});

it.each(kinds)(
    '$kind 只有目前 active 商品的獨立原生 disclosure，切換／清空不保留舊警告且不提交', async ({ kind }) => {
        const { view, submit, close } = render(kind);
        const session = await start(view);
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

it.each(kinds)(
    '$kind 精確去重後空 detail 不生成空 span，完整列 title 類別不重複、非空 detail 不遺失', async ({ kind }) => {
        const { view } = render(kind);
        const session = await start(view);
        const etf: ProductSuggestion = { ...stock, code: '0050', name: '元大台灣50', kind: 'ETF', detail: 'ETF' };
        const dated: ProductSuggestion = { ...future, detail: '期貨 · 近月' };
        await act(async () => session.resolve([stock, etf, dated]));
        for (const item of [stock, etf]) {
            const button = row(view, item.code)!;
            const meta = rowParts(button)[2]!;
            expect(meta.children).toHaveLength(1);
            expect((meta.children[0] as ReactTestInstance).type).toBe(ProductBadge);
            expect(button.findAllByType('span').filter(node => node.props.title === item.detail)).toHaveLength(0);
            expect(rowText(button).props.title).toBe(`${item.name} · ${item.code} · ${item.detail}`);
        }
        const button = row(view, dated.code)!;
        expect(rowText(button).props.title).toBe(`${dated.name} · ${dated.code} · 期貨 · 近月`);
        expect(button.findAllByType('span').filter(node => node.props.title !== undefined)).toEqual([rowText(button)]);
        expect(text(button)).toContain('近月');
    },
);

it.each(kinds)(
    '$kind 以 scrollIntoView nearest 捲動選取列，插列後仍捲原選取，焦點不移動', async ({ kind }) => {
        const { focus, rowFocus, revealed, createNodeMock } = revealMock();
        const { view } = render(kind, { createNodeMock });
        const session = await start(view);
        await act(async () => (kind === 'palette' ? session.onUpdate : session.resolve)([stock, future, warrant]));
        const initialFocusCount = focus.mock.calls.length;
        act(() => key(view, 'ArrowUp'));
        expect(revealed.at(-1)).toEqual([warrant.code, { block: 'nearest' }]);
        act(() => key(view, 'ArrowDown'));
        expect(revealed.at(-1)).toEqual([stock.code, { block: 'nearest' }]);
        act(() => key(view, 'ArrowDown'));
        expect(revealed.at(-1)).toEqual([future.code, { block: 'nearest' }]);
        if (kind === 'palette') {
            // Only the palette shows partial rows, so only it can insert rows above the selection.
            revealed.length = 0;
            act(() => session.onUpdate([{ ...stock, code: 'NEW' }, stock, future, warrant]));
            expect(revealed).toEqual([[future.code, { block: 'nearest' }]]);
        }
        expect(focus).toHaveBeenCalledTimes(initialFocusCount);
        expect(rowFocus).not.toHaveBeenCalled();
        expect(activeText(view)).toContain(future.code);
    },
);

it.each(kinds)('$kind 一般股名稱版本在結果出現與 Enter 之間改變時，不送出舊列並以新名稱重查', async ({ kind }) => {
    const { view, submit } = render(kind);
    const session = await start(view);
    // The palette shows partial rows; the watchlist only shows a completed search.
    await act(async () => (kind === 'palette' ? session.onUpdate : session.resolve)([stock]));
    expect(row(view, stock.code)).toBeDefined();
    // The catalog moves before its listeners have re-rendered this surface.
    mocks.equityVersion++;
    await act(async () => key(view, 'Enter'));
    expect(submit).not.toHaveBeenCalled();
    expect(row(view, stock.code)).toBeUndefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(DEBOUNCE); });
    expect(sessions).toHaveLength(2);
    await act(async () => sessions[1]!.resolve([{ ...stock, name: '一般股更新名稱' }]));
    expect(text(row(view, stock.code)!)).toContain('一般股更新名稱');
    await act(async () => key(view, 'Enter'));
    expect(submit).toHaveBeenCalledExactlyOnceWith(...(kind === 'palette' ? ['2330', 'STK'] : ['2330', 'STK', undefined]));
});

it('命令面板的 Esc 從外框關閉並標記已處理，關閉那一下不算 Esc×2 全部刪單的第一下', async () => {
    const { view, close } = render('palette');
    const session = await start(view);
    act(() => session.onUpdate([stock]));
    // Rows and the retry button sit inside the frame, so their Esc bubbles here too.
    expect(input(view).props.onKeyDown({ key: 'Escape', preventDefault: vi.fn() })).toBeUndefined();
    expect(close).not.toHaveBeenCalled();
    let event!: ReturnType<typeof escape>;
    act(() => { event = escape(view, 'palette'); });
    expect(event.defaultPrevented).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(session.signal.aborted).toBe(true);
});

describe.each(kinds)('$kind combobox 與 listbox', ({ kind }) => {
    it('輸入框是 combobox；只有搜尋中提示時不展開、不指向 listbox', async () => {
        const { view } = render(kind);
        await start(view);
        const box = input(view);
        expect(box.props.role).toBe('combobox');
        expect(box.props['aria-autocomplete']).toBe('list');
        expect(box.props['aria-expanded']).toBe(false);
        expect(box.props['aria-controls']).toBeUndefined();
        expect(box.props['aria-activedescendant']).toBeUndefined();
        expect(view.root.findAll((node) => node.props.role === 'listbox')).toHaveLength(0);
        expect(text(view.root)).toContain('搜尋中…');
    });

    it('方向鍵後 aria-activedescendant 等於 active 列的 id，listbox 只含 option', async () => {
        const { view } = render(kind);
        const session = await start(view);
        await act(async () => session.resolve([stock, future, warrant]));
        const list = listbox(view);
        expect(input(view).props['aria-expanded']).toBe(true);
        expect(input(view).props['aria-controls']).toBe(list.props.id);
        expect(hostChildren(list)).toHaveLength(3);
        expect(hostChildren(list).every((child) => typeof child !== 'string' && child.props.role === 'option')).toBe(true);
        expect(list.findAllByType('details')).toHaveLength(0);
        const active = () => optionNodes(view).find((node) => node.props.id === input(view).props['aria-activedescendant'])!;
        expect(rowCode(active().props)).toBe(stock.code);
        act(() => key(view, 'ArrowDown'));
        expect(rowCode(active().props)).toBe(future.code);
        // aria-selected marks the keyboard row, not the stored value.
        expect(optionNodes(view).filter((node) => node.props['aria-selected']).map((node) => node.props.id)).toEqual([active().props.id]);
        // Tab leaves the input instead of walking through every option.
        expect(optionNodes(view).map((node) => node.props.tabIndex)).toEqual([-1, -1, -1]);
        const ids = optionNodes(view).map((node) => String(node.props.id));
        expect(new Set(ids).size).toBe(3);
        for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('重試鈕按下不搶走焦點，點擊後焦點回到輸入框', async () => {
        const focus = vi.fn();
        const { view } = render(kind, { createNodeMock: (element) => element.type === 'input' ? { focus } : null });
        const session = await start(view);
        await act(async () => session.reject(new Error('搜尋失敗')));
        const retry = row(view, '重試')!;
        for (let parent = retry.parent; parent; parent = parent.parent) expect(parent.props.role).not.toBe('listbox');
        const mouseDown = { preventDefault: vi.fn() };
        retry.props.onMouseDown(mouseDown);
        expect(mouseDown.preventDefault).toHaveBeenCalledOnce();
        focus.mockClear();
        act(() => retry.props.onClick());
        expect(focus).toHaveBeenCalledOnce();
    });
});

it('命令面板的 option id 取自商品身分：前方插入 partial 列時 active 列的 id 不變', async () => {
    const { view } = render('palette', { withCommands: true });
    const session = await start(view);
    act(() => session.onUpdate([stock, future]));
    act(() => key(view, 'ArrowDown'));
    const before = input(view).props['aria-activedescendant'];
    act(() => session.onUpdate([warrant, stock, future]));
    expect(input(view).props['aria-activedescendant']).toBe(before);
    expect(rowCode(optionNodes(view).find((node) => node.props.id === before)!.props)).toBe(future.code);
    // Panel commands are options as well, with a decorative icon.
    const command = row(view, '新增面板')!;
    expect(command.props.role).toBe('option');
    expect(hostChildren(listbox(view)).at(-1)).toBe(command);
    const mouseDown = { preventDefault: vi.fn() };
    command.props.onMouseDown(mouseDown);
    row(view, stock.code)!.props.onMouseDown(mouseDown);
    expect(mouseDown.preventDefault).toHaveBeenCalledTimes(2);
});

it('自選展開完整資訊時把明細捲進浮層可視範圍，收合時不捲動', async () => {
    const { view } = render('watchlist');
    const session = await start(view);
    await act(async () => session.resolve([stock]));
    const scrollIntoView = vi.fn();
    const details = view.root.findByType('details');
    act(() => details.props.onToggle({ currentTarget: { open: false, scrollIntoView } }));
    expect(scrollIntoView).not.toHaveBeenCalled();
    act(() => details.props.onToggle({ currentTarget: { open: true, scrollIntoView } }));
    expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'nearest' });
});

describe('自選浮層錨定在輸入列', () => {
    function fixture() {
        type Listener = (event: { target: unknown }) => void;
        const listen = () => {
            const listeners = new Map<string, Set<Listener>>();
            return {
                listeners,
                addEventListener: vi.fn((type: string, listener: Listener) => {
                    const group = listeners.get(type) ?? new Set(); group.add(listener); listeners.set(type, group);
                }),
                removeEventListener: vi.fn((type: string, listener: Listener) => { listeners.get(type)?.delete(listener); }),
                emit: (type: string, target: unknown) => act(() => { for (const listener of listeners.get(type) ?? []) listener({ target }); }),
            };
        };
        const observers: { callback: (entries: { isIntersecting: boolean }[]) => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
        const win = {
            ...listen(), innerWidth: 1910, innerHeight: 872,
            IntersectionObserver: vi.fn(function (callback: (entries: { isIntersecting: boolean }[]) => void) {
                const observer = { callback, observe: vi.fn(), disconnect: vi.fn() }; observers.push(observer); return observer;
            }),
        };
        // No body: the popup renders in place, but listeners attach to this document.
        const doc = { ...listen(), defaultView: win, documentElement: { clientWidth: 1900 } };
        const outside = { name: 'outside' };
        const details = { focus: vi.fn() };
        const popup = { contains: (node: unknown) => node === popup, querySelector: vi.fn(() => details) };
        const anchor = {
            ownerDocument: doc, top: 500, left: 40, right: 340, clientTop: 1,
            contains: (node: unknown) => node === anchor,
            getBoundingClientRect() { return { top: this.top, bottom: this.top + 35, left: this.left, right: this.right }; },
        };
        const createNodeMock = (element: ReactElement) => {
            const props = element.props as Record<string, unknown>;
            if (element.type === 'div' && props.className === watchStyles.addRow) return anchor;
            if (element.type === 'div' && props.className === watchStyles.suggestBox) return popup;
            return null;
        };
        const rendered = render('watchlist', { createNodeMock });
        const box = () => rendered.view.root.findAll((node) => node.type === 'div' && node.props.className === watchStyles.suggestBox);
        return { ...rendered, win, doc, anchor, popup, details, outside, observers, box };
    }

    it('在輸入列上方、左右對齊輸入列，max-height 同為 min(24rem, 50vh) 且不超出視窗頂端；捲動與縮放跟著移動', async () => {
        const state = fixture();
        const session = await start(state.view);
        await act(async () => session.resolve([stock, future]));
        expect(state.box()[0]!.props.style).toEqual({ left: 40, right: 1560, bottom: 371, maxHeight: 'min(24rem, 50vh, 492px)' });
        // A panel or workspace scrolled: any capture scroll re-places the popup.
        state.anchor.top = 300;
        state.win.emit('scroll', state.outside);
        expect(state.box()[0]!.props.style).toEqual({ left: 40, right: 1560, bottom: 571, maxHeight: 'min(24rem, 50vh, 292px)' });
        state.win.innerHeight = 700;
        state.win.emit('resize', state.win);
        expect(state.box()[0]!.props.style).toMatchObject({ bottom: 399 });
    });

    it('上方不到 120px 且下方較大時改往下開，不留看不見的浮層', async () => {
        const state = fixture();
        state.anchor.top = 60;
        const session = await start(state.view);
        await act(async () => session.resolve([stock]));
        expect(state.box()[0]!.props.style).toEqual({ left: 40, right: 1560, top: 95, boxShadow: '0 6px 18px rgba(0, 0, 0, 0.3)', maxHeight: 'min(24rem, 50vh, 769px)' });
    });

    it('Tab 先進到浮層的詳情，浮層內 Esc 收起並回到輸入框', async () => {
        const state = fixture();
        const session = await start(state.view);
        await act(async () => session.resolve([stock]));
        const tab = { key: 'Tab', shiftKey: false, preventDefault: vi.fn() };
        act(() => input(state.view).props.onKeyDown(tab));
        expect(tab.preventDefault).toHaveBeenCalled();
        expect(state.details.focus).toHaveBeenCalledOnce();
        const esc = { key: 'Escape', preventDefault: vi.fn() };
        act(() => state.box()[0]!.props.onKeyDown(esc));
        expect(esc.preventDefault).toHaveBeenCalled();
        expect(state.box()).toHaveLength(0);
        expect(input(state.view).props.value).toBe('台積電');
        // Closed on purpose: focusing the input again does not reopen it.
        act(() => input(state.view).props.onFocus());
        expect(state.box()).toHaveLength(0);
    });

    it.each(['pointerdown', 'focusin'] as const)('%s 落在浮層與輸入列以外（例如拖動面板）即收起，不留可送出的隱藏列', async (type) => {
        const state = fixture();
        const session = await start(state.view);
        await act(async () => session.resolve([stock]));
        state.doc.emit(type, state.popup);
        state.doc.emit(type, state.anchor);
        expect(state.box()).toHaveLength(1);
        state.doc.emit(type, state.outside);
        expect(state.box()).toHaveLength(0);
        expect(input(state.view).props['aria-expanded']).toBe(false);
        await act(async () => key(state.view, 'Enter'));
        expect(state.submit).not.toHaveBeenCalled();
        expect(input(state.view).props.value).toBe('台積電');
        // Focusing the input again searches the kept text.
        act(() => input(state.view).props.onFocus());
        expect(state.box()).toHaveLength(1);
    });

    it('輸入列捲出可視範圍即收起，收起後移除所有監聽', async () => {
        const state = fixture();
        const session = await start(state.view);
        await act(async () => session.resolve([stock]));
        const observer = state.observers[0]!;
        expect(observer.observe).toHaveBeenCalledWith(state.anchor);
        act(() => observer.callback([{ isIntersecting: true }]));
        expect(state.box()).toHaveLength(1);
        act(() => observer.callback([{ isIntersecting: false }]));
        expect(state.box()).toHaveLength(0);
        expect(observer.disconnect).toHaveBeenCalledOnce();
        for (const target of [state.win, state.doc]) {
            for (const group of target.listeners.values()) expect(group.size).toBe(0);
        }
        await act(async () => key(state.view, 'Enter'));
        expect(state.submit).not.toHaveBeenCalled();
    });
});

describe.each(kinds)('$kind 中文輸入法與查詢取消', ({ kind }) => {
    const searchOptions = searchOptionsFor(kind);

    it.each([
        { nativeEvent: { isComposing: true }, keyCode: 13 },
        { nativeEvent: { isComposing: false }, keyCode: 229 },
    ])('不以組字 Enter 提交商品：%j', async (flags) => {
        const { view, submit } = render(kind);
        await start(view, '2330');
        await act(async () => { input(view).props.onKeyDown({ key: 'Enter', ...flags }); });
        expect(submit).not.toHaveBeenCalled();
        await act(async () => { input(view).props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: false }, keyCode: 13 }); });
        expect(submit).toHaveBeenCalledOnce();
    });

    it('composition ref 也阻擋無旗標的 Enter，結束組字後只搜尋完成文字', async () => {
        const { view, submit } = render(kind);
        act(() => input(view).props.onChange({ target: { value: '2330' } }));
        act(() => input(view).props.onCompositionStart());
        await act(async () => { await vi.advanceTimersByTimeAsync(DEBOUNCE); });
        expect(mocks.search).not.toHaveBeenCalled();
        await act(async () => { input(view).props.onKeyDown({ key: 'Enter' }); });
        expect(submit).not.toHaveBeenCalled();
        act(() => input(view).props.onCompositionEnd({ currentTarget: { value: '台積電' } }));
        await act(async () => { await vi.advanceTimersByTimeAsync(DEBOUNCE); });
        expect(mocks.search).toHaveBeenCalledExactlyOnceWith('台積電', searchLimit(kind), searchOptions);
    });

    it('組字開始取消先前在途查詢，其結果不得回填或被選取', async () => {
        const { view, submit } = render(kind);
        const old = await start(view, '舊商品');
        act(() => input(view).props.onCompositionStart());
        expect(old.signal.aborted).toBe(true);
        act(() => input(view).props.onChange({ target: { value: '新商品' } }));
        act(() => old.onUpdate([stock]));
        await act(async () => old.resolve([stock]));
        expect(view.root.findAllByType('span').some((node) => node.children.includes('2330'))).toBe(false);
        await act(async () => { input(view).props.onKeyDown({ key: 'Enter' }); });
        expect(submit).not.toHaveBeenCalled();
        act(() => input(view).props.onCompositionEnd({ currentTarget: { value: '新商品' } }));
        await act(async () => { await vi.advanceTimersByTimeAsync(DEBOUNCE); });
        expect(mocks.search).toHaveBeenLastCalledWith('新商品', searchLimit(kind), searchOptions);
    });

    it('卸載取消尚未發出的 debounce', async () => {
        const { view } = render(kind);
        act(() => input(view).props.onChange({ target: { value: '台積電' } }));
        act(() => view.unmount());
        forget(view);
        await act(async () => { await vi.advanceTimersByTimeAsync(DEBOUNCE); });
        expect(mocks.search).not.toHaveBeenCalled();
    });
});

it('命令面板組字時方向鍵與 Escape 不控制搜尋面板', async () => {
    const { view, close, submit } = render('palette');
    await start(view, '2330');
    const preventDefault = vi.fn();
    act(() => input(view).props.onKeyDown({ key: 'ArrowDown', nativeEvent: { isComposing: true }, preventDefault }));
    // Esc closes from the palette frame; an IME Esc there only cancels the composition.
    act(() => { escape(view, 'palette', { keyCode: 229, preventDefault }); });
    act(() => { escape(view, 'palette', { nativeEvent: { isComposing: true }, preventDefault }); });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
});
