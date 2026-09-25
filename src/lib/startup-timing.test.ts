// src/lib/startup-timing.test.ts — per-stage start/restart/stop/switch
// timing: nesting, reload survival, stale retirement, diagnostics text
// (issue #142)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vitest runs in a node environment — minimal in-memory localStorage shim
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
};

const timing = await import('./startup-timing');
const {
    STALE_RUN_MS,
    __resetTimingForTest,
    applyScenario,
    beginTiming,
    describeActiveStage,
    endTiming,
    MAX_MARKS,
    beginBootTiming,
    getActiveTiming,
    getTimingHistory,
    markStage,
    subscribeTiming,
    timingDiagnostics,
} = timing;

beforeEach(() => {
    store.clear();
    __resetTimingForTest();
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 25, 1, 0, 0));
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('startup timing runs', () => {
    it('records stage offsets and the total for a restart', () => {
        expect(beginTiming('restart')).toBe(true);
        markStage('kill', 'port=21322');
        vi.advanceTimersByTime(300);
        markStage('wait-exit');
        vi.advanceTimersByTime(200);
        markStage('stopped', 'polls=3');
        vi.advanceTimersByTime(8000);
        markStage('listener-up', 'polls=14');
        vi.advanceTimersByTime(250);
        endTiming('ok');
        const [run] = getTimingHistory();
        expect(getActiveTiming()).toBeNull();
        expect(run).toMatchObject({ scenario: 'restart', outcome: 'ok', endedAt: 8750 });
        expect(run!.marks.map((m) => [m.stage, m.at])).toEqual([
            ['kill', 0],
            ['wait-exit', 300],
            ['stopped', 500],
            ['listener-up', 8500],
        ]);
    });

    it('a nested start keeps the outer run; a new click replaces it', () => {
        beginTiming('sim-to-prod');
        expect(beginTiming('start')).toBe(false);
        expect(getActiveTiming()?.scenario).toBe('sim-to-prod');
        expect(beginTiming('stop', { replace: true })).toBe(true);
        expect(getActiveTiming()?.scenario).toBe('stop');
        expect(getTimingHistory()[0]).toMatchObject({
            scenario: 'sim-to-prod',
            outcome: 'abandoned',
            detail: 'superseded by stop',
        });
    });

    it('survives a page reload through storage so boot can close it', () => {
        beginTiming('prod-to-sim');
        markStage('wait-health');
        vi.advanceTimersByTime(1200);
        markStage('reload');
        __resetTimingForTest(); // the module re-initialises after reload
        vi.advanceTimersByTime(900);
        markStage('page-loaded');
        endTiming('ok');
        const [run] = getTimingHistory();
        expect(run!.scenario).toBe('prod-to-sim');
        expect(run!.marks.map((m) => m.stage)).toEqual([
            'wait-health',
            'reload',
            'page-loaded',
        ]);
        expect(run!.endedAt).toBe(2100);
    });

    it('retires a run left over from a crash instead of extending it', () => {
        beginTiming('start');
        vi.advanceTimersByTime(STALE_RUN_MS + 1);
        markStage('probe'); // no-op: nothing active any more
        expect(getActiveTiming()).toBeNull();
        expect(getTimingHistory()[0]!.outcome).toBe('abandoned');
        expect(beginTiming('cold-start')).toBe(true);
    });

    it('marks and ends without an active run are no-ops', () => {
        markStage('kill');
        endTiming('ok');
        expect(getTimingHistory()).toEqual([]);
    });

    it('cold start counts from the given navigation start', () => {
        const nav = Date.now() - 1500;
        beginTiming('cold-start', { startedAt: nav });
        markStage('app-js-start');
        expect(getActiveTiming()!.marks[0]!.at).toBe(1500);
    });

    it('keeps a bounded history, newest first', () => {
        for (let i = 0; i < 15; i++) {
            beginTiming('stop');
            endTiming('ok', `#${i}`);
        }
        const h = getTimingHistory();
        expect(h).toHaveLength(12);
        expect(h[0]!.detail).toBe('#14');
    });

    it('notifies subscribers on every change', () => {
        const fn = vi.fn();
        const off = subscribeTiming(fn);
        beginTiming('start');
        markStage('spawn');
        endTiming('failed');
        off();
        beginTiming('start');
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('writes a debug-log line per mark', () => {
        beginTiming('restart');
        vi.advanceTimersByTime(1234);
        markStage('wait-listener');
        expect(console.info).toHaveBeenLastCalledWith(
            '[startup-timing] restart +1.23s wait-listener',
        );
    });
});

describe('storage', () => {
    it('migrates the legacy key to sj-pro-startup-timing once', () => {
        const legacy = { active: null, history: [{ id: 'x', scenario: 'stop', startedAt: 0, marks: [], endedAt: 10, outcome: 'ok' }] };
        store.set('sjpro.startupTiming.v1', JSON.stringify(legacy));
        __resetTimingForTest();
        expect(getTimingHistory()[0]!.id).toBe('x');
        expect(store.has('sjpro.startupTiming.v1')).toBe(false);
        expect(JSON.parse(store.get('sj-pro-startup-timing')!).history[0].id).toBe('x');
        beginTiming('start');
        expect(JSON.parse(store.get('sj-pro-startup-timing')!).active.scenario).toBe('start');
    });

    it('the new key wins over a leftover legacy one', () => {
        store.set('sj-pro-startup-timing', JSON.stringify({ active: null, history: [] }));
        store.set('sjpro.startupTiming.v1', JSON.stringify({ active: null, history: [{ id: 'old' }] }));
        __resetTimingForTest();
        expect(getTimingHistory()).toEqual([]);
        expect(store.has('sjpro.startupTiming.v1')).toBe(false);
    });

    it('caps marks per run, keeping the first ones and the newest', () => {
        beginTiming('restart');
        for (let i = 0; i < MAX_MARKS + 10; i++) {
            vi.advanceTimersByTime(1);
            markStage(i % 2 ? 'reload' : 'page-loaded', `#${i}`);
        }
        const run = getActiveTiming()!;
        expect(run.marks).toHaveLength(MAX_MARKS);
        expect(run.marks[0]!.detail).toBe('#0');
        expect(run.marks.at(-1)!.detail).toBe(`#${MAX_MARKS + 9}`);
        expect(run.droppedMarks).toBe(10);
        expect(timingDiagnostics()).toContain('10 marks dropped');
    });
});

describe('run pinning', () => {
    it('a mark or end for another run id is ignored', () => {
        beginTiming('start');
        const oldId = getActiveTiming()!.id;
        beginTiming('restart', { replace: true });
        markStage('healthy', undefined, { runId: oldId });
        endTiming('failed', 'late timeout', { runId: oldId });
        const run = getActiveTiming()!;
        expect(run.scenario).toBe('restart');
        expect(run.marks).toEqual([]);
        markStage('kill', undefined, { runId: run.id });
        expect(getActiveTiming()!.marks.map((m) => m.stage)).toEqual(['kill']);
    });
});

describe('boot timing decision', () => {
    const nav = () => Date.now() - 800;

    it('an app launch with autostart opens a cold-start run from navigation start', () => {
        expect(
            beginBootTiming({ reloaded: false, autoStart: true, navigationStart: nav() }),
        ).toBe('cold-start');
        const run = getActiveTiming()!;
        expect(run.scenario).toBe('cold-start');
        expect(run.marks).toEqual([{ stage: 'app-js-start', at: 800 }]);
    });

    it('an app launch retires the previous session\'s open run first', () => {
        beginTiming('sim-to-prod');
        vi.advanceTimersByTime(30_000); // not stale yet
        __resetTimingForTest(); // app quit + relaunch
        expect(
            beginBootTiming({ reloaded: false, autoStart: true, navigationStart: nav() }),
        ).toBe('cold-start');
        expect(getTimingHistory()[0]).toMatchObject({
            scenario: 'sim-to-prod',
            outcome: 'abandoned',
            detail: 'previous app session',
        });
        expect(getActiveTiming()!.scenario).toBe('cold-start');
    });

    it('an app launch without autostart retires and opens nothing', () => {
        beginTiming('restart');
        expect(
            beginBootTiming({ reloaded: false, autoStart: false, navigationStart: nav() }),
        ).toBe('none');
        expect(getActiveTiming()).toBeNull();
        expect(getTimingHistory()[0]!.outcome).toBe('abandoned');
    });

    it('our post-start reload continues the in-flight run', () => {
        beginTiming('prod-to-sim');
        const id = getActiveTiming()!.id;
        expect(
            beginBootTiming({ reloaded: true, autoStart: true, navigationStart: nav() }),
        ).toBe('continued');
        expect(getActiveTiming()!.id).toBe(id);
        expect(getActiveTiming()!.marks.at(-1)!.stage).toBe('page-loaded');
    });

    it('a plain user reload opens nothing', () => {
        expect(
            beginBootTiming({ reloaded: true, autoStart: true, navigationStart: nav() }),
        ).toBe('none');
        expect(getActiveTiming()).toBeNull();
        expect(getTimingHistory()).toEqual([]);
    });
});

describe('scenario and stage text', () => {
    it('classifies applying settings to the running server', () => {
        expect(applyScenario(false, undefined, true)).toBe('start');
        expect(applyScenario(true, true, true)).toBe('sim-to-prod');
        expect(applyScenario(true, false, false)).toBe('prod-to-sim');
        expect(applyScenario(true, true, false)).toBe('restart');
        expect(applyScenario(true, undefined, false)).toBe('restart');
    });

    it('describes the current stage with elapsed seconds', () => {
        beginTiming('sim-to-prod');
        expect(describeActiveStage(getActiveTiming())).toBe(
            '切換至正式環境 — 準備中 · 0 秒',
        );
        vi.advanceTimersByTime(12_400);
        markStage('wait-listener');
        expect(describeActiveStage(getActiveTiming())).toBe(
            '切換至正式環境 — 登入與載入合約（約需 10–30 秒） · 12 秒',
        );
        expect(describeActiveStage(null)).toBeNull();
        vi.advanceTimersByTime(STALE_RUN_MS);
        expect(describeActiveStage(timing.peekActiveTiming())).toBeNull();
    });
});

describe('diagnostics block', () => {
    it('is empty when nothing was timed', () => {
        expect(timingDiagnostics()).toBe('');
    });

    it('lists offsets and stage durations, in-flight run first', () => {
        beginTiming('stop');
        markStage('kill', 'port=21322');
        vi.advanceTimersByTime(400);
        markStage('stopped', 'polls=2');
        vi.advanceTimersByTime(100);
        endTiming('ok');
        beginTiming('start');
        markStage('spawn', 'port=21322 sim');
        expect(timingDiagnostics().split('\n')).toEqual([
            '--- startup timing (newest first; +offset, stage duration) ---',
            '[start] 2026-09-25T01:00:00.500Z · in progress',
            '  +   0.00s           spawn (port=21322 sim)',
            '[stop] 2026-09-25T01:00:00.000Z · ok · total 0.50s',
            '  +   0.00s    0.40s  kill (port=21322)',
            '  +   0.40s    0.10s  stopped (polls=2)',
        ]);
    });

    it('never carries more than the short detail it was given', () => {
        beginTiming('start');
        markStage('spawn', 'x'.repeat(500));
        expect(getActiveTiming()!.marks[0]!.detail).toHaveLength(80);
    });
});
