import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('./runtime', () => ({ isTauri: true, getApiBase: () => '' }));

const values = new Map<string, string>();
beforeEach(() => {
    values.clear();
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
    });
});
afterEach(() => vi.unstubAllGlobals());

it('keeps desktop order mutations blocked until the verified boot clears the gate', async () => {
    const { serverIdentityVerified, setServerIdentityVerified } = await import('./server-identity');
    expect(serverIdentityVerified()).toBe(false);
    setServerIdentityVerified(true);
    expect(serverIdentityVerified()).toBe(true);
    setServerIdentityVerified(false);
    expect(serverIdentityVerified()).toBe(false);
});

it('invalidates the mode and retires earlier info requests when the main starts identity verification', async () => {
    const identity = await import('./server-identity');
    const info = await import('./server-info-store');
    info.observeServerInfo(info.beginServerInfoRequest(), { simulation: true } as import('./shioaji').ServerInfo);
    identity.setServerIdentityVerified(true);
    const old = info.beginServerInfoRequest();
    identity.setServerIdentityVerified(false);
    expect(info.knownServerInfo()).toBeUndefined();
    info.observeServerInfo(old, { simulation: true } as import('./shioaji').ServerInfo);
    expect(info.knownServerInfo()).toBeUndefined();
});
