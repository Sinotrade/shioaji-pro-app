// B／S 切換下單方向的全域快捷鍵：帶 Ctrl／Cmd／Alt 的組合鍵屬於系統或
// 瀏覽器（⌘S、Ctrl+S、⌘B…），不可靜默改掉下單面板與組合單的方向。

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TICKET_ACTION_EVENT, useHotkeys } from './use-hotkeys';

vi.mock('../lib/trade', () => ({ cancelAllOrders: vi.fn(async () => {}), notify: vi.fn() }));
vi.mock('../lib/risk', () => ({ getRiskSettings: () => ({ escCancelAll: false }) }));

type Listener = (e: KeyboardEvent) => void;
type Mods = { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean };

let keyListeners: Map<Listener, boolean>;
let actions: string[];
let onOpenPalette: ReturnType<typeof vi.fn<() => void>>;
let root: ReactTestRenderer | undefined;

function Probe() {
    useHotkeys({ onOpenPalette, onAfterCancelAll: () => {} });
    return null;
}

function press(key: string, mods: Mods = {}) {
    const e = {
        key,
        repeat: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        defaultPrevented: false,
        preventDefault() {
            this.defaultPrevented = true;
        },
        ...mods,
    };
    for (const [l] of [...keyListeners]) l(e as unknown as KeyboardEvent);
}

function focus(el: { tagName: string; isContentEditable?: boolean } | null) {
    vi.stubGlobal('document', { activeElement: el });
}

beforeEach(async () => {
    keyListeners = new Map();
    actions = [];
    onOpenPalette = vi.fn<() => void>();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', {
        addEventListener: (type: string, l: Listener, capture?: boolean) => {
            if (type === 'keydown') keyListeners.set(l, !!capture);
        },
        removeEventListener: (type: string, l: Listener) => {
            if (type === 'keydown') keyListeners.delete(l);
        },
        dispatchEvent: (e: CustomEvent<{ action: string }>) => {
            if (e.type === TICKET_ACTION_EVENT) actions.push(e.detail.action);
            return true;
        },
    });
    focus(null);
    await act(async () => {
        root = create(createElement(Probe));
    });
});

afterEach(async () => {
    await act(async () => {
        root?.unmount();
    });
    root = undefined;
    vi.unstubAllGlobals();
});

describe('B／S 切換下單方向', () => {
    it('沒有修飾鍵時 B 切買、S 切賣', () => {
        press('b');
        press('s');
        expect(actions).toEqual(['Buy', 'Sell']);
    });

    it.each<[string, string, Mods]>([
        ['⌘S', 's', { metaKey: true }],
        ['Ctrl+S', 's', { ctrlKey: true }],
        ['⌘B', 'b', { metaKey: true }],
        ['Ctrl+B', 'b', { ctrlKey: true }],
        ['Alt+S', 's', { altKey: true }],
        ['Alt+B', 'b', { altKey: true }],
        ['⌘⇧S', 'S', { metaKey: true, shiftKey: true }],
    ])('%s 不觸發', (_name, key, mods) => {
        press(key, mods);
        expect(actions).toEqual([]);
    });

    // Shift 的行為待使用者決定，這裡只固定現狀，避免被順手改掉
    it('Shift+B／Shift+S 維持現狀：仍會切換', () => {
        press('B', { shiftKey: true });
        press('S', { shiftKey: true });
        expect(actions).toEqual(['Buy', 'Sell']);
    });

    it.each([
        ['input', { tagName: 'INPUT' }],
        ['textarea', { tagName: 'TEXTAREA' }],
        ['select', { tagName: 'SELECT' }],
        ['contenteditable', { tagName: 'DIV', isContentEditable: true }],
    ])('焦點在 %s 時不觸發', (_name, el) => {
        focus(el);
        press('b');
        press('s');
        expect(actions).toEqual([]);
    });

    it('焦點離開輸入框後恢復作用', () => {
        focus({ tagName: 'INPUT' });
        press('s');
        focus(null);
        press('s');
        expect(actions).toEqual(['Sell']);
    });
});

describe('其他快捷鍵不受影響', () => {
    it.each<[string, Mods]>([
        ['⌘K', { metaKey: true }],
        ['Ctrl+K', { ctrlKey: true }],
    ])('%s 仍開啟商品面板', (_name, mods) => {
        press('k', mods);
        expect(onOpenPalette).toHaveBeenCalledTimes(1);
        expect(actions).toEqual([]);
    });
});
