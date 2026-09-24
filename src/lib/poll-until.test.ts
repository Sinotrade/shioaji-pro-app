// src/lib/poll-until.test.ts — immediate first check, early-fast/later-slow
// backoff, deadline and hung-check handling (issue #142)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    FAST_START_SCHEDULE,
    STOP_SCHEDULE,
    pollDelay,
    pollUntil,
} from './poll-until';

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
});
afterEach(() => {
    vi.useRealTimers();
});

describe('pollDelay', () => {
    it('checks at once, then 250 ms growing to a 1 s ceiling', () => {
        const delays = Array.from({ length: 7 }, (_, i) =>
            pollDelay(i, FAST_START_SCHEDULE),
        );
        expect(delays).toEqual([0, 250, 375, 563, 844, 1000, 1000]);
    });

    it('stop waits start at 100 ms and cap at the old 500 ms', () => {
        expect(
            Array.from({ length: 5 }, (_, i) => pollDelay(i, STOP_SCHEDULE)),
        ).toEqual([0, 100, 200, 400, 500]);
    });
});

describe('pollUntil', () => {
    it('runs the first check immediately — no leading interval', async () => {
        const check = vi.fn(async () => true);
        const res = await pollUntil(check, { timeoutMs: 45_000 });
        expect(check).toHaveBeenCalledTimes(1);
        expect(res).toEqual({
            value: true,
            attempts: 1,
            elapsedMs: 0,
            timedOut: false,
            cancelled: false,
        });
    });

    it('returns as soon as the check succeeds, on the backoff schedule', async () => {
        const seen: number[] = [];
        let n = 0;
        const p = pollUntil(
            async () => {
                seen.push(Date.now());
                return ++n === 4 ? 'up' : undefined;
            },
            { timeoutMs: 45_000 },
        );
        await vi.advanceTimersByTimeAsync(5000);
        const res = await p;
        expect(seen).toEqual([0, 250, 625, 1188]);
        expect(res.value).toBe('up');
        expect(res.attempts).toBe(4);
        expect(res.elapsedMs).toBe(1188);
    });

    it('beats the old fixed 1.5 s loop for a server ready at 6 s', async () => {
        const readyAt = 6000;
        const p = pollUntil(
            async () => (Date.now() >= readyAt ? true : undefined),
            { timeoutMs: 45_000 },
        );
        await vi.advanceTimersByTimeAsync(10_000);
        const res = await p;
        // old loop: first check at 1.5 s, then every 1.5 s → noticed at 6 s
        // only by luck of alignment; worst case lag was 1.5 s, now ≤ 1 s
        expect(res.elapsedMs).toBeGreaterThanOrEqual(readyAt);
        expect(res.elapsedMs - readyAt).toBeLessThanOrEqual(1000);
    });

    it('treats a throwing check as a miss', async () => {
        let n = 0;
        const p = pollUntil(
            async () => {
                if (++n < 3) throw new Error('ECONNREFUSED');
                return 'ok';
            },
            { timeoutMs: 5000 },
        );
        await vi.advanceTimersByTimeAsync(2000);
        await expect(p).resolves.toMatchObject({ value: 'ok', attempts: 3 });
    });

    it('times out at the deadline with the last check no later than it', async () => {
        const seen: number[] = [];
        const p = pollUntil(
            async () => {
                seen.push(Date.now());
                return undefined;
            },
            { timeoutMs: 5000, schedule: STOP_SCHEDULE },
        );
        await vi.advanceTimersByTimeAsync(6000);
        const res = await p;
        expect(res.timedOut).toBe(true);
        expect(res.value).toBeUndefined();
        expect(seen.at(-1)).toBe(5000);
        expect(res.elapsedMs).toBe(5000);
        // 0,100,300,700,1200 … then every 500 ms up to 5000
        expect(seen.slice(0, 5)).toEqual([0, 100, 300, 700, 1200]);
    });

    // a check that hangs until its signal aborts — like fetch({ signal })
    const hangUntilAborted = (signal: AbortSignal) =>
        new Promise<undefined>((_, reject) =>
            signal.addEventListener('abort', () => reject(new Error('aborted'))),
        );

    it('aborts a hung check at attemptTimeoutMs and only then retries', async () => {
        let n = 0;
        let inFlight = 0;
        let maxInFlight = 0;
        const signals: AbortSignal[] = [];
        const p = pollUntil(
            async (_attempt, signal) => {
                n++;
                signals.push(signal);
                inFlight++;
                maxInFlight = Math.max(maxInFlight, inFlight);
                try {
                    if (n === 1) return await hangUntilAborted(signal);
                    return true;
                } finally {
                    inFlight--;
                }
            },
            { timeoutMs: 20_000, attemptTimeoutMs: 5000 },
        );
        await vi.advanceTimersByTimeAsync(4999);
        expect(n).toBe(1);
        expect(signals[0]!.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(300);
        const res = await p;
        expect(signals[0]!.aborted).toBe(true);
        expect(res).toMatchObject({ value: true, attempts: 2 });
        expect(res.elapsedMs).toBe(5250);
        expect(maxInFlight).toBe(1);
    });

    it('never starts a new attempt while one that ignores abort still hangs', async () => {
        const check = vi.fn(() => new Promise<undefined>(() => undefined));
        const p = pollUntil(check, { timeoutMs: 20_000, attemptTimeoutMs: 5000 });
        await vi.advanceTimersByTimeAsync(25_000);
        const res = await p;
        expect(check).toHaveBeenCalledTimes(1);
        expect(res).toMatchObject({ timedOut: true, attempts: 1 });
        expect(res.elapsedMs).toBe(20_000);
    });

    it('a cancelled wait aborts the in-flight check and stops', async () => {
        const wait = new AbortController();
        let seen: AbortSignal | undefined;
        const check = vi.fn(async (_a: number, signal: AbortSignal) => {
            seen = signal;
            return hangUntilAborted(signal);
        });
        const p = pollUntil(check, { timeoutMs: 20_000, signal: wait.signal });
        await vi.advanceTimersByTimeAsync(1000);
        wait.abort();
        const res = await p;
        expect(seen!.aborted).toBe(true);
        expect(res).toMatchObject({ cancelled: true, timedOut: false });
        await vi.advanceTimersByTimeAsync(20_000);
        expect(check).toHaveBeenCalledTimes(1);
    });

    it('a wait cancelled between attempts does not check again', async () => {
        const wait = new AbortController();
        const check = vi.fn(async () => undefined);
        const p = pollUntil(check, { timeoutMs: 20_000, signal: wait.signal });
        await vi.advanceTimersByTimeAsync(100); // inside the 250 ms gap
        wait.abort();
        await expect(p).resolves.toMatchObject({ cancelled: true, attempts: 1 });
        expect(check).toHaveBeenCalledTimes(1);
    });

    it('never overlaps attempts', async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        const p = pollUntil(
            async () => {
                inFlight++;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await new Promise((r) => setTimeout(r, 2000));
                inFlight--;
                return undefined;
            },
            { timeoutMs: 10_000 },
        );
        await vi.advanceTimersByTimeAsync(20_000);
        await p;
        expect(maxInFlight).toBe(1);
    });

    it('reports each attempt with its elapsed time', async () => {
        const onAttempt = vi.fn();
        let n = 0;
        const p = pollUntil(async () => (++n === 2 ? 1 : undefined), {
            timeoutMs: 5000,
            onAttempt,
        });
        await vi.advanceTimersByTimeAsync(1000);
        await p;
        expect(onAttempt.mock.calls).toEqual([
            [1, 0],
            [2, 250],
        ]);
    });
});
