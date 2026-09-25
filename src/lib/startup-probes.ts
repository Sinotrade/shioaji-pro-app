// src/lib/startup-probes.ts — the cheap pre-checks that keep the sidecar
// start path from waiting on things that are not there (issue #142 native
// measurements). Pure over injected probes so each decision is testable;
// src/lib/tauri.ts wires them to the native commands.

import { STOP_SCHEDULE, pollUntil, throttled } from './poll-until';

const PROCESS_ALIVE_INTERVAL_MS = 1500;

export type WarmingOutcome<T> =
    | { kind: 'answered'; hit: T; attempts: number }
    | { kind: 'dead'; attempts: number } // the remembered process is gone
    | { kind: 'timeout'; attempts: number };

/**
 * A spawn this App remembers may still be inside its login window (the
 * sidecar binds only after login), so a reload must wait for it instead of
 * killing it. But the record also survives an App quit: on relaunch the
 * remembered process has usually exited with the old App, and the old code
 * then sat out the full 20 s (native measurement: cold start 28.4 s, 20.2 s
 * of it here). Check liveness first and keep checking while waiting, so a
 * process that is gone — or dies mid-wait — ends the wait at once.
 * `alive` resolving true on an IPC error keeps the old wait (fail safe).
 */
export async function waitForRememberedSpawn<T>(deps: {
    probe: () => Promise<T | null>;
    alive: () => Promise<boolean>;
    timeoutMs?: number;
}): Promise<WarmingOutcome<T>> {
    if (!(await deps.alive())) return { kind: 'dead', attempts: 0 };
    const alive = throttled(deps.alive, PROCESS_ALIVE_INTERVAL_MS, true);
    const res = await pollUntil<{ hit: T } | 'dead'>(
        async () => {
            const hit = await deps.probe();
            if (hit) return { hit };
            return (await alive()) ? undefined : 'dead';
        },
        // a probe = up to two 5 s requests (http, https): a last one started
        // before the deadline is awaited up to 15 s past it
        { timeoutMs: deps.timeoutMs ?? 20_000, attemptTimeoutMs: 15_000 },
    );
    if (res.value === 'dead') return { kind: 'dead', attempts: res.attempts };
    if (res.value) {
        return { kind: 'answered', hit: res.value.hit, attempts: res.attempts };
    }
    return { kind: 'timeout', attempts: res.attempts };
}

/**
 * Which of `ports` have a listener, by the same bind test the native
 * `find_free_port` uses to pick a port (it returns the port itself when it
 * is free). One cheap local call per port instead of two HTTP probes per
 * port through plugin-http: the orphan sweep only probes ports that are
 * actually bound. Returns null when the command is unavailable, and the
 * caller falls back to probing every port.
 */
export async function boundPorts(
    ports: number[],
    findFreePort: (preferred: number) => Promise<number>,
): Promise<number[] | null> {
    try {
        const free = await Promise.all(ports.map((p) => findFreePort(p)));
        return ports.filter((p, i) => free[i] !== p);
    } catch {
        return null;
    }
}

/**
 * Right after stopping our own server its port can take a moment to be
 * bindable again. Instead of the old fixed 1.2 s sleep before every
 * restart, check at once and poll briefly (≤ `timeoutMs`, 2.5 s) only while the
 * preferred port is still taken; returns what find_free_port last chose.
 */
export async function freePortAfterStop(
    preferred: number,
    findFreePort: (preferred: number) => Promise<number>,
    timeoutMs = 2500,
): Promise<{ port: number; attempts: number; elapsedMs: number }> {
    const start = Date.now();
    // the first call may throw (older shell): the caller keeps its fallback
    let last = await findFreePort(preferred);
    if (last === preferred || timeoutMs <= 0) {
        return { port: last, attempts: 1, elapsedMs: 0 };
    }
    const res = await pollUntil(
        async () => {
            last = await findFreePort(preferred);
            return last === preferred ? last : undefined;
        },
        { timeoutMs, schedule: { ...STOP_SCHEDULE, initialDelayMs: 100 } },
    );
    return {
        port: res.value ?? last,
        attempts: res.attempts + 1,
        elapsedMs: Date.now() - start,
    };
}
