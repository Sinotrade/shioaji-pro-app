// src/lib/startup-probes.test.ts — start-path pre-checks from the issue #142
// native measurements: no 20 s wait for a spawn that no longer exists, no
// HTTP sweep of free ports, no fixed restart settle

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    boundPorts,
    freePortAfterStop,
    waitForRememberedSpawn,
} from './startup-probes';

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe('waitForRememberedSpawn', () => {
    it('relaunch: the remembered sidecar exited with the old App — no wait at all', async () => {
        const probe = vi.fn(async () => null);
        const res = await waitForRememberedSpawn({ probe, alive: async () => false });
        expect(res).toEqual({ kind: 'dead', attempts: 0 });
        expect(probe).not.toHaveBeenCalled();
        expect(Date.now()).toBe(0); // was: 20 s (native cold start 28.4 s)
    });

    it('reload during login: waits for the live spawn and returns its answer', async () => {
        let t = 0;
        const probe = vi.fn(async () => (Date.now() >= 6000 ? { port: 21322 } : null));
        const alive = vi.fn(async () => {
            t++;
            return true;
        });
        let at = -1;
        const p = waitForRememberedSpawn({ probe, alive }).finally(() => { at = Date.now(); });
        await vi.advanceTimersByTimeAsync(10_000);
        const res = await p;
        expect(res).toMatchObject({ kind: 'answered', hit: { port: 21322 } });
        expect(at).toBeGreaterThanOrEqual(6000);
        expect(at).toBeLessThanOrEqual(7000);
        // liveness at most once per 1.5 s (+ the up-front check)
        expect(t).toBeLessThanOrEqual(1 + 4);
    });

    it('stops waiting soon after the process dies mid-wait', async () => {
        let dead = false;
        let at = -1;
        const p = waitForRememberedSpawn({
            probe: async () => null,
            alive: async () => !dead,
        }).finally(() => { at = Date.now(); });
        await vi.advanceTimersByTimeAsync(3000);
        dead = true;
        await vi.advanceTimersByTimeAsync(5000);
        const res = await p;
        expect(res.kind).toBe('dead');
        expect(at).toBeLessThanOrEqual(3000 + 1500 + 1000);
    });

    it('an unknown liveness (IPC failure → true) keeps the old 20 s budget', async () => {
        const p = waitForRememberedSpawn({ probe: async () => null, alive: async () => true });
        await vi.advanceTimersByTimeAsync(40_000);
        await expect(p).resolves.toMatchObject({ kind: 'timeout' });
    });
});

describe('boundPorts', () => {
    it('keeps only ports find_free_port reports as taken', async () => {
        const taken = new Set([21324]);
        const ffp = vi.fn(async (p: number) => (taken.has(p) ? p + 1 : p));
        expect(await boundPorts([21323, 21324, 21325], ffp)).toEqual([21324]);
        expect(ffp).toHaveBeenCalledTimes(3);
    });

    it('nothing bound → nothing to probe', async () => {
        expect(await boundPorts([8081, 8082], async (p) => p)).toEqual([]);
    });

    it('an older shell without the command → null (probe every port)', async () => {
        const ffp = async () => {
            throw new Error('command find_free_port not found');
        };
        expect(await boundPorts([8081], ffp)).toBeNull();
    });
});

describe('freePortAfterStop', () => {
    it('free at once: no wait (was a fixed 1.2 s settle on every restart)', async () => {
        const ffp = vi.fn(async (p: number) => p);
        expect(await freePortAfterStop(21322, ffp)).toEqual({ port: 21322, attempts: 1, elapsedMs: 0 });
        expect(ffp).toHaveBeenCalledTimes(1);
    });

    it('still bound right after the stop: polls until it frees', async () => {
        const ffp = vi.fn(async (p: number) => (Date.now() >= 300 ? p : p + 1));
        const pending = freePortAfterStop(21322, ffp);
        await vi.advanceTimersByTimeAsync(2000);
        const res = await pending;
        expect(res.port).toBe(21322);
        expect(res.elapsedMs).toBeGreaterThanOrEqual(300);
        expect(res.elapsedMs).toBeLessThan(700);
    });

    it('never frees: gives up after the budget with the fallback port', async () => {
        const pending = freePortAfterStop(21322, async (p) => p + 1);
        await vi.advanceTimersByTimeAsync(10_000);
        const res = await pending;
        expect(res.port).toBe(21323);
        expect(res.elapsedMs).toBeLessThanOrEqual(1200 + 100);
    });

    it('no recent stop (budget 0): a single check, as before', async () => {
        const ffp = vi.fn(async (p: number) => p + 1);
        expect((await freePortAfterStop(21322, ffp, 0)).port).toBe(21323);
        expect(ffp).toHaveBeenCalledTimes(1);
    });

    it('a failing command propagates so the caller keeps its fallback', async () => {
        await expect(
            freePortAfterStop(21322, async () => {
                throw new Error('unknown command');
            }),
        ).rejects.toThrow('unknown command');
    });
});
