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

export interface ServerActionDeps {
    serverStart: (cfg: DesktopSettings) => Promise<StartResult>;
    serverStop: (opts: { stopAgents: boolean }) => Promise<SidecarResult>;
    reloadWhenHealthy: () => Promise<unknown>;
    scheduleReload: (delayMs: number) => void;
    sleep: (ms: number) => Promise<void>;
}

/** Start (or, nested inside a restart, continue) a run and hand it on:
 * a fresh spawn to the health wait, a moved port to the reload; an
 * attach or failure ends it here. Rethrows after closing the run. */
export async function timedStart(
    cfg: DesktopSettings,
    scenario: TimingScenario,
    deps: ServerActionDeps,
    nested = false,
): Promise<StartResult> {
    if (!nested) beginTiming(scenario, { replace: true });
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
    } else if (res.portChanged) {
        // boot closes the run after the reload
        markStage('reload', 'port/scheme moved', { runId });
        deps.scheduleReload(1800);
    } else if (!res.attached) {
        void deps.reloadWhenHealthy();
    } else {
        endTiming('attached', undefined, { runId });
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
    const runId = peekActiveTiming()?.id;
    try {
        const res = await deps.serverStop({ stopAgents: true });
        endTiming(res.ok ? 'ok' : 'failed', undefined, { runId });
        return res;
    } catch (e) {
        endTiming('failed', 'stop threw', { runId });
        throw e;
    }
}

/** Stop, settle, then `start` (the component's nested doStart, which
 * closes the run through timedStart). A refused stop ends the run. */
export async function timedRestart(
    scenario: TimingScenario,
    deps: ServerActionDeps,
    start: () => Promise<boolean>,
): Promise<{ stopped: SidecarResult; started: boolean }> {
    beginTiming(scenario, { replace: true });
    const runId = peekActiveTiming()?.id;
    try {
        const stopped = await deps.serverStop({ stopAgents: true });
        if (!stopped.ok) {
            endTiming('failed', 'stop refused', { runId });
            return { stopped, started: false };
        }
        // kept as-is (measured, not removed): lets the OS release the old
        // listener's port before serverStart picks one
        markStage('settle', undefined, { runId });
        await deps.sleep(1200);
        return { stopped, started: await start() };
    } catch (e) {
        endTiming('failed', 'restart threw', { runId });
        throw e;
    }
}
