// src/lib/server-actions.test.ts — 啟動／重啟／停止 close the timing run
// they opened on every branch (issue #142)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopSettings, StartResult } from './tauri';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
};

const timing = await import('./startup-timing');
const { timedAutostart, timedOnboarding, timedRestart, timedStart, timedStop } = await import('./server-actions');

const cfg = { production: false } as DesktopSettings;
const started = (over: Partial<StartResult>): StartResult => ({
    ok: true,
    output: '',
    port: 21322,
    attached: false,
    portChanged: false,
    ...over,
});
const deps = (over: Partial<Parameters<typeof timedStop>[0]> = {}) => ({
    serverStart: vi.fn(async () => started({})),
    serverStop: vi.fn(async () => ({ ok: true, output: '' })),
    reloadWhenHealthy: vi.fn(async () => undefined),
    reloadAfterFailedStop: vi.fn(),
    scheduleReload: vi.fn(),
    ...over,
});
const last = () => timing.getTimingHistory()[0];

beforeEach(() => {
    store.clear();
    timing.__resetTimingForTest();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('timedStart', () => {
    it('fresh spawn: hands the open run to the health wait', async () => {
        const d = deps();
        await timedStart(cfg, 'start', d);
        expect(d.reloadWhenHealthy).toHaveBeenCalledTimes(1);
        expect(timing.getActiveTiming()?.scenario).toBe('start');
    });

    it('attached: reloads immediately to verify fresh frontend state', async () => {
        const d = deps({ serverStart: vi.fn(async () => started({ attached: true })) });
        await timedStart(cfg, 'start', d);
        expect(d.scheduleReload).toHaveBeenCalledWith(0);
        expect(timing.getActiveTiming()?.marks.at(-1)?.stage).toBe('reload');
        expect(d.reloadWhenHealthy).not.toHaveBeenCalled();
    });

    it('healthy attached port moved: reloads without a fixed delay', async () => {
        const d = deps({
            serverStart: vi.fn(async () => started({ attached: true, portChanged: true })),
        });
        await timedStart(cfg, 'start', d);
        expect(d.scheduleReload).toHaveBeenCalledWith(0);
        expect(timing.getActiveTiming()!.marks.at(-1)!.stage).toBe('reload');
    });

    it('fresh spawn on another port waits for real health before reloading', async () => {
        const d = deps({ serverStart: vi.fn(async () => started({ portChanged: true })) });
        await timedStart(cfg, 'start', d);
        expect(d.reloadWhenHealthy).toHaveBeenCalledTimes(1);
        expect(d.scheduleReload).not.toHaveBeenCalled();
        expect(timing.getActiveTiming()?.marks.some((m) => m.stage === 'reload')).toBe(false);
    });

    it('failed: ends the run as failed', async () => {
        const d = deps({ serverStart: vi.fn(async () => started({ ok: false })) });
        await timedStart(cfg, 'start', d);
        expect(last()).toMatchObject({ scenario: 'start', outcome: 'failed' });
    });

    it('throws: ends the run as failed and rethrows', async () => {
        const d = deps({ serverStart: vi.fn(async () => { throw new Error('ipc'); }) });
        await expect(timedStart(cfg, 'start', d)).rejects.toThrow('ipc');
        expect(timing.getActiveTiming()).toBeNull();
        expect(last()!.outcome).toBe('failed');
    });

    it('a new click supersedes a run still waiting for health', async () => {
        await timedStart(cfg, 'start', deps());
        await timedStart(cfg, 'start', deps({ serverStart: vi.fn(async () => started({ ok: false })) }));
        expect(timing.getTimingHistory().map((r) => r.outcome)).toEqual(['failed', 'abandoned']);
    });
});

describe('timedAutostart (boot)', () => {
    it('a throwing serverStart ends the cold-start run as failed', async () => {
        timing.beginTiming('cold-start');
        await expect(
            timedAutostart(async () => { throw new Error('sidecar missing'); }),
        ).rejects.toThrow('sidecar missing');
        expect(timing.getActiveTiming()).toBeNull();
        expect(last()).toMatchObject({ scenario: 'cold-start', outcome: 'failed', detail: 'autostart threw' });
    });

    it('a failed start ends it; a fresh spawn leaves it for the health wait', async () => {
        timing.beginTiming('cold-start');
        await timedAutostart(async () => started({ ok: false }));
        expect(last()).toMatchObject({ outcome: 'failed', detail: 'autostart' });
        timing.beginTiming('cold-start');
        await timedAutostart(async () => started({}));
        expect(timing.getActiveTiming()?.scenario).toBe('cold-start');
    });

    it('with no run at boot, a failure never closes a later user run', async () => {
        expect(timing.getActiveTiming()).toBeNull();
        await expect(
            timedAutostart(async () => {
                timing.beginTiming('restart'); // user clicks 重啟 meanwhile
                throw new Error('sidecar missing');
            }),
        ).rejects.toThrow('sidecar missing');
        expect(timing.getActiveTiming()?.scenario).toBe('restart');
        timing.endTiming('ok');
        await timedAutostart(async () => {
            timing.beginTiming('stop');
            return started({ ok: false });
        });
        expect(timing.getActiveTiming()?.scenario).toBe('stop');
        expect(timing.getTimingHistory().map((r) => r.scenario)).toEqual(['restart']);
    });

    it('only closes the run it started with', async () => {
        timing.beginTiming('cold-start');
        const p = timedAutostart(async () => {
            timing.beginTiming('restart', { replace: true });
            throw new Error('late');
        });
        await expect(p).rejects.toThrow('late');
        expect(timing.getActiveTiming()?.scenario).toBe('restart');
    });
});

describe('timedOnboarding', () => {
    const ob = (over: Partial<Parameters<typeof timedOnboarding>[0]> = {}) => ({
        save: vi.fn(async () => undefined),
        start: vi.fn(async () => started({})),
        reloadWhenHealthy: vi.fn(async () => true),
        ...over,
    });

    it('a failed save opens no run and ends no unrelated run', async () => {
        timing.beginTiming('restart');
        const d = ob({ save: vi.fn(async () => { throw new Error('store'); }) });
        await expect(timedOnboarding(d)).rejects.toThrow('store');
        expect(d.start).not.toHaveBeenCalled();
        expect(timing.getActiveTiming()?.scenario).toBe('restart');
        expect(timing.getTimingHistory()).toEqual([]);
    });

    it('failed or throwing start ends the onboarding run', async () => {
        await timedOnboarding(ob({ start: vi.fn(async () => started({ ok: false })) }));
        expect(last()).toMatchObject({ scenario: 'onboarding', outcome: 'failed' });
        await expect(
            timedOnboarding(ob({ start: vi.fn(async () => { throw new Error('ipc'); }) })),
        ).rejects.toThrow('ipc');
        expect(last()).toMatchObject({ scenario: 'onboarding', outcome: 'failed', detail: 'onboarding threw' });
        expect(timing.getActiveTiming()).toBeNull();
    });

    it('success hands the run to the health wait', async () => {
        const d = ob();
        await timedOnboarding(d);
        expect(d.reloadWhenHealthy).toHaveBeenCalledTimes(1);
        expect(timing.getActiveTiming()?.scenario).toBe('onboarding');
    });
});

describe('timedStop', () => {
    it('ok and failed both end the run', async () => {
        const ok = deps();
        await timedStop(ok);
        expect(last()).toMatchObject({ scenario: 'stop', outcome: 'ok' });
        expect(ok.reloadAfterFailedStop).not.toHaveBeenCalled();
        const failed = deps({ serverStop: vi.fn(async () => ({ ok: false, output: 'x' })) });
        await timedStop(failed);
        expect(last()).toMatchObject({ scenario: 'stop', outcome: 'failed' });
        expect(failed.reloadAfterFailedStop).toHaveBeenCalledTimes(1);
        expect(timing.getActiveTiming()).toBeNull();
    });

    it('throws: ends the run and rethrows', async () => {
        const d = deps({ serverStop: vi.fn(async () => { throw new Error('boom'); }) });
        await expect(timedStop(d)).rejects.toThrow('boom');
        expect(last()).toMatchObject({ scenario: 'stop', outcome: 'failed' });
        expect(d.reloadAfterFailedStop).toHaveBeenCalledTimes(1);
    });
});

describe('timedRestart', () => {
    it('refused stop: ends the run, never starts', async () => {
        const start = vi.fn(async () => true);
        const d = deps({ serverStop: vi.fn(async () => ({ ok: false, output: 'refused' })) });
        const res = await timedRestart('sim-to-prod', d, start);
        expect(res.started).toBe(false);
        expect(start).not.toHaveBeenCalled();
        expect(last()).toMatchObject({ scenario: 'sim-to-prod', outcome: 'failed', detail: 'stop refused' });
        expect(d.reloadAfterFailedStop).toHaveBeenCalledTimes(1);
    });

    it('starts right after the stop — no fixed settle — inside the same run', async () => {
        vi.useFakeTimers();
        const d = deps();
        const res = await timedRestart('prod-to-sim', d, () =>
            timedStart(cfg, 'prod-to-sim', d, true).then((r) => r.ok),
        );
        vi.useRealTimers();
        expect(res.started).toBe(true);
        expect(d.serverStart).toHaveBeenCalledTimes(1);
        const run = timing.getActiveTiming()!;
        expect(run.scenario).toBe('prod-to-sim');
        expect(run.marks).toEqual([]);
        expect(timing.getTimingHistory()).toEqual([]);
    });

    it('nested start failure ends the restart run', async () => {
        const d = deps({ serverStart: vi.fn(async () => started({ ok: false })) });
        await timedRestart('restart', d, () => timedStart(cfg, 'restart', d, true).then((r) => r.ok));
        expect(timing.getActiveTiming()).toBeNull();
        expect(last()).toMatchObject({ scenario: 'restart', outcome: 'failed' });
    });

    it('nested start attach keeps the restart run through a fresh page load', async () => {
        const d = deps({ serverStart: vi.fn(async () => started({ attached: true })) });
        await timedRestart('restart', d, () => timedStart(cfg, 'restart', d, true).then((r) => r.ok));
        expect(d.scheduleReload).toHaveBeenCalledWith(0);
        expect(timing.getActiveTiming()).toMatchObject({ scenario: 'restart' });
    });

    it('a throwing stop or start ends the run and rethrows', async () => {
        const d = deps({ serverStop: vi.fn(async () => { throw new Error('ipc'); }) });
        await expect(timedRestart('restart', d, async () => true)).rejects.toThrow('ipc');
        expect(last()!.outcome).toBe('failed');
        await expect(
            timedRestart('restart', deps(), async () => { throw new Error('late'); }),
        ).rejects.toThrow('late');
        expect(last()).toMatchObject({ outcome: 'failed', detail: 'restart threw' });
        expect(timing.getActiveTiming()).toBeNull();
    });
});
