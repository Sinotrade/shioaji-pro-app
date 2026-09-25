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
    // main-thread stall probe: a 50 ms tick that runs late was blocked by
    // other JS (rendering, parsing). An EventSource `open` or first event
    // that arrives meanwhile is only handled after the stall, so this tells
    // "the stream was slow" apart from "the page was busy" (#142).
    const TICK = 50;
    let lastTick = Date.now();
    let busyMs = 0;
    let maxStallMs = 0;
    const stall = setInterval(() => {
        const now = Date.now();
        const late = now - lastTick - TICK;
        if (late > TICK) {
            busyMs += late;
            maxStallMs = Math.max(maxStallMs, late);
        }
        lastTick = now;
        // also re-evaluate every tick: a signal must be marked when it IS
        // ready, not only when some store happens to notify (#142: a
        // subscription that missed or preceded a transition left
        // stream-live marked seconds after the stream was actually open)
        check();
    }, TICK);
    const markStalls = () =>
        markStage('main-thread', `busy=${busyMs}ms maxStall=${maxStallMs}ms`, { runId });
    const dispose = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        clearInterval(stall);
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
            dispose(); // first: the marks below re-notify timing listeners
            markStalls();
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
        dispose();
        markStalls();
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
