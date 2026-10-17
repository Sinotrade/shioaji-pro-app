import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductSuggestion } from '../lib/product-search';

const mocks = vi.hoisted(() => ({ search: vi.fn(), prime: vi.fn() }));
vi.mock('../lib/product-search', () => ({ searchProducts: mocks.search }));
vi.mock('../lib/contracts-cache', () => ({ primeContract: mocks.prime }));
vi.mock('../lib/workspace', () => ({ BLOCK_META: { chart: { label: '圖表', description: '台積電' } } }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => undefined }));
vi.mock('../lib/stream', () => ({ getQuote: () => undefined }));
vi.mock('../lib/limit-style-prefs', () => ({ useLimitStyle: () => 'none' }));
vi.mock('./sparkline', () => ({ Sparkline: () => null }));

import { CommandPalette } from './command-palette';
import { Watchlist } from './watchlist';
import * as paletteStyles from './command-palette.css';

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
function render(kind: 'palette' | 'watchlist', withCommands = false, submitHandler: () => Promise<unknown> = async () => undefined) {
    const submit = vi.fn(submitHandler);
    const close = vi.fn();
    const addPanel = vi.fn();
    let view!: ReactTestRenderer;
    act(() => {
        view = create(kind === 'palette'
            ? createElement(CommandPalette, { open: true, onClose: close, onJump: submit, onAddPanel: withCommands ? addPanel : undefined })
            : createElement(Watchlist, {
                items: [], selectedCode: null, onSelect: vi.fn(), onAdd: submit, onRemove: vi.fn(), onReorder: vi.fn(),
                serverLists: [{ id: 'fixture', name: '測試', contracts: [] }], activeListId: 'fixture',
                onSelectList: vi.fn(), onCreateList: vi.fn(async () => undefined), onRenameList: vi.fn(async () => true),
                onDeleteList: vi.fn(async () => undefined), loading: false, structureBusy: false, loadError: false, onRetryLoad: vi.fn(),
            }));
    });
    views.push(view);
    return { view, submit, close, addPanel };
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
    mocks.search.mockReset().mockImplementation((_query: string, _limit: number, options: Pick<Session, 'signal' | 'onUpdate'>) => new Promise((resolve, reject) => {
        sessions.push({ ...options, resolve, reject });
    }));
});
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

    it('後段失敗保留可用 partial 並提供重試，不冒充空結果', async () => {
        const { view } = render(kind);
        const session = await start(view, debounce);
        act(() => session.onUpdate([stock]));
        await act(async () => session.reject(new Error('後段來源失敗')));
        expect(row(view, '2330')).toBeDefined();
        expect(text(view.root)).toContain('搜尋失敗，可重試');
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
    act(() => row(view, 'OTC 同碼股票')!.props.onMouseEnter());
    act(() => session.onUpdate([index, stock, otc]));
    expect(activeText(view)).toContain('OTC 同碼股票');
    expect(activeText(view)).not.toContain('OTC 同碼指數');
});

it('已選列被名額截掉時安全回首項', async () => {
    const { view, submit } = render('palette');
    const session = await start(view, 120);
    act(() => session.onUpdate([stock, future]));
    act(() => row(view, 'CDFR1')!.props.onMouseEnter());
    act(() => session.onUpdate([warrant, stock]));
    expect(activeText(view)).toContain('200001');
    await act(async () => input(view).props.onKeyDown({ key: 'Enter' }));
    expect(submit).toHaveBeenCalledExactlyOnceWith('200001', 'WRT');
});

it('面板命令也保留身分，不因背景商品補入而被替換', async () => {
    const { view, submit, addPanel } = render('palette', true);
    const session = await start(view, 120);
    act(() => row(view, '新增面板')!.props.onMouseEnter());
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
