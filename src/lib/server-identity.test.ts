import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('./runtime', () => ({ isTauri: true }));

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
