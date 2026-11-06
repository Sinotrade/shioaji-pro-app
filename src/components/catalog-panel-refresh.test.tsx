import { createElement, useSyncExternalStore } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StockMeta } from '../lib/stock-index';
import type { ContractInfo } from '../lib/types/contract';

const mocks = vi.hoisted(() => ({
    catalog: vi.fn(), futures: vi.fn(), warrants: vi.fn(), resolve: vi.fn(), snapshots: vi.fn(),
    version: 0, namesVersion: 0, listeners: new Set<() => void>(), namesListeners: new Set<() => void>(), window: new EventTarget(),
    phases: [] as string[],
}));
// 記錄每次實際繪出的載入狀態，抓只閃一次 render 的空狀態
vi.mock('./async-status', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./async-status')>();
    return {
        ...actual,
        AsyncStatus: (props: Parameters<typeof actual.AsyncStatus>[0]) => {
            mocks.phases.push(props.phase);
            return createElement(actual.AsyncStatus, props);
        },
    };
});
vi.mock('../lib/stock-index', () => ({
    loadStockCatalog: mocks.catalog,
    searchStocks: (rows: StockMeta[], query: string) => rows.filter(row => row.name.includes(query) || row.code.startsWith(query)),
}));
vi.mock('../lib/product-catalog-version', () => ({
    getProductCatalogVersion: () => mocks.version,
    useProductCatalogVersion: () => useSyncExternalStore(
        (listener) => { mocks.listeners.add(listener); return () => { mocks.listeners.delete(listener); }; },
        () => mocks.version,
        () => 0,
    ),
}));
vi.mock('../hooks/use-product-names-version', () => ({
    useProductNamesVersion: () => useSyncExternalStore(
        listener => { mocks.namesListeners.add(listener); return () => { mocks.namesListeners.delete(listener); }; },
        () => mocks.namesVersion,
        () => 0,
    ),
}));
vi.mock('../lib/shioaji', () => ({
    fetchFutures: mocks.futures, fetchWarrants: mocks.warrants,
    resolveContract: mocks.resolve, fetchSnapshots: mocks.snapshots,
}));
vi.mock('../hooks/use-live-snapshots', () => ({
    useLiveSnapshots: () => ({ snapshots: new Map(), loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock('../lib/contracts-cache', () => ({ primeContract: vi.fn() }));
vi.mock('../lib/trade', () => ({ notify: vi.fn() }));

import { UnderlyingPicker } from './underlying-picker';
import { StockFuturesPanel } from './stock-futures-panel';
import { WarrantPanel } from './warrant-panel';

const stock = (code: string, name = code): StockMeta => ({ code, name, category: '', exchange: 'TSE' });
const stocks = [stock('2330', '台積電'), stock('0050', '元大台灣50')];
const contract = (code: string, security_type: 'FUT' | 'WRT' = 'FUT'): ContractInfo => ({
    code, security_type, region: 'TW', exchange: security_type === 'FUT' ? 'TAIFEX' : 'TSE',
    target_code: null, name: `${code} 合約`, currency: 'TWD', reference: 0, limit_up: 0, limit_down: 0,
    day_trade: '', update_date: '', category: '', margin_trading_balance: 0, short_selling_balance: 0,
    underlying_code: '2330', expiry_date: '2026-12-31', call_put: 'C',
});
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no; }), resolve, reject };
}
function text(node: ReactTestInstance | string): string {
    return typeof node === 'string' ? node : node.children.map(text).join('');
}
let view: ReactTestRenderer | undefined;
async function flush() { await act(async () => { await Promise.resolve(); }); }
async function invalidate() {
    await act(async () => {
        mocks.version++;
        for (const listener of [...mocks.listeners]) listener();
    });
}
async function render(kind: 'picker' | 'futures' | 'warrants', linked?: ContractInfo) {
    await act(async () => {
        view = create(kind === 'picker'
            ? createElement(UnderlyingPicker, { value: stocks[0]!, onChange: vi.fn() })
            : kind === 'futures'
                ? createElement(StockFuturesPanel, { onPick: vi.fn(), onAdd: vi.fn(), contract: linked })
                : createElement(WarrantPanel, { onPick: vi.fn(), onAdd: vi.fn() }));
    });
}
function button(label: string) {
    return view!.root.findAllByType('button').find(node => text(node).includes(label))!;
}
function star(code: string) {
    return view!.root.findAllByType('button').find(node => node.props['aria-label'] === `將 ${code} 加入自選`)!;
}
function statusLines() {
    return view!.root.findAll(node => typeof node.type === 'string' && node.props.role === 'status');
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', mocks.window);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    mocks.version = 0;
    mocks.namesVersion = 0;
    mocks.listeners.clear();
    mocks.namesListeners.clear();
    mocks.phases.length = 0;
    mocks.catalog.mockReset().mockResolvedValue(stocks);
    mocks.futures.mockReset().mockResolvedValue([contract('CCFR1')]);
    mocks.warrants.mockReset().mockResolvedValue([contract('123456', 'WRT')]);
    mocks.resolve.mockReset().mockResolvedValue(contract('2330'));
    mocks.snapshots.mockReset().mockResolvedValue([{ code: '2330', close: 100 }]);
});
afterEach(() => {
    act(() => view?.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

describe('標的目錄更新', () => {
    it('標的選擇器失敗顯示錯誤並可重試，成功空目錄不當成錯誤', async () => {
        mocks.catalog.mockRejectedValueOnce(new Error('離線')).mockResolvedValueOnce([]);
        await render('picker');
        expect(text(view!.root)).toContain('標的目錄載入失敗');
        await act(async () => button('重試').props.onClick());
        expect(text(view!.root)).not.toContain('載入失敗');
        expect(mocks.catalog).toHaveBeenCalledTimes(2);
        expect(mocks.catalog).toHaveBeenLastCalledWith({ signal: expect.any(AbortSignal) });
    });

    it('選擇器版本更新與再次開啟會重讀，不覆蓋正在輸入的文字', async () => {
        await render('picker');
        await act(async () => view!.root.findByType('input').props.onFocus());
        await act(async () => view!.root.findByType('input').props.onChange({ target: { value: '元大' } }));
        mocks.catalog.mockResolvedValue([stocks[0]!, stock('0050', '元大新名稱')]);
        await invalidate();
        expect(view!.root.findByType('input').props.value).toBe('元大');
        expect(button('0050')).toBeDefined();
        expect(text(button('0050'))).toContain('元大新名稱');
        expect(mocks.catalog).toHaveBeenCalledTimes(3);
        await flush();
        expect(mocks.catalog).toHaveBeenCalledTimes(3);
    });

    it('選擇器取消舊 reader，即使來源忽略取消也不能蓋掉新目錄', async () => {
        const old = deferred<StockMeta[]>();
        mocks.catalog.mockImplementationOnce(() => old.promise);
        await render('picker');
        const signal = mocks.catalog.mock.calls[0]![0].signal as AbortSignal;
        mocks.catalog.mockResolvedValue([stock('0050', '新版ETF')]);
        await invalidate();
        expect(signal.aborted).toBe(true);
        await act(async () => old.resolve([stock('0050', '舊版ETF')]));
        // 直接輸入開啟選單：onFocus 會再讀一次目錄，蓋過舊回應造成的錯誤
        await act(async () => view!.root.findByType('input').props.onChange({ target: { value: 'ETF' } }));
        expect(text(view!.root)).toContain('新版ETF');
        expect(text(view!.root)).not.toContain('舊版ETF');
    });

    it('新版本目錄讀到前，不用舊版本目錄提供候選', async () => {
        await render('picker');
        const pending = deferred<StockMeta[]>();
        mocks.catalog.mockImplementationOnce(() => pending.promise);
        await invalidate();
        await act(async () => view!.root.findByType('input').props.onChange({ target: { value: '台積' } }));
        expect(view!.root.findAllByType('button').filter(node => text(node).includes('2330'))).toHaveLength(0);
        await act(async () => pending.resolve(stocks));
        expect(button('2330')).toBeDefined();
    });

    it('中文組字確認 Enter 不會誤選商品，組字完成後才可選', async () => {
        await render('picker');
        const input = () => view!.root.findByType('input');
        await act(async () => input().props.onFocus());
        await act(async () => input().props.onChange({ target: { value: '台積' } }));
        const onChange = view!.root.findByType(UnderlyingPicker).props.onChange;
        act(() => input().props.onCompositionStart());
        act(() => input().props.onKeyDown({ key: 'Enter' }));
        expect(onChange).not.toHaveBeenCalled();
        act(() => input().props.onCompositionEnd());
        act(() => input().props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: true } }));
        act(() => input().props.onKeyDown({ key: 'Enter', keyCode: 229 }));
        expect(onChange).not.toHaveBeenCalled();
        act(() => input().props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: false } }));
        expect(onChange).toHaveBeenCalledExactlyOnceWith(stocks[0]);
    });

    it('blur 後立即重新取得焦點不會被舊 timer 關閉選單', async () => {
        vi.useFakeTimers();
        try {
            await render('picker');
            const input = () => view!.root.findByType('input');
            await act(async () => input().props.onFocus());
            act(() => input().props.onBlur());
            await act(async () => input().props.onFocus());
            await act(async () => { await vi.advanceTimersByTimeAsync(120); });
            expect(button('2330')).toBeDefined();
        } finally { vi.useRealTimers(); }
    });
});

describe.each([
    {
        name: '個股期面板', kind: 'futures', Panel: StockFuturesPanel, rows: () => mocks.futures, type: 'FUT',
        visibleCode: 'CCFR1', freshCode: 'NEWFR1', loadingText: '載入個股期合約…', failureText: '個股期合約載入失敗',
    },
    {
        name: '權證面板', kind: 'warrants', Panel: WarrantPanel, rows: () => mocks.warrants, type: 'WRT',
        visibleCode: '123456', freshCode: '654321', loadingText: '載入權證市場…', failureText: '權證資料載入失敗',
    },
] as const)('$name', ({ kind, Panel, rows, type, visibleCode, freshCode, loadingText, failureText }) => {
    const panelProps = () => view!.root.findByType(Panel).props;
    const firstRow = () => view!.root.findAllByType('tr')[1]!;

    it('版本更新保留使用者選擇，改用新版名稱並重讀衍生合約', async () => {
        await render(kind, kind === 'futures' ? contract('2330') : undefined);
        await act(async () => view!.root.findByType(UnderlyingPicker).props.onChange(stocks[1]));
        mocks.catalog.mockResolvedValue([stocks[0]!, stock('0050', '新版ETF')]);
        const before = rows().mock.calls.length;
        await invalidate();
        expect(view!.root.findByType(UnderlyingPicker).props.value).toMatchObject({ code: '0050', name: '新版ETF' });
        expect(rows()).toHaveBeenCalledTimes(before + 1);
        expect(kind === 'futures' ? rows().mock.lastCall?.[0].underlyingCode : rows().mock.lastCall?.[0]).toBe('0050');
        await flush();
        expect(rows()).toHaveBeenCalledTimes(before + 1);
    });

    it('重讀期間及失敗後保留最後有效表格，錯誤可重試', async () => {
        await render(kind);
        expect(text(view!.root)).toContain(visibleCode);
        const update = deferred<ContractInfo[]>();
        rows().mockImplementationOnce(() => update.promise);
        await invalidate();
        expect(text(view!.root)).toContain(visibleCode);
        expect(view!.root.findAllByType('table')).toHaveLength(1);
        await act(async () => update.reject(new Error('離線')));
        expect(text(view!.root)).toContain('保留上次資料');
        expect(view!.root.findAllByType('table')).toHaveLength(1);
        await act(async () => button('重試商品資料').props.onClick());
        expect(text(view!.root)).not.toContain('保留上次資料');
        expect(view!.root.findAllByType('table')).toHaveLength(1);
    });

    it('目錄首次讀取失敗會結束載入並顯示錯誤，重試成功後恢復表格', async () => {
        mocks.catalog.mockRejectedValue(new Error('離線'));
        await render(kind);
        expect(text(view!.root)).toContain('標的目錄載入失敗；保留上次資料');
        expect(text(view!.root)).not.toContain(loadingText);
        expect(rows()).not.toHaveBeenCalled();
        mocks.catalog.mockResolvedValue(stocks);
        await act(async () => button('重試商品資料').props.onClick());
        expect(text(view!.root)).not.toContain('保留上次資料');
        expect(star(visibleCode).props.disabled).toBe(false);
    });

    it('目錄與合約舊回應忽略取消時，也不能覆蓋新版本', async () => {
        await render(kind);
        const oldCatalog = deferred<StockMeta[]>();
        const oldContracts = deferred<ContractInfo[]>();
        mocks.catalog.mockImplementation(() => oldCatalog.promise);
        rows().mockImplementationOnce(() => oldContracts.promise);
        const before = rows().mock.calls.length;
        await invalidate();
        expect(rows()).toHaveBeenCalledTimes(before);
        expect(view!.root.findAllByType('table')).toHaveLength(1);
        expect(star(visibleCode).props.disabled).toBe(true);
        await act(async () => oldCatalog.resolve(stocks));
        expect(rows()).toHaveBeenCalledTimes(before + 1);
        const signal = rows().mock.lastCall?.[kind === 'futures' ? 1 : 2].signal as AbortSignal;
        mocks.catalog.mockResolvedValue([stock('2330', '新版名稱')]);
        rows().mockResolvedValue([contract(freshCode, type)]);
        await invalidate();
        expect(signal.aborted).toBe(true);
        await act(async () => {
            oldCatalog.resolve([stock('2330', '舊版名稱')]);
            oldContracts.resolve([contract('OLD', type)]);
        });
        expect(view!.root.findByType(UnderlyingPicker).props.value.name).toBe('新版名稱');
        expect(text(view!.root)).toContain(freshCode);
        expect(text(view!.root)).not.toContain('OLD 合約');
    });

    it('視窗取得焦點會重讀目錄與合約，重抓期間舊列仍可點選與加入自選，也不插入狀態列', async () => {
        await render(kind);
        const beforeCatalog = mocks.catalog.mock.calls.length;
        const beforeContracts = rows().mock.calls.length;
        const pending = deferred<ContractInfo[]>();
        rows().mockImplementationOnce(() => pending.promise);
        await act(async () => { mocks.window.dispatchEvent(new Event('focus')); });
        expect(mocks.catalog).toHaveBeenCalledTimes(beforeCatalog + 2);
        expect(rows()).toHaveBeenCalledTimes(beforeContracts + 1);
        panelProps().onAdd.mockResolvedValue(undefined);
        expect(star(visibleCode).props.disabled).toBe(false);
        expect(statusLines()).toHaveLength(0);
        expect(text(view!.root)).toContain(kind === 'futures' ? '1 口合約可選' : '1 檔發行中');
        expect(text(view!.root)).not.toContain('更新完成後可選取');
        act(() => firstRow().props.onClick());
        expect(panelProps().onPick).toHaveBeenCalledExactlyOnceWith(visibleCode);
        await act(async () => star(visibleCode).props.onClick({ stopPropagation: vi.fn() }));
        expect(panelProps().onAdd).toHaveBeenCalledOnce();
        await act(async () => pending.resolve([contract(visibleCode, type)]));
        expect(star(visibleCode).props.disabled).toBe(false);
        await flush();
        expect(rows()).toHaveBeenCalledTimes(beforeContracts + 1);
    });

    it('新目錄完成後，新合約未成功前仍不可選取舊表格', async () => {
        await render(kind);
        const pending = deferred<ContractInfo[]>();
        rows().mockImplementationOnce(() => pending.promise);
        await invalidate();
        const onPick = panelProps().onPick;
        expect(star(visibleCode).props.disabled).toBe(true);
        // 鎖表提示併入摘要列，不另插狀態列；個股期不把鎖住的列算成可選
        expect(statusLines()).toHaveLength(0);
        expect(text(view!.root)).toContain('更新完成後可選取');
        expect(text(view!.root)).not.toContain('口合約可選');
        act(() => firstRow().props.onClick());
        expect(onPick).not.toHaveBeenCalled();
        await act(async () => pending.reject(new Error('新目錄合約讀取失敗')));
        expect(star(visibleCode).props.disabled).toBe(true);
        act(() => firstRow().props.onClick());
        expect(onPick).not.toHaveBeenCalled();
        await act(async () => button('重試商品資料').props.onClick());
        expect(star(visibleCode).props.disabled).toBe(false);
        expect(text(view!.root)).not.toContain('更新完成後可選取');
        if (kind === 'futures') expect(text(view!.root)).toContain('1 口合約可選');
    });

    it('換標的載入期間，摘要、表格與現貨價都屬於新標的，也不先閃空狀態', async () => {
        await render(kind);
        expect(text(view!.root)).toContain(visibleCode);
        if (kind === 'warrants') expect(text(view!.root)).toContain('現貨 100.00');
        const pending = deferred<ContractInfo[]>();
        rows().mockImplementationOnce(() => pending.promise);
        mocks.phases.length = 0;
        await act(async () => view!.root.findByType(UnderlyingPicker).props.onChange(stocks[1]));
        expect(text(view!.root)).toContain('0050 元大台灣50');
        expect(view!.root.findAllByType('table')).toHaveLength(0);
        expect(text(view!.root)).not.toContain(visibleCode);
        expect(text(view!.root)).toContain(loadingText);
        expect(new Set(mocks.phases)).toEqual(new Set(['loading']));
        if (kind === 'warrants') expect(text(view!.root)).not.toContain('現貨 100.00');
        await act(async () => pending.resolve([contract(freshCode, type)]));
        expect(text(view!.root)).toContain(freshCode);
        expect(star(freshCode).props.disabled).toBe(false);
    });

    it('換標的抓取失敗時，不留上一檔的表格與現貨價', async () => {
        await render(kind);
        rows().mockRejectedValueOnce(new Error('離線'));
        await act(async () => view!.root.findByType(UnderlyingPicker).props.onChange(stocks[1]));
        expect(text(view!.root)).toContain('0050 元大台灣50');
        expect(view!.root.findAllByType('table')).toHaveLength(0);
        expect(text(view!.root)).not.toContain(visibleCode);
        expect(text(view!.root)).toContain(failureText);
        if (kind === 'warrants') expect(text(view!.root)).not.toContain('現貨 100.00');
    });

    it('成功空目錄會結束載入，不會無限等待標的', async () => {
        mocks.catalog.mockResolvedValue([]);
        await render(kind);
        expect(text(view!.root)).not.toContain(loadingText);
        expect(rows()).not.toHaveBeenCalled();
    });

    it('ETF 名稱版本只重組名稱，不重抓同代碼衍生合約且保持可操作', async () => {
        await render(kind);
        await act(async () => view!.root.findByType(UnderlyingPicker).props.onChange(stocks[1]));
        const before = rows().mock.calls.length;
        mocks.catalog.mockResolvedValue([stocks[0]!, stock('0050', 'ETF更新名稱')]);
        await act(async () => {
            mocks.namesVersion++;
            for (const listener of [...mocks.namesListeners]) listener();
        });
        expect(view!.root.findByType(UnderlyingPicker).props.value).toMatchObject({ code: '0050', name: 'ETF更新名稱' });
        expect(rows()).toHaveBeenCalledTimes(before);
        expect(star(visibleCode).props.disabled).toBe(false);
        await flush();
        expect(rows()).toHaveBeenCalledTimes(before);
    });

    it('版本通知尚未完成 React 重繪前，舊事件 handler 也不可選或新增', async () => {
        await render(kind);
        const row = firstRow();
        const add = star(visibleCode);
        const props = panelProps();
        mocks.version++;
        act(() => {
            row.props.onClick();
            add.props.onClick({ stopPropagation: vi.fn() });
        });
        expect(props.onPick).not.toHaveBeenCalled();
        expect(props.onAdd).not.toHaveBeenCalled();
    });
});
