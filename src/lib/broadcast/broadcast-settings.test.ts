import { beforeEach, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
            store.set(k, String(v));
        },
        removeItem: (k: string) => {
            store.delete(k);
        },
    });
    vi.resetModules();
});

it('starts disabled with the WpfApp6 defaults', async () => {
    const m = await import('./broadcast-settings');
    expect(m.getBroadcastSettings()).toEqual({
        enabled: false,
        rate: 4,
        cooldownSec: 4,
        voiceUri: '',
        quoteEnabled: false,
        dealEnabled: false,
        noticeEnabled: false,
    });
});

it('starts with all three event switches off', async () => {
    const m = await import('./broadcast-settings');
    const s = m.getBroadcastSettings();
    // 一次全開會被轟炸 —— 由使用者逐一開啟
    expect(s.quoteEnabled).toBe(false);
    expect(s.dealEnabled).toBe(false);
    expect(s.noticeEnabled).toBe(false);
});

it('toggles each event switch independently', async () => {
    const m = await import('./broadcast-settings');
    m.setBroadcastSettings({ dealEnabled: true });
    expect(m.getBroadcastSettings().dealEnabled).toBe(true);
    expect(m.getBroadcastSettings().quoteEnabled).toBe(false);
    expect(m.getBroadcastSettings().noticeEnabled).toBe(false);
});

it('clamps the rate and the cooldown into range', async () => {
    const m = await import('./broadcast-settings');
    m.setBroadcastSettings({ rate: 99, cooldownSec: -5 });
    expect(m.getBroadcastSettings().rate).toBe(10);
    expect(m.getBroadcastSettings().cooldownSec).toBe(0);
    m.setBroadcastSettings({ rate: -99, cooldownSec: 999 });
    expect(m.getBroadcastSettings().rate).toBe(-10);
    expect(m.getBroadcastSettings().cooldownSec).toBe(60);
});

it('persists the settings to localStorage', async () => {
    const m = await import('./broadcast-settings');
    m.setBroadcastSettings({ enabled: true, rate: 6, noticeEnabled: true });
    expect(store.get('sj-pro-broadcast')).toContain('"enabled":true');
    expect(store.get('sj-pro-broadcast')).toContain('"rate":6');
    expect(store.get('sj-pro-broadcast')).toContain('"noticeEnabled":true');
});

it('ignores a corrupted stored payload and falls back to the defaults', async () => {
    store.set('sj-pro-broadcast', '{ not json');
    const m = await import('./broadcast-settings');
    expect(m.getBroadcastSettings().enabled).toBe(false);
    expect(m.getBroadcastSettings().rate).toBe(4);
});

it('drops a non-boolean event switch value instead of trusting it', async () => {
    store.set(
        'sj-pro-broadcast',
        JSON.stringify({ quoteEnabled: 'yes', dealEnabled: true }),
    );
    const m = await import('./broadcast-settings');
    expect(m.getBroadcastSettings().quoteEnabled).toBe(false);
    expect(m.getBroadcastSettings().dealEnabled).toBe(true);
});
