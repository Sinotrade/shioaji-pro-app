// 快捷鍵登錄表：按鍵字串、平台顯示、改鍵檢查（保留鍵／衝突／風險）、
// 儲存與還原、視窗角色與面板焦點、Windows 瀏覽器按鍵。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isBlockedBrowserKey, installBrowserKeyGuard } from './browser-keys';
import {
    escTakenByArmedPanel,
    getFocusedPanel,
    holdEscForDisarm,
    holdKeyboard,
    isInsidePanel,
    isTypingElement,
    keyboardHeld,
    panelOfTarget,
    setFocusedPanel,
    windowRoleOf,
} from './guards';
import { chordFromEvent, chordText, keyCaps, parseChord } from './keys';
import { matchesShortcut } from './match';
import {
    SHORTCUTS,
    availability,
    checkBinding,
    defById,
    effectiveKeys,
    forPlatform,
    isEditable,
    sanitizeOverrides,
} from './registry';
import {
    SHORTCUTS_STORAGE_KEY,
    __setShortcutPlatformForTests,
    clearBinding,
    getShortcutState,
    resetAllBindings,
    resetBinding,
    setBinding,
} from './store';

const ev = (code: string, mods: Partial<KeyboardEvent> = {}) => ({
    code,
    key: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
});

let storage: Map<string, string>;
beforeEach(() => {
    storage = new Map();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => void storage.set(k, v),
        removeItem: (k: string) => void storage.delete(k),
    });
    __setShortcutPlatformForTests('mac');
    resetAllBindings();
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe('登錄表', () => {
    it('id 不重複，每個預設鍵都是合法格式', () => {
        const ids = SHORTCUTS.map((d) => d.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const d of SHORTCUTS) for (const k of d.keys) expect(parseChord(k), `${d.id} ${k}`).not.toBeNull();
    });

    it.each(['mac', 'win'] as const)('%s：可改的預設鍵彼此不衝突、也不撞保留鍵', (platform) => {
        for (const d of forPlatform(platform).filter(isEditable)) {
            for (const k of d.keys) {
                const level = checkBinding(d, k, {}, platform).level;
                expect(['ok', 'note', 'confirm'], `${d.id} ${k} → ${level}`).toContain(level);
            }
        }
    });

    it('2026-11-06 決定：提示頁 ⌘/、Agent ⌘J、全部刪單固定不開放改鍵', () => {
        expect(defById('help.open')!.keys).toEqual(['Mod+Slash']);
        expect(defById('help.open')!.window).toBe('any');
        expect(defById('agent.toggle')!.keys).toEqual(['Mod+KeyJ']);
        const cancel = defById('orders.cancelAll')!;
        expect(cancel.keys).toEqual(['Escape*2']);
        expect(isEditable(cancel)).toBe(false);
        expect(cancel.window).toBe('main');
        expect(defById('ticket.buy')!.window).toBe('main');
    });

    it('第一版沒有任何會直接送單的鍵盤快捷鍵', () => {
        const sendKeys = SHORTCUTS.filter((d) => d.risk === 'send' && d.keys.length > 0);
        expect(sendKeys).toEqual([]);
    });
});

describe('按鍵字串與顯示', () => {
    it('macOS 用 ⌘⌥⇧ 符號、Windows 用 Ctrl／Alt／Shift', () => {
        expect(keyCaps('Mod+Shift+KeyZ', 'mac')).toEqual(['⌘', '⇧', 'Z']);
        expect(keyCaps('Mod+Shift+KeyZ', 'win')).toEqual(['Ctrl', 'Shift', 'Z']);
        expect(chordText('Mod+Slash', 'mac')).toBe('⌘/');
        expect(chordText('Mod+Slash', 'win')).toBe('Ctrl+/');
        expect(chordText('Alt+KeyT', 'mac')).toBe('⌥T');
        expect(chordText('Escape*2', 'win')).toBe('Esc Esc');
    });

    it('修飾鍵順序不對或未知按鍵視為無效', () => {
        expect(parseChord('Shift+Mod+KeyZ')).toBeNull();
        expect(parseChord('Hyper+KeyZ')).toBeNull();
        expect(parseChord('Mod+Foo')).toBeNull();
    });

    it('錄製：Caps Lock 不影響、Shift 會記下、只按修飾鍵回 null', () => {
        expect(chordFromEvent(ev('KeyB', { key: 'B' }), 'mac')).toBe('KeyB');
        expect(chordFromEvent(ev('KeyB', { key: 'B', shiftKey: true }), 'mac')).toBe('Shift+KeyB');
        expect(chordFromEvent(ev('MetaLeft', { metaKey: true }), 'mac')).toBeNull();
        expect(chordFromEvent(ev('KeyK', { metaKey: true }), 'mac')).toBe('Mod+KeyK');
        expect(chordFromEvent(ev('KeyK', { ctrlKey: true }), 'mac')).toBe('Ctrl+KeyK');
        expect(chordFromEvent(ev('KeyK', { ctrlKey: true }), 'win')).toBe('Mod+KeyK');
        // Windows 的 ⊞ 鍵屬於系統
        expect(chordFromEvent(ev('KeyK', { metaKey: true }), 'win')).toBeNull();
        // 沒有 code（遠端桌面）時由 key 推回
        expect(chordFromEvent(ev('', { key: '/', metaKey: true }), 'mac')).toBe('Mod+Slash');
    });
});

describe('改鍵檢查', () => {
    const d = (id: string) => defById(id)!;

    it('保留鍵擋下：編輯鍵、macOS ⌘Q、Windows 已停用的 F5／Ctrl+R／Ctrl+P', () => {
        expect(checkBinding(d('draw.ray'), 'Mod+KeyC', {}, 'mac')).toMatchObject({ level: 'block' });
        expect(checkBinding(d('draw.ray'), 'Mod+KeyQ', {}, 'mac')).toMatchObject({ level: 'block' });
        expect(checkBinding(d('draw.ray'), 'Mod+KeyQ', {}, 'win')).not.toMatchObject({ level: 'block' });
        expect(checkBinding(d('draw.ray'), 'F5', {}, 'win')).toMatchObject({ level: 'block' });
        expect(checkBinding(d('draw.ray'), 'Mod+KeyR', {}, 'win')).toMatchObject({ level: 'block' });
        expect(checkBinding(d('draw.ray'), 'Mod+KeyP', {}, 'win')).toMatchObject({ level: 'block' });
    });

    it('固定鍵不能改', () => {
        expect(checkBinding(d('orders.cancelAll'), 'Mod+Alt+KeyX', {}, 'mac')).toMatchObject({ level: 'block' });
        expect(checkBinding(d('draw.undo'), 'Mod+KeyU', {}, 'mac')).toMatchObject({ level: 'block' });
    });

    it('同範圍撞到可改的項目 → 衝突，可取代', () => {
        const r = checkBinding(d('draw.ray'), 'Alt+KeyT', {}, 'mac');
        expect(r).toMatchObject({ level: 'conflict' });
        expect(r.level === 'conflict' && r.other.id).toBe('draw.trend');
    });

    it('撞到全域鍵也算衝突（⌘K 在 K 線圖範圍內也會被商品搜尋拿走）', () => {
        const r = checkBinding(d('chart.lockDrawings'), 'Mod+KeyK', {}, 'mac');
        expect(r.level === 'conflict' && r.other.id).toBe('palette.open');
    });

    it('撞到固定鍵或會影響委託的鍵 → 擋下，不能取代', () => {
        expect(checkBinding(d('draw.ray'), 'Mod+KeyZ', {}, 'mac')).toMatchObject({ level: 'block' });
        expect(checkBinding(d('draw.ray'), 'Mod+KeyL', {}, 'mac')).toMatchObject({ level: 'block' });
    });

    it('不同面板範圍可以共用同一鍵（K 線圖 vs 下單面板）', () => {
        expect(checkBinding(d('chart.lockDrawings'), 'KeyB', {}, 'mac').level).toBe('note');
    });

    it('衝突以目前生效的鍵為準：清掉對方的鍵後就不衝突', () => {
        expect(checkBinding(d('draw.ray'), 'Alt+KeyT', { 'draw.trend': [] }, 'mac').level).toBe('ok');
    });

    it('切方向只能用字母或加修飾鍵，改前要確認', () => {
        expect(checkBinding(d('ticket.buy'), 'Digit1', {}, 'mac')).toMatchObject({ level: 'block' });
        expect(checkBinding(d('ticket.buy'), 'F2', {}, 'mac')).toMatchObject({ level: 'block' });
        expect(checkBinding(d('ticket.buy'), 'KeyJ', {}, 'mac')).toMatchObject({ level: 'confirm' });
    });

    it('委託線鎖定一定要有 ⌘／Ctrl 或 ⌥／Alt', () => {
        expect(checkBinding(d('chart.lockOrders'), 'KeyL', {}, 'mac')).toMatchObject({ level: 'block' });
        expect(checkBinding(d('chart.lockOrders'), 'Shift+KeyL', {}, 'mac')).toMatchObject({ level: 'block' });
        expect(checkBinding(d('chart.lockOrders'), 'Mod+Alt+KeyL', {}, 'mac')).toMatchObject({ level: 'confirm' });
    });

    it('Shift 只能搭配字母', () => {
        expect(checkBinding(d('draw.ray'), 'Shift+Digit1', {}, 'mac')).toMatchObject({ level: 'block' });
    });
});

describe('儲存', () => {
    it('改鍵後立即生效、寫入 localStorage，回復預設會清掉', () => {
        expect(setBinding('draw.ray', 'Alt+KeyY')).toBe(true);
        expect(matchesShortcut('draw.ray', ev('KeyY', { altKey: true }))).toBe(true);
        expect(JSON.parse(storage.get(SHORTCUTS_STORAGE_KEY)!)).toEqual({ v: 1, overrides: { 'draw.ray': ['Alt+KeyY'] } });
        resetBinding('draw.ray');
        expect(matchesShortcut('draw.ray', ev('KeyY', { altKey: true }))).toBe(false);
        expect(storage.has(SHORTCUTS_STORAGE_KEY)).toBe(false);
    });

    it('衝突時不會直接寫入；指定取代才清掉對方的鍵', () => {
        expect(setBinding('draw.ray', 'Alt+KeyT')).toBe(false);
        expect(setBinding('draw.ray', 'Alt+KeyT', 'draw.trend')).toBe(true);
        const { overrides } = getShortcutState();
        expect(effectiveKeys(defById('draw.trend')!, overrides)).toEqual([]);
        expect(matchesShortcut('draw.ray', ev('KeyT', { altKey: true }))).toBe(true);
        expect(matchesShortcut('draw.trend', ev('KeyT', { altKey: true }))).toBe(false);
    });

    it('被擋下的鍵不會寫入', () => {
        expect(setBinding('draw.ray', 'Mod+KeyC')).toBe(false);
        expect(setBinding('orders.cancelAll', 'Mod+Alt+KeyX')).toBe(false);
        expect(getShortcutState().overrides).toEqual({});
    });

    it('清除＝停用；改回預設值時不留覆寫', () => {
        clearBinding('chart.toggleDrawings');
        expect(effectiveKeys(defById('chart.toggleDrawings')!, getShortcutState().overrides)).toEqual([]);
        setBinding('chart.toggleDrawings', 'Alt+Shift+KeyH');
        expect(getShortcutState().overrides).toEqual({});
    });

    it('讀回時丟掉未知項目、固定鍵、格式錯誤、保留鍵；互相衝突的覆寫只留一個', () => {
        const clean = sanitizeOverrides(
            {
                nope: ['KeyA'],
                'orders.cancelAll': ['Mod+KeyX'],
                'draw.ray': ['Shift+Mod+KeyZ'],
                'draw.extended': ['Mod+KeyC'],
                'chart.lockDrawings': ['Alt+KeyY'],
                'draw.box': ['Alt+KeyY'],
                'draw.fib': ['Alt+KeyU'],
            },
            'mac',
        );
        // 兩邊都是覆寫：丟登錄表順序較後者（draw.box）
        expect(clean).toEqual({ 'chart.lockDrawings': ['Alt+KeyY'], 'draw.fib': ['Alt+KeyU'] });
        expect(sanitizeOverrides('garbage', 'mac')).toEqual({});
    });

    it('localStorage 版本不符時用預設值', () => {
        storage.set(SHORTCUTS_STORAGE_KEY, JSON.stringify({ v: 99, overrides: { 'draw.ray': ['Alt+KeyY'] } }));
        __setShortcutPlatformForTests('mac');
        expect(getShortcutState().overrides).toEqual({});
        storage.set(SHORTCUTS_STORAGE_KEY, JSON.stringify({ v: 1, overrides: { 'draw.ray': ['Alt+KeyY'] } }));
        __setShortcutPlatformForTests('mac');
        expect(getShortcutState().overrides).toEqual({ 'draw.ray': ['Alt+KeyY'] });
    });
});

describe('比對', () => {
    it('⌘ 與 Ctrl 沿用舊版互通，但明確自訂的 ⌃ 組合優先', () => {
        expect(matchesShortcut('palette.open', ev('KeyK', { ctrlKey: true }))).toBe(true);
        expect(setBinding('chart.lockDrawings', 'Ctrl+KeyK')).toBe(true);
        expect(matchesShortcut('palette.open', ev('KeyK', { ctrlKey: true }))).toBe(false);
        expect(matchesShortcut('chart.lockDrawings', ev('KeyK', { ctrlKey: true }))).toBe(true);
        expect(matchesShortcut('palette.open', ev('KeyK', { metaKey: true }))).toBe(true);
    });

    it('Windows：Ctrl 是 Mod', () => {
        __setShortcutPlatformForTests('win');
        expect(matchesShortcut('help.open', ev('Slash', { ctrlKey: true }))).toBe(true);
        expect(matchesShortcut('draw.undo', ev('KeyZ', { ctrlKey: true }))).toBe(true);
        expect(matchesShortcut('draw.redo', ev('KeyY', { ctrlKey: true }))).toBe(true);
    });

    it('Shift+B 不是 B', () => {
        expect(matchesShortcut('ticket.buy', ev('KeyB'))).toBe(true);
        expect(matchesShortcut('ticket.buy', ev('KeyB', { shiftKey: true }))).toBe(false);
    });
});

describe('提示頁可用狀態', () => {
    const ctx = { panel: 'chart', escCancelAll: false, role: 'main' as const };

    it('彈出視窗：交易鍵標示只在主視窗，提示頁本身可用', () => {
        const popout = { ...ctx, role: 'popout' as const };
        expect(availability(defById('ticket.buy')!, popout)).toEqual({ state: 'elsewhere', reason: '只在主視窗' });
        expect(availability(defById('orders.cancelAll')!, { ...popout, escCancelAll: true }).state).toBe('elsewhere');
        expect(availability(defById('help.open')!, popout).state).toBe('now');
        expect(availability(defById('chart.toggleDrawings')!, popout).state).toBe('now');
    });

    it('依目前面板判斷；全部刪單未啟用標示 off；⌘J 保留', () => {
        expect(availability(defById('draw.trend')!, ctx).state).toBe('now');
        expect(availability(defById('ticket.buy')!, ctx).state).toBe('elsewhere');
        expect(availability(defById('ticket.buy')!, { ...ctx, panel: 'combo' }).state).toBe('now');
        expect(availability(defById('orders.cancelAll')!, ctx)).toEqual({ state: 'off', reason: '未啟用' });
        expect(availability(defById('orders.cancelAll')!, { ...ctx, escCancelAll: true }).state).toBe('now');
        expect(availability(defById('agent.toggle')!, ctx).state).toBe('reserved');
    });
});

describe('guards', () => {
    it('輸入中判斷', () => {
        expect(isTypingElement({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
        expect(isTypingElement({ tagName: 'textarea' } as unknown as EventTarget)).toBe(true);
        expect(isTypingElement({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true);
        expect(isTypingElement({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false);
        expect(isTypingElement(null)).toBe(false);
    });

    it('視窗角色：帶 popout 參數的是彈出視窗', () => {
        expect(windowRoleOf('')).toBe('main');
        expect(windowRoleOf('?shortcutsDemo=1')).toBe('main');
        expect(windowRoleOf('?popout=flash&code=TXFR1')).toBe('popout');
    });

    it('Esc 由啟用中的面板接手：持有到釋放為止，重複釋放無效', () => {
        expect(escTakenByArmedPanel()).toBe(false);
        const a = holdEscForDisarm();
        const b = holdEscForDisarm();
        a();
        a();
        expect(escTakenByArmedPanel()).toBe(true);
        b();
        expect(escTakenByArmedPanel()).toBe(false);
    });

    it('鍵盤暫時接手', () => {
        const r = holdKeyboard();
        expect(keyboardHeld()).toBe(true);
        r();
        expect(keyboardHeld()).toBe(false);
    });

    it('面板焦點：grid 內記下面板，grid 外不改變', () => {
        const cell = { getAttribute: (n: string) => (n === 'data-block-id' ? 'b7' : 'ticket') };
        const inside = { closest: () => cell };
        const outside = { closest: () => null };
        expect(panelOfTarget(inside as unknown as EventTarget)).toEqual({ id: 'b7', type: 'ticket' });
        expect(panelOfTarget(outside as unknown as EventTarget)).toBeUndefined();
        setFocusedPanel({ id: 'b7', type: 'ticket' });
        expect(getFocusedPanel()).toEqual({ id: 'b7', type: 'ticket' });
        expect(isInsidePanel(inside, 'b7')).toBe(true);
        expect(isInsidePanel(inside, 'b8')).toBe(false);
        expect(isInsidePanel(null, 'b7')).toBe(false);
        setFocusedPanel(null);
    });
});

describe('Windows 瀏覽器按鍵', () => {
    it.each([
        ['F5', ev('F5')],
        ['Shift+F5', ev('F5', { shiftKey: true })],
        ['Ctrl+R', ev('KeyR', { ctrlKey: true })],
        ['Ctrl+Shift+R', ev('KeyR', { ctrlKey: true, shiftKey: true })],
        ['Ctrl+P', ev('KeyP', { ctrlKey: true })],
        ['Ctrl+r（無 code）', ev('', { key: 'r', ctrlKey: true })],
    ])('%s 被攔下', (_n, e) => {
        expect(isBlockedBrowserKey(e)).toBe(true);
    });

    it.each([
        ['R', ev('KeyR')],
        ['Alt+R', ev('KeyR', { altKey: true })],
        ['Ctrl+C', ev('KeyC', { ctrlKey: true })],
        ['Ctrl+V', ev('KeyV', { ctrlKey: true })],
    ])('%s 不受影響', (_n, e) => {
        expect(isBlockedBrowserKey(e)).toBe(false);
    });

    it('只在 Tauri 的 Windows 安裝', () => {
        const add = vi.fn();
        vi.stubGlobal('window', { addEventListener: add, removeEventListener: vi.fn() });
        installBrowserKeyGuard({ tauri: false, mac: false });
        installBrowserKeyGuard({ tauri: true, mac: true });
        expect(add).not.toHaveBeenCalled();
        const off = installBrowserKeyGuard({ tauri: true, mac: false });
        expect(add).toHaveBeenCalledWith('keydown', expect.any(Function), true);
        const handler = add.mock.calls[0]![1] as (e: KeyboardEvent) => void;
        const prevent = vi.fn();
        handler({ ...ev('F5'), preventDefault: prevent } as unknown as KeyboardEvent);
        handler({ ...ev('KeyC', { ctrlKey: true }), preventDefault: prevent } as unknown as KeyboardEvent);
        expect(prevent).toHaveBeenCalledTimes(1);
        off();
    });
});
