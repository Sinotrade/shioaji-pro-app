// src/lib/limit-style-prefs.test.ts — 自選清單漲跌停樣式偏好（全域、跨視窗同步）
import { afterEach, describe, expect, it, vi } from 'vitest';

let storageListener: ((e: { key: string | null }) => void) | null = null;

async function loadWith(saved: string | null) {
    vi.resetModules();
    const store = new Map<string, string>();
    if (saved !== null) store.set('sj-pro-watchlist-limit-style', saved);
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
    });
    vi.stubGlobal('window', {
        addEventListener: (type: string, fn: (e: { key: string | null }) => void) => {
            if (type === 'storage') storageListener = fn;
        },
    });
    const mod = await import('./limit-style-prefs');
    return { mod, store };
}

afterEach(() => {
    vi.unstubAllGlobals();
    storageListener = null;
});

describe('limit style prefs', () => {
    it('預設為 A 整塊數字區實心底（block）', async () => {
        const { mod } = await loadWith(null);
        expect(mod.getLimitStyle()).toBe('block');
    });

    it('讀回已存的樣式；未知值退回預設', async () => {
        expect((await loadWith('solid')).mod.getLimitStyle()).toBe('solid');
        expect((await loadWith('tint')).mod.getLimitStyle()).toBe('tint');
        expect((await loadWith('none')).mod.getLimitStyle()).toBe('none');
        expect((await loadWith('C')).mod.getLimitStyle()).toBe('block');
    });

    it('設定即時通知訂閱者並寫回 localStorage', async () => {
        const { mod, store } = await loadWith(null);
        const seen: string[] = [];
        mod.subscribeLimitStyle(() => seen.push(mod.getLimitStyle()));
        mod.setLimitStyle('tint');
        expect(seen).toEqual(['tint']);
        expect(store.get('sj-pro-watchlist-limit-style')).toBe('tint');
    });

    it('其他視窗改設定（storage 事件）時同步', async () => {
        const { mod, store } = await loadWith(null);
        const seen: string[] = [];
        mod.subscribeLimitStyle(() => seen.push(mod.getLimitStyle()));
        store.set('sj-pro-watchlist-limit-style', 'solid');
        storageListener?.({ key: 'sj-pro-watchlist-limit-style' });
        expect(mod.getLimitStyle()).toBe('solid');
        expect(seen).toEqual(['solid']);
        // 無關的 key 不觸發
        storageListener?.({ key: 'other' });
        expect(seen).toEqual(['solid']);
    });
});
