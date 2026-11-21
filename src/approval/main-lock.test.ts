// src/approval/main-lock.test.ts — Agent 核可視窗的應用程式鎖接線。
// 核可視窗是另一個入口（獨立 WebView），沒有包 AppLockBoundary 的話，主視窗
// 鎖定中仍可在這裡核准 Agent 交易（審查報告 #6）。

import { isValidElement, type ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
    const calls: string[] = [];
    return {
        calls,
        render: vi.fn(),
        // 工廠函式在 vi.resetModules() 後會重跑；元件要用同一個參考才比得起來
        Boundary: ({ children }: { children: unknown }) => children,
    };
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('react-dom/client', () => ({
    createRoot: () => {
        m.calls.push('createRoot');
        return { render: m.render };
    },
}));
// vanilla-extract 樣式與本測試無關（元件根本不渲染），mock 掉省下編譯時間
vi.mock('../theme.css', () => ({ darkTwClass: 'dark-tw' }));
vi.mock('./approval.css', () => ({}));
vi.mock('../lib/app-lock', () => ({ initializeAppLock: () => void m.calls.push('initializeAppLock') }));
vi.mock('../components/app-lock-boundary', () => ({ AppLockBoundary: m.Boundary }));

// 在元件樹裡找某個型別的元素（不管外面包了幾層）
type El = ReactElement<{ children?: unknown }>;
const findType = (el: unknown, type: unknown): El | undefined => !isValidElement(el) ? undefined
    : el.type === type ? el as El : [(el as El).props.children].flat().map((c) => findType(c, type)).find(Boolean);

beforeEach(() => {
    vi.resetModules();
    m.calls.length = 0;
    m.render.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

it('有 #root 時：先裝攔截再掛載，內容包在 AppLockBoundary 裡', async () => {
    vi.stubGlobal('window', { location: { search: '' } });
    vi.stubGlobal('document', {
        getElementById: () => ({}),
        documentElement: { classList: { add: vi.fn() } },
    });
    await import('./main');
    expect(m.calls).toEqual(['initializeAppLock', 'createRoot']);
    const boundary = findType(m.render.mock.calls[0]![0], m.Boundary);
    expect(isValidElement(boundary?.props.children)).toBe(true);
});

it('沒有 DOM（node 測試匯入元件與解析函式）時不初始化也不掛載', async () => {
    await import('./main');
    expect(m.calls).toEqual([]);
});
