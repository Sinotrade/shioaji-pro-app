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
    });
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
    m.setBroadcastSettings({ enabled: true, rate: 6 });
    expect(store.get('sj-pro-broadcast')).toContain('"enabled":true');
    expect(store.get('sj-pro-broadcast')).toContain('"rate":6');
});

it('ignores a corrupted stored payload and falls back to the defaults', async () => {
    store.set('sj-pro-broadcast', '{ not json');
    const m = await import('./broadcast-settings');
    expect(m.getBroadcastSettings().enabled).toBe(false);
    expect(m.getBroadcastSettings().rate).toBe(4);
});

it('maps the WPF rate scale onto the Web Speech speed', async () => {
    const m = await import('./broadcast-settings');
    expect(m.rateToSpeed(0)).toBeCloseTo(1);
    expect(m.rateToSpeed(4)).toBeCloseTo(1.4);
    expect(m.rateToSpeed(10)).toBeCloseTo(2);
    expect(m.rateToSpeed(-10)).toBeCloseTo(0.1);
});
