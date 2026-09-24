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

    it('a hung check counts as a miss after attemptTimeoutMs', async () => {
        let n = 0;
        const p = pollUntil(
            () =>
                ++n === 1
                    ? new Promise<boolean | undefined>(() => undefined)
                    : Promise.resolve(true),
            { timeoutMs: 20_000, attemptTimeoutMs: 5000 },
        );
        await vi.advanceTimersByTimeAsync(4999);
        expect(n).toBe(1);
        await vi.advanceTimersByTimeAsync(300);
        const res = await p;
        expect(res).toMatchObject({ value: true, attempts: 2 });
        expect(res.elapsedMs).toBe(5250);
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
