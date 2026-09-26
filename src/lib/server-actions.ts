// src/lib/server-actions.ts — the timed lifecycle of the server manager's
// 啟動／重啟／停止 actions (issue #142). The component keeps notifications
// and busy state; these own the timing run so every branch — success,
// failure, attach, exception — closes the run it opened.

import {
    beginTiming,
    endTiming,
    markStage,
    peekActiveTiming,
    type TimingScenario,
} from './startup-timing';
import type { DesktopSettings, SidecarResult, StartResult } from './tauri';
import { setServerIdentityVerified } from './server-identity';

export interface ServerActionDeps {
    serverStart: (cfg: DesktopSettings) => Promise<StartResult>;
    serverStop: (opts: { stopAgents: boolean }) => Promise<SidecarResult>;
    reloadWhenHealthy: () => Promise<unknown>;
    scheduleReload: (delayMs: number) => void;
    reloadAfterFailedStop: () => void;
}

/** Start (or, nested inside a restart, continue) a run and hand it on:
 * a fresh spawn to the health wait, an already healthy attach to a reload;
 * a failure ends it here. Rethrows after closing the run. */
export async function timedStart(
    cfg: DesktopSettings,
    scenario: TimingScenario,
    deps: ServerActionDeps,
    nested = false,
): Promise<StartResult> {
    if (!nested) beginTiming(scenario, { replace: true });
    setServerIdentityVerified(false);
    const runId = peekActiveTiming()?.id;
    let res: StartResult;
    try {
        res = await deps.serverStart(cfg);
    } catch (e) {
        endTiming('failed', 'start threw', { runId });
        throw e;
    }
    if (!res.ok) {
        endTiming('failed', undefined, { runId });
    } else if (!res.attached) {
        // /info can answer before the broker session is usable. A changed
        // port/scheme is no reason to reload early or sleep a fixed 1.8 s.
        void deps.reloadWhenHealthy();
    } else {
        // serverStart only attaches after a successful /health body check,
        // but this page can still show accounts from the previous listener.
        // Reload immediately so boot re-verifies identity and snapshots.
        markStage('healthy', 'attached server', { runId });
        markStage('reload', res.portChanged ? 'port/scheme moved' : 'attached server', { runId });
        deps.scheduleReload(0);
    }
    return res;
}

/** Boot autostart: the cold-start (or continued) run is closed as failed
 * when serverStart fails OR throws — a throw used to fall into boot's
 * generic catch and leave the run open until it went stale. */
export async function timedAutostart(
    start: () => Promise<StartResult>,
): Promise<StartResult> {
    // no run at boot (timing unavailable) → nothing of ours to close; an
    // unpinned end would hit whatever run the user started meanwhile
    const runId = peekActiveTiming()?.id;
    let res: StartResult;
    try {
        res = await start();
    } catch (e) {
        if (runId) endTiming('failed', 'autostart threw', { runId });
        throw e;
    }
    if (!res.ok && runId) endTiming('failed', 'autostart', { runId });
    return res;
}

/** First-run setup: save, then start timed as `onboarding`. A failed
 * save opens no run, so it must not end one (the user's may be open). */
export async function timedOnboarding(deps: {
    save: () => Promise<void>;
    start: () => Promise<StartResult>;
    reloadWhenHealthy: () => Promise<unknown>;
}): Promise<StartResult> {
    let runId: string | undefined;
    try {
        await deps.save();
        beginTiming('onboarding', { replace: true });
        setServerIdentityVerified(false);
        runId = peekActiveTiming()?.id;
        const res = await deps.start();
        if (!res.ok) endTiming('failed', undefined, { runId });
        else void deps.reloadWhenHealthy();
        return res;
    } catch (e) {
        if (runId) endTiming('failed', 'onboarding threw', { runId });
        throw e;
    }
}

export async function timedStop(deps: ServerActionDeps): Promise<SidecarResult> {
    beginTiming('stop', { replace: true });
    setServerIdentityVerified(false);
    const runId = peekActiveTiming()?.id;
    try {
        const res = await deps.serverStop({ stopAgents: true });
        endTiming(res.ok ? 'ok' : 'failed', undefined, { runId });
        if (!res.ok) deps.reloadAfterFailedStop();
        return res;
    } catch (e) {
        endTiming('failed', 'stop threw', { runId });
        deps.reloadAfterFailedStop();
        throw e;
    }
}

/** Stop, then `start` (the component's nested doStart, which
 * closes the run through timedStart). A refused stop ends the run. */
export async function timedRestart(
    scenario: TimingScenario,
    deps: ServerActionDeps,
    start: () => Promise<boolean>,
): Promise<{ stopped: SidecarResult; started: boolean }> {
    beginTiming(scenario, { replace: true });
    setServerIdentityVerified(false);
    const runId = peekActiveTiming()?.id;
    try {
        const stopped = await deps.serverStop({ stopAgents: true });
        if (!stopped.ok) {
            endTiming('failed', 'stop refused', { runId });
            deps.reloadAfterFailedStop();
            return { stopped, started: false };
        }
        // no fixed settle any more (was 1.2 s): serverStop returns once the
        // old server stopped answering, and serverStart re-checks the port
        // right after a stop, waiting only while it is really still taken
        return { stopped, started: await start() };
    } catch (e) {
        endTiming('failed', 'restart threw', { runId });
        deps.reloadAfterFailedStop();
        throw e;
    }
}
