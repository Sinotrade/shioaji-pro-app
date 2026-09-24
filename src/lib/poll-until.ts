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
}

const sleep = (ms: number) =>
    new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

// a check that hangs must not hang the whole wait — treat it as a miss
function withAttemptTimeout<T>(
    p: Promise<T | undefined>,
    ms: number | undefined,
): Promise<T | undefined> {
    if (!ms) return p;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
        p,
        new Promise<undefined>((r) => {
            timer = setTimeout(() => r(undefined), ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

/**
 * Run `check` until it returns something other than `undefined` or the
 * deadline passes. A throwing check counts as a miss. At least one check
 * always runs; the last one lands no later than the deadline.
 */
export async function pollUntil<T>(
    check: (attempt: number) => Promise<T | undefined>,
    opts: {
        timeoutMs: number;
        schedule?: PollSchedule;
        attemptTimeoutMs?: number;
        onAttempt?: (attempt: number, elapsedMs: number) => void;
    },
): Promise<PollResult<T>> {
    const schedule = opts.schedule ?? FAST_START_SCHEDULE;
    const start = Date.now();
    const deadline = start + opts.timeoutMs;
    let attempt = 0;
    for (;;) {
        const delay = pollDelay(attempt, schedule);
        const room = deadline - Date.now();
        // always run the first check; later ones only if they fit
        if (attempt > 0 && room <= 0) {
            return {
                value: undefined,
                attempts: attempt,
                elapsedMs: Date.now() - start,
                timedOut: true,
            };
        }
        const wait = attempt > 0 ? Math.min(delay, room) : delay;
        if (wait > 0) await sleep(wait); // 0 = check in this very tick
        let value: T | undefined;
        try {
            value = await withAttemptTimeout(
                check(attempt),
                opts.attemptTimeoutMs,
            );
        } catch {
            value = undefined;
        }
        attempt += 1;
        opts.onAttempt?.(attempt, Date.now() - start);
        if (value !== undefined) {
            return {
                value,
                attempts: attempt,
                elapsedMs: Date.now() - start,
                timedOut: false,
            };
        }
    }
}
