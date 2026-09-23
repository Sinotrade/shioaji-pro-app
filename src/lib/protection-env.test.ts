import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ status: 'live', changed: [] as (() => void)[], info: vi.fn() }));
vi.mock('./runtime', () => ({ getApiBase: () => 'http://127.0.0.1:21322' }));
vi.mock('./stream', () => ({
    getStreamStatus: () => m.status,
    subscribeStatusStore: (cb: () => void) => { m.changed.push(cb); return () => undefined; },
}));
vi.mock('./shioaji', () => {
    return { fetchInfo: async () => {
        const store = await import('./server-info-store'); // current module registry
        const request = store.beginServerInfoRequest();
        const info = await m.info();
        store.observeServerInfo(request, info);
        return info;
    } };
});

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
beforeEach(() => { vi.resetModules(); m.status = 'live'; m.changed = []; m.info.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe('protection environment across a same-port sim/prod switch', () => {
    it('forgets the mode when the stream drops and only a fresh /info restores it', async () => {
        const env = await import('./protection-env');
        m.info.mockResolvedValue({ simulation: true, version: '1.7.6' });
        await env.refreshProtectionEnv();
        expect(env.currentProtectionEnv()).toBe('http://127.0.0.1:21322|simulation');
        env.watchProtectionEnv();
        // an /info request started before the drop must not repopulate it
        let resolveOld: ((v: unknown) => void) | undefined;
        m.info.mockImplementationOnce(() => new Promise(r => { resolveOld = r; }));
        const old = env.refreshProtectionEnv();
        await vi.waitFor(() => expect(resolveOld).toBeTypeOf('function')); // the old request has started
        m.status = 'down'; m.changed.forEach(cb => cb());
        expect(env.currentProtectionEnv()).toBeNull(); // no dispatch while unknown
        resolveOld!({ simulation: true, version: '1.7.6' }); await old; await flush();
        expect(env.currentProtectionEnv()).toBeNull();
        // sidecar came back in production on the same port
        m.info.mockResolvedValue({ simulation: false, version: '1.7.6' });
        m.status = 'live'; m.changed.forEach(cb => cb());
        await vi.waitFor(() => expect(env.currentProtectionEnv()).toBe('http://127.0.0.1:21322|production'));
    });

    it('keeps retrying /info with backoff while LIVE and the mode is unknown; stops when the stream drops', async () => {
        vi.useFakeTimers();
        const env = await import('./protection-env');
        m.info.mockRejectedValue(new Error('booting'));
        env.watchProtectionEnv();
        await vi.advanceTimersByTimeAsync(0);
        expect(m.info).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1000);
        expect(m.info).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(2000);
        expect(m.info).toHaveBeenCalledTimes(3);
        expect(env.currentProtectionEnv()).toBeNull(); // protection paused
        m.info.mockResolvedValue({ simulation: false, version: '1.7.6' });
        await vi.advanceTimersByTimeAsync(5000);
        await vi.advanceTimersByTimeAsync(0);
        expect(m.info).toHaveBeenCalledTimes(4);
        expect(env.currentProtectionEnv()).toBe('http://127.0.0.1:21322|production');
        const calls = m.info.mock.calls.length;
        await vi.advanceTimersByTimeAsync(120_000);
        expect(m.info).toHaveBeenCalledTimes(calls); // known → no more requests
        // stream drops: mode forgotten, and no retries while down
        m.status = 'down'; m.changed.forEach(cb => cb());
        await vi.advanceTimersByTimeAsync(120_000);
        expect(m.info).toHaveBeenCalledTimes(calls);
    });

    it('caps the backoff at 30s', async () => {
        const env = await import('./protection-env');
        expect(Math.max(...env.MODE_RETRY_MS)).toBe(30000);
    });
});

