// #204 K 線圖下單設定：工具列一顆按鈕（數量＋單位）、彈出面板只列適用選項、
// 點價與停損停利實際使用這組設定（帳號、單位、數量、委託、開平倉）
import { createElement, useState } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';

vi.mock('react-dom', () => ({ createPortal: (children: unknown) => children }));

vi.hoisted(() => {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k), key: () => null, length: 0 };
    (globalThis as any).window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, location: { search: '', href: 'http://x/' } });
    (globalThis as any).document = { addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, getContext: () => null }), body: {} };
});
const m = vi.hoisted(() => ({
    place: vi.fn(), addTrigger: vi.fn(), notify: vi.fn(), creditPost: vi.fn(),
    click: [] as ((p: unknown) => void)[],
    accounts: [] as Account[],
    roundClose: 100 as number | null,
    oddClose: 100 as number | null,
    drawingBusy: false,
    skipDisarm: false,
    skipInvalidate: false,
    updatePrice: vi.fn(),
    dragEvents: false,
    dragHost: null as EventTarget | null,
    lines: [] as { options: () => { price: number }; applyOptions: (p: { price: number }) => void }[],
}));
vi.mock('../hooks/use-chart-drawings', async (importOriginal) => {
    const real = await importOriginal<typeof import('../hooks/use-chart-drawings')>();
    return { ...real, useChartDrawings: (...args: Parameters<typeof real.useChartDrawings>) => {
        const api = real.useChartDrawings({ ...args[0], onEnterDrawingMode: () => {
            if (!m.skipDisarm) args[0].onEnterDrawingMode();
        }, onInvalidateInteraction: () => !m.skipInvalidate && (args[0].onInvalidateInteraction?.() ?? false) });
        return { ...api, drawingBusy: () => m.drawingBusy || api.drawingBusy() };
    } };
});
vi.mock('../lib/trade', () => ({ notify: m.notify, placeQuickOrder: m.place }));
vi.mock('../lib/api', async (importOriginal) => ({ ...await importOriginal<typeof import('../lib/api')>(), apiPost: m.creditPost }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: async () => {}, updateOrderPrice: m.updatePrice }));
vi.mock('../lib/trigger-engine', () => ({ addTrigger: m.addTrigger, removeTrigger: vi.fn(), useTriggers: () => [] }));
vi.mock('../lib/account-store', () => ({ ensureAccounts: () => undefined,
    useAccounts: () => ({ loaded: true, accounts: m.accounts, selectedStock: m.accounts[0], selectedFutures: m.accounts[2] }) }));
vi.mock('../hooks/use-stream', () => ({ useQuote: (code: string | null, o?: { oddLot?: boolean }) => {
    if (!code) return undefined;
    const close = o?.oddLot ? m.oddClose : m.roundClose;
    return close === null ? undefined : { tick: { code, date: '2026/09/30', time: '11:00:00', close, volume: 1 }, seq: 1, lastDir: 0, flashSeq: 0 };
} }));
vi.mock('../lib/chart-history', () => ({ fetchChartHistory: async () => ({ candles: [], exhausted: true }), nextChartHistoryRevision: () => 1 }));
vi.mock('lightweight-charts', async () => {
    const h = await import('./chart-session.test-harness');
    const base = h.lwMock();
    const chart = () => {
        const inner = h.makeChart();
        return new Proxy({}, { get: (_t, p) => {
            if (p === 'subscribeClick') return (cb: (p: unknown) => void) => { m.click.push(cb); };
            if (p === 'addSeries') return (type: { kind: string }) => {
                const s = h.makeSeries(type.kind);
                return new Proxy(s, { get: (t, q) => {
                    if (q === 'coordinateToPrice') return (y: number) => m.dragEvents ? y : 100;
                    if (q === 'priceToCoordinate' && m.dragEvents) return (p: number) => p;
                    if (q === 'createPriceLine' && m.dragEvents) return (options: { price: number }) => {
                        const opts = { ...options };
                        const line = { options: () => opts, applyOptions: (p: { price: number }) => Object.assign(opts, p) };
                        m.lines.push(line);
                        return line;
                    };
                    return t[q as keyof typeof t];
                } });
            };
            return inner[p];
        } });
    };
    return { ...base, createChart: chart };
});

import { CandleChart } from './candle-chart';
import { ChartDrawingTools, ChartDrawingOverlays, ChartObjectList, DrawingSettingsDialog, Popover, TextEditor } from './chart-drawing-tools';
import { __resetDrawingsForTest, addDrawing, DEFAULT_DRAWING_STYLE, DRAWING_TOOL_DEFS } from '../lib/chart-drawings';
import type { ChartDrawingsApi } from '../hooks/use-chart-drawings';
import { loadOrderLotPreference, saveOrderLotPreference, QUICK_ORDER_LOTS } from '../lib/order-lot-preference';
import type { ChartOrderPanelState } from '../lib/chart-order-settings';
import { resetCreditEnquireCache } from '../lib/credit-eligibility';

const S1 = { account_type: 'S', broker_id: 'B', account_id: '1111121', signed: true, person_id: '', username: '' } as Account;
const S2 = { ...S1, account_id: '2222207' } as Account;
const F1 = { ...S1, account_type: 'F', account_id: '3333307' } as Account;
const stk = { code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', target_code: null, reference: 100, limit_up: 110, limit_down: 90 } as any;
const fut = { code: 'TXFR1', name: '臺股期貨', security_type: 'FUT', exchange: 'TAIFEX', target_code: 'TXFJ6', reference: 100 } as any;
const text = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : text(c))).join('');
let view!: ReactTestRenderer;
const chip = () => view.root.findAll(n => n.type === 'button' && String(n.props['aria-label'] ?? '').startsWith('圖表下單設定'))[0]!;
const pop = () => view.root.findAll(n => n.props.role === 'dialog')[0];
const button = (root: ReactTestInstance, label: string) => root.findAll(n => n.type === 'button' && text(n) === label)[0]!;
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => {}); };
async function mount(props: Record<string, unknown>) {
    await act(async () => {
        view = create(createElement(CandleChart, props as any), { createNodeMock: () => {
            const events = new EventTarget();
            const node = { clientWidth: 800, clientHeight: 400, getBoundingClientRect: () => ({ width: 800, height: 400, left: 0, top: 0 }),
                addEventListener: (name: string, cb: EventListener, capture?: boolean) => {
                    if (!m.dragEvents) return;
                    if (name === 'mousedown') m.dragHost = events;
                    events.addEventListener(name, cb, capture);
                },
                removeEventListener: events.removeEventListener.bind(events), contains: () => true, hasAttribute: () => true,
                focus: () => { if (m.dragEvents) (document as any).activeElement = node; }, style: {} };
            return node;
        } });
    });
    await flush();
}
const clickChart = async () => { await act(async () => { m.click.at(-1)!({ point: { x: 10, y: 10 } }); }); await flush(); };
// react-test-renderer 不派送 DOM 事件；沿實際 host ancestry 執行 capture，
// 再執行子按鈕事件，保留 stopPropagation 無法阻擋 capture 的時序。
function capture(target: ReactTestInstance, kind: 'PointerDown' | 'KeyDown') {
    const path: ReactTestInstance[] = [];
    for (let n: ReactTestInstance | null = target; n; n = n.parent) path.unshift(n);
    for (const n of path) if (typeof n.type === 'string') n.props[`on${kind}Capture`]?.({});
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('requestAnimationFrame', (cb: any) => setTimeout(cb, 0));
    vi.stubGlobal('cancelAnimationFrame', (id: any) => clearTimeout(id));
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    m.place.mockReset().mockResolvedValue({ status: { status: 'PendingSubmit' } });
    m.addTrigger.mockReset().mockResolvedValue(null);
    m.notify.mockReset();
    m.creditPost.mockReset().mockResolvedValue([{ stock_id: '2330', system: 'ALL', update_time: '', margin_unit: 100, short_unit: 50, margin_loan_ratio: 60, short_margin_ratio: 90 }]);
    resetCreditEnquireCache();
    m.click.length = 0;
    m.accounts = [S1, S2, F1];
    m.roundClose = 100; m.oddClose = 100;
    m.drawingBusy = false;
    m.skipDisarm = false;
    m.skipInvalidate = false;
    m.dragEvents = false; m.dragHost = null; m.lines.length = 0;
    m.updatePrice.mockReset().mockResolvedValue(undefined);
    __resetDrawingsForTest();
    (globalThis as any).localStorage.setItem('sj-pro-chart-order-defaults', '{}');
    (globalThis as any).localStorage.setItem('sj-pro-order-lot-preferences', '{}');
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

it.each(['symbol', 'switch back', 'unit', 'account', 'unmount'])(
    'refuses a pending chart order at dispatch after %s changes', async change => {
        let release!: () => void;
        const wait = new Promise<void>(r => { release = r; });
        const dispatched = vi.fn();
        m.place.mockImplementation(async (_c, _s, _p, _q, opts) => {
            await wait;
            opts.beforeSend();
            dispatched();
            return { status: { status: 'Submitted' } };
        });
        const props = { contract: stk };
        await mount(props);
        await act(async () => { button(view.root, '點價買').props.onClick(); });
        await clickChart();
        expect(m.place).toHaveBeenCalledOnce();
        if (change === 'unmount') await act(async () => view.unmount());
        else if (change === 'unit') {
            await act(async () => { chip().props.onClick(); });
            await act(async () => { button(pop()!, '盤中零股（股）').props.onClick(); });
        } else if (change === 'account') {
            m.accounts = [S2, S1, F1];
            await act(async () => { view.update(createElement(CandleChart, props)); });
        } else {
            await act(async () => { view.update(createElement(CandleChart, { contract: { ...stk, code: '2317' } })); });
            if (change === 'switch back') await act(async () => { view.update(createElement(CandleChart, props)); });
        }
        await act(async () => { release(); });
        await flush();
        expect(dispatched).not.toHaveBeenCalled();
        expect(m.notify.mock.calls.at(-1)![0]).toMatchObject({ title: '圖表下單失敗' });
    },
);

describe('chart order settings button', () => {
    const drawingApi = () => view.root.findByType(ChartDrawingTools).props.api as ChartDrawingsApi;

    async function orderDrag() {
        m.dragEvents = true;
        const windowEvents = new EventTarget();
        const documentEvents = new EventTarget();
        const upHandlers: EventListener[] = [];
        const saved = { wa: window.addEventListener, wr: window.removeEventListener, da: document.addEventListener, dr: document.removeEventListener, active: document.activeElement, hidden: document.hidden };
        window.addEventListener = windowEvents.addEventListener.bind(windowEvents);
        window.removeEventListener = windowEvents.removeEventListener.bind(windowEvents);
        document.addEventListener = ((name: string, handler: EventListener, options?: boolean) => {
            if (name === 'mouseup') upHandlers.push(handler);
            documentEvents.addEventListener(name, handler, options);
        }) as typeof document.addEventListener;
        document.removeEventListener = documentEvents.removeEventListener.bind(documentEvents);
        onTestFinished(() => {
            window.addEventListener = saved.wa; window.removeEventListener = saved.wr;
            document.addEventListener = saved.da; document.removeEventListener = saved.dr;
            (document as any).activeElement = saved.active;
            (document as any).hidden = saved.hidden;
        });
        const trade = { contract: stk, order: { id: 'drag-order', action: 'Buy', price: 100, quantity: 1 },
            status: { status: 'Submitted', deal_quantity: 0, cancel_quantity: 0, modified_price: 0 } };
        await mount({ contract: stk, trades: [trade] });
        const mouse = (type: string, y: number) => Object.assign(new Event(type, { cancelable: true }), { button: 0, clientX: 790, clientY: y });
        const line = m.lines.find(l => l.options().price === 100)!;
        expect(line).toBeDefined();
        const start = async () => {
            await act(async () => { m.dragHost!.dispatchEvent(mouse('mousedown', 100)); });
            await act(async () => { documentEvents.dispatchEvent(mouse('mousemove', 105)); });
            expect(line.options().price).toBe(105);
        };
        const release = () => act(async () => { documentEvents.dispatchEvent(mouse('mouseup', 105)); });
        const key = (k: Record<string, unknown>) => {
            const e = Object.assign(new Event('keydown', { cancelable: true }), k);
            windowEvents.dispatchEvent(e);
            return e;
        };
        return { line, start, release, key, windowEvents, documentEvents, trade, upHandlers };
    }

    it('委託線正常拖曳放開只送出一次改價', async () => {
        const drag = await orderDrag();
        await drag.start(); await drag.release(); await drag.release();
        expect(m.updatePrice).toHaveBeenCalledExactlyOnceWith('drag-order', 105);
    });

    it.each([
        ...DRAWING_TOOL_DEFS.filter(d => d.shortcut).map(d => `Alt+${d.shortcut}`),
        'Ctrl+Z', 'Ctrl+Shift+Z', 'Ctrl+Y', 'Delete', 'Backspace',
        '工具按鈕', '游標按鈕', 'Esc', 'blur', 'pointercancel', 'pagehide', 'hidden', '換商品', '換週期',
        'UI PointerDown', 'UI KeyDown', 'API', 'undo', 'redo',
    ])('委託線拖曳中%s使拖曳作廢並立即恢復原價，遲到放開不改價', async (entry) => {
        const drag = await orderDrag();
        await drag.start();
        const sequence = drawingApi().interactionSequence();
        await act(async () => {
            if (entry.startsWith('Alt+')) drag.key({ key: entry.at(-1)!.toLowerCase(), code: `Key${entry.at(-1)}`, altKey: true });
            else if (entry.startsWith('Ctrl+')) drag.key({ key: entry.at(-1)!.toLowerCase(), code: `Key${entry.at(-1)}`, ctrlKey: true, shiftKey: entry.includes('Shift') });
            else if (entry === 'Delete' || entry === 'Backspace') drag.key({ key: entry });
            else if (entry === 'Esc') drag.key({ key: 'Escape' });
            else if (entry === 'blur') drag.windowEvents.dispatchEvent(new Event('blur'));
            else if (entry === 'pointercancel') drag.documentEvents.dispatchEvent(new Event('pointercancel'));
            else if (entry === 'pagehide') drag.windowEvents.dispatchEvent(new Event('pagehide'));
            else if (entry === 'hidden') { Object.assign(document, { hidden: true }); drag.documentEvents.dispatchEvent(new Event('visibilitychange')); }
            else if (entry === '換商品') view.update(createElement(CandleChart, { contract: { ...stk, code: '2317' }, trades: [drag.trade] } as any));
            else if (entry === '換週期') button(view.root, '1m').props.onClick();
            else if (entry.startsWith('UI ')) {
                const target = view.root.findByType(ChartDrawingTools).findAllByType('button')[0]!;
                capture(target, entry === 'UI PointerDown' ? 'PointerDown' : 'KeyDown');
            } else if (entry === '工具按鈕') view.root.findByType(ChartDrawingTools).findAllByType('button')[1]!.props.onClick();
            else if (entry === '游標按鈕') view.root.findAllByProps({ 'aria-label': '游標' }).find(n => n.type === 'button')!.props.onClick();
            else if (entry === 'undo') drawingApi().undo();
            else if (entry === 'redo') drawingApi().redo();
            else drawingApi().setMagnet(true);
        });
        expect(drawingApi().interactionSequence()).toBeGreaterThan(sequence);
        expect(drag.line.options().price).toBe(100);
        await drag.release();
        expect(m.updatePrice).not.toHaveBeenCalled();
    });

    it('取消回呼遺漏時，放開仍核對畫圖序號並還原原價', async () => {
        const drag = await orderDrag();
        await drag.start();
        m.skipInvalidate = true;
        await act(async () => drawingApi().setMagnet(true));
        expect(drag.line.options().price).toBe(105);
        await drag.release();
        expect(drag.line.options().price).toBe(100);
        expect(m.updatePrice).not.toHaveBeenCalled();
    });

    it('舊拖曳的延遲 mouseup 不影響新拖曳，也不送出舊改價', async () => {
        const drag = await orderDrag();
        await drag.start();
        const lateUp = drag.upHandlers.at(-1)!;
        await act(async () => drawingApi().onInteraction());
        expect(drag.line.options().price).toBe(100);
        await drag.start();
        await act(async () => { lateUp(new Event('mouseup')); });
        expect(drag.line.options().price).toBe(105);
        expect(m.updatePrice).not.toHaveBeenCalled();
        await drag.release();
        expect(m.updatePrice).toHaveBeenCalledExactlyOnceWith('drag-order', 105);
    });

    it.each(DRAWING_TOOL_DEFS.map(d => d.tool))('委託線拖曳中切換 %s 工具，立即還原且不改價', async tool => {
        const drag = await orderDrag();
        await drag.start();
        await act(async () => drawingApi().setTool(tool));
        expect(drag.line.options().price).toBe(100);
        await drag.release();
        expect(m.updatePrice).not.toHaveBeenCalled();
    });

    it('卸載圖表取消委託線拖曳，排隊的舊 mouseup 不送改價', async () => {
        const drag = await orderDrag();
        await drag.start();
        const lateUp = drag.upHandlers.at(-1)!;
        await act(async () => view.unmount());
        expect(drag.line.options().price).toBe(100);
        await act(async () => { lateUp(new Event('mouseup')); });
        expect(m.updatePrice).not.toHaveBeenCalled();
    });

    it('彈出畫圖選單的原生 Esc 即使先於 UI capture，也取消委託線拖曳', async () => {
        const drag = await orderDrag();
        const onClose = vi.fn();
        let ui!: ReactTestRenderer;
        await act(async () => { ui = create(createElement(Popover, { anchor: null, label: '工具選單', onClose,
            onInteraction: drawingApi().onInteraction, children: createElement('button', {}, '工具') })); });
        try {
            await drag.start();
            await act(async () => { drag.key({ key: 'Escape' }); });
            expect(onClose).toHaveBeenCalled();
            expect(drag.line.options().price).toBe(100);
            await drag.release();
            expect(m.updatePrice).not.toHaveBeenCalled();
        } finally { await act(async () => ui.unmount()); }
    });

    it('畫圖鍵盤 listener 先註冊時，取消委託拖曳的 Esc 仍被吃掉，不流入 Esc×2 刪單', async () => {
        const drag = await orderDrag();
        await act(async () => drawingApi().setTool('horizontal'));
        await act(async () => drawingApi().setTool(null));
        await drag.start();
        let escape!: Event;
        await act(async () => { escape = drag.key({ key: 'Escape' }); });
        expect(escape.defaultPrevented).toBe(true);
        expect(drag.line.options().price).toBe(100);
        await drag.release();
        expect(m.updatePrice).not.toHaveBeenCalled();
    });

    it.each(['工具列', '物件列表', '浮動工具列', '文字編輯框', '設定對話框', '彈出工具選單']
        .flatMap(surface => (['PointerDown', 'KeyDown'] as const).map(kind => [surface, kind] as const)))
    ('委託線拖曳中%s的%s同步還原原價並取消改價', async (surface, kind) => {
        const drag = await orderDrag();
        let drawing!: NonNullable<ReturnType<typeof addDrawing>>;
        await act(async () => { drawing = addDrawing('2330', 'text', [{ time: 1, price: 100 }], DEFAULT_DRAWING_STYLE, { text: '原文' })!; });
        if (surface === '物件列表') await act(async () => drawingApi().setObjectListOpen(true));
        const api = drawingApi();
        const overlayApi = { ...api, selected: drawing, selectedList: [drawing], selectedIds: [drawing.id], selectionBox: { left: 10, top: 10, right: 50, bottom: 50 }, hostSize: { width: 800, height: 400 } };
        let ui: ReactTestRenderer | undefined;
        if (!['工具列', '物件列表'].includes(surface)) await act(async () => {
            ui = create(surface === '浮動工具列' ? createElement(ChartDrawingOverlays, { api: overlayApi })
                : surface === '文字編輯框' ? createElement(TextEditor, { initial: '原文', box: { left: 0, top: 0 }, onCommit: api.commitText, onInteraction: api.onInteraction })
                : surface === '設定對話框' ? createElement(DrawingSettingsDialog, { api, drawing, onClose: vi.fn() })
                : createElement(Popover, { anchor: null, label: '工具選單', onClose: vi.fn(), onInteraction: api.onInteraction, children: createElement('button', {}, '工具') }));
        });
        try {
            await drag.start();
            const root = surface === '工具列' ? view.root.findByType(ChartDrawingTools)
                : surface === '物件列表' ? view.root.findByType(ChartObjectList) : ui!.root;
            const target = surface === '文字編輯框' ? root.findByType('textarea') : root.findAllByType('button')[0]!;
            await act(async () => capture(target, kind));
            expect(drag.line.options().price).toBe(100);
            await drag.release();
            expect(m.updatePrice).not.toHaveBeenCalled();
        } finally { if (ui) await act(async () => ui!.unmount()); }
    });

    it.each(['點價買', '點價賣'].flatMap(side => ['隱藏', '顯示', '鎖定', '解鎖', '刪除', '收起物件列表', '清除全部'].map(action => [side, action])))
    ('武裝%s後操作%s，capture 先解除武裝且後續空白點擊不下單', async (side, action) => {
        await mount({ contract: stk });
        let id!: string;
        await act(async () => { id = addDrawing('2330', 'horizontal', [{ time: 1, price: 100 }], DEFAULT_DRAWING_STYLE)!.id; });
        if (action === '顯示') await act(async () => drawingApi().setHidden(id, true));
        if (action === '解鎖') await act(async () => drawingApi().setLocked(id, true));
        await act(async () => drawingApi().setObjectListOpen(true));
        await act(async () => button(view.root, side!).props.onClick());
        const target = view.root.findAll(n => n.type === 'button' && String(n.props['aria-label'] ?? '').startsWith(action!))[0]!;
        expect(target).toBeDefined();
        await act(async () => {
            capture(target, 'PointerDown');
            // capture 本身已封住同步到達的 chart click，尚未執行子操作。
            m.click.at(-1)!({ point: { x: 10, y: 10 } });
            target.props.onClick({ stopPropagation() {} });
        });
        await clickChart();
        expect(m.place).not.toHaveBeenCalled();
        await act(async () => button(view.root, side!).props.onClick());
        await clickChart();
        expect(m.place).toHaveBeenCalledTimes(1); // 新武裝可正常下單
    });

    it.each(['PointerDown', 'KeyDown'] as const)('武裝後設定對話框的%s即使沒有改物件，也使後續空白點擊不下單', async (kind) => {
        await mount({ contract: stk });
        let drawing!: NonNullable<ReturnType<typeof addDrawing>>;
        await act(async () => { drawing = addDrawing('2330', 'horizontal', [{ time: 1, price: 100 }], DEFAULT_DRAWING_STYLE)!; });
        let dialog!: ReactTestRenderer;
        await act(async () => { dialog = create(createElement(DrawingSettingsDialog, { api: drawingApi(), drawing, onClose: vi.fn() })); });
        try {
            await act(async () => button(view.root, '點價買').props.onClick());
            const target = dialog.root.findAllByProps({ role: 'tab' })[0]!;
            await act(async () => capture(target, kind));
            await clickChart();
            expect(m.place).not.toHaveBeenCalled();
        } finally { await act(async () => dialog.unmount()); }
    });

    it.each([false, true])('畫圖 API 操作即使未經 UI capture，也使本次武裝失效（模式解除遺漏=%s）', async (skipDisarm) => {
        await mount({ contract: stk });
        let id!: string;
        await act(async () => { id = addDrawing('2330', 'horizontal', [{ time: 1, price: 100 }], DEFAULT_DRAWING_STYLE)!.id; });
        await act(async () => button(view.root, '點價買').props.onClick());
        m.skipDisarm = skipDisarm;
        await act(async () => {
            drawingApi().setHidden(id, true);
            m.click.at(-1)!({ point: { x: 10, y: 10 } });
        });
        await clickChart();
        expect(m.place).not.toHaveBeenCalled();
    });

    it.each(['浮動工具列', '文字編輯框', '彈出工具選單'].flatMap(surface => (['PointerDown', 'KeyDown'] as const).map(kind => [surface, kind] as const)))
    ('武裝後%s的%s先使武裝失效', async (surface, kind) => {
        await mount({ contract: stk });
        let drawing!: NonNullable<ReturnType<typeof addDrawing>>;
        await act(async () => { drawing = addDrawing('2330', 'text', [{ time: 1, price: 100 }], DEFAULT_DRAWING_STYLE, { text: '註記' })!; });
        const api = drawingApi();
        const overlayApi = { ...api, selected: drawing, selectedList: [drawing], selectedIds: [drawing.id], selectionBox: { left: 10, top: 10, right: 50, bottom: 50 }, hostSize: { width: 800, height: 400 } };
        let ui!: ReactTestRenderer;
        await act(async () => {
            ui = create(surface === '浮動工具列' ? createElement(ChartDrawingOverlays, { api: overlayApi })
                : surface === '文字編輯框' ? createElement(TextEditor, { initial: '註記', box: { left: 0, top: 0 }, onCommit: api.commitText, onInteraction: api.onInteraction })
                : createElement(Popover, { anchor: null, label: '工具選單', onClose: vi.fn(), onInteraction: api.onInteraction, children: createElement('button', {}, '工具') }));
        });
        try {
            await act(async () => button(view.root, '點價賣').props.onClick());
            const target = surface === '文字編輯框' ? ui.root.findByType('textarea') : ui.root.findAllByType('button')[0]!;
            await act(async () => capture(target, kind));
            await clickChart();
            expect(m.place).not.toHaveBeenCalled();
        } finally { await act(async () => ui.unmount()); }
    });

    it.each([
        { key: 'h', code: 'KeyH', altKey: true },
        { key: 'z', code: 'KeyZ', ctrlKey: true },
        { key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey: true },
        { key: 'y', code: 'KeyY', ctrlKey: true },
        { key: 'Delete' }, { key: 'Backspace' }, { key: 'Escape' },
    ])('畫圖快捷鍵 $key（$code）後空白點擊不下單', async (key) => {
        const events = new EventTarget();
        const w = window as any;
        const saved = { add: w.addEventListener, remove: w.removeEventListener, active: document.activeElement };
        w.addEventListener = events.addEventListener.bind(events);
        w.removeEventListener = events.removeEventListener.bind(events);
        (document as any).activeElement = {};
        onTestFinished(() => { w.addEventListener = saved.add; w.removeEventListener = saved.remove; (document as any).activeElement = saved.active; });
        await mount({ contract: stk });
        await act(async () => drawingApi().setTool('horizontal')); // 鍵盤歸此圖
        await act(async () => button(view.root, '點價買').props.onClick());
        const sequence = drawingApi().interactionSequence();
        await act(async () => { events.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), key)); });
        expect(drawingApi().interactionSequence()).toBeGreaterThan(sequence);
        await clickChart();
        expect(m.place).not.toHaveBeenCalled();
    });

    it.each(['設定對話框', '彈出工具選單'])('%s的原生 Esc 關閉早於 UI capture，後續空白點擊仍不下單', async (surface) => {
        const events = new EventTarget();
        const w = window as any;
        const saved = { add: w.addEventListener, remove: w.removeEventListener };
        w.addEventListener = events.addEventListener.bind(events);
        w.removeEventListener = events.removeEventListener.bind(events);
        onTestFinished(() => { w.addEventListener = saved.add; w.removeEventListener = saved.remove; });
        await mount({ contract: stk });
        let drawing!: NonNullable<ReturnType<typeof addDrawing>>;
        await act(async () => { drawing = addDrawing('2330', 'horizontal', [{ time: 1, price: 100 }], DEFAULT_DRAWING_STYLE)!; });
        let ui!: ReactTestRenderer;
        const onClose = vi.fn(() => ui.unmount());
        await act(async () => {
            ui = create(surface === '設定對話框' ? createElement(DrawingSettingsDialog, { api: drawingApi(), drawing, onClose })
                : createElement(Popover, { anchor: null, label: '工具選單', onClose, onInteraction: drawingApi().onInteraction, children: null }));
        });
        try {
            await act(async () => button(view.root, '點價買').props.onClick());
            await act(async () => { events.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' })); });
            expect(onClose).toHaveBeenCalledOnce();
            await clickChart();
            expect(m.place).not.toHaveBeenCalled();
        } finally { await act(async () => ui.unmount()); }
    });

    it.each(['點價買', '點價賣'])('武裝%s後物件列表選取，同一事件圖表 click 不會呼叫 placeQuickOrder', async (side) => {
        await mount({ contract: stk });
        let id!: string;
        await act(async () => { id = addDrawing('2330', 'horizontal', [{ time: 1, price: 100 }], DEFAULT_DRAWING_STYLE)!.id; });
        await act(async () => drawingApi().setObjectListOpen(true));
        await act(async () => button(view.root, side).props.onClick());
        const row = view.root.findByType(ChartObjectList).findByProps({ role: 'option' });
        await act(async () => {
            row.props.onClick({ shiftKey: false });
            m.click.at(-1)!({ point: { x: 10, y: 10 } });
        });
        expect(drawingApi().selected?.id).toBe(id);
        expect(m.place).not.toHaveBeenCalled();
        await clickChart();
        expect(m.place).not.toHaveBeenCalled();
    });

    it.each(['點價買', '點價賣'])('武裝%s時若畫圖仍忙碌，即使入口漏解除交易，click 防線也擋住快速下單', async (side) => {
        await mount({ contract: stk });
        await act(async () => button(view.root, side).props.onClick());
        m.drawingBusy = true;
        await clickChart();
        expect(m.place).not.toHaveBeenCalled();
        m.drawingBusy = false;
        await clickChart();
        expect(m.place).toHaveBeenCalledTimes(1); // 確認測試確實走到可下單路徑
    });

    it('replaces the 量 input and 零股 toggle with one chip that shows only quantity and unit', async () => {
        await mount({ contract: stk });
        expect(text(chip())).toBe('1 張');
        expect(view.root.findAll(n => n.type === 'button' && text(n) === '零股')).toHaveLength(0);
        expect(view.root.findAll(n => n.type === 'input' && String(n.props['aria-label']).startsWith('圖表下單數量'))).toHaveLength(0);
        expect(String(chip().props.title)).toContain('點價買／賣以 ROD 限價送出 1 張');
    });

    it.each([false, true])('按商品恢復單位，換單位不把 500 股變成張數（受控=%s）', async controlled => {
        function Chart({ contract }: { contract: typeof stk }) {
            const [settings, setSettings] = useState<ChartOrderPanelState>({});
            return createElement(CandleChart, { contract, ...(controlled ? {
                orderSettings: { ...settings, ...(settings.S ? { S: { ...settings.S } } : {}) },
                onOrderSettingsChange: setSettings,
            } : {}) });
        }
        await mount({ contract: stk });
        await act(async () => view.update(createElement(Chart, { contract: stk })));
        await flush();
        await act(async () => chip().props.onClick());
        await act(async () => button(pop()!, '盤中零股（股）').props.onClick());
        await act(async () => button(pop()!, '500').props.onClick());
        expect(text(chip())).toBe('500 股');
        const other = { ...stk, code: '2317', name: '鴻海' };
        await act(async () => view.update(createElement(Chart, { contract: other })));
        await flush();
        expect(text(chip())).toBe('1 張');
        // 受控設定經序列化或父元件重建後，舊市場值也不能蓋回商品單位。
        await act(async () => view.update(createElement(Chart, { contract: { ...other } })));
        expect(text(chip())).toBe('1 張');
        await act(async () => button(pop()!, '整股（張）').props.onClick());
        await act(async () => view.update(createElement(Chart, { contract: stk })));
        await flush();
        expect(text(chip())).toBe('1 股');
        await act(async () => button(view.root, '點價買').props.onClick());
        await clickChart();
        expect(m.place.mock.calls.at(-1)!.slice(1, 4)).toEqual(['Buy', 100, 1]);
        expect(m.place.mock.calls.at(-1)![4]).toMatchObject({ orderLot: 'IntradayOdd' });
        await act(async () => button(pop()!, '500').props.onClick());
        await act(async () => button(pop()!, '整股（張）').props.onClick());
        expect(text(chip())).toBe('1 張');
        expect(loadOrderLotPreference('chart', stk, QUICK_ORDER_LOTS, 'IntradayOdd')).toBe('Common');
    });

    it('新圖表恢復商品單位且不將既存股數當成張數；期貨設定保持原樣', async () => {
        saveOrderLotPreference('chart', stk, 'Common');
        await mount({ contract: stk, orderSettings: { S: { lot: 'IntradayOdd', qty: 500, accountKey: 'S:B:2222207' }, F: { qty: 5, orderType: 'IOC', octype: 'Cover' } } });
        expect(text(chip())).toBe('1 張');
        await act(async () => view.update(createElement(CandleChart, { contract: fut })));
        await flush();
        expect(text(chip())).toBe('5 口·平倉');
        await act(async () => button(view.root, '點價買').props.onClick());
        await clickChart();
        expect(m.place.mock.calls.at(-1)![3]).toBe(5);
        expect(m.place.mock.calls.at(-1)![4]).toMatchObject({ orderType: 'IOC', ocType: 'Cover', account: F1 });
        expect(m.place.mock.calls.at(-1)![4].orderLot).toBeUndefined();
    });

    it('重新開圖恢復圖表專屬的單位；同為零股的商品切換也不沿用股數', async () => {
        saveOrderLotPreference('ticket', stk, 'Odd');
        await mount({ contract: stk });
        expect(text(chip())).toBe('1 張');
        await act(async () => chip().props.onClick());
        await act(async () => button(pop()!, '盤中零股（股）').props.onClick());
        await act(async () => button(pop()!, '500').props.onClick());
        await act(async () => view.unmount());
        await mount({ contract: stk });
        expect(text(chip())).toBe('1 股');
        expect(loadOrderLotPreference('ticket', stk, ['Odd', 'Common'], 'Common')).toBe('Odd');
        await act(async () => chip().props.onClick());
        await act(async () => button(pop()!, '500').props.onClick());
        const other = { ...stk, code: '2317' };
        saveOrderLotPreference('chart', other, 'IntradayOdd');
        await act(async () => view.update(createElement(CandleChart, { contract: other })));
        await flush();
        expect(text(chip())).toBe('1 股');
    });

    it('儲存失敗時仍保留這張圖每檔商品的單位', async () => {
        vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
        try {
            await mount({ contract: stk });
            await act(async () => chip().props.onClick());
            await act(async () => button(pop()!, '盤中零股（股）').props.onClick());
            await act(async () => button(pop()!, '500').props.onClick());
            await act(async () => view.update(createElement(CandleChart, { contract: { ...stk, code: '2317' } })));
            await flush();
            expect(text(chip())).toBe('1 張');
            await act(async () => view.update(createElement(CandleChart, { contract: stk })));
            await flush();
            expect(text(chip())).toBe('1 股');
        } finally { vi.restoreAllMocks(); }
    });

    it('stock odd lot: hides the ROD/IOC/FOK row, summarises, and 點價買 sends IntradayOdd shares with the chosen account', async () => {
        const onOrderSettingsChange = vi.fn();
        let state: any = {};
        onOrderSettingsChange.mockImplementation(v => { state = v; });
        await mount({ contract: stk, panelId: 'c1', orderSettings: state, onOrderSettingsChange });
        await act(async () => { chip().props.onClick(); });
        expect(pop()).toBeDefined();
        expect(text(pop()!)).toContain('委託'); // round lot: ROD / IOC / FOK shown
        await act(async () => { button(pop()!, '盤中零股（股）').props.onClick(); });
        await act(async () => view.update(createElement(CandleChart, { contract: stk, panelId: 'c1', orderSettings: state, onOrderSettingsChange } as any)));
        await act(async () => { button(pop()!, '500').props.onClick(); });
        await act(async () => view.update(createElement(CandleChart, { contract: stk, panelId: 'c1', orderSettings: state, onOrderSettingsChange } as any)));
        const select = pop()!.findAll(n => n.type === 'select')[0]!;
        await act(async () => { select.props.onChange({ target: { value: 'S:B:2222207' } }); });
        await act(async () => view.update(createElement(CandleChart, { contract: stk, panelId: 'c1', orderSettings: state, onOrderSettingsChange } as any)));
        expect(state).toEqual({ S: { qty: 500, lot: 'IntradayOdd', orderType: 'ROD', octype: 'Auto', accountKey: 'S:B:2222207' } });
        const t = text(pop()!);
        expect(t).not.toContain('IOC');
        expect(t).not.toContain('開平倉');
        // 零股：信用條件列停用並說明（不是隱藏）
        expect(button(pop()!, '融資').props.disabled).toBe(true);
        expect(button(pop()!, '現股當沖先賣').props.disabled).toBe(true);
        expect(t).toContain('零股只能以現股買賣');
        expect(text(view.root.findAll(n => n.props['data-testid'] === 'order-settings-summary')[0]!)).toMatch(/^點價買／賣以 ROD 限價送出 500 股盤中零股，帳號 .*2207；停損停利觸發後以漲跌停價送零股限價 ROD/);
        expect(text(chip())).toBe('500 股');
        await act(async () => { button(pop()!, '完成').props.onClick(); });
        expect(pop()).toBeUndefined();

        await act(async () => { button(view.root, '點價買').props.onClick(); });
        expect(text(view.root)).toContain('點擊價位 → 限價買進 500 股');
        await clickChart();
        expect(m.place).toHaveBeenCalledTimes(1);
        const [, action, price, qty, opts] = m.place.mock.calls[0]!;
        expect([action, price, qty]).toEqual(['Buy', 100, 500]);
        expect(opts).toMatchObject({ orderLot: 'IntradayOdd', account: S2 });
        expect(opts.orderType).toBeUndefined();

        // a stop from the same settings: odd-lot trigger pinned to the chosen account
        await act(async () => { button(view.root, '停損').props.onClick(); });
        await clickChart();
        expect(m.addTrigger).toHaveBeenCalledTimes(1);
        expect(m.addTrigger.mock.calls[0]![0]).toMatchObject({ quantity: 500, kind: 'stop', orderLot: 'IntradayOdd' });
        expect(m.addTrigger.mock.calls[0]![2]).toEqual({ account: S2 });
    });

    it('round lot IOC following the main account: the order uses IOC and no odd lot', async () => {
        await mount({ contract: stk });
        await act(async () => { chip().props.onClick(); });
        await act(async () => { button(pop()!, 'IOC').props.onClick(); });
        await act(async () => { button(pop()!, '5').props.onClick(); });
        expect(text(chip())).toBe('5 張');
        await act(async () => { button(view.root, '點價賣').props.onClick(); });
        expect(text(view.root)).toContain('點擊價位 → 限價賣出 IOC 5 張');
        await clickChart();
        const [, action, , qty, opts] = m.place.mock.calls[0]!;
        expect([action, qty]).toEqual(['Sell', 5]);
        expect(opts).toMatchObject({ orderType: 'IOC', account: S1 });
        expect(opts.orderLot).toBeUndefined();
        // following the main selection: triggers use the default account path
        await act(async () => { button(view.root, '停利').props.onClick(); });
        await clickChart();
        expect(m.addTrigger.mock.calls[0]![2]).toBeUndefined();
    });

    it('futures: unit fixed at 口, no 單位 row, 類別 自動／新倉／平倉 flows into orders and stops', async () => {
        await mount({ contract: fut });
        expect(text(chip())).toBe('1 口');
        await act(async () => { chip().props.onClick(); });
        const t = text(pop()!);
        expect(t).not.toContain('整股');
        expect(t).toContain('自動');
        await act(async () => { button(pop()!, '平倉').props.onClick(); });
        await act(async () => { button(pop()!, '2').props.onClick(); });
        expect(text(view.root.findAll(n => n.props['data-testid'] === 'order-settings-summary')[0]!)).toContain('2 口（平倉）');
        await act(async () => { button(view.root, '點價買').props.onClick(); });
        await clickChart();
        expect(m.place.mock.calls[0]![4]).toMatchObject({ ocType: 'Cover', account: F1 });
        await act(async () => { button(view.root, '停損').props.onClick(); });
        await clickChart();
        expect(m.addTrigger.mock.calls[0]![0]).toMatchObject({ quantity: 2, octype: 'Cover' });
        expect(m.addTrigger.mock.calls[0]![0].orderLot).toBeUndefined();
    });

    it('Esc closes the popover; a pinned account that disappeared blocks the order', async () => {
        const target = new EventTarget();
        const w = window as any;
        const saved = { add: w.addEventListener, remove: w.removeEventListener, dispatch: w.dispatchEvent };
        w.addEventListener = vi.fn((...a: Parameters<EventTarget['addEventListener']>) => target.addEventListener(...a));
        w.removeEventListener = target.removeEventListener.bind(target);
        w.dispatchEvent = target.dispatchEvent.bind(target);
        onTestFinished(() => { w.addEventListener = saved.add; w.removeEventListener = saved.remove; w.dispatchEvent = saved.dispatch; });
        await mount({ contract: stk, orderSettings: { S: { qty: 1, lot: 'Common', orderType: 'ROD', octype: 'Auto', accountKey: 'S:B:gone' } }, onOrderSettingsChange: vi.fn() });
        // closed: no key listener is installed (chart hotkeys untouched)
        const spy = w.addEventListener as ReturnType<typeof vi.fn>;
        expect(spy.mock.calls.some(c => c[0] === 'keydown')).toBe(false);
        await act(async () => { chip().props.onClick(); });
        expect(pop()).toBeDefined();
        expect(spy.mock.calls.some(c => c[0] === 'keydown')).toBe(true);
        await act(async () => { window.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' })); });
        expect(pop()).toBeUndefined();
        await act(async () => { button(view.root, '點價買').props.onClick(); });
        await clickChart();
        expect(m.place).not.toHaveBeenCalled();
        expect(m.notify.mock.calls.at(-1)![0]).toMatchObject({ kind: 'err', body: expect.stringContaining('固定帳號已不可用') });
    });

    it('odd-lot stop/take pick their side from the odd-lot price, not the round-lot one', async () => {
        // round-lot last 105 and odd-lot last 95 straddle the click at 100
        m.roundClose = 105; m.oddClose = 95;
        await mount({ contract: stk, orderSettings: { S: { qty: 300, lot: 'IntradayOdd', orderType: 'ROD', octype: 'Auto' } }, onOrderSettingsChange: vi.fn() });
        await act(async () => { button(view.root, '停損').props.onClick(); });
        await clickChart();
        // 100 is ABOVE the odd-lot price → a buy stop on a rise (round-lot would say below/sell)
        expect(m.addTrigger.mock.calls[0]![0]).toMatchObject({ condition: 'above', action: 'Buy', orderLot: 'IntradayOdd', quantity: 300 });
        await act(async () => { button(view.root, '停利').props.onClick(); });
        await clickChart();
        expect(m.addTrigger.mock.calls[1]![0]).toMatchObject({ condition: 'above', action: 'Sell', kind: 'take' });
        // alerts keep the round-lot price
        await act(async () => { button(view.root, '警示').props.onClick(); });
        await clickChart();
        expect(m.addTrigger.mock.calls[2]![0]).toMatchObject({ condition: 'below', kind: 'alert' });
    });

    it('odd-lot stop without any odd-lot trade yet is refused with 等待零股行情', async () => {
        m.oddClose = null;
        await mount({ contract: stk, orderSettings: { S: { qty: 300, lot: 'IntradayOdd', orderType: 'ROD', octype: 'Auto' } }, onOrderSettingsChange: vi.fn() });
        await act(async () => { button(view.root, '停損').props.onClick(); });
        await clickChart();
        expect(m.addTrigger).not.toHaveBeenCalled();
        expect(m.notify.mock.calls.at(-1)![0]).toMatchObject({ kind: 'err', body: expect.stringContaining('等待零股行情') });
    });

    it('another chart saving 設為預設 does not change an existing chart that never customised its settings', async () => {
        const nodeMock = { createNodeMock: () => ({ clientWidth: 800, clientHeight: 400, getBoundingClientRect: () => ({ width: 800, height: 400, left: 0, top: 0 }), addEventListener() {}, removeEventListener() {}, style: {} }) };
        let other!: ReactTestRenderer;
        // a workspace chart (controlled, nothing saved yet for its market)
        const otherProps = { contract: stk, panelId: 'b', orderSettings: undefined, onOrderSettingsChange: vi.fn() };
        await act(async () => { other = create(createElement(CandleChart, otherProps as any), nodeMock); });
        await mount({ contract: stk });
        await act(async () => { chip().props.onClick(); });
        await act(async () => { button(pop()!, '盤中零股（股）').props.onClick(); });
        await act(async () => { button(pop()!, '500').props.onClick(); });
        await act(async () => { button(pop()!, '設為預設').props.onClick(); });
        expect(JSON.parse((globalThis as any).localStorage.getItem('sj-pro-chart-order-defaults')).S).toMatchObject({ qty: 500, lot: 'IntradayOdd' });
        const otherChip = () => other.root.findAll(n => n.type === 'button' && String(n.props['aria-label'] ?? '').startsWith('圖表下單設定'))[0]!;
        // the other chart re-renders (new quote / props) and keeps 1 張
        await act(async () => { other.update(createElement(CandleChart, { ...otherProps, contract: { ...stk } } as any)); });
        await flush();
        expect(text(otherChip())).toBe('1 張');
        // a chart opened afterwards starts from the new default
        let fresh!: ReactTestRenderer;
        await act(async () => { fresh = create(createElement(CandleChart, { contract: stk } as any), nodeMock); });
        expect(text(fresh.root.findAll(n => n.type === 'button' && String(n.props['aria-label'] ?? '').startsWith('圖表下單設定'))[0]!)).toBe('500 股');
        await act(async () => { other.unmount(); fresh.unmount(); });
    });

    it('a futures chart that later switches to an unremembered stock keeps its initial stock default', async () => {
        const nodeMock = { createNodeMock: () => ({ clientWidth: 800, clientHeight: 400, getBoundingClientRect: () => ({ width: 800, height: 400, left: 0, top: 0 }), addEventListener() {}, removeEventListener() {}, style: {} }) };
        const futProps = { contract: fut, panelId: 'f', orderSettings: undefined, onOrderSettingsChange: vi.fn() };
        let futChart!: ReactTestRenderer;
        await act(async () => { futChart = create(createElement(CandleChart, futProps as any), nodeMock); });
        // another chart saves 500 股 odd lot as the stock default
        await mount({ contract: stk });
        await act(async () => { chip().props.onClick(); });
        await act(async () => { button(pop()!, '盤中零股（股）').props.onClick(); });
        await act(async () => { button(pop()!, '500').props.onClick(); });
        await act(async () => { button(pop()!, '設為預設').props.onClick(); });
        // the futures chart moves to a stock: 1 張, not 500 股
        await act(async () => { futChart.update(createElement(CandleChart, { ...futProps, contract: { ...stk, code: '2317' } } as any)); });
        await flush();
        const futChip = futChart.root.findAll(n => n.type === 'button' && String(n.props['aria-label'] ?? '').startsWith('圖表下單設定'))[0]!;
        expect(text(futChip)).toBe('1 張');
        await act(async () => futChart.unmount());
    });
});

// 圖表下單的信用條件、現股當沖先賣與期貨當沖倉別（同下單面板與閃電 #255、#256）
describe('chart order credit conditions', () => {
    const stkDT = { ...stk, day_trade: 'Yes' };
    const summary = () => text(view.root.findAll(n => n.props['data-testid'] === 'order-settings-summary')[0]!);
    const modeBtn = (label: string) => button(view.root, label);
    const pick = async (label: string) => { await act(async () => { button(pop()!, label).props.onClick(); }); await flush(); };
    const openPop = async () => { if (!pop()) await act(async () => { chip().props.onClick(); }); };
    const closePop = async () => { if (pop()) await act(async () => { button(pop()!, '完成').props.onClick(); }); };

    it('融資: the chip says 1 張·融資, the hint, summary and order carry 融資 both ways', async () => {
        await mount({ contract: stkDT });
        await openPop();
        await pick('融資');
        expect(text(chip())).toBe('1 張·融資');
        expect(summary()).toContain('融資');
        await closePop();
        await act(async () => { modeBtn('點價買').props.onClick(); });
        expect(text(view.root)).toContain('點擊價位 → 融資限價買進 1 張');
        await clickChart();
        expect(m.place).toHaveBeenCalledOnce();
        expect(m.place.mock.calls[0]![4]).toMatchObject({ orderCond: 'MarginTrading', afterConfirm: expect.any(Function) });
        expect(m.notify.mock.calls.at(-1)![0].title).toContain('融資買進已送出');
        await act(async () => { modeBtn('點價賣').props.onClick(); });
        await clickChart();
        // 融資賣出（償還）不查可否融資
        expect(m.place.mock.calls[1]![4]).toMatchObject({ orderCond: 'MarginTrading' });
        expect(m.place.mock.calls[1]![4].afterConfirm).toBeUndefined();
    });

    it('融券／借券 only sell: 點價買 is disabled and says why; sell sends the condition', async () => {
        await mount({ contract: stkDT });
        await openPop();
        await pick('借券豁免');
        expect(text(chip())).toBe('1 張·借豁');
        await closePop();
        expect(modeBtn('點價買').props.disabled).toBe(true);
        expect(modeBtn('點價買').props.title).toMatch(/只能賣出/);
        await act(async () => { modeBtn('點價賣').props.onClick(); });
        await clickChart();
        expect(m.place.mock.calls[0]![4]).toMatchObject({ orderCond: 'SBLShortPriceExempt' });
        expect(m.creditPost).not.toHaveBeenCalled();
        await openPop();
        await pick('融券');
        await closePop();
        await act(async () => { modeBtn('點價賣').props.onClick(); });
        await clickChart();
        expect(m.place.mock.calls[1]![4]).toMatchObject({ orderCond: 'ShortSelling', afterConfirm: expect.any(Function) });
    });

    it('現股當沖先賣: sell is a 現沖 sell, buy stays cash; a stock that cannot day-trade disables 點價賣', async () => {
        await mount({ contract: stkDT });
        await openPop();
        await pick('現股當沖先賣');
        expect(text(chip())).toBe('1 張·現沖');
        await closePop();
        await act(async () => { modeBtn('點價賣').props.onClick(); });
        expect(text(view.root)).toContain('點擊價位 → 現沖限價賣出 1 張');
        await clickChart();
        expect(m.place.mock.calls[0]![4]).toMatchObject({ daytradeShort: true });
        expect(m.place.mock.calls[0]![4].orderCond).toBeUndefined();
        await act(async () => { view.update(createElement(CandleChart, { contract: { ...stk, day_trade: 'OnlyBuy' } })); });
        await flush();
        expect(modeBtn('點價賣').props.disabled).toBe(true);
        expect(modeBtn('點價賣').props.title).toMatch(/只能先買後賣/);
        expect(modeBtn('點價買').props.disabled).toBeFalsy();
    });

    it('a stock whose margin ratio is 0 disables only 融資買進; 融資賣出 (repaying) still goes out', async () => {
        m.creditPost.mockResolvedValue([{ stock_id: '2330', system: 'ALL', update_time: '', margin_unit: 100, short_unit: 50, margin_loan_ratio: 0, short_margin_ratio: 90 }]);
        await mount({ contract: stkDT, orderSettings: { S: { qty: 1, lot: 'Common', orderType: 'ROD', octype: 'Auto', credit: { cond: 'MarginTrading', daytradeShort: false } } }, onOrderSettingsChange: vi.fn() });
        await flush();
        expect(modeBtn('點價買').props.disabled).toBe(true);
        expect(modeBtn('點價買').props.title).toMatch(/不能融資買進/);
        await act(async () => { modeBtn('點價賣').props.onClick(); });
        await clickChart();
        expect(m.place).toHaveBeenCalledOnce();
        expect(m.place.mock.calls[0]![0]).toBeDefined();
        expect(m.place.mock.calls[0]![1]).toBe('Sell');
    });

    it('the post-confirmation re-check refuses a 融資買進 that became 0 meanwhile', async () => {
        m.place.mockImplementation(async (_c, _a, _p, _q, opts) => { await opts.afterConfirm(); opts.beforeSend(); return { status: { status: 'Submitted' } }; });
        await mount({ contract: stkDT, orderSettings: { S: { qty: 1, lot: 'Common', orderType: 'ROD', octype: 'Auto', credit: { cond: 'MarginTrading', daytradeShort: false } } }, onOrderSettingsChange: vi.fn() });
        await act(async () => { modeBtn('點價買').props.onClick(); });
        // 面板已查到可以（快取）；確認之後的重查才變成 0
        await flush();
        expect(m.creditPost).toHaveBeenCalledOnce();
        m.creditPost.mockResolvedValue([{ stock_id: '2330', system: 'ALL', update_time: '', margin_unit: 0, short_unit: 50, margin_loan_ratio: 60, short_margin_ratio: 90 }]);
        await clickChart();
        expect(m.place).toHaveBeenCalledOnce();
        expect(m.notify.mock.calls.at(-1)![0]).toMatchObject({ title: '圖表下單失敗', body: expect.stringContaining('不能融資買進') });
    });

    it('odd lot suspends credit (orders are cash) and back to 張 restores 融資', async () => {
        await mount({ contract: stkDT });
        await openPop();
        await pick('融資');
        await pick('盤中零股（股）');
        expect(text(chip())).toBe('1 股');
        await closePop();
        await act(async () => { modeBtn('點價買').props.onClick(); });
        await clickChart();
        expect(m.place.mock.calls[0]![4].orderCond).toBeUndefined();
        expect(m.place.mock.calls[0]![4]).toMatchObject({ orderLot: 'IntradayOdd' });
        await openPop();
        await pick('整股（張）');
        expect(text(chip())).toBe('1 張·融資');
    });

    it('keeps the condition when the chart moves to another stock and to futures and back', async () => {
        let state: ChartOrderPanelState = {};
        const onOrderSettingsChange = vi.fn((v: ChartOrderPanelState) => { state = v; });
        const render = (contract: unknown) => act(async () => view.update(createElement(CandleChart, { contract, orderSettings: state, onOrderSettingsChange } as any)));
        await mount({ contract: stkDT, orderSettings: state, onOrderSettingsChange });
        await openPop();
        await pick('融券');
        await render(stkDT);
        await closePop();
        await render({ ...stkDT, code: '2317' });
        await flush();
        expect(text(chip())).toBe('1 張·融券');
        await render(fut);
        expect(text(chip())).toBe('1 口');
        await render(stkDT);
        expect(text(chip())).toBe('1 張·融券');
    });

    it('futures: 當沖 倉別 is offered and sent with point orders; no credit row', async () => {
        await mount({ contract: fut });
        await openPop();
        expect(text(pop()!)).not.toContain('融資');
        await pick('當沖');
        expect(text(chip())).toBe('1 口·當沖');
        await closePop();
        await act(async () => { modeBtn('點價賣').props.onClick(); });
        await clickChart();
        expect(m.place.mock.calls[0]![4]).toMatchObject({ ocType: 'DayTrade' });
        expect(m.place.mock.calls[0]![4].orderCond).toBeUndefined();
    });

    it('stop／take are disabled while a credit condition applies (triggers only send cash)', async () => {
        await mount({ contract: stkDT, orderSettings: { S: { qty: 1, lot: 'Common', orderType: 'ROD', octype: 'Auto', credit: { cond: 'MarginTrading', daytradeShort: false } } }, onOrderSettingsChange: vi.fn() });
        expect(modeBtn('停損').props.disabled).toBe(true);
        expect(modeBtn('停利').props.title).toMatch(/現股/);
    });

    it('changing any condition disarms 點價 in the same render — also when the owner changes it', async () => {
        await mount({ contract: stkDT });
        await act(async () => { modeBtn('點價買').props.onClick(); });
        expect(text(view.root)).toContain('點擊價位 →');
        await openPop();
        await pick('融資');
        expect(text(view.root)).not.toContain('點擊價位 →');
        await clickChart();
        expect(m.place).not.toHaveBeenCalled();
        // owner-driven change
        let state: ChartOrderPanelState = { S: { qty: 1, lot: 'Common', orderType: 'ROD', octype: 'Auto' } };
        await act(async () => view.update(createElement(CandleChart, { contract: stkDT, orderSettings: state, onOrderSettingsChange: vi.fn() } as any)));
        await closePop();
        await act(async () => { modeBtn('點價賣').props.onClick(); });
        state = { S: { ...state.S!, orderType: 'IOC' } };
        await act(async () => view.update(createElement(CandleChart, { contract: stkDT, orderSettings: state, onOrderSettingsChange: vi.fn() } as any)));
        expect(text(view.root)).not.toContain('點擊價位 →');
        await clickChart();
        expect(m.place).not.toHaveBeenCalled();
    });

    it('a pending (confirming) order is refused at dispatch once the condition changes, even back again', async () => {
        let release!: () => void;
        const wait = new Promise<void>(r => { release = r; });
        const dispatched = vi.fn();
        m.place.mockImplementation(async (_c, _a, _p, _q, opts) => { await wait; opts.beforeSend(); dispatched(); return { status: { status: 'Submitted' } }; });
        await mount({ contract: stkDT });
        await act(async () => { modeBtn('點價賣').props.onClick(); });
        await clickChart();
        expect(m.place).toHaveBeenCalledOnce();
        await openPop();
        await pick('融資');
        await pick('現股');
        await act(async () => { release(); });
        await flush();
        expect(dispatched).not.toHaveBeenCalled();
        expect(m.notify.mock.calls.at(-1)![0]).toMatchObject({ title: '圖表下單失敗' });
    });

    it('working order lines name a non-cash condition', async () => {
        const trade = { contract: stkDT, order: { id: 'o1', seqno: '', ordno: '', action: 'Buy', price: 99, quantity: 2, order_cond: 'MarginTrading' },
            status: { id: 'o1', status: 'Submitted', status_code: '', order_quantity: 2, deal_quantity: 0, cancel_quantity: 0, modified_price: 0, msg: '', deals: [] } };
        m.dragEvents = true;
        await mount({ contract: stkDT, trades: [trade] });
        expect(m.lines.map(l => (l.options() as { title?: string }).title)).toContain('融資買2 ⠿');
    });
});
