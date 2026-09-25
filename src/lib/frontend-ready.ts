// src/lib/frontend-ready.ts — closes a startup timing run only when the
// front end is actually usable after the post-start reload: accounts
// loaded, first positions snapshot settled, quote/order stream live
// (issue #142). Server health alone says nothing about how long the
// panels still take to bootstrap.

import { getAccountState, subscribeAccounts } from './account-store';
import {
    endTiming,
    markStage,
    peekActiveTiming,
    subscribeTiming,
    type TimingOutcome,
    type TimingStage,
} from './startup-timing';
import { getStreamStatus, streamOpenedAt, subscribeStatusStore } from './stream';
import { getTradingState, subscribeTradingState } from './trading-state';

export interface ReadySignal {
    stage: TimingStage;
    subscribe: (fn: () => void) => () => void;
    ready: () => boolean;
    detail?: () => string | undefined;
}

// generous: covers a slow production account/positions read
export const FRONTEND_READY_TIMEOUT_MS = 60_000;

// ---- page-level main-thread stall probe ----
// A 50 ms tick that runs late was blocked by other JS (parsing, the first
// render). Started by boot at page load so the first render is measured
// even when boot-checked comes after it (the earlier busy=0 readings only
// covered the time after boot-checked, when the render was already over).
const TICK = 50;
const PROBE_MAX_MS = 90_000;
let probe: { timer: ReturnType<typeof setInterval>; stop: ReturnType<typeof setTimeout>; last: number; busy: number; max: number } | null = null;
const probeListeners = new Set<() => void>();
export function startStallProbe(): void {
    if (probe) return;
    const p = {
        last: Date.now(),
        busy: 0,
        max: 0,
        timer: setInterval(() => {
            const now = Date.now();
            const late = now - p.last - TICK;
            if (late > TICK) {
                p.busy += late;
                p.max = Math.max(p.max, late);
            }
            p.last = now;
            for (const fn of probeListeners) fn();
        }, TICK),
        stop: setTimeout(() => stopStallProbe(), PROBE_MAX_MS),
    };
    probe = p;
}
export function stopStallProbe(): void {
    if (!probe) return;
    clearInterval(probe.timer);
    clearTimeout(probe.stop);
    probe = null;
}
export function stallStats(): { busyMs: number; maxStallMs: number } {
    return { busyMs: probe?.busy ?? 0, maxStallMs: probe?.max ?? 0 };
}

/**
 * Mark each signal's stage the moment it turns ready, and end run `runId`
 * with `outcome` once all are ready — or as `partial` (listing what was
 * missing) after `timeoutMs`. Stops early if another run takes over.
 * Returns a disposer.
 */
export function watchFrontendReady(
    runId: string,
    signals: ReadySignal[],
    opts: { outcome?: TimingOutcome; timeoutMs?: number } = {},
): () => void {
    const done = new Set<ReadySignal>();
    const offs: (() => void)[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    // the stall probe (started at page load by boot, or here) also drives
    // a re-check every tick: a signal is marked when it IS ready, not only
    // when some store happens to notify
    startStallProbe();
    const tick = () => check();
    probeListeners.add(tick);
    const markStalls = ({ busyMs, maxStallMs }: ReturnType<typeof stallStats>) =>
        markStage('main-thread', `busy=${busyMs}ms maxStall=${maxStallMs}ms`, { runId });
    const dispose = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        probeListeners.delete(tick);
        stopStallProbe();
        for (const off of offs) off();
    };
    const check = () => {
        if (closed) return;
        if (peekActiveTiming()?.id !== runId) return dispose();
        for (const sig of signals) {
            if (!done.has(sig) && sig.ready()) {
                done.add(sig);
                markStage(sig.stage, sig.detail?.(), { runId });
            }
        }
        if (done.size === signals.length) {
            const stats = stallStats(); // before dispose stops the probe
            dispose(); // first: the marks below re-notify timing listeners
            markStalls(stats);
            endTiming(opts.outcome ?? 'ok', undefined, { runId });
        }
    };
    offs.push(subscribeTiming(check));
    for (const sig of signals) offs.push(sig.subscribe(check));
    timer = setTimeout(() => {
        if (closed) return;
        const missing = signals
            .filter((sig) => !done.has(sig))
            .map((sig) => sig.stage)
            .join(',');
        const stats = stallStats();
        dispose();
        markStalls(stats);
        endTiming('partial', `not ready: ${missing}`, { runId });
    }, opts.timeoutMs ?? FRONTEND_READY_TIMEOUT_MS);
    check();
    return dispose;
}

// the real app signals
export function appReadySignals(): ReadySignal[] {
    return [
        {
            stage: 'accounts-loaded',
            subscribe: subscribeAccounts,
            ready: () => getAccountState().loaded,
            detail: () => `accounts=${getAccountState().accounts.length}`,
        },
        {
            stage: 'positions-loaded',
            subscribe: subscribeTradingState,
            // a read that failed or needs reconciliation also settles the
            // first snapshot — recorded as such
            ready: () => {
                const q = getTradingState().queries.positions;
                return q.updatedAt !== null || q.needsReconcile || q.error !== null;
            },
            detail: () => {
                const q = getTradingState().queries.positions;
                return q.updatedAt !== null
                    ? undefined
                    : q.error !== null
                      ? 'error'
                      : 'needs reconcile';
            },
        },
        {
            stage: 'stream-live',
            subscribe: subscribeStatusStore,
            ready: () => getStreamStatus() === 'live',
            // how long the stream had already been open when this was marked
            detail: () => {
                const at = streamOpenedAt();
                return at === null ? undefined : `open for ${Date.now() - at}ms`;
            },
        },
    ];
}
