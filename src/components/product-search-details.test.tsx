import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductSuggestion } from '../lib/product-search';
import type { ContractInfo } from '../lib/types/contract';
import { ProductSearchDetails } from './product-search-details';
import { TICKET_ACTION_EVENT, useHotkeys } from '../hooks/use-hotkeys';
import { resetEscCancelArm } from '../lib/esc-cancel-arm';

const hotkeys = vi.hoisted(() => ({ enabled: true, cancelAll: vi.fn(async () => undefined), notify: vi.fn() }));
vi.mock('../lib/trade', () => ({ cancelAllOrders: hotkeys.cancelAll, notify: hotkeys.notify }));
vi.mock('../lib/risk', () => ({ getRiskSettings: () => ({ escCancelAll: hotkeys.enabled }) }));

const views: ReactTestRenderer[] = [];
const value: ProductSuggestion = {
    code: 'LONGWARRANT1234', name: '完整權證商品名稱', exchange: 'TSE', security_type: 'WRT',
    detail: '權證 · 認購 · 2027-04-07 · 交易日期待確認',
};
const text = (node: ReactTestInstance | string): string => typeof node === 'string' ? node : node.children.map(text).join('');
function render(item?: ProductSuggestion) {
    let view!: ReactTestRenderer;
    act(() => { view = create(createElement(ProductSearchDetails, { item })); });
    views.push(view);
    return view;
}
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => { for (const view of views.splice(0)) act(() => view.unmount()); vi.unstubAllGlobals(); });

it('無 active 商品不顯示 disclosure', () => {
    expect(render().toJSON()).toBeNull();
});

it('單一原生 disclosure 顯示完整商品與到期／警告筆數，summary 保留原生開合、不加提交 handler', () => {
    const view = render(value);
    expect(view.root.findAllByType('details')).toHaveLength(1);
    const summary = view.root.findByType('summary');
    expect(text(summary)).toBe('完整資訊（到期 1、警告 1）');
    expect(summary.props.onClick).toBeUndefined();
    expect(summary.props.onKeyDown).toBeUndefined();
    expect(view.root.findAllByType('button')).toHaveLength(0);
    for (const content of [value.code, value.name, '權證', '認購', '2027-04-07', '交易日期待確認']) {
        expect(text(view.root)).toContain(content);
    }
    expect(view.root.findByType('details').props.open).toBeUndefined();
});

it('只顯示目前 active 的完整資訊，更新時不保留上一筆或改寫來源', () => {
    const view = render(value);
    const next = { ...value, code: 'CDFR1', name: '台積電期貨', security_type: 'FUT' as const, detail: '期貨 · 近月',
        contract: { delivery_date: '2027-04-21', last_trading_date: '2027-04-20' } as ContractInfo };
    const snapshot = JSON.stringify(next);
    act(() => view.update(createElement(ProductSearchDetails, { item: next })));
    expect(text(view.root)).toContain(next.code);
    expect(text(view.root)).toContain('2027-04-21');
    expect(text(view.root)).toContain('最後交易日');
    expect(text(view.root)).toContain('2027-04-20');
    expect(text(view.root)).not.toContain(value.code);
    expect(text(view.root.findByType('summary'))).toBe('完整資訊（到期 1、警告 0）');
    expect(JSON.stringify(next)).toBe(snapshot);
});

it('股票與 ETF 的 typed 分類不由 detail 猜測，沒有日期就不編造', () => {
    const view = render({ ...value, name: '元大台灣50', security_type: 'STK', kind: 'ETF', detail: 'ETF' });
    expect(text(view.root.findByType('summary'))).toBe('完整資訊（到期 0、警告 0）');
    expect(text(view.root)).toContain('ETF');
    expect(text(view.root)).not.toContain('2027-04-07');
    expect(text(view.root)).not.toContain('權證');
});

describe.each([true, false])('disclosure 與真 useHotkeys 隔離（escCancelAll=%s）', enabled => {
    const listeners = new Map<(event: KeyboardEvent) => void, boolean>();
    const ticketAction = vi.fn();
    const openPalette = vi.fn();
    const parentKey = vi.fn();
    const body = { tagName: 'BODY' };
    const summary = { tagName: 'SUMMARY' };
    const disclosure = { open: true, querySelector: () => ({ focus: () => { documentState.activeElement = summary; } }) };
    let view!: ReactTestRenderer;
    let documentState: { activeElement: typeof summary | typeof body };
    function HotkeysProbe() {
        useHotkeys({ onOpenPalette: openPalette, onAfterCancelAll: vi.fn() });
        return null;
    }
    beforeEach(() => {
        vi.useFakeTimers();
        hotkeys.enabled = enabled;
        hotkeys.cancelAll.mockClear();
        hotkeys.notify.mockClear();
        openPalette.mockClear();
        ticketAction.mockClear();
        parentKey.mockClear();
        resetEscCancelArm();
        listeners.clear();
        disclosure.open = true;
        documentState = { activeElement: summary };
        vi.stubGlobal('document', documentState);
        vi.stubGlobal('performance', { now: () => 1000 });
        vi.stubGlobal('window', {
            addEventListener: (type: string, listener: (event: KeyboardEvent) => void, capture?: boolean) => {
                if (type === 'keydown') listeners.set(listener, !!capture);
            },
            removeEventListener: (_type: string, listener: (event: KeyboardEvent) => void) => listeners.delete(listener),
            dispatchEvent: (event: Event) => { if (event.type === TICKET_ACTION_EVENT) ticketAction(event); return true; },
        });
        act(() => {
            view = create(createElement('div', { onKeyDown: parentKey }, createElement(HotkeysProbe), createElement(ProductSearchDetails, { item: value })));
        });
        views.push(view);
    });
    afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

    function press(key: string, inside = true, modifiers: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; repeat?: boolean } = {}) {
        documentState.activeElement = inside ? summary : body;
        const event = {
            key, repeat: false, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers,
            currentTarget: disclosure, target: documentState.activeElement,
            defaultPrevented: false, stopped: false,
            preventDefault() { this.defaultPrevented = true; },
            stopPropagation() { this.stopped = true; },
        };
        // Match native dispatch: window capture, React target/ancestor, window bubble, native default.
        for (const [listener, capture] of listeners) if (capture) listener(event as unknown as KeyboardEvent);
        if (inside) view.root.findByType('details').props.onKeyDown?.(event);
        if (!event.stopped && inside) parentKey(event);
        for (const [listener, capture] of listeners) if (!capture && !event.stopped) listener(event as unknown as KeyboardEvent);
        if (inside && !event.defaultPrevented && (key === 'Enter' || key === ' ')) disclosure.open = !disclosure.open;
        return event;
    }

    it('summary 連按 Esc 只收合，焦點留在 summary，不 armed、不通知、不全部刪單', () => {
        let first!: ReturnType<typeof press>;
        act(() => { first = press('Escape'); press('Escape'); press('Escape', true, { repeat: true }); });
        expect(first.defaultPrevented).toBe(true);
        expect(first.stopped).toBe(true);
        expect(disclosure.open).toBe(false);
        expect(documentState.activeElement).toBe(summary);
        expect(hotkeys.cancelAll).not.toHaveBeenCalled();
        expect(hotkeys.notify).not.toHaveBeenCalled();
        expect(parentKey).not.toHaveBeenCalled();
    });

    it('外部 Esc、summary Esc、外部 Esc 不湊成全部刪單；離開後全域風控仍正常', () => {
        act(() => { press('Escape', false); press('Escape'); press('Escape', false); });
        expect(hotkeys.cancelAll).not.toHaveBeenCalled();
        expect(hotkeys.notify).toHaveBeenCalledTimes(enabled ? 2 : 0);
        act(() => { press('Escape', false); });
        expect(hotkeys.cancelAll).toHaveBeenCalledTimes(enabled ? 1 : 0);
    });

    it('B／S／Ctrl-K／Cmd-K 不送票券動作或重新開啟搜尋', () => {
        act(() => { press('b'); press('B'); press('s'); press('S'); press('k', true, { ctrlKey: true }); press('k', true, { metaKey: true }); });
        expect(ticketAction).not.toHaveBeenCalled();
        expect(openPalette).not.toHaveBeenCalled();
        expect(hotkeys.cancelAll).not.toHaveBeenCalled();
        expect(parentKey).not.toHaveBeenCalled();
    });

    it('Enter／Space 保留原生開合預設、不送出或冒泡到父元件，Tab／Shift-Tab 不受阻擋', () => {
        let enter!: ReturnType<typeof press>;
        let space!: ReturnType<typeof press>;
        act(() => { enter = press('Enter'); });
        expect(enter.defaultPrevented).toBe(false);
        expect(disclosure.open).toBe(false);
        act(() => { space = press(' '); });
        expect(space.defaultPrevented).toBe(false);
        expect(disclosure.open).toBe(true);
        expect(parentKey).not.toHaveBeenCalled();
        for (const shiftKey of [false, true]) {
            const tab = press('Tab', true, { shiftKey });
            expect(tab.defaultPrevented).toBe(false);
            expect(tab.stopped).toBe(false);
        }
        expect(hotkeys.cancelAll).not.toHaveBeenCalled();
        expect(ticketAction).not.toHaveBeenCalled();
    });
});
