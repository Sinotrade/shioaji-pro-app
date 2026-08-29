// modal Esc stack 語意：只關最上層、一律 preventDefault（Esc-Esc 全刪單
// 防護依 defaultPrevented 判斷）、空栈時卸掉 window listener。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { escStackDepth, pushEscHandler } from './use-esc-close';

type Listener = (e: KeyboardEvent) => void;

let captureListeners: Listener[];
let cleanups: (() => void)[];

// 測試內一律經 push 註冊 — afterEach 統一出栈（不能用 dispatch 清栈：
// 不自清的 handler 會讓 while 迴圈永不見底）
function push(h: () => void) {
    const c = pushEscHandler(h);
    cleanups.push(c);
    return c;
}

function fakeEsc() {
    return {
        key: 'Escape',
        preventDefault: vi.fn(),
    } as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> };
}

function dispatchEsc() {
    const e = fakeEsc();
    for (const l of [...captureListeners]) l(e);
    return e;
}

beforeEach(() => {
    captureListeners = [];
    cleanups = [];
    vi.stubGlobal('window', {
        addEventListener: (
            type: string,
            l: Listener,
            capture?: boolean,
        ) => {
            if (type === 'keydown' && capture) captureListeners.push(l);
        },
        removeEventListener: (
            type: string,
            l: Listener,
            capture?: boolean,
        ) => {
            if (type === 'keydown' && capture) {
                captureListeners = captureListeners.filter((x) => x !== l);
            }
        },
    });
});

afterEach(() => {
    for (const c of cleanups) c(); // 重複 cleanup 為 no-op
    expect(escStackDepth()).toBe(0);
    vi.unstubAllGlobals();
});

describe('pushEscHandler', () => {
    it('只有最上層 handler 被呼叫，且 preventDefault', () => {
        const a = vi.fn();
        const b = vi.fn();
        push(a);
        push(b);
        const e = dispatchEsc();
        expect(b).toHaveBeenCalledTimes(1);
        expect(a).not.toHaveBeenCalled();
        expect(e.preventDefault).toHaveBeenCalled();
    });

    it('上層卸除後 Esc 落到下一層', () => {
        const a = vi.fn();
        const b = vi.fn();
        push(a);
        const cleanupB = push(b);
        cleanupB();
        dispatchEsc();
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).not.toHaveBeenCalled();
    });

    it('空栈時 window listener 卸載、Esc 不再被攔（刪單熱鍵可運作）', () => {
        const a = vi.fn();
        const cleanup = push(a);
        expect(captureListeners.length).toBe(1);
        cleanup();
        expect(captureListeners.length).toBe(0);
    });

    it('handler 觸發關閉（呼叫端 unmount → cleanup）後下一下 Esc 給下層', () => {
        // 模擬真實流程：Esc 關最上層 modal，其 effect cleanup 出栈
        const closedOrder: string[] = [];
        const cleanupA: (() => void)[] = [];
        cleanupA.push(
            push(() => {
                closedOrder.push('dialog');
                cleanupA[0]!();
            }),
        );
        const cleanupB: (() => void)[] = [];
        cleanupB.push(
            push(() => {
                closedOrder.push('editor');
                cleanupB[0]!();
            }),
        );
        dispatchEsc();
        dispatchEsc();
        expect(closedOrder).toEqual(['editor', 'dialog']);
    });
});
