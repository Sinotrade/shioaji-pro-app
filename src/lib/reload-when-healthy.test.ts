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
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('reloadWhenHealthy', () => {
    it('reloads on the first check when the server is already healthy', async () => {
        fetchHealth.mockResolvedValue({ status: 'healthy' });
        timing.beginTiming('restart');
        await reloadWhenHealthy();
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
        await vi.advanceTimersByTimeAsync(4000);
        await done;
        expect(reload).not.toHaveBeenCalled();
        expect(timing.getTimingHistory()[0]).toMatchObject({
            scenario: 'start',
            outcome: 'failed',
        });
    });
});
