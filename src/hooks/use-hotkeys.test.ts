// src/hooks/use-hotkeys.test.ts — 應用程式鎖：遮蔽中快捷鍵不動作（⇧⌘L 在 lib/app-lock.test.ts）
//
// 按鍵本來就被 lib/app-lock 的攔截層擋在前面；Esc×2 全部刪單不能只靠那一層，
// use-hotkeys 的 listener 自己再擋一次（這裡直接把按鍵送給它）。每個「鎖定中不動作」
// 的案例都先確認沒鎖時會動作（對照），測試才有可能失敗。

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEscCancelArm } from '../lib/esc-cancel-arm';
import { TICKET_ACTION_EVENT, useHotkeys } from './use-hotkeys';

const m = vi.hoisted(() => ({
    cancelAll: vi.fn(async () => {}),
    notify: vi.fn(),
    blocked: false,
}));
vi.mock('../lib/trade', () => ({ cancelAllOrders: m.cancelAll, notify: m.notify }));
vi.mock('../lib/risk', () => ({ getRiskSettings: () => ({ escCancelAll: true }) }));
vi.mock('../lib/app-lock', () => ({ isAppAccessBlocked: () => m.blocked }));
const setLocked = (locked: boolean) => void (m.blocked = locked);

type KeyListener = (e: KeyboardEvent) => void;
const listeners = new Map<KeyListener, boolean>();
const ticketActions: string[] = [];
const roots: ReactTestRenderer[] = [];

// 派送順序同瀏覽器：window 的 capture listener 先、bubble listener 後。
// stopAtTarget：目標元件在這個按鍵上 stopPropagation — capture 照樣收到
function press(
    key: string,
    mods: Partial<{
        code: string;
        metaKey: boolean;
        ctrlKey: boolean;
        shiftKey: boolean;
        altKey: boolean;
        repeat: boolean;
    }> = {},
    opts: { stopAtTarget?: boolean } = {},
) {
    const e = {
        key,
        code: '',
        target: null,
        repeat: false,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        defaultPrevented: false,
        preventDefault() {
            this.defaultPrevented = true;
        },
        ...mods,
    };
    const all = [...listeners];
    for (const [l, capture] of all) if (capture) l(e as unknown as KeyboardEvent);
    if (opts.stopAtTarget) return e;
    for (const [l, capture] of all) if (!capture) l(e as unknown as KeyboardEvent);
    return e;
}

function Probe(props: { onOpenPalette: () => void; onAfterCancelAll: () => void }) {
    useHotkeys(props);
    return null;
}

async function mount() {
    const onOpenPalette = vi.fn();
    const onAfterCancelAll = vi.fn();
    await act(async () => {
        roots.push(create(createElement(Probe, { onOpenPalette, onAfterCancelAll })));
    });
    return { onOpenPalette, onAfterCancelAll };
}

beforeEach(() => {
    listeners.clear();
    ticketActions.length = 0;
    m.cancelAll.mockClear();
    m.notify.mockClear();
    setLocked(false);
    resetEscCancelArm(); // 前一個測試留下的「第一下」不能帶過來
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', {
        addEventListener: (type: string, l: KeyListener, capture?: boolean) => {
            if (type === 'keydown') listeners.set(l, !!capture);
        },
        removeEventListener: (type: string, l: KeyListener) => {
            if (type === 'keydown') listeners.delete(l);
        },
        dispatchEvent: (e: CustomEvent<{ action: string }>) => {
            if (e.type === TICKET_ACTION_EVENT) ticketActions.push(e.detail.action);
            return true;
        },
    });
    // 時間不動：第二下 Esc 永遠落在 0.6 秒內，只有「清掉第一下」才擋得住
    vi.stubGlobal('performance', { now: () => 1000 });
    vi.stubGlobal('document', { activeElement: null });
});

afterEach(async () => {
    await act(async () => {
        for (const root of roots.splice(0)) root.unmount();
    });
    vi.unstubAllGlobals();
});

describe('遮蔽中：Esc×2 全部刪單', () => {
    it('對照：沒鎖時連按兩下 Esc 會全部刪單', async () => {
        await mount();
        press('Escape');
        expect(m.notify).toHaveBeenCalledTimes(1);
        press('Escape');
        expect(m.cancelAll).toHaveBeenCalledTimes(1);
    });

    it('鎖定中連按兩下 Esc 不會全部刪單，也不顯示「再按一次」提示', async () => {
        await mount();
        setLocked(true);
        press('Escape');
        press('Escape');
        expect(m.cancelAll).not.toHaveBeenCalled();
        expect(m.notify).not.toHaveBeenCalled();
        // 解鎖後快捷鍵本身沒被弄壞
        setLocked(false);
        press('Escape');
        press('Escape');
        expect(m.cancelAll).toHaveBeenCalledTimes(1);
    });

    it('鎖定前的第一下 + 鎖定中的第二下不湊成 Esc×2；解鎖後的下一下只算新的第一下', async () => {
        await mount();
        press('Escape'); // 沒鎖：第一下（武裝）
        expect(m.notify).toHaveBeenCalledTimes(1);
        setLocked(true);
        press('Escape'); // 鎖定中：不能算第二下
        expect(m.cancelAll).not.toHaveBeenCalled();
        setLocked(false);
        press('Escape'); // 0.6 秒內，但只能是新的第一下
        expect(m.cancelAll).not.toHaveBeenCalled();
        expect(m.notify).toHaveBeenCalledTimes(2);
    });

    it('鎖定中的任何按鍵（例如輸入密碼）都會清掉等待中的 Esc 第一下', async () => {
        await mount();
        press('Escape'); // 第一下（武裝）
        setLocked(true);
        press('x'); // 遮蔽層裡的一般按鍵
        setLocked(false);
        press('Escape');
        expect(m.cancelAll).not.toHaveBeenCalled();
        expect(m.notify).toHaveBeenCalledTimes(2);
    });

    it('遮蔽層的元件擋下按鍵傳遞（bubble 收不到）時，capture 那邊一樣清掉第一下', async () => {
        await mount();
        press('Escape'); // 第一下（武裝）
        setLocked(true);
        press('Enter', {}, { stopAtTarget: true });
        setLocked(false);
        press('Escape');
        expect(m.cancelAll).not.toHaveBeenCalled();
        expect(m.notify).toHaveBeenCalledTimes(2);
    });
});

describe('遮蔽中：其他快捷鍵', () => {
    it('Cmd+K：沒鎖時開啟商品面板，鎖定中不開', async () => {
        const { onOpenPalette } = await mount();
        const open = press('k', { metaKey: true });
        expect(onOpenPalette).toHaveBeenCalledTimes(1);
        expect(open.defaultPrevented).toBe(true);
        setLocked(true);
        const e = press('k', { metaKey: true });
        expect(onOpenPalette).toHaveBeenCalledTimes(1);
        expect(e.defaultPrevented).toBe(false);
    });

    it('B／S：沒鎖時切換下單方向，鎖定中不切換', async () => {
        await mount();
        press('b');
        press('s');
        expect(ticketActions).toEqual(['Buy', 'Sell']);
        setLocked(true);
        press('b');
        press('s');
        expect(ticketActions).toEqual(['Buy', 'Sell']);
    });
});
