// 頂部列「螢幕鎖」膠囊：只在已啟用、沒鎖時出現；要不要顯示放在 設定 → 頂欄顯示。
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
let view: ReactTestRenderer | undefined;

beforeEach(() => {
    vi.resetModules();
    store.clear();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
    });
    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: '' });
});
afterEach(async () => {
    if (view) await act(async () => view!.unmount());
    view = undefined;
    vi.unstubAllGlobals();
});

it('沒啟用不顯示；已啟用沒鎖時是「關」的開關，按下立即上鎖；鎖著時不顯示', async () => {
    const lib = await import('../lib/app-lock');
    const { ScreenLockSwitch } = await import('./screen-lock-switch');
    await act(async () => { view = create(createElement(ScreenLockSwitch)); });
    expect(view!.toJSON()).toBeNull();
    await act(async () => { await lib.enableAppLock('correct horse'); });
    const capsule = view!.root.findByType('button');
    expect(capsule.props).toMatchObject({ role: 'switch', 'aria-checked': false, 'aria-label': '螢幕鎖', 'aria-keyshortcuts': 'Control+Shift+L' });
    expect(capsule.props.title).toContain('Ctrl+Shift+L');
    await act(async () => { capsule.props.onClick(); });
    expect(lib.isAppAccessBlocked()).toBe(true);
    expect(view!.toJSON()).toBeNull();
});

it('頂欄顯示有「螢幕鎖」一項，預設開著；舊的偏好沒有這一項也當成開著', async () => {
    store.set('sj-pro-header-items', JSON.stringify({ clock: false }));
    const items = await import('../lib/header-items');
    expect(items.HEADER_ITEMS.map((i) => i.key)).toContain('screenLock');
    expect(items.getHeaderItems()).toMatchObject({ screenLock: true, clock: false });
    items.setHeaderItem('screenLock', false);
    expect(JSON.parse(store.get('sj-pro-header-items')!)).toMatchObject({ screenLock: false });
});
