// src/lib/startup-timing.ts — per-stage timing of the shioaji server start,
// restart, stop and sim ↔ prod switch as the APP sees them (issue #142).
//
// One "run" covers one user-visible wait: from the click (or the app launch
// for a cold start) until the page has reloaded against a healthy server.
// Runs survive the post-start page reload through localStorage, so the boot
// flow can close them; the last few finished runs stay for 複製診斷.
//
// Only stage names, offsets, ports, modes and poll counts are recorded —
// never keys, passwords, paths or server output.

export type TimingScenario =
    | 'cold-start'
    | 'onboarding'
    | 'start'
    | 'restart'
    | 'stop'
    | 'sim-to-prod'
    | 'prod-to-sim';

export type TimingOutcome = 'ok' | 'attached' | 'failed' | 'abandoned';

// user-facing stage labels; the key is what diagnostics print
export const STAGE_LABELS = {
    'app-js-start': 'App 啟動',
    probe: '檢查現有伺服器',
    'wait-warming': '等待先前啟動中的伺服器',
    'sweep-orphans': '搜尋遺留的伺服器',
    attach: '連接既有伺服器',
    'stop-agents': '停止 Agent',
    kill: '停止伺服器',
    'wait-exit': '等待伺服器結束',
    stopped: '伺服器已停止',
    settle: '等待連接埠釋放',
    'reclaim-port': '清理連接埠',
    spawn: '啟動伺服器程序',
    // the sidecar binds its listener only AFTER login + contract load, so
    // from the app side those are one opaque wait
    'wait-listener': '登入與載入合約（約需 10–30 秒）',
    'listener-up': '伺服器已回應',
    'wait-health': '等待健康檢查',
    healthy: '健康檢查通過',
    reload: '重新載入畫面',
    'page-loaded': '畫面載入中',
} as const;

export type TimingStage = keyof typeof STAGE_LABELS;

export const SCENARIO_LABELS: Record<TimingScenario, string> = {
    'cold-start': '啟動中',
    onboarding: '啟動中',
    start: '啟動中',
    restart: '重啟中',
    stop: '停止中',
    'sim-to-prod': '切換至正式環境',
    'prod-to-sim': '切換至模擬環境',
};

export interface TimingMark {
    stage: TimingStage;
    at: number; // ms since run start
    detail?: string;
}

export interface TimingRun {
    id: string;
    scenario: TimingScenario;
    startedAt: number; // epoch ms
    marks: TimingMark[];
    endedAt?: number; // ms since run start
    outcome?: TimingOutcome;
    detail?: string;
}

interface TimingState {
    active: TimingRun | null;
    history: TimingRun[]; // finished, newest first
}

const STORAGE_KEY = 'sjpro.startupTiming.v1';
const HISTORY_LIMIT = 12;
// longer than any legitimate wait (20 s warming + 45 s spawn + 90 s health):
// an older active run was cut off by a crash/quit and must not swallow the
// next scenario
export const STALE_RUN_MS = 180_000;

type Listener = () => void;
const listeners = new Set<Listener>();

function readStorage(): TimingState {
    try {
        const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<TimingState>;
            return {
                active: parsed.active ?? null,
                history: Array.isArray(parsed.history) ? parsed.history : [],
            };
        }
    } catch {
        // unavailable or corrupt — start empty
    }
    return { active: null, history: [] };
}

let state: TimingState = readStorage();

function commit(next: TimingState) {
    state = next;
    try {
        globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
        // storage full/unavailable — in-memory still works
    }
    for (const fn of listeners) fn();
}

function debugLog(run: TimingRun, text: string) {
    // the "debug log": visible in the webview devtools console
    console.debug(`[startup-timing] ${run.scenario} ${text}`);
}

function clip(detail: string | undefined): string | undefined {
    return detail ? detail.slice(0, 80) : undefined;
}

function finish(
    run: TimingRun,
    outcome: TimingOutcome,
    detail?: string,
    now = Date.now(),
): TimingState {
    const done: TimingRun = {
        ...run,
        endedAt: now - run.startedAt,
        outcome,
        detail: clip(detail),
    };
    debugLog(
        done,
        `end ${outcome} +${fmtSec(done.endedAt!)}${detail ? ` ${detail}` : ''}`,
    );
    return {
        active: null,
        history: [done, ...state.history].slice(0, HISTORY_LIMIT),
    };
}

/** The active run, after retiring one left over from a crash/quit. */
export function getActiveTiming(now = Date.now()): TimingRun | null {
    const run = state.active;
    if (run && now - run.startedAt > STALE_RUN_MS) {
        commit(finish(run, 'abandoned', undefined, now));
        return null;
    }
    return run;
}

/**
 * Start timing `scenario`. When a run is already in flight it keeps
 * ownership and this returns false, unless `replace` is set: a new user
 * action (click) supersedes whatever was still being timed, which is
 * retired as abandoned. `startedAt` lets a cold start count from the
 * webview's navigation start.
 */
export function beginTiming(
    scenario: TimingScenario,
    opts: { startedAt?: number; now?: number; replace?: boolean } = {},
): boolean {
    const now = opts.now ?? Date.now();
    const current = getActiveTiming(now);
    if (current && !opts.replace) return false;
    if (current) commit(finish(current, 'abandoned', `superseded by ${scenario}`, now));
    const run: TimingRun = {
        id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        scenario,
        startedAt: opts.startedAt ?? now,
        marks: [],
    };
    debugLog(run, `begin ${new Date(run.startedAt).toISOString()}`);
    commit({ ...state, active: run });
    return true;
}

export function markStage(
    stage: TimingStage,
    detail?: string,
    now = Date.now(),
): void {
    const run = getActiveTiming(now);
    if (!run) return;
    const mark: TimingMark = { stage, at: now - run.startedAt };
    const d = clip(detail);
    if (d) mark.detail = d;
    debugLog(run, `+${fmtSec(mark.at)} ${stage}${d ? ` ${d}` : ''}`);
    commit({ ...state, active: { ...run, marks: [...run.marks, mark] } });
}

export function endTiming(
    outcome: TimingOutcome,
    detail?: string,
    now = Date.now(),
): void {
    const run = getActiveTiming(now);
    if (!run) return;
    commit(finish(run, outcome, detail, now));
}

/** Side-effect-free read for React snapshots (no stale retirement). */
export function peekActiveTiming(): TimingRun | null {
    return state.active;
}

export function getTimingHistory(): TimingRun[] {
    return state.history;
}

export function subscribeTiming(fn: Listener): () => void {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}

/** Which scenario applying `production` to a server in `runningSimulation`
 * mode is: a mode flip is a switch, otherwise a plain restart/start. */
export function applyScenario(
    running: boolean,
    runningSimulation: boolean | undefined,
    production: boolean,
): TimingScenario {
    if (!running) return 'start';
    if (runningSimulation === undefined) return 'restart';
    if (runningSimulation && production) return 'sim-to-prod';
    if (!runningSimulation && !production) return 'prod-to-sim';
    return 'restart';
}

/** What the server manager shows while a run is in flight, e.g.
 * 「重啟中 — 登入與載入合約（約需 10–30 秒）· 12 秒」. */
export function describeActiveStage(
    run: TimingRun | null,
    now = Date.now(),
): string | null {
    // a run nobody closed (crash, failed health wait) stops being "current"
    if (!run || now - run.startedAt > STALE_RUN_MS) return null;
    const last = run.marks[run.marks.length - 1];
    const stage = last ? STAGE_LABELS[last.stage] : '準備中';
    const sec = Math.max(0, Math.floor((now - run.startedAt) / 1000));
    return `${SCENARIO_LABELS[run.scenario]} — ${stage} · ${sec} 秒`;
}

function fmtSec(ms: number): string {
    return `${(ms / 1000).toFixed(2)}s`;
}

/** Human-readable lines: each mark with its offset and how long the stage
 * lasted until the next mark (or the end). */
export function formatTimingRun(run: TimingRun): string[] {
    const head = `[${run.scenario}] ${new Date(run.startedAt).toISOString()} · ${
        run.outcome ?? 'in progress'
    }${run.endedAt !== undefined ? ` · total ${fmtSec(run.endedAt)}` : ''}${
        run.detail ? ` · ${run.detail}` : ''
    }`;
    const lines = [head];
    run.marks.forEach((m, i) => {
        const next = run.marks[i + 1]?.at ?? run.endedAt;
        const dur =
            next !== undefined ? fmtSec(next - m.at).padStart(8) : ' '.repeat(8);
        lines.push(
            `  +${fmtSec(m.at).padStart(8)} ${dur}  ${m.stage}${
                m.detail ? ` (${m.detail})` : ''
            }`,
        );
    });
    return lines;
}

/** Block appended to 複製診斷: the in-flight run, then recent ones. */
export function timingDiagnostics(limit = 6): string {
    const runs = [
        ...(state.active ? [state.active] : []),
        ...state.history,
    ].slice(0, limit);
    if (runs.length === 0) return '';
    return [
        '--- startup timing (newest first; +offset, stage duration) ---',
        ...runs.flatMap(formatTimingRun),
    ].join('\n');
}

// tests only
export function __resetTimingForTest(): void {
    listeners.clear();
    state = readStorage();
}
