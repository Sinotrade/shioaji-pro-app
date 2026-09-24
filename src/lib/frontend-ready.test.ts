// src/lib/frontend-ready.test.ts — a post-start run ends only once accounts,
// positions and the live stream are all in (issue #142)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./account-store', () => ({ getAccountState: vi.fn(), subscribeAccounts: vi.fn() }));
vi.mock('./stream', () => ({ getStreamStatus: vi.fn(), subscribeStatusStore: vi.fn() }));
vi.mock('./trading-state', () => ({ getTradingState: vi.fn(), subscribeTradingState: vi.fn() }));

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
};

const timing = await import('./startup-timing');
const { watchFrontendReady } = await import('./frontend-ready');
type Signal = Parameters<typeof watchFrontendReady>[1][number];

// a controllable signal
function signal(stage: Signal['stage']) {
    let ready = false;
    const fns = new Set<() => void>();
    return {
        sig: {
            stage,
            subscribe: (fn: () => void) => {
                fns.add(fn);
                return () => fns.delete(fn);
            },
            ready: () => ready,
        } satisfies Signal,
        set() {
            ready = true;
            for (const fn of fns) fn();
        },
        listeners: () => fns.size,
    };
}

beforeEach(() => {
    store.clear();
    timing.__resetTimingForTest();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('watchFrontendReady', () => {
    it('marks each signal as it arrives and ends when all are in', () => {
        timing.beginTiming('restart');
        const id = timing.getActiveTiming()!.id;
        const acc = signal('accounts-loaded');
        const pos = signal('positions-loaded');
        const live = signal('stream-live');
        watchFrontendReady(id, [acc.sig, pos.sig, live.sig]);
        vi.advanceTimersByTime(400);
        acc.set();
        vi.advanceTimersByTime(1100);
        live.set();
        expect(timing.getActiveTiming()).not.toBeNull();
        vi.advanceTimersByTime(500);
        pos.set();
        const run = timing.getTimingHistory()[0]!;
        expect(run).toMatchObject({ scenario: 'restart', outcome: 'ok', endedAt: 2000 });
        expect(run.marks.map((m) => [m.stage, m.at])).toEqual([
            ['accounts-loaded', 400],
            ['stream-live', 1500],
            ['positions-loaded', 2000],
        ]);
        expect(acc.listeners()).toBe(0);
    });

    it('ends as partial listing what never arrived', () => {
        timing.beginTiming('cold-start');
        const id = timing.getActiveTiming()!.id;
        const acc = signal('accounts-loaded');
        const live = signal('stream-live');
        watchFrontendReady(id, [acc.sig, live.sig], { timeoutMs: 60_000 });
        acc.set();
        vi.advanceTimersByTime(60_000);
        expect(timing.getTimingHistory()[0]).toMatchObject({
            outcome: 'partial',
            detail: 'not ready: stream-live',
        });
    });

    it('keeps the given outcome (attached) and ends at once if already ready', () => {
        timing.beginTiming('cold-start');
        const id = timing.getActiveTiming()!.id;
        const acc = signal('accounts-loaded');
        acc.set();
        watchFrontendReady(id, [acc.sig], { outcome: 'attached' });
        expect(timing.getTimingHistory()[0]!.outcome).toBe('attached');
    });

    it('stops watching when another run takes over', () => {
        timing.beginTiming('start');
        const id = timing.getActiveTiming()!.id;
        const acc = signal('accounts-loaded');
        watchFrontendReady(id, [acc.sig]);
        timing.beginTiming('stop', { replace: true });
        expect(acc.listeners()).toBe(0);
        acc.set();
        vi.advanceTimersByTime(120_000);
        expect(timing.getActiveTiming()!.scenario).toBe('stop');
        expect(timing.getActiveTiming()!.marks).toEqual([]);
    });
});
