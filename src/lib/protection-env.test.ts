import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ status: 'live', changed: [] as (() => void)[], info: vi.fn() }));
vi.mock('./runtime', () => ({ getApiBase: () => 'http://127.0.0.1:21322' }));
vi.mock('./stream', () => ({
    getStreamStatus: () => m.status,
    subscribeStatusStore: (cb: () => void) => { m.changed.push(cb); return () => undefined; },
}));
vi.mock('./shioaji', async () => {
    const store = await import('./server-info-store');
    return { fetchInfo: async () => {
        const request = store.beginServerInfoRequest();
        const info = await m.info();
        store.observeServerInfo(request, info);
        return info;
    } };
});

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
beforeEach(() => { vi.resetModules(); m.status = 'live'; m.changed = []; m.info.mockReset(); });

describe('protection environment across a same-port sim/prod switch', () => {
    it('forgets the mode when the stream drops and only a fresh /info restores it', async () => {
        const env = await import('./protection-env');
        m.info.mockResolvedValue({ simulation: true, version: '1.7.6' });
        await env.refreshProtectionEnv();
        expect(env.currentProtectionEnv()).toBe('http://127.0.0.1:21322|simulation');
        env.watchProtectionEnv();
        // an /info request started before the drop must not repopulate it
        let resolveOld!: (v: unknown) => void;
        m.info.mockImplementationOnce(() => new Promise(r => { resolveOld = r; }));
        const old = env.refreshProtectionEnv();
        m.status = 'down'; m.changed.forEach(cb => cb());
        expect(env.currentProtectionEnv()).toBeNull(); // no dispatch while unknown
        resolveOld({ simulation: true, version: '1.7.6' }); await old; await flush();
        expect(env.currentProtectionEnv()).toBeNull();
        // sidecar came back in production on the same port
        m.info.mockResolvedValue({ simulation: false, version: '1.7.6' });
        m.status = 'live'; m.changed.forEach(cb => cb()); await flush();
        expect(env.currentProtectionEnv()).toBe('http://127.0.0.1:21322|production');
    });
});
