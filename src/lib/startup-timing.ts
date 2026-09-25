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

import { isChildWindow } from './window-role';

export type TimingScenario =
    | 'cold-start'
    | 'onboarding'
    | 'start'
    | 'restart'
    | 'stop'
    | 'sim-to-prod'
    | 'prod-to-sim';

// partial: the server is healthy but the front end did not reach
// accounts + positions + live stream within the watch window
export type TimingOutcome =
    | 'ok'
    | 'attached'
    | 'partial'
    | 'failed'
    | 'abandoned';

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
    'boot-checked': '伺服器確認完成',
    'stream-connect': '行情串流連線中',
    'stream-error': '行情串流連線失敗，重試中',
    'stream-open': '行情串流已開啟',
    'stream-heartbeat': '收到第一個串流心跳',
    'stream-restart': '行情串流重新連線',
    // the dashboard's first commit (all panels mounted, their effects run)
    'app-mounted': '畫面元件已掛載',
    'trading-start': '交易資料開始載入',
    // detail only: how long the JS main thread was blocked while the front
    // end got ready — an SSE open/first event cannot be handled meanwhile
    'main-thread': '主執行緒忙碌統計',
    // front-end bootstrap after the reload, until trading data is usable
    'accounts-loaded': '帳戶已載入',
    'positions-loaded': '持倉已載入',
    'stream-live': '行情串流已連線',
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
    droppedMarks?: number;
    // retired without a real end (stale, or left by a previous app
    // session): endedAt is the last mark, never the retirement time
    retired?: boolean;
}

interface TimingState {
    active: TimingRun | null;
    history: TimingRun[]; // finished, newest first
}

const STORAGE_KEY = 'sj-pro-startup-timing';
const LEGACY_STORAGE_KEY = 'sjpro.startupTiming.v1'; // first PR #149 builds
// repeated reloads must not grow one run without bound: past this the last
// slot keeps the newest mark and `droppedMarks` counts the rest
export const MAX_MARKS = 64;
const HISTORY_LIMIT = 12;
// longer than any legitimate run — 20 s warming + 45 s spawn + 90 s health
// + 60 s front-end watch = 215 s, plus the last probes' grace: an older
// active run was cut off by a crash/quit and must not swallow the next
// scenario
export const STALE_RUN_MS = 270_000;

type Listener = () => void;
const listeners = new Set<Listener>();

function readStorage(): TimingState {
    try {
        const ls = globalThis.localStorage;
        let raw = ls?.getItem(STORAGE_KEY);
        const legacy = ls?.getItem(LEGACY_STORAGE_KEY);
        if (legacy !== null && legacy !== undefined) {
            // one-time migration of the old key
            if (!raw) {
                raw = legacy;
                ls?.setItem(STORAGE_KEY, legacy);
            }
            ls?.removeItem(LEGACY_STORAGE_KEY);
        }
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
    // runs are owned by the main window: a popout holds only the copy it
    // read at load and must never write it back over the main window's
    if (!isChildWindow()) {
        try {
            globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
            // storage full/unavailable — in-memory still works
        }
    }
    for (const fn of listeners) fn();
}

function debugLog(run: TimingRun, text: string) {
    // the "debug log": info level so the devtools console shows it without
    // enabling Verbose; release builds without devtools use 複製診斷
    console.info(`[startup-timing] ${run.scenario} ${text}`);
}

function clip(detail: string | undefined): string | undefined {
    return detail ? detail.slice(0, 80) : undefined;
}

function finish(
    run: TimingRun,
    outcome: TimingOutcome,
    detail?: string,
    now = Date.now(),
    retired = false,
): TimingState {
    // a retired run's end is unknown: stop the clock at its last real mark
    // so an 8 h old leftover never reads as an 8 h stage
    const lastAt = run.marks[run.marks.length - 1]?.at ?? 0;
    const done: TimingRun = {
        ...run,
        endedAt: retired ? lastAt : now - run.startedAt,
        outcome,
        detail: clip(detail),
    };
    if (retired) done.retired = true;
    debugLog(
        done,
        `end ${outcome} +${fmtSec(done.endedAt!)}${retired ? ' (last mark)' : ''}${
            detail ? ` ${detail}` : ''
        }`,
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
        commit(finish(run, 'abandoned', 'stale: never ended', now, true));
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

/** `runId` pins a mark to the run its caller started with: a late mark
 * from a superseded wait must never land in (or close) a newer run. */
export interface TimingTarget {
    runId?: string;
    now?: number;
}

function target(opts: TimingTarget): TimingRun | null {
    const run = getActiveTiming(opts.now ?? Date.now());
    if (!run) return null;
    if (opts.runId !== undefined && run.id !== opts.runId) return null;
    return run;
}

export function markStage(
    stage: TimingStage,
    detail?: string,
    opts: TimingTarget = {},
): void {
    const now = opts.now ?? Date.now();
    const run = target({ ...opts, now });
    if (!run) return;
    const mark: TimingMark = { stage, at: now - run.startedAt };
    const d = clip(detail);
    if (d) mark.detail = d;
    debugLog(run, `+${fmtSec(mark.at)} ${stage}${d ? ` ${d}` : ''}`);
    const next =
        run.marks.length < MAX_MARKS
            ? { ...run, marks: [...run.marks, mark] }
            : {
                  ...run,
                  marks: [...run.marks.slice(0, MAX_MARKS - 1), mark],
                  droppedMarks: (run.droppedMarks ?? 0) + 1,
              };
    commit({ ...state, active: next });
}

export function endTiming(
    outcome: TimingOutcome,
    detail?: string,
    opts: TimingTarget = {},
): void {
    const now = opts.now ?? Date.now();
    const run = target({ ...opts, now });
    if (!run) return;
    commit(finish(run, outcome, detail, now));
}

/**
 * Boot-time decision (main window). A real app launch retires whatever run
 * the previous session left open, then opens a cold-start run when the
 * server will be auto-started. A reload (our post-start reload or a user
 * F5) continues the in-flight run instead.
 */
export function beginBootTiming(opts: {
    reloaded: boolean;
    autoStart: boolean;
    navigationStart: number;
    now?: number;
}): 'continued' | 'cold-start' | 'none' {
    const now = opts.now ?? Date.now();
    // retire directly (stale or not) so the record says why it never ended
    if (!opts.reloaded && state.active) {
        commit(finish(state.active, 'abandoned', 'previous app session', now, true));
    }
    if (getActiveTiming(now)) {
        markStage('page-loaded', undefined, { now });
        return 'continued';
    }
    if (!opts.reloaded && opts.autoStart) {
        beginTiming('cold-start', { startedAt: opts.navigationStart, now });
        markStage('app-js-start', undefined, { now });
        return 'cold-start';
    }
    return 'none';
}

/** This page load is the reload a run triggered after the server answered
 * healthy (every "reload" mark follows a health/listener confirmation). */
export function reloadedIntoHealthyServer(
    reloaded: boolean,
    run: TimingRun | null,
    now = Date.now(),
): boolean {
    if (!reloaded || !run || now - run.startedAt > STALE_RUN_MS) return false;
    return run.marks[run.marks.length - 1]?.stage === 'reload';
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
    const total =
        run.endedAt === undefined
            ? ''
            : run.retired
              ? ` · no end recorded, last mark +${fmtSec(run.endedAt)}`
              : ` · total ${fmtSec(run.endedAt)}`;
    const head = `[${run.scenario}] ${new Date(run.startedAt).toISOString()} · ${
        run.outcome ?? 'in progress'
    }${total}${
        run.detail ? ` · ${run.detail}` : ''
    }${run.droppedMarks ? ` · ${run.droppedMarks} marks dropped` : ''}`;
    const lines = [head];
    run.marks.forEach((m, i) => {
        // a retired run's last stage has no known end: leave it blank
        const next =
            run.marks[i + 1]?.at ?? (run.retired ? undefined : run.endedAt);
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
    getActiveTiming(); // retire a stale leftover before printing it
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
