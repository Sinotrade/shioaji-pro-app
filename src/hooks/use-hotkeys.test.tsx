// 主視窗全域快捷鍵：B／S 只切換「目前選取」的下單面板、Shift+B／S 不觸發、
// Caps Lock 不影響；帶 Ctrl／Cmd／Alt 的組合鍵屬於系統或瀏覽器（⌘S、Ctrl+S、
// ⌘B…），不可靜默改掉方向；閃電下單啟用中 Esc 不算全部刪單的第一下。

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEscCancelArm } from '../lib/esc-cancel-arm';
import { holdEscForDisarm, setFocusedPanel } from '../lib/shortcuts/guards';
import { SHORTCUT_EVENT } from '../lib/shortcuts/match';
import { __resetTicketHintForTests, TICKET_ACTION_EVENT, useHotkeys } from './use-hotkeys';

const trade = vi.hoisted(() => ({ cancelAllOrders: vi.fn(async () => {}), notify: vi.fn() }));
const risk = vi.hoisted(() => ({ escCancelAll: false }));
vi.mock('../lib/trade', () => trade);
vi.mock('../lib/risk', () => ({ getRiskSettings: () => risk }));

type Listener = (e: KeyboardEvent) => void;
type Mods = {
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
    code?: string;
    isComposing?: boolean;
    keyCode?: number;
};

let keyListeners: Map<Listener, boolean>;
let actions: { action: string; blockId: string }[];
let shortcuts: string[];
let onOpenPalette: ReturnType<typeof vi.fn<() => void>>;
let root: ReactTestRenderer | undefined;

function Probe() {
    useHotkeys({ onOpenPalette, onAfterCancelAll: () => {} });
    return null;
}

function press(key: string, mods: Mods = {}) {
    const e = {
        key,
        code: '',
        repeat: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        isComposing: false,
        keyCode: 0,
        defaultPrevented: false,
        preventDefault() {
            this.defaultPrevented = true;
        },
        ...mods,
    };
    // capture 先、bubble 後（與瀏覽器一致）
    const ordered = [...keyListeners].sort((a, b) => Number(b[1]) - Number(a[1]));
    for (const [l] of ordered) l(e as unknown as KeyboardEvent);
    return e;
}

function focus(el: { tagName: string; isContentEditable?: boolean } | null) {
    vi.stubGlobal('document', { activeElement: el });
}

beforeEach(async () => {
    keyListeners = new Map();
    actions = [];
    shortcuts = [];
    onOpenPalette = vi.fn<() => void>();
    trade.notify.mockClear();
    trade.cancelAllOrders.mockClear();
    risk.escCancelAll = false;
    resetEscCancelArm();
    __resetTicketHintForTests();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', {
        addEventListener: (type: string, l: Listener, capture?: boolean) => {
            if (type === 'keydown') keyListeners.set(l, !!capture);
        },
        removeEventListener: (type: string, l: Listener) => {
            if (type === 'keydown') keyListeners.delete(l);
        },
        dispatchEvent: (e: CustomEvent<{ action: string; blockId: string; id: string }>) => {
            if (e.type === TICKET_ACTION_EVENT) actions.push({ action: e.detail.action, blockId: e.detail.blockId });
            if (e.type === SHORTCUT_EVENT) shortcuts.push(e.detail.id);
            return true;
        },
    });
    focus(null);
    setFocusedPanel({ id: 'tk1', type: 'ticket' });
    await act(async () => {
        root = create(createElement(Probe));
    });
});

afterEach(async () => {
    await act(async () => {
        root?.unmount();
    });
    root = undefined;
    setFocusedPanel(null);
    vi.unstubAllGlobals();
});

const sides = () => actions.map((a) => a.action);

describe('B／S 切換下單方向', () => {
    it('沒有修飾鍵時 B 切買、S 切賣，只送給目前選取的面板', () => {
        press('b');
        press('s');
        expect(actions).toEqual([
            { action: 'Buy', blockId: 'tk1' },
            { action: 'Sell', blockId: 'tk1' },
        ]);
    });

    it('組合單面板也算下單面板', () => {
        setFocusedPanel({ id: 'cb1', type: 'combo' });
        press('s');
        expect(actions).toEqual([{ action: 'Sell', blockId: 'cb1' }]);
    });

    it('選取的不是下單面板時不切換，第一次落空提示一次', () => {
        setFocusedPanel({ id: 'ch1', type: 'chart' });
        press('b');
        press('s');
        expect(actions).toEqual([]);
        expect(trade.notify).toHaveBeenCalledTimes(1);
        expect(trade.notify.mock.calls[0]![0]).toMatchObject({ title: 'B／S 只作用在選取的下單面板' });
    });

    it('沒有選取任何面板時不切換', () => {
        setFocusedPanel(null);
        press('b');
        expect(actions).toEqual([]);
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

    // 2026-11-06 產品決定：Shift+B／Shift+S 不觸發
    it('Shift+B／Shift+S 不觸發', () => {
        press('B', { shiftKey: true, code: 'KeyB' });
        press('S', { shiftKey: true, code: 'KeyS' });
        press('B', { shiftKey: true });
        expect(actions).toEqual([]);
    });

    it('Caps Lock 開著（大寫 B、沒有 Shift）仍然有效', () => {
        press('B', { code: 'KeyB' });
        press('S');
        expect(sides()).toEqual(['Buy', 'Sell']);
    });

    it('注音等輸入法改了 e.key 時依實體鍵位判斷', () => {
        press('ㄖ', { code: 'KeyB' });
        expect(sides()).toEqual(['Buy']);
    });

    it('輸入法組字中不觸發', () => {
        press('Process', { code: 'KeyB', isComposing: true, keyCode: 229 });
        press('b', { keyCode: 229 });
        expect(actions).toEqual([]);
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
        expect(sides()).toEqual(['Sell']);
    });
});

describe('其他全域鍵', () => {
    it.each<[string, Mods]>([
        ['⌘K', { metaKey: true }],
        ['Ctrl+K', { ctrlKey: true }],
    ])('%s 開啟商品面板（⌘ 與 Ctrl 沿用舊版都有效）', (_name, mods) => {
        press('k', mods);
        expect(onOpenPalette).toHaveBeenCalledTimes(1);
        expect(actions).toEqual([]);
    });

    it('⌘K 在輸入框內也能用', () => {
        focus({ tagName: 'INPUT' });
        press('k', { metaKey: true });
        expect(onOpenPalette).toHaveBeenCalledTimes(1);
    });

    it('⌘J 廣播給頂欄 Agent（保留鍵），⌘, 開設定', () => {
        const j = press('j', { metaKey: true });
        press(',', { metaKey: true, code: 'Comma' });
        expect(shortcuts).toEqual(['agent.toggle', 'settings.open']);
        expect(j.defaultPrevented).toBe(true);
    });
});

describe('Esc×2 全部刪單', () => {
    beforeEach(() => {
        risk.escCancelAll = true;
    });

    it('連按兩次 Esc 全部刪單', () => {
        press('Escape');
        press('Escape');
        expect(trade.cancelAllOrders).toHaveBeenCalledTimes(1);
    });

    it('設定未開啟時不刪單', () => {
        risk.escCancelAll = false;
        press('Escape');
        press('Escape');
        expect(trade.cancelAllOrders).not.toHaveBeenCalled();
    });

    it('閃電下單啟用中：Esc 只解除，不算第一下', () => {
        const release = holdEscForDisarm();
        // 面板自己的 Esc listener 解除後立刻釋放（模擬 React 同步跑完 cleanup）—
        // 這個 bubble listener 排在 use-hotkeys 前面也一樣
        const panelEsc: Listener = () => release();
        const rest = [...keyListeners];
        keyListeners = new Map([[panelEsc, false], ...rest]);
        press('Escape');
        press('Escape');
        expect(trade.cancelAllOrders).not.toHaveBeenCalled();
        // 解除後的這一下才算第一下
        expect(trade.notify).toHaveBeenCalledTimes(1);
        expect(trade.notify.mock.calls[0]![0]).toMatchObject({ title: '再按一次 Esc 全部刪單' });
    });

    it('閃電下單解除後的 Esc、Esc 照常全部刪單', () => {
        const release = holdEscForDisarm();
        press('Escape');
        release();
        press('Escape');
        press('Escape');
        expect(trade.cancelAllOrders).toHaveBeenCalledTimes(1);
    });

    it('焦點在輸入框的 Esc 不算', () => {
        press('Escape');
        focus({ tagName: 'INPUT' });
        press('Escape');
        focus(null);
        press('Escape');
        expect(trade.cancelAllOrders).not.toHaveBeenCalled();
    });

    it('被介面用掉（preventDefault）的 Esc 清掉等待中的第一下', () => {
        press('Escape');
        keyListeners.set((e) => e.preventDefault(), true);
        press('Escape');
        expect(trade.cancelAllOrders).not.toHaveBeenCalled();
    });
});
