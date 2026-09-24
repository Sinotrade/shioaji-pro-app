// Restore confirmation for triggers already past their price when the
// executor (re)starts (#144). All broker I/O is mocked: no order is sent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from './types/portfolio';

const F1: Account = { account_type: 'F', broker_id: 'fixture-broker-F', account_id: 'fixture-account-F',
    person_id: '', signed: true, username: '' };
const TXF = { code: 'TXFR1', target_code: 'TXFJ6', security_type: 'FUT', exchange: 'TAIFEX' };
const SIM = 'http://sim.invalid|simulation';

const m = vi.hoisted(() => ({
    status: 'live' as string,
    tick: null as ((t: { code: string; close: number; simtrade?: boolean }) => void) | null,
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
    onStreamEvent: (name: string, cb: () => void) => { if (name === 'heartbeat') m.heartbeat = cb; return () => undefined; },
}));
vi.mock('./account-store', () => ({ getAccountState: () => ({ accounts: m.accounts,
    selectedFutures: m.accounts.find(a => a.account_type === 'F') ?? null, selectedStock: null }) }));
vi.mock('./trade', () => ({ notify: m.notify, placeQuickOrder: m.place }));
vi.mock('./contracts-cache', () => ({ ensureContract: m.ensure }));
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
    m.place.mockImplementation(async () => ({ order: { id: `exit-${++n}` }, status: { status: 'PendingSubmit' } }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('restore confirmation (#144)', () => {
    it('a trigger already past on the first tick after reload becomes 待確認 and sends nothing', async () => {
        await restoredStop();
        await tick(47900);
        await tick(47800);
        expect(m.place).not.toHaveBeenCalled();
        expect(only().pending?.price).toBe(47900);
        expect(titles()).toContain('觸價單待確認（未自動送出）');
        await vi.advanceTimersByTimeAsync(600);
        expect(engine.getTriggers()).toHaveLength(1);
        // still pending after another reload; nothing is sent on its ticks
        await boot({ keepStore: true });
        await tick(47700);
        expect(m.place).not.toHaveBeenCalled();
        expect(only().pending).toBeTruthy();
    });

    it('a trigger not past on the first tick after reload resumes normally', async () => {
        await restoredStop();
        await tick(48200);
        expect(only().pending).toBeUndefined();
        await tick(47900);
        expect(m.place).toHaveBeenCalledTimes(1);
        expect(engine.getTriggers()).toHaveLength(0);
    });

    it('a stream reconnect in the same environment keeps immediate firing', async () => {
        await boot();
        await addStop();
        await tick(48300);
        await setEnv(null); // stream down → mode forgotten
        await setEnv(SIM);
        await tick(47900);
        expect(m.place).toHaveBeenCalledTimes(1);
    });

    async function outage(ms: number) {
        await setStatus('down');
        await setEnv(null); // mode forgotten while down
        await vi.advanceTimersByTimeAsync(ms);
        await setStatus('live');
        await setEnv(SIM);
    }

    it('a 59 s same-environment outage keeps immediate firing', async () => {
        await boot();
        await addStop();
        await tick(48300);
        await outage(59_000);
        await tick(47900);
        expect(m.place).toHaveBeenCalledTimes(1);
    });

    it('a 61 s same-environment outage is a restart: already past → 待確認; alerts still notify', async () => {
        await boot();
        await addStop();
        await engine.addTrigger({ code: 'TXFR1', condition: 'below', price: 48000, action: 'Buy', quantity: 0, kind: 'alert' });
        await tick(48300);
        await outage(61_000);
        await tick(47900);
        expect(m.place).not.toHaveBeenCalled();
        expect(titles()).toContain('到價警示');
        expect(only().kind).toBe('stop');
        expect(only().pending?.price).toBe(47900);
    });

    it('a 61 s outage with the first tick not past resumes normally', async () => {
        await boot();
        await addStop();
        await tick(48300);
        await outage(61_000);
        await tick(48100);
        await tick(47900);
        expect(m.place).toHaveBeenCalledTimes(1);
    });

    it('a 105 s silent stall (status still live, no tick / heartbeat) is a restart', async () => {
        await boot();
        await addStop();
        await tick(48300);
        await vi.advanceTimersByTimeAsync(105_000);
        await tick(47900);
        expect(m.place).not.toHaveBeenCalled();
        expect(only().pending?.price).toBe(47900);
    });

    it('a 2 h sleep with the status still live is a restart; heartbeats every 30 s are not', async () => {
        await boot();
        await addStop();
        await tick(48300);
        for (let i = 0; i < 4; i++) { await vi.advanceTimersByTimeAsync(30_000); await heartbeat(); }
        await tick(47900); // quiet market with heartbeats: normal firing
        expect(m.place).toHaveBeenCalledTimes(1);

        await boot();
        await addStop();
        await tick(48300);
        await vi.advanceTimersByTimeAsync(2 * 3600_000);
        await heartbeat(); // first activity after waking up
        await tick(47900);
        expect(m.place).toHaveBeenCalledTimes(1);
        expect(only().pending).toBeTruthy();
    });

    it('a long stretch with the server mode unknown counts toward the 60 s, even with heartbeats', async () => {
        await boot();
        await addStop();
        await tick(48300);
        await setEnv(null);
        for (let i = 0; i < 3; i++) { await vi.advanceTimersByTimeAsync(25_000); await heartbeat(); }
        await setEnv(SIM);
        await tick(47900);
        expect(m.place).not.toHaveBeenCalled();
        expect(only().pending).toBeTruthy();
    });

    it('a manual 送出 refused before sending (declined / kill switch) returns to 待確認 with its OCO pair', async () => {
        await boot();
        await addStop({ group: 'g3' });
        await addStop({ group: 'g3', kind: 'take', condition: 'above', price: 48600 });
        await tick(48300);
        await boot({ keepStore: true });
        await tick(47900);
        const stop = engine.getTriggers().find(t => t.kind === 'stop')!;
        m.place.mockRejectedValueOnce(Object.assign(new Error('已取消下單'), { mutationNotStarted: true }));
        await engine.resolvePendingTrigger(stop.id, 'send');
        await flush();
        expect(m.place).toHaveBeenCalledTimes(1);
        expect(engine.getTriggers().map(t => [t.kind, !!t.pending]).sort()).toEqual([['stop', true], ['take', false]]);
        expect(engine.isGroupProcessed(SIM, 'g3')).toBe(false);
        expect(engine.getExits()).toHaveLength(0); // nothing reserved
        expect(titles()).toContain('觸價單未送出（仍待確認）');
        await tick(47850);
        await engine.resolvePendingTrigger(stop.id, 'send'); // the user can try again
        await flush();
        expect(m.place).toHaveBeenCalledTimes(2);
        expect(engine.getTriggers()).toHaveLength(0);
    });

    it('試撮 ticks count as stream activity but never fire', async () => {
        await boot();
        await addStop();
        await tick(48300);
        for (let i = 0; i < 3; i++) { await vi.advanceTimersByTimeAsync(40_000); await tick(47000, true); }
        expect(m.place).not.toHaveBeenCalled();
        await tick(47900);
        expect(m.place).toHaveBeenCalledTimes(1);
    });

    it('switching back to the trigger\'s environment is a restore', async () => {
        await boot();
        await addStop();
        await tick(48300);
        await setEnv('http://sim.invalid|production');
        await tick(47000); // other environment: not evaluated
        await setEnv(SIM);
        await tick(47900);
        expect(m.place).not.toHaveBeenCalled();
        expect(only().pending?.price).toBe(47900);
    });

    it('keep: fires only after price is seen on the other side and crosses again (persisted)', async () => {
        await restoredStop();
        await tick(47900);
        await engine.resolvePendingTrigger(only().id, 'keep');
        expect(only().pending).toBeUndefined();
        expect(only().awaitingRecross).toBe(true);
        await tick(47800);
        await boot({ keepStore: true });
        await tick(47700);
        expect(m.place).not.toHaveBeenCalled();
        await tick(48100); // back on the non-trigger side → armed
        expect(only().awaitingRecross).toBeUndefined();
        expect(m.place).not.toHaveBeenCalled();
        await tick(47950);
        expect(m.place).toHaveBeenCalledTimes(1);
    });

    it('send: re-checks stream, account and a fresh tick, then places exactly once as a user order', async () => {
        await restoredStop();
        await tick(47900);
        const id = only().id;
        await tick(47850); // price moved: no exact match is required
        m.accounts = [];
        await expect(engine.resolvePendingTrigger(id, 'send')).rejects.toThrow('帳戶');
        m.accounts = [F1];
        await setStatus('down');
        await expect(engine.resolvePendingTrigger(id, 'send')).rejects.toThrow('行情');
        expect(engine.getTriggers()[0]!.pending).toBeTruthy();
        await setStatus('live');
        await expect(engine.resolvePendingTrigger(id, 'send')).rejects.toThrow('尚未收到新成交價'); // needs a fresh tick
        expect(m.place).not.toHaveBeenCalled();
        await tick(47800);
        await engine.resolvePendingTrigger(id, 'send');
        await flush();
        expect(m.place).toHaveBeenCalledTimes(1);
        const [, action, price, qty, opts] = m.place.mock.calls[0]!;
        expect([action, price, qty, opts.account.account_id]).toEqual(['Sell', null, 1, 'fixture-account-F']);
        // a manual trigger may be an entry: risk checks apply, recorded as a user order
        expect([opts.bypassRisk, opts.source]).toEqual([false, 'manual']);
        await expect(engine.resolvePendingTrigger(id, 'send')).rejects.toThrow('不在待確認');
        await tick(47000);
        expect(m.place).toHaveBeenCalledTimes(1);
        expect(engine.getExits()[0]!.status).toBe('working');
    });

    it('an environment change drops known prices: send waits for a fresh tick', async () => {
        await restoredStop();
        await tick(47900);
        await vi.advanceTimersByTimeAsync(600);
        expect(engine.getTriggers()[0]!.pending).toBeTruthy();
        await setEnv('http://sim.invalid|production');
        await setEnv(SIM);
        await expect(engine.resolvePendingTrigger(only().id, 'send')).rejects.toThrow('尚未收到新成交價');
        await tick(47950);
        await engine.resolvePendingTrigger(only().id, 'send');
        await flush();
        expect(m.place).toHaveBeenCalledTimes(1);
    });

    it('bracket exits sent from 待確認 stay protective (bypass risk, auto)', async () => {
        await boot();
        engine.armBracketGroup({ group: 'bracket:g', bracketId: 'plan-1', env: SIM,
            account: { account_type: 'F', broker_id: F1.broker_id, account_id: F1.account_id }, code: 'TXFR1',
            orderCode: 'TXFJ6', entryAction: 'Buy', octype: 'Cover', stopPrice: 48000, takePrice: 48600, quantity: 2 });
        await boot({ keepStore: true });
        await tick(47900);
        const stop = engine.getTriggers().find(t => t.kind === 'stop')!;
        await engine.resolvePendingTrigger(stop.id, 'send');
        await flush();
        const opts = m.place.mock.calls[0]![4];
        expect([opts.bypassRisk, opts.source, opts.ocType]).toEqual([true, 'auto', 'Cover']);
        expect(engine.getTriggers()).toHaveLength(0); // OCO sibling removed
    });

    it('executor handover with the first tick already past → 待確認', async () => {
        await boot();
        await addStop();
        await tick(48300);
        m.lockGranted = false;
        await boot({ keepStore: true }); // second main window: standby mirror
        expect(m.tick).toBeNull();
        m.queued!({}); await flush(); // the executor window closed → take over
        await tick(47900);
        expect(m.place).not.toHaveBeenCalled();
        expect(only().pending?.price).toBe(47900);
    });

    it('no 待確認 notice for a held trigger removed by an OCO sibling on the same tick', async () => {
        await restoredStop({ group: 'g2', price: 48200 });
        // added after the restart: not restore-checked, fires normally
        await addStop({ group: 'g2', kind: 'take', condition: 'above', price: 48100 });
        await tick(48150); // both conditions match; the held stop is removed by the take
        expect(m.place).toHaveBeenCalledTimes(1);
        expect(engine.getTriggers()).toHaveLength(0);
        expect(titles()).not.toContain('觸價單待確認（未自動送出）');
    });

    it('cancel removes only that trigger; a bracket\'s pair is refused', async () => {
        await restoredStop();
        await tick(47900);
        await engine.resolvePendingTrigger(only().id, 'cancel');
        expect(engine.getTriggers()).toHaveLength(0);
        expect(m.place).not.toHaveBeenCalled();

        await boot();
        engine.armBracketGroup({ group: 'bracket:g', bracketId: 'plan-1', env: SIM,
            account: { account_type: 'F', broker_id: F1.broker_id, account_id: F1.account_id }, code: 'TXFR1',
            orderCode: 'TXFJ6', entryAction: 'Buy', octype: 'Cover', stopPrice: 48000, takePrice: 48600, quantity: 2 });
        await boot({ keepStore: true });
        await tick(47900);
        const stop = engine.getTriggers().find(t => t.kind === 'stop')!;
        expect(stop.pending).toBeTruthy();
        await expect(engine.resolvePendingTrigger(stop.id, 'cancel')).rejects.toThrow('括號單');
        expect(engine.getTriggers()).toHaveLength(2);
    });

    it('OCO: sending a pending side removes its sibling and closes the group', async () => {
        await boot();
        await addStop({ group: 'g1' });
        await addStop({ group: 'g1', kind: 'take', condition: 'above', price: 48600 });
        await tick(48300);
        await boot({ keepStore: true });
        await tick(47900);
        const [stop, take] = [engine.getTriggers().find(t => t.kind === 'stop')!, engine.getTriggers().find(t => t.kind === 'take')!];
        expect(stop.pending).toBeTruthy();
        expect(take.pending).toBeUndefined();
        await engine.resolvePendingTrigger(stop.id, 'send');
        await flush();
        expect(m.place).toHaveBeenCalledTimes(1);
        expect(engine.getTriggers()).toHaveLength(0);
        expect(engine.isGroupProcessed(SIM, 'g1')).toBe(true);
    });

    it('OCO: the other side firing normally removes the pending one', async () => {
        await boot();
        await addStop({ group: 'g1' });
        await addStop({ group: 'g1', kind: 'take', condition: 'above', price: 48600 });
        await tick(48300);
        await boot({ keepStore: true });
        await tick(47900);
        await tick(48700);
        expect(m.place).toHaveBeenCalledTimes(1);
        expect(m.place.mock.calls[0]![1]).toBe('Sell');
        expect(engine.getTriggers()).toHaveLength(0);
    });

    it('price alerts are never held: they notify on the first tick after reload', async () => {
        await boot();
        await engine.addTrigger({ code: 'TXFR1', condition: 'below', price: 48000, action: 'Buy', quantity: 0, kind: 'alert' });
        await tick(48300);
        await boot({ keepStore: true });
        await tick(47900);
        expect(titles()).toContain('到價警示');
        expect(engine.getTriggers()).toHaveLength(0);
        expect(m.place).not.toHaveBeenCalled();
    });

    it('the pending description masks the account in privacy mode', async () => {
        await restoredStop();
        await tick(47900);
        const line = engine.describePending(only(), 47850, true);
        expect(line).not.toContain('fixture-account-F');
        expect(line).toContain('目前 47850（差 -150）');
        expect(engine.describePending(only(), 47850, false)).toContain('fixture-account-F');
    });
});
