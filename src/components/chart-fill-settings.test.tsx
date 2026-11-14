// 圖表設定的「成交標記」頁：分頁、各列選項、完成；Esc 只關設定、不算進 Esc×2 全刪單（真的 useHotkeys）
import { createElement, Fragment } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// 最小的 window：同一個 keydown 先跑 capture、再跑 bubble 的 listener；localStorage 用記憶體
const win = vi.hoisted(() => {
    const listeners: { fn: (e: unknown) => void; capture: boolean }[] = [];
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
        getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k),
    };
    (globalThis as { window?: unknown }).window = {
        addEventListener: (type: string, fn: (e: unknown) => void, capture?: boolean) => { if (type === 'keydown') listeners.push({ fn, capture: !!capture }); },
        removeEventListener: (type: string, fn: (e: unknown) => void, capture?: boolean) => {
            const i = listeners.findIndex((l) => l.fn === fn && l.capture === !!capture);
            if (type === 'keydown' && i >= 0) listeners.splice(i, 1);
        },
        dispatchEvent: () => true,
    };
    (globalThis as { document?: unknown }).document = { activeElement: null };
    const esc = () => {
        let stopped = false;
        const e = { key: 'Escape', repeat: false, defaultPrevented: false, preventDefault() { e.defaultPrevented = true; }, stopImmediatePropagation() { stopped = true; } };
        for (const capture of [true, false]) for (const l of listeners.filter((x) => x.capture === capture)) { if (stopped) break; l.fn(e); }
        return e;
    };
    return { store, esc };
});
const trade = vi.hoisted(() => ({ cancelAll: vi.fn(async () => undefined), notify: vi.fn() }));
vi.mock('../lib/trade', () => ({ cancelAllOrders: trade.cancelAll, notify: trade.notify }));
vi.mock('../lib/risk', () => ({ getRiskSettings: () => ({ escCancelAll: true }) }));

import { useHotkeys } from '../hooks/use-hotkeys';
import { getChartFillColor, getChartFillScope, getChartFillStyle, setChartFillColor, setChartFillScope, setChartFillStyle } from '../lib/chart-fill-prefs';
import { normalizeChartOrder } from '../lib/chart-order-settings';
import { escStackDepth } from '../hooks/use-esc-close';
import { resetEscCancelArm } from '../lib/esc-cancel-arm';
import { ChartFillSettings } from './chart-fill-settings';
import { OrderSettingsButton } from './chart-order-popover';

const text = (n: ReactTestInstance | string): string => typeof n === 'string' ? n : n.children.map(text).join('');
let view: ReactTestRenderer;
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    trade.cancelAll.mockClear();
    sheetTouched.mockClear();
    resetEscCancelArm();
    setChartFillStyle('price');
    setChartFillColor('distinct');
    setChartFillScope('active');
});
afterEach(() => {
    act(() => view?.unmount());
    vi.unstubAllGlobals();
});

const row = (label: string) => view.root.find((n) => n.props.role === 'group' && n.props['aria-label'] === label).findAllByType('button');
const pressed = (label: string) => row(label).filter((b) => b.props['aria-pressed']).map(text);
const pick = (label: string, option: string) => act(() => row(label).find((b) => text(b) === option)!.props.onClick());

it('四種標記（不畫只關這張圖）、兩種顏色（預設藍買橘賣）、兩種帳戶範圍；完成關閉', () => {
    const onShowChange = vi.fn();
    const onClose = vi.fn();
    const props = { show: true, onShowChange, style: 'price' as const, color: 'distinct' as const, scope: 'active' as const, onClose };
    act(() => { view = create(createElement(ChartFillSettings, props)); });
    expect(row('標記').map(text)).toEqual(['不畫', '三角形', '買賣', '價格']);
    expect([pressed('標記'), pressed('顏色'), pressed('帳戶')]).toEqual([['價格'], ['藍買橘賣'], ['目前帳戶']]);
    pick('標記', '三角形');
    expect([getChartFillStyle(), onShowChange.mock.calls.length]).toEqual(['dot', 0]);
    pick('標記', '不畫');
    expect(onShowChange).toHaveBeenLastCalledWith(false);
    expect(getChartFillStyle()).toBe('dot'); // 不畫不動全域樣式
    act(() => view.update(createElement(ChartFillSettings, { ...props, show: false })));
    expect(pressed('標記')).toEqual(['不畫']);
    pick('標記', '買賣');
    expect([getChartFillStyle(), onShowChange.mock.lastCall]).toEqual(['side', [true]]);
    pick('顏色', '同 K 棒');
    expect(getChartFillColor()).toBe('candle');
    expect(win.store.get('sj-pro-chart-fill-color')).toBe('candle');
    pick('帳戶', '全部帳戶');
    expect(getChartFillScope()).toBe('all');
    act(() => view.root.findAll((n) => n.type === 'button' && text(n) === '完成')[0]!.props.onClick());
    expect(onClose).toHaveBeenCalled();
});

const sheetTouched = vi.fn();
function Settings({ sheets, hotkeys = false }: { sheets?: boolean; hotkeys?: boolean }) {
    if (hotkeys) useHotkeys({ onOpenPalette: () => {}, onAfterCancelAll: () => {} });
    return createElement(Fragment, null, createElement(OrderSettingsButton, {
        market: 'F', settings: normalizeChartOrder({}, 'F'), onChange: () => {}, onSaveDefault: () => {}, contractLabel: 'TXFR1', summary: '', ariaLabel: '圖表下單設定',
        layout: { title: '圖表下單設定', scope: '只影響這張圖', qtyLabel: '數量', unit: false, orderType: true, octype: true, defaultNote: '' },
        sheets: sheets ? [{ key: 'fills', label: '成交標記', onInteraction: sheetTouched, render: (close) => createElement('button', { type: 'button', 'data-sheet': 'fills', onClick: close }, '成交標記內容') }] : undefined,
    }));
}
const dialog = () => view.root.findAll((n) => n.props.role === 'dialog');
const tabs = () => view.root.find((n) => n.props.role === 'group' && n.props['aria-label'] === '設定分頁').findAllByType('button');
const openChip = () => act(() => view.root.find(n => n.type === 'button' && n.props['aria-label'] === '圖表下單設定').props.onClick());
// 模擬捕獲階段：從最外層到 target 依序跑 DOM 元素的 on*Capture
function capture(target: ReactTestInstance, kind: 'PointerDown' | 'KeyDown') {
    const path: ReactTestInstance[] = [];
    for (let n: ReactTestInstance | null = target; n; n = n.parent) path.unshift(n);
    for (const n of path) if (typeof n.type === 'string') n.props[`on${kind}Capture`]?.({});
}

it('有其他分頁時頂端多一排「下單｜成交標記」，切換只換內容、再打開停在上次的分頁；沒有分頁時跟以前一樣', () => {
    act(() => { view = create(createElement(Settings, { sheets: true })); });
    openChip();
    expect(tabs().map((t) => [text(t), t.props['aria-pressed']])).toEqual([['下單', true], ['成交標記', false]]);
    expect(dialog()[0]!.props['aria-label']).toBe('圖表下單設定');
    expect(view.root.findAll((n) => n.props['data-testid'] === 'order-settings-summary')).toHaveLength(1);
    act(() => tabs()[1]!.props.onClick());
    expect(tabs().map((t) => t.props['aria-pressed'])).toEqual([false, true]);
    expect(dialog()[0]!.props['aria-label']).toBe('圖表設定：成交標記');
    expect(view.root.findAll((n) => n.props['data-sheet'] === 'fills')).toHaveLength(1);
    expect(view.root.findAll((n) => n.props['data-testid'] === 'order-settings-summary')).toHaveLength(0);
    act(() => view.root.findByProps({ 'data-sheet': 'fills' }).props.onClick()); // 分頁裡的「完成」
    expect(dialog()).toHaveLength(0);
    openChip();
    expect(tabs().map((t) => t.props['aria-pressed'])).toEqual([false, true]);
    act(() => view.update(createElement(Settings, {})));
    expect(view.root.findAll((n) => n.props['aria-label'] === '設定分頁')).toHaveLength(0); // 沒有分頁：只剩下單設定
    expect(view.root.findAll((n) => n.props['data-testid'] === 'order-settings-summary')).toHaveLength(1);
});

it('在成交標記頁按 Esc 只關設定（標記為已處理），緊接著第二下也不會全刪單', () => {
    act(() => { view = create(createElement(Settings, { sheets: true, hotkeys: true })); });
    openChip();
    act(() => tabs()[1]!.props.onClick());
    let first!: { defaultPrevented: boolean };
    act(() => { first = win.esc(); });
    expect(first.defaultPrevented).toBe(true);
    expect(dialog()).toHaveLength(0);
    act(() => { win.esc(); });
    expect(trade.cancelAll).not.toHaveBeenCalled();
});

it('重開停在成交標記頁會先執行該頁互動；切回下單頁再重開不執行', () => {
    act(() => { view = create(createElement(Settings, { sheets: true })); });
    openChip();
    act(() => tabs()[1]!.props.onClick());
    openChip(); // 關閉後仍記住成交標記頁
    sheetTouched.mockClear();
    openChip();
    expect(dialog()[0]!.props['aria-label']).toBe('圖表設定：成交標記');
    expect(sheetTouched).toHaveBeenCalledTimes(1);
    act(() => tabs()[0]!.props.onClick());
    openChip();
    sheetTouched.mockClear();
    openChip();
    expect(dialog()[0]!.props['aria-label']).toBe('圖表下單設定');
    expect(sheetTouched).not.toHaveBeenCalled();
});

it.each(['有分頁按 Esc', '有分頁按完成', '有分頁點背景', '沒有分頁按 Esc'])('%s 關閉設定時只在內部關閉有分頁設定才歸還焦點', (entry) => {
    const focus = vi.fn();
    act(() => {
        view = create(createElement(Settings, { sheets: entry !== '沒有分頁按 Esc' }), {
            createNodeMock: n => (n.props as { 'aria-haspopup'?: string })['aria-haspopup'] === 'dialog' ? { focus } : null,
        });
    });
    openChip();
    expect(focus).not.toHaveBeenCalled();
    if (entry === '有分頁按完成') {
        act(() => tabs()[1]!.props.onClick());
        act(() => view.root.findByProps({ 'data-sheet': 'fills' }).props.onClick());
    } else if (entry === '有分頁點背景') {
        act(() => view.root.find(n => n.type === 'div' && typeof n.props.onClick === 'function').props.onClick());
    } else act(() => { win.esc(); });
    expect(dialog()).toHaveLength(0);
    if (entry === '有分頁按 Esc' || entry === '有分頁按完成') {
        expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    } else expect(focus).not.toHaveBeenCalled();
});

it('有分頁時開著就進 modal 的 Esc 堆疊（畫圖工具會讓出這一下 Esc）；閃電下單（沒有分頁）照舊不進；點分頁鈕先解除點價武裝', () => {
    act(() => { view = create(createElement(Settings, { sheets: true })); });
    expect(escStackDepth()).toBe(0);
    openChip();
    expect(escStackDepth()).toBe(1);
    const fillsTab = tabs()[1]!;
    fillsTab.props.onPointerDownCapture({});
    expect(sheetTouched).toHaveBeenCalledTimes(1);
    expect(tabs()[0]!.props.onPointerDownCapture).toBeUndefined(); // 下單分頁不另外做事
    act(() => { win.esc(); });
    expect(dialog()).toHaveLength(0);
    expect(escStackDepth()).toBe(0);
    act(() => view.update(createElement(Settings, {})));
    openChip();
    expect(escStackDepth()).toBe(0);
});

it('成交標記頁內容的指標按下與按鍵也先執行該頁互動（分頁不用自己接）；下單頁內容不執行', () => {
    act(() => { view = create(createElement(Settings, { sheets: true })); });
    openChip();
    capture(view.root.findByProps({ 'data-testid': 'order-settings-summary' }), 'PointerDown');
    expect(sheetTouched).not.toHaveBeenCalled();
    act(() => tabs()[1]!.props.onClick());
    sheetTouched.mockClear();
    const content = view.root.findByProps({ 'data-sheet': 'fills' });
    capture(content, 'PointerDown');
    expect(sheetTouched).toHaveBeenCalledTimes(1);
    capture(content, 'KeyDown');
    expect(sheetTouched).toHaveBeenCalledTimes(2);
});
