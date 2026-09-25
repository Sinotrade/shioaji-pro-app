// src/lib/reload-when-healthy.test.ts — post-start health reload checks at
// once instead of after a 2 s interval, and records its stages (issue #142)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchHealth } = vi.hoisted(() => ({ fetchHealth: vi.fn() }));
vi.mock('./shioaji', () => ({ fetchHealth }));
vi.mock('./trade', () => ({ notify: vi.fn() }));

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
};
const reload = vi.fn();
(globalThis as { window?: unknown }).window = Object.assign(
    (globalThis as { window?: object }).window ?? {},
    { location: { reload } },
);

const { reloadWhenHealthy } = await import('./tauri');
const timing = await import('./startup-timing');

beforeEach(() => {
    store.clear();
    timing.__resetTimingForTest();
    fetchHealth.mockReset();
    reload.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('reloadWhenHealthy', () => {
    it('reloads on the first check when the server is already healthy', async () => {
        fetchHealth.mockResolvedValue({ status: 'healthy' });
        timing.beginTiming('restart');
        expect(await reloadWhenHealthy()).toBe(true);
        expect(fetchHealth).toHaveBeenCalledTimes(1);
        expect(reload).toHaveBeenCalledTimes(1);
        expect(Date.now()).toBe(0); // no leading 2 s wait
        expect(timing.getActiveTiming()!.marks.map((m) => m.stage)).toEqual([
            'wait-health',
            'healthy',
            'reload',
        ]);
    });

    it('keeps polling quickly until /health answers', async () => {
        fetchHealth
            .mockRejectedValueOnce(new Error('down'))
            .mockRejectedValueOnce(new Error('down'))
            .mockResolvedValue({ status: 'healthy' });
        const done = reloadWhenHealthy();
        await vi.advanceTimersByTimeAsync(1000);
        await done;
        expect(fetchHealth).toHaveBeenCalledTimes(3);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('gives up at the deadline and closes the run as failed', async () => {
        fetchHealth.mockRejectedValue(new Error('down'));
        timing.beginTiming('start');
        const done = reloadWhenHealthy(3000);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(await done).toBe(false); // boot falls back to its watchdog
        expect(reload).not.toHaveBeenCalled();
        expect(timing.getTimingHistory()[0]).toMatchObject({
            scenario: 'start',
            outcome: 'failed',
        });
    });

    it('a restart during a never-healthy wait is not closed by the old timeout', async () => {
        fetchHealth.mockRejectedValue(new Error('down'));
        timing.beginTiming('start');
        const first = reloadWhenHealthy(); // 90 s budget
        await vi.advanceTimersByTimeAsync(80_000);
        // the user clicks 重啟 at 80 s: a new run begins …
        timing.beginTiming('restart', { replace: true });
        const restartId = timing.getActiveTiming()!.id;
        expect(await first).toBe(false); // … which cancels the old wait at once
        await vi.advanceTimersByTimeAsync(20_000); // past the old deadline
        const run = timing.getActiveTiming();
        expect(run?.id).toBe(restartId);
        expect(run?.outcome).toBeUndefined();
        expect(timing.getTimingHistory()[0]).toMatchObject({
            scenario: 'start',
            outcome: 'abandoned',
        });
        expect(reload).not.toHaveBeenCalled();
    });

    it('a newer wait cancels the older one; only the newer reloads', async () => {
        fetchHealth.mockRejectedValue(new Error('down'));
        const first = reloadWhenHealthy();
        await vi.advanceTimersByTimeAsync(2000);
        const calls = fetchHealth.mock.calls.length;
        fetchHealth.mockResolvedValue({ status: 'healthy' });
        const second = reloadWhenHealthy();
        await first;
        await second;
        expect(reload).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(5000);
        expect(fetchHealth.mock.calls.length).toBe(calls + 1);
    });

    it('aborts a hung /health probe before the next one — never overlapping', async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        let n = 0;
        fetchHealth.mockImplementation(({ signal }: { signal: AbortSignal }) => {
            n++;
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            const done = () => inFlight--;
            if (n === 1) {
                return new Promise((_, reject) =>
                    signal.addEventListener('abort', () => {
                        done();
                        reject(new Error('aborted'));
                    }),
                );
            }
            done();
            return Promise.resolve({ status: 'healthy' });
        });
        const p = reloadWhenHealthy();
        await vi.advanceTimersByTimeAsync(4999);
        expect(n).toBe(1);
        await vi.advanceTimersByTimeAsync(300);
        await p;
        expect(fetchHealth.mock.calls[0]![0].signal.aborted).toBe(true);
        expect(n).toBe(2);
        expect(maxInFlight).toBe(1);
        expect(reload).toHaveBeenCalledTimes(1);
    });
});
