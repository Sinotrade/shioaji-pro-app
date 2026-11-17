// src/main.test.ts — 進入點的應用程式鎖接線（popout、tray 視窗也走這個入口）：
// 1. initializeAppLock() 早於其他所有初始化 — window 擷取階段先註冊先執行，
//    攔截層要排在所有 listener 前面，鎖定中才擋得住它們
// 2. <AppGate /> 包在 <AppLockBoundary> 裡，而且主線的 <AppErrorBoundary> 在鎖的內層 —
//    反過來的話 App 出錯換成錯誤頁時鎖定畫面會跟著卸載，攔截層卻還在（鎖死）

import { isValidElement, type ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
    const calls: string[] = [];
    return {
        calls,
        render: vi.fn(),
        // 工廠函式在 vi.resetModules() 後會重跑；元件要用同一個參考才比得起來
        Boundary: ({ children }: { children: unknown }) => children,
        ErrorBoundary: ({ children }: { children: unknown }) => children,
        Gate: () => null,
        track: (name: string) => () => void calls.push(name),
    };
});
vi.mock('./lib/polyfills', () => ({}));
vi.mock('./index.css', () => ({}));
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: m.render }) }));
vi.mock('./app-gate', () => ({ AppGate: m.Gate }));
vi.mock('./components/app-lock-boundary', () => ({ AppLockBoundary: m.Boundary }));
vi.mock('./components/app-error-boundary', () => ({ AppErrorBoundary: m.ErrorBoundary }));
vi.mock('./lib/app-lock', () => ({ initializeAppLock: m.track('initializeAppLock') }));
vi.mock('./lib/analytics', () => ({ startAnalytics: m.track('startAnalytics') }));
vi.mock('./lib/boot', () => ({ bootstrap: m.track('bootstrap') }));
vi.mock('./lib/theme-store', () => ({ initTheme: m.track('initTheme') }));
vi.mock('./lib/bracket', () => ({ startBracketRuntime: m.track('startBracketRuntime') }));
vi.mock('./lib/execution/background', () => ({ startBackgroundExecution: m.track('startBackgroundExecution') }));
vi.mock('./lib/odd-spread-service', () => ({ startOddSpreadService: m.track('startOddSpreadService') }));
vi.mock('./lib/trigger-engine', () => ({ startTriggerEngine: m.track('startTriggerEngine') }));
vi.mock('./lib/conditional/runtime', () => ({ startConditionalRuntime: m.track('startConditionalRuntime') }));

// 在元件樹裡找某個型別的元素（不管外面包了幾層）
type El = ReactElement<{ children?: unknown }>;
const findType = (el: unknown, type: unknown): El | undefined => !isValidElement(el) ? undefined
    : el.type === type ? el as El : [(el as El).props.children].flat().map((c) => findType(c, type)).find(Boolean);

beforeEach(() => {
    vi.resetModules();
    m.calls.length = 0;
    m.render.mockClear();
    vi.stubGlobal('document', { getElementById: () => ({}) });
    vi.stubGlobal('location', { search: '' });
});
afterEach(() => vi.unstubAllGlobals());

it('先裝應用程式鎖的事件攔截，再做其他初始化與 bootstrap', async () => {
    await import('./main');
    expect(m.calls[0]).toBe('initializeAppLock');
    // 其他初始化都有跑到，「第一個」才有意義
    expect([...m.calls].sort()).toEqual(
        [
            'initializeAppLock',
            'initTheme',
            'startAnalytics',
            'startTriggerEngine',
            'startBracketRuntime',
            'startOddSpreadService',
            'startBackgroundExecution',
            'startConditionalRuntime',
            'bootstrap',
        ].sort(),
    );
});

it('<AppGate /> 包在 <AppLockBoundary> 裡，<AppErrorBoundary> 在鎖的內層', async () => {
    await import('./main');
    expect(m.render).toHaveBeenCalledTimes(1);
    expect(findType(findType(findType(m.render.mock.calls[0]![0], m.Boundary), m.ErrorBoundary), m.Gate)).toBeDefined();
});
