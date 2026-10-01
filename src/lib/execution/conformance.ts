// src/lib/execution/conformance.ts — shared conformance scenario format for
// order program executors (#201). The same JSON files (./scenarios/*.json)
// run against the TypeScript reference core here and against the native
// Rust core (private desktop layer), which implements the identical
// matching rules below. A scenario is the behavioural spec: events in →
// exact intents out + a subset of the resulting state.
//
// Matching rules (keep in sync with the Rust runner):
// - `intents`: omitted means NONE may be emitted; otherwise the emitted list
//   must have the same length and each element must subset-match.
// - `notices`: every listed code must appear among the step's notices.
// - `absentNotices`: no listed code may appear among the step's notices.
// - `programs`: keyed by program id; `null` = the program must not exist;
//   an object subset-matches the program, where `levels` may be given as an
//   object keyed by level id (matched against the level with that id).
// - `state`: subset-matches the whole engine state.
// - subset match: objects compare listed keys only; `null` expects null or
//   absent; arrays must have equal length and match element-wise; numbers
//   compare within 1e-9.
// - `{ "restart": { "ts": n } }` simulates a crash and restart: the executor
//   is rebuilt from what it persisted (TS: JSON round trip of the state;
//   Rust: journal + snapshot on disk) and a `restore` event at `ts` is applied.

import { initialState, step } from './core';
import type { EngineState, ExecEvent, Notice, OrderIntent } from './model';

export const CONFORMANCE_SCHEMA_VERSION = 'execution-conformance-v1';

export interface ScenarioExpect {
    intents?: unknown[];
    notices?: string[];
    absentNotices?: string[];
    programs?: Record<string, unknown>;
    state?: unknown;
}

export type ScenarioStep =
    | { event: ExecEvent; expect?: ScenarioExpect; note?: string }
    | { restart: { ts: number }; expect?: ScenarioExpect; note?: string };

export interface Scenario {
    schema: typeof CONFORMANCE_SCHEMA_VERSION;
    name: string;
    description: string;
    /** Issues / rules this scenario pins (e.g. "#144", "dedupe"). */
    covers: string[];
    steps: ScenarioStep[];
}

export interface Executor {
    initial(): EngineState;
    step(state: EngineState, event: ExecEvent): { state: EngineState; intents: OrderIntent[]; notices: Notice[] };
}

export const referenceExecutor: Executor = { initial: initialState, step };

/** Subset match; returns the first mismatch path, or null. */
export function subsetMismatch(expected: unknown, actual: unknown, path = '$'): string | null {
    if (expected === null) return actual === null || actual === undefined ? null : `${path}: expected null, got ${JSON.stringify(actual)}`;
    if (Array.isArray(expected)) {
        if (!Array.isArray(actual)) return `${path}: expected array, got ${JSON.stringify(actual)}`;
        if (actual.length !== expected.length) return `${path}: expected ${expected.length} items, got ${actual.length} ${JSON.stringify(actual)}`;
        for (let i = 0; i < expected.length; i++) {
            const m = subsetMismatch(expected[i], actual[i], `${path}[${i}]`);
            if (m) return m;
        }
        return null;
    }
    if (typeof expected === 'object') {
        if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return `${path}: expected object, got ${JSON.stringify(actual)}`;
        const a = actual as Record<string, unknown>;
        for (const [k, v] of Object.entries(expected as Record<string, unknown>)) {
            let av = a[k];
            // levels keyed by id
            if (k === 'levels' && v !== null && typeof v === 'object' && !Array.isArray(v) && Array.isArray(av)) {
                av = Object.fromEntries((av as { id: string }[]).map(l => [l.id, l]));
            }
            const m = subsetMismatch(v, av, `${path}.${k}`);
            if (m) return m;
        }
        return null;
    }
    if (typeof expected === 'number') {
        return typeof actual === 'number' && Math.abs(actual - expected) < 1e-9 ? null : `${path}: expected ${expected}, got ${JSON.stringify(actual)}`;
    }
    return expected === actual ? null : `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
}

export function checkExpect(expect: ScenarioExpect | undefined, state: EngineState, intents: unknown[], notices: Notice[]): string | null {
    const e = expect ?? {};
    const m = subsetMismatch(e.intents ?? [], intents, 'intents');
    if (m) return m;
    for (const code of e.notices ?? []) {
        if (!notices.some(n => n.code === code)) return `notices: missing ${code} in ${JSON.stringify(notices.map(n => n.code))}`;
    }
    for (const code of e.absentNotices ?? []) {
        if (notices.some(n => n.code === code)) return `notices: unexpected ${code}`;
    }
    for (const [id, exp] of Object.entries(e.programs ?? {})) {
        const p = state.programs.find(x => x.id === id);
        const mm = subsetMismatch(exp, p ?? null, `programs.${id}`);
        if (mm) return mm;
    }
    if (e.state !== undefined) {
        const mm = subsetMismatch(e.state, state, 'state');
        if (mm) return mm;
    }
    return null;
}

/** Run one scenario; returns failures ("step N: …"), empty when it passes. */
export function runScenario(sc: Scenario, exec: Executor = referenceExecutor): string[] {
    if (sc.schema !== CONFORMANCE_SCHEMA_VERSION) return [`unsupported schema ${sc.schema}`];
    let state = exec.initial();
    const failures: string[] = [];
    sc.steps.forEach((st, i) => {
        let r: { state: EngineState; intents: OrderIntent[]; notices: Notice[] };
        if ('restart' in st) {
            const persisted = JSON.parse(JSON.stringify(state)) as EngineState;
            r = exec.step(persisted, { type: 'restore', ts: st.restart.ts });
        } else {
            r = exec.step(state, st.event);
        }
        // everything crosses a JSON boundary, as it does between executors
        const intents = JSON.parse(JSON.stringify(r.intents)) as unknown[];
        state = JSON.parse(JSON.stringify(r.state)) as EngineState;
        const m = checkExpect(st.expect, state, intents, r.notices);
        if (m) failures.push(`step ${i}${st.note ? ` (${st.note})` : ''}: ${m}`);
    });
    return failures;
}
