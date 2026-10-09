// #226 management panel commands on the window trigger engine: pause /
// resume, modify, history and today's finished list. All broker I/O is
// mocked: no order is sent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from './types/portfolio';

const F1: Account = { account_type: 'F', broker_id: 'fixture-broker-F', account_id: 'fixture-account-F',
    person_id: '', signed: true, username: '' };
const TXF = { code: 'TXFR1', target_code: 'TXFJ6', security_type: 'FUT', exchange: 'TAIFEX' };
const SIM = 'http://sim.invalid|simulation';

const m = vi.hoisted(() => ({
    status: 'live' as string,
    tick: null as ((t: { code: string; close: number; simtrade?: boolean }) => void) | null,
    oddTick: null as ((t: { code: string; close: number; simtrade?: boolean }) => void) | null,
    heartbeat: null as (() => void) | null,
    envChanged: [] as (() => void)[],
    statusChanged: [] as (() => void)[],
    lockGranted: true,
    queued: null as ((lock: object | null) => unknown) | null,
    accounts: [] as Account[],
    env: 'http://sim.invalid|simulation' as string | null,
    place: vi.fn(),
    notify: vi.fn(),
    ensure: vi.fn(),
}));

vi.mock('./runtime', () => ({ getApiBase: () => 'http://sim.invalid' }));
vi.mock('./stream', () => ({
    getStreamStatus: () => m.status,
    subscribeStatusStore: (cb: () => void) => { m.statusChanged.push(cb); return () => undefined; },
    onOrderEvent: () => () => undefined,
    onAnyTick: (cb: typeof m.tick) => { m.tick = cb; return () => undefined; },
    onOddLotTick: (cb: typeof m.tick) => { m.oddTick = cb; return () => undefined; },
    onStreamEvent: (name: string, cb: () => void) => { if (name === 'heartbeat') m.heartbeat = cb; return () => undefined; },
}));
vi.mock('./account-store', () => ({ getAccountState: () => ({ accounts: m.accounts,
    selectedFutures: m.accounts.find(a => a.account_type === 'F') ?? null, selectedStock: null }) }));
vi.mock('./trade', () => ({ notify: m.notify, placeQuickOrder: m.place }));
vi.mock('./contracts-cache', () => ({ ensureContract: m.ensure, getCachedContract: () => undefined }));
vi.mock('./quote-ownership', () => ({ retainQuote: () => () => undefined }));
vi.mock('./trading-state', () => ({ getTradingState: () => ({ positions: [],
    queries: { positions: { updatedAt: null, needsReconcile: false, error: null } } }) }));
vi.mock('./shioaji', () => ({ fetchTrades: async () => [] }));
vi.mock('./protection-env', () => {
    const envBase = (env: string) => env.slice(0, env.lastIndexOf('|'));
    return {
        currentProtectionEnv: () => m.env,
        refreshProtectionEnv: async () => undefined,
        onProtectionEnvChange: (cb: () => void) => { m.envChanged.push(cb); return () => undefined; },
        envBase,
        reportEnvMatches: (env: string, base: string) => envBase(env) === base,
        watchProtectionEnv: () => undefined,
    };
});

let store = new Map<string, string>();
let engine: typeof import('./trigger-engine');

/** Launch (or reload) the main window; `keepStore` keeps persisted triggers. */
async function boot(opts: { keepStore?: boolean } = {}) {
    vi.resetModules();
    if (!opts.keepStore) store = new Map();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    vi.stubGlobal('location', { search: '' });
    vi.stubGlobal('navigator', { locks: { request: (_n: string, a: unknown, b?: (lock: object | null) => unknown) => {
        const cb = (typeof a === 'function' ? a : b) as (lock: object | null) => unknown;
        if (typeof a === 'function' || !(a as { ifAvailable?: boolean }).ifAvailable) { m.queued = cb; return new Promise(() => undefined); }
        const r = cb(m.lockGranted ? {} : null); return Promise.resolve(r instanceof Promise ? undefined : r); } } });
    m.tick = null; m.heartbeat = null; m.envChanged = []; m.statusChanged = []; m.queued = null;
    engine = await import('./trigger-engine');
    engine.startTriggerEngine();
    await flush();
}
async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); }
const tick = async (close: number, simtrade = false) => { m.tick!({ code: 'TXFR1', close, simtrade }); await flush(); };
const heartbeat = async () => { m.heartbeat!(); await flush(); };
const setStatus = async (status: string) => { m.status = status; m.statusChanged.forEach(cb => cb()); await flush(); };
const setEnv = async (env: string | null) => { m.env = env; m.envChanged.forEach(cb => cb()); await flush(); };
const only = () => engine.getTriggers()[0]!;
const titles = () => m.notify.mock.calls.map(([n]) => (n as { title: string }).title);

function addStop(over: Record<string, unknown> = {}) {
    return engine.addTrigger({ code: 'TXFR1', condition: 'below', price: 48000, action: 'Sell', quantity: 1, kind: 'stop', ...over },
        TXF as never);
}

/** Stop at 48000 created while price was 48300, then the app reloads. */
async function restoredStop(over: Record<string, unknown> = {}) {
    await boot();
    await addStop(over);
    await tick(48300);
    await boot({ keepStore: true });
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('BroadcastChannel', undefined);
    m.status = 'live'; m.accounts = [F1]; m.env = SIM; m.lockGranted = true;
    for (const f of [m.place, m.notify, m.ensure]) f.mockReset();
    m.ensure.mockResolvedValue(TXF);
    let n = 0;
    // like placeQuickOrder: beforeSend runs right before sending and may refuse
    m.place.mockImplementation(async (...args: unknown[]) => {
        (args[4] as { beforeSend?: () => void } | undefined)?.beforeSend?.();
        return { order: { id: `exit-${++n}` }, status: { status: 'PendingSubmit' } };
    });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });


const entry = (over: Record<string, unknown> = {}) =>
    engine.addTrigger({ code: 'TXFR1', condition: 'below', price: 48000, action: 'Sell', quantity: 1, kind: 'stop', role: 'entry', ...over },
        TXF as never);

describe('pause / resume (#226)', () => {
    it('a paused trigger never fires; resuming while past holds it as 待確認, nothing sent', async () => {
        await boot();
        await addStop();
        await tick(48300);
        await engine.setTriggerPaused(only().id, true);
        expect(only().paused).toBe(true);
        await tick(47900);
        await tick(47800);
        expect(m.place).not.toHaveBeenCalled();
        await engine.setTriggerPaused(only().id, false);
        expect(only().paused).toBeUndefined();
        await tick(47700);
        expect(m.place).not.toHaveBeenCalled();
        expect(only().pending?.reason).toBe('resume');
        expect(only().history?.map(h => h.text)).toEqual(expect.arrayContaining(['已暫停，不再盯價', '恢復盯價']));
    });

    it('resumed with the first tick not past: fires normally on the next cross', async () => {
        await boot();
        await addStop();
        await tick(48300);
        await engine.setTriggerPaused(only().id, true);
        await engine.setTriggerPaused(only().id, false);
        await tick(48100);
        expect(only().pending).toBeUndefined();
        await tick(47950);
        expect(m.place).toHaveBeenCalledTimes(1);
    });

    it('a paused trigger is not restore-checked after a reload and stays paused', async () => {
        await boot();
        await addStop();
        await tick(48300);
        await engine.setTriggerPaused(only().id, true);
        await boot({ keepStore: true });
        await tick(47900);
        expect(only().paused).toBe(true);
        expect(only().pending).toBeUndefined();
        expect(m.place).not.toHaveBeenCalled();
    });

    it('a 待確認 trigger cannot be paused (decide it first)', async () => {
        await restoredStopPast();
        await expect(engine.setTriggerPaused(only().id, true)).rejects.toThrow('待確認');
    });
});

async function restoredStopPast() {
    await boot();
    await addStop();
    await tick(48300);
    await boot({ keepStore: true });
    await tick(47900);
    expect(only().pending).toBeTruthy();
}

describe('modify (#226)', () => {
    it('changes price and quantity and records the change; never sends by itself', async () => {
        await boot();
        await addStop();
        await tick(48300);
        await engine.modifyTrigger(only().id, { price: 47900, quantity: 2 });
        expect(only().price).toBe(47900);
        expect(only().quantity).toBe(2);
        expect(only().history?.at(-1)?.text).toBe('修改觸發價 48,000 → 47,900、數量 1 → 2');
        expect(m.place).not.toHaveBeenCalled();
        await tick(47950);
        expect(m.place).not.toHaveBeenCalled();
        await tick(47900);
        expect(m.place).toHaveBeenCalledTimes(1);
        expect(m.place.mock.calls[0]![3]).toBe(2);
    });

    it('a new price already crossed waits for the user (待確認) instead of firing', async () => {
        await boot();
        await addStop();
        await tick(48300);
        await engine.modifyTrigger(only().id, { price: 48400 });
        await tick(48300);
        expect(m.place).not.toHaveBeenCalled();
        expect(only().pending?.reason).toBe('resume');
    });

    it('refuses invalid values and bracket legs', async () => {
        await boot();
        await addStop();
        await expect(engine.modifyTrigger(only().id, { price: -1 })).rejects.toThrow('觸發價');
        await expect(engine.modifyTrigger(only().id, { quantity: 1.5 })).rejects.toThrow('數量');
        expect(only().price).toBe(48000);
    });
});

describe('entries and the finished list (#226)', () => {
    it('an entry trigger fires through the risk checks (not bypassed); a protective stop bypasses them', async () => {
        await boot();
        await entry();
        await addStop({ price: 47000 });
        await tick(48300);
        await tick(47900);
        expect(m.place).toHaveBeenCalledTimes(1);
        expect((m.place.mock.calls[0]![4] as { bypassRisk: boolean }).bypassRisk).toBe(false);
        await tick(46900);
        expect((m.place.mock.calls[1]![4] as { bypassRisk: boolean }).bypassRisk).toBe(true);
        expect(titles()).toContain('觸價單觸發');
    });

    it('fired, cancelled and OCO-removed triggers are listed as ended today', async () => {
        await boot();
        await addStop({ group: 'g1' });
        await engine.addTrigger({ code: 'TXFR1', condition: 'above', price: 48600, action: 'Sell', quantity: 1, kind: 'take', group: 'g1' },
            TXF as never);
        await addStop({ price: 47000 });
        await tick(48300);
        const lone = engine.getTriggers().find(t => t.price === 47000)!;
        await engine.removeTrigger(lone.id);
        await tick(47900);
        await flush();
        const ended = (await import('./trigger-engine')).getTriggers().length;
        expect(ended).toBe(0);
        const snapshot = store.get('sj-pro-trigger-ended');
        const list = JSON.parse(snapshot!) as { reason: string; trigger: { price: number } }[];
        expect(list.map(e => [e.reason, e.trigger.price])).toEqual([['cancelled', 47000], ['fired', 48000], ['oco', 48600]]);
    });

    it('the history notes a disconnect and the reconnect', async () => {
        await boot();
        await addStop();
        await setStatus('down');
        await setStatus('live');
        const texts = only().history?.map(h => h.text) ?? [];
        expect(texts).toEqual(expect.arrayContaining(['連線中斷，暫停盯價', '重新連線，恢復盯價']));
    });
});
