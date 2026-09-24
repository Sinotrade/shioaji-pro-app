// src/lib/poll-until.ts — sequential poll with an early-fast, later-slow
// schedule, shared by the sidecar start/stop/health waits (issue #142).
//
// The old loops slept a full interval BEFORE the first check (1.5 s for the
// spawn wait, 2 s for the post-start health reload) and polled at a fixed
// rate. Checking immediately and tightening the early intervals trims the
// dead time between "server is ready" and "the app notices", without adding
// load once a wait turns long: the interval backs off to the old rate.
// Attempts never overlap — a new probe starts only after the previous one
// settled — so a congested plugin-http queue is never piled onto.

export interface PollSchedule {
    initialDelayMs: number; // wait before the FIRST check (0 = immediately)
    firstIntervalMs: number; // wait after the first miss
    maxIntervalMs: number; // backoff ceiling
    factor: number; // interval growth per miss
}

// sidecar listener / health waits: immediate first probe, 250 ms → 1 s
export const FAST_START_SCHEDULE: PollSchedule = {
    initialDelayMs: 0,
    firstIntervalMs: 250,
    maxIntervalMs: 1000,
    factor: 1.5,
};

// waiting for a killed server to stop answering
export const STOP_SCHEDULE: PollSchedule = {
    initialDelayMs: 0,
    firstIntervalMs: 100,
    maxIntervalMs: 500,
    factor: 2,
};

/** Delay before attempt `n` (0-based): the initial delay for the first
 * attempt, then firstIntervalMs × factor^(n-1), capped at maxIntervalMs. */
export function pollDelay(attempt: number, s: PollSchedule): number {
    if (attempt <= 0) return s.initialDelayMs;
    return Math.min(
        s.maxIntervalMs,
        Math.round(s.firstIntervalMs * s.factor ** (attempt - 1)),
    );
}

export interface PollResult<T> {
    value: T | undefined; // the first non-undefined check result
    attempts: number;
    elapsedMs: number; // from the call until the deciding check settled
    timedOut: boolean;
    cancelled: boolean; // opts.signal aborted the whole wait
}

// resolves after `ms`, or early (false) when `signal` aborts
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
        if (signal?.aborted) return resolve(false);
        const onAbort = () => {
            clearTimeout(timer);
            resolve(false);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve(true);
        }, Math.max(0, ms));
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Run `check` until it returns something other than `undefined` or the
 * deadline passes. A throwing check counts as a miss. At least one check
 * always runs; the last one lands no later than the deadline.
 *
 * Each attempt gets its own AbortSignal. When `attemptTimeoutMs` elapses
 * (or the whole wait is cancelled) that signal aborts, and the next attempt
 * starts only after the aborted one has SETTLED — a check that forwards the
 * signal to fetch therefore never overlaps the next one. A check that
 * ignores its signal still cannot hold the wait past the deadline.
 */
export async function pollUntil<T>(
    check: (attempt: number, signal: AbortSignal) => Promise<T | undefined>,
    opts: {
        timeoutMs: number;
        schedule?: PollSchedule;
        attemptTimeoutMs?: number;
        signal?: AbortSignal; // cancels the whole wait
        onAttempt?: (attempt: number, elapsedMs: number) => void;
    },
): Promise<PollResult<T>> {
    const schedule = opts.schedule ?? FAST_START_SCHEDULE;
    const start = Date.now();
    const deadline = start + opts.timeoutMs;
    let attempt = 0;
    const result = (
        value: T | undefined,
        timedOut: boolean,
        cancelled = false,
    ): PollResult<T> => ({
        value,
        attempts: attempt,
        elapsedMs: Date.now() - start,
        timedOut,
        cancelled,
    });
    for (;;) {
        if (opts.signal?.aborted) return result(undefined, false, true);
        const delay = pollDelay(attempt, schedule);
        const room = deadline - Date.now();
        // always run the first check; later ones only if they fit
        if (attempt > 0 && room <= 0) return result(undefined, true);
        const wait = attempt > 0 ? Math.min(delay, room) : delay;
        // 0 = check in this very tick
        if (wait > 0 && !(await sleep(wait, opts.signal))) {
            return result(undefined, false, true);
        }
        const controller = new AbortController();
        const abort = () => controller.abort();
        opts.signal?.addEventListener('abort', abort, { once: true });
        const timer = opts.attemptTimeoutMs
            ? setTimeout(abort, opts.attemptTimeoutMs)
            : undefined;
        let value: T | undefined;
        let settled = false;
        const attemptPromise = (async () => {
            try {
                return await check(attempt, controller.signal);
            } catch {
                return undefined;
            } finally {
                settled = true;
            }
        })();
        // a check that ignores its signal: give up on it at the deadline
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        const outOfTime = new Promise<undefined>((r) => {
            deadlineTimer = setTimeout(
                () => r(undefined),
                Math.max(0, deadline - Date.now()),
            );
        });
        try {
            value = await Promise.race([attemptPromise, outOfTime]);
        } finally {
            clearTimeout(timer);
            clearTimeout(deadlineTimer);
            opts.signal?.removeEventListener('abort', abort);
        }
        attempt += 1;
        opts.onAttempt?.(attempt, Date.now() - start);
        if (controller.signal.aborted && opts.signal?.aborted) {
            return result(undefined, false, true);
        }
        if (value !== undefined) return result(value, false);
        if (!settled) {
            // still hanging past the deadline: never start another attempt
            controller.abort();
            return result(undefined, true);
        }
    }
}
