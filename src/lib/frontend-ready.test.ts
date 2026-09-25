// src/lib/frontend-ready.test.ts — a post-start run ends only once accounts,
// positions and the live stream are all in (issue #142)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./account-store', () => ({ getAccountState: vi.fn(), subscribeAccounts: vi.fn() }));
vi.mock('./stream', () => ({ getStreamStatus: vi.fn(), subscribeStatusStore: vi.fn(), streamOpenedAt: vi.fn() }));
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
    it('marks a signal within one tick even if its store never notifies', () => {
        timing.beginTiming('cold-start');
        const id = timing.getActiveTiming()!.id;
        let live = false;
        const silent: Signal = { stage: 'stream-live', subscribe: () => () => undefined, ready: () => live };
        watchFrontendReady(id, [silent]);
        vi.advanceTimersByTime(1000);
        expect(timing.getActiveTiming()).not.toBeNull();
        live = true; // flipped with no notification
        vi.advanceTimersByTime(50);
        const run = timing.getTimingHistory()[0]!;
        expect(run.outcome).toBe('ok');
        expect(run.marks.find((m) => m.stage === 'stream-live')!.at).toBe(1050);
    });

    it('reports how long the main thread was blocked while waiting', () => {
        timing.beginTiming('restart');
        const id = timing.getActiveTiming()!.id;
        const live = signal('stream-live');
        watchFrontendReady(id, [live.sig]);
        vi.advanceTimersByTime(200);
        // a 1.2 s synchronous render: timers resume only afterwards
        vi.setSystemTime(Date.now() + 1200);
        vi.advanceTimersByTime(50);
        live.set();
        const run = timing.getTimingHistory()[0]!;
        const detail = run.marks.find((m) => m.stage === 'main-thread')!.detail!;
        const [, busy, max] = /busy=(\d+)ms maxStall=(\d+)ms/.exec(detail)!.map(Number);
        expect(max).toBeGreaterThanOrEqual(1100);
        expect(busy).toBeGreaterThanOrEqual(max!);
    });

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
            ['main-thread', 2000],
        ]);
        // fake timers never run late: no stall recorded
        expect(run.marks.at(-1)!.detail).toBe('busy=0ms maxStall=0ms');
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
