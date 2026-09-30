// Native execution engine toggle / ownership / UI mapping (#201 wiring).
// The Tauri host is replaced by an in-memory fake of the execution_* commands;
// broker I/O is mocked: nothing is sent anywhere.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '../types/portfolio';
import type { OrderProgram, UserCommand } from './model';

const acct = (type: 'S' | 'F', id: string): Account => ({ account_type: type, broker_id: `fixture-broker-${type}`,
    account_id: id, person_id: '', signed: true, username: '' });
const F1 = acct('F', 'fixture-account-F');
const TXF = { code: 'TXFR1', target_code: 'TXFJ6', security_type: 'FUT', exchange: 'TAIFEX' };

const m = vi.hoisted(() => ({
    status: 'live' as string,
    tick: null as ((t: { code: string; close: number; simtrade?: boolean }) => void) | null,
    heartbeat: null as (() => void) | null,
    statusChanged: [] as (() => void)[],
    envChanged: [] as (() => void)[],
    accounts: [] as Account[],
    place: vi.fn(),
    notify: vi.fn(),
    ensure: vi.fn(),
    env: 'http://sim.invalid|simulation' as string | null,
    queued: null as ((lock: object | null) => unknown) | null,
}));

vi.mock('../runtime', () => ({ getApiBase: () => 'http://sim.invalid' }));
vi.mock('../stream', () => ({
    getStreamStatus: () => m.status,
    subscribeStatusStore: (cb: () => void) => { m.statusChanged.push(cb); return () => undefined; },
    onOrderEvent: () => () => undefined,
    onAnyTick: (cb: typeof m.tick) => { m.tick = cb; return () => undefined; },
    onStreamEvent: (name: string, cb: () => void) => { if (name === 'heartbeat') m.heartbeat = cb; return () => undefined; },
}));
vi.mock('../account-store', () => ({ getAccountState: () => ({ accounts: m.accounts,
    selectedFutures: m.accounts.find(a => a.account_type === 'F') ?? null, selectedStock: null }) }));
vi.mock('../trade', () => ({ notify: m.notify, placeQuickOrder: m.place }));
vi.mock('../contracts-cache', () => ({ ensureContract: m.ensure, getCachedContract: () => undefined }));
vi.mock('../quote-ownership', () => ({ retainQuote: () => () => undefined }));
vi.mock('../trading-state', () => ({ tradeCacheContinuous: () => true, checkTradeCacheHealth: vi.fn(),
    getTradingState: () => ({ positions: [], queries: { positions: { updatedAt: null, needsReconcile: false, error: null } } }) }));
vi.mock('../shioaji', () => ({ fetchTrades: async () => [], fetchTradeCacheHealth: async () => ({ state: 'Healthy', reasons: [] }),
    cancelOrder: vi.fn() }));
vi.mock('../boot', () => ({ subscribeTradeReports: vi.fn() }));
vi.mock('../protection-env', () => {
    const envBase = (env: string) => env.slice(0, env.lastIndexOf('|'));
    return {
        currentProtectionEnv: () => m.env,
        protectionEnvLabel: () => '',
        refreshProtectionEnv: async () => undefined,
        onProtectionEnvChange: (cb: () => void) => { m.envChanged.push(cb); return () => undefined; },
        envBase,
        reportEnvMatches: (env: string, base: string) => envBase(env) === base,
        watchProtectionEnv: () => undefined,
    };
});

/** In-memory stand-in for the Rust host's execution_* commands. */
function fakeHost(opts: { live?: boolean } = {}) {
    const programs: OrderProgram[] = [];
    const commands: UserCommand[] = [];
    let revision = 1;
    const health = () => ({ enabled: true, state: opts.live === false ? 'down' : 'live', env: 'simulation',
        serverId: 'http://sim.invalid', lastError: null, partitionErrors: [], programs: programs.length, revision });
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
        if (cmd === 'execution_programs') return { revision, programs: structuredClone(programs), lastPrices: { TXFR1: 48123 } };
        if (cmd === 'execution_status' || cmd === 'execution_set_enabled') return health();
        if (cmd !== 'execution_command') throw new Error(`unexpected ${cmd}`);
        const envelope = args!.envelope as { schema: string; command: UserCommand };
        expect(envelope.schema).toBe('execution-v1');
        const c = envelope.command;
        commands.push(c);
        revision++;
        if (c.op === 'create') {
            programs.push({ ...structuredClone(c.program), version: 1, status: 'running' });
            return { accepted: true, notices: [{ code: 'created', programId: c.program.id, levelId: null, detail: '' }], revision };
        }
        const p = programs.find(x => x.id === c.programId);
        if (!p || p.version !== c.version) return { accepted: false, notices: [{ code: 'rejected.staleVersion', programId: null, levelId: null, detail: '' }], revision };
        if (c.op === 'stop') { p.status = 'stopped'; p.version++; }
        else if (c.op === 'remove') programs.splice(programs.indexOf(p), 1);
        else p.version++;
        return { accepted: true, notices: [], revision };
    });
    return { invoke, programs, commands, bump: () => { revision++; } };
}

let store = new Map<string, string>();
let engine: typeof import('../trigger-engine');
let bracket: typeof import('../bracket');
let native: typeof import('./native');
let host: ReturnType<typeof fakeHost>;

async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); }

async function boot(opts: { enabled?: boolean; desktop?: boolean; live?: boolean; keepStore?: boolean } = {}) {
    vi.resetModules();
    if (!opts.keepStore) store = new Map();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    vi.stubGlobal('location', { search: '' });
    vi.stubGlobal('navigator', { locks: { request: (_n: string, a: unknown, b?: (lock: object | null) => unknown) => {
        const cb = (typeof a === 'function' ? a : b) as (lock: object | null) => unknown;
        if (typeof a === 'function' || !(a as { ifAvailable?: boolean }).ifAvailable) { m.queued = cb; return new Promise(() => undefined); }
        const r = cb({}); return Promise.resolve(r instanceof Promise ? undefined : r); } } });
    m.tick = null; m.heartbeat = null; m.statusChanged = []; m.envChanged = [];
    host = fakeHost({ live: opts.live });
    native = await import('./native');
    native.__setNativeInvokeForTest(host.invoke as never, { desktop: opts.desktop ?? true, enabled: opts.enabled ?? false });
    engine = await import('../trigger-engine');
    bracket = await import('../bracket');
    engine.startTriggerEngine();
    bracket.startBracketRuntime();
    await flush();
    (m.heartbeat as (() => void) | null)?.();
    await native.refreshNative();
    await flush();
}

const addStop = (over: Record<string, unknown> = {}) => engine.addTrigger(
    { code: 'TXFR1', condition: 'below', price: 48000, action: 'Sell', quantity: 1, kind: 'stop', ...over }, TXF as never);
const tick = async (close: number) => { m.tick!({ code: 'TXFR1', close }); await flush(); };
const creates = () => host.commands.filter(c => c.op === 'create');

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('BroadcastChannel', undefined);
    m.status = 'live'; m.accounts = [F1]; m.env = 'http://sim.invalid|simulation';
    for (const f of [m.place, m.notify, m.ensure]) f.mockReset();
    m.ensure.mockResolvedValue(TXF);
    m.place.mockImplementation(async () => ({ order: { id: 'T1' }, status: { status: 'Submitted' } }));
});

describe('toggle 原生執行引擎（實驗）', () => {
    it('is off by default: new triggers stay in the TS runtime', async () => {
        await boot();
        expect(native.getNativeExecutionEnabled()).toBe(false);
        await addStop();
        expect(engine.getTriggers()).toHaveLength(1);
        expect(creates()).toHaveLength(0);
    });

    it('never turns on in the web build', async () => {
        await boot({ desktop: false });
        native.setNativeExecutionEnabled(true);
        expect(native.getNativeExecutionEnabled()).toBe(false);
        expect(native.nativeOwnsNew()).toBe(false);
        await addStop();
        expect(engine.getTriggers()).toHaveLength(1);
        expect(host.invoke).not.toHaveBeenCalled();
    });

    it('persists and tells the host from the main window', async () => {
        await boot();
        native.setNativeExecutionEnabled(true);
        await flush();
        expect(store.get(native.NATIVE_TOGGLE_KEY)).toBe('1');
        expect(host.invoke).toHaveBeenCalledWith('execution_set_enabled', { enabled: true });
    });
});

describe('ownership: one executor per trigger / bracket', () => {
    it('on: a new stop becomes a native program only — the TS executor never holds or fires it', async () => {
        await boot({ enabled: true });
        const t = await addStop();
        expect(t?.id.startsWith('native:')).toBe(true);
        expect(engine.getTriggers()).toHaveLength(0);
        const [create] = creates();
        expect(create?.op).toBe('create');
        const program = (create as Extract<UserCommand, { op: 'create' }>).program;
        expect(program.kind).toBe('trigger');
        expect(program.binding).toEqual({ env: 'simulation', serverId: 'http://sim.invalid',
            account: { accountType: 'F', brokerId: F1.broker_id, accountId: F1.account_id },
            contract: { market: 'futures', quoteCode: 'TXFR1', orderCode: 'TXFJ6', securityType: 'FUT' } });
        expect(program.levels[0]!.entry).toMatchObject({ type: 'touch', condition: 'below', price: 48000,
            order: { priceType: 'MKT', timeInForce: 'IOC' } });
        // shown like any trigger, marked native
        const rows = engine.getDisplayTriggers();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: 'stop', price: 48000, action: 'Sell', quantity: 1, code: 'TXFR1',
            native: { programId: program.id, leg: 'entry' } });
        // a crossing tick in the webview never sends it: the native engine does
        await tick(47000);
        expect(m.place).not.toHaveBeenCalled();
    });

    it('a TS trigger created before the toggle keeps running in TS (no double execution)', async () => {
        await boot();
        await addStop();
        await tick(48300);
        native.setNativeExecutionEnabled(true);
        await flush();
        await tick(47900);
        expect(m.place).toHaveBeenCalledTimes(1);
        expect(creates()).toHaveLength(0);
    });

    it('turning the toggle off keeps native programs listed (they run to completion natively)', async () => {
        await boot({ enabled: true });
        await addStop();
        native.setNativeExecutionEnabled(false);
        await flush();
        expect(engine.getDisplayTriggers().filter(r => r.id.startsWith('native:'))).toHaveLength(1);
        await addStop({ price: 47000 });
        expect(engine.getTriggers()).toHaveLength(1); // the new one is TS again
        expect(creates()).toHaveLength(1);
    });

    it('price alerts never become native programs', async () => {
        await boot({ enabled: true });
        await engine.addTrigger({ code: 'TXFR1', condition: 'above', price: 49000, action: 'Sell', quantity: 0, kind: 'alert' });
        expect(creates()).toHaveLength(0);
        expect(engine.getTriggers()).toHaveLength(1);
    });

    it('commands for a native row go to the native engine, TS rows to the TS bus', async () => {
        await boot({ enabled: true });
        const t = await addStop();
        await engine.removeTrigger(t!.id);
        expect(host.commands.map(c => c.op)).toEqual(['create', 'stop', 'remove']);
        expect(engine.getDisplayTriggers()).toHaveLength(0);

        native.setNativeExecutionEnabled(false);
        await flush();
        const ts = await addStop();
        const before = host.commands.length;
        await engine.removeTrigger(ts!.id);
        expect(host.commands.length).toBe(before);
        expect(engine.getTriggers()).toHaveLength(0);
    });

    it('a native 待確認 is resolved by a versioned native command', async () => {
        await boot({ enabled: true });
        await addStop();
        const p = host.programs[0]!;
        p.levels[0]!.phase = 'needsConfirm';
        p.levels[0]!.pending = { leg: 'entry', price: 47950, ts: 1_700_000_000_000, reason: 'restart' };
        host.bump();
        await native.refreshNative();
        const row = engine.getDisplayTriggers()[0]!;
        expect(row.pending).toEqual({ price: 47950, at: 1_700_000_000_000, reason: 'restart' });
        await engine.resolvePendingTrigger(row.id, 'keep');
        const last = host.commands[host.commands.length - 1]!;
        expect(last).toEqual({ op: 'resolvePending', programId: p.id, version: 1, levelId: p.levels[0]!.id, choice: 'keep' });
    });

    it('on: a bracket registers as a native program tracking the ticket\'s entry order; TS plans stay empty', async () => {
        await boot({ enabled: true });
        await bracket.ensureBracketHost();
        const plan = await bracket.registerBracket({ env: m.env!, account: { account_type: 'F', broker_id: F1.broker_id,
            account_id: F1.account_id }, orderId: 'fixture-f1', seqno: 'fixture-f1', quoteCode: 'TXFR1', orderCode: 'TXFJ6',
            securityType: 'FUT', exchange: 'TAIFEX', action: 'Buy', quantity: 2, stopPrice: 48000, takePrice: 48600 });
        expect(bracket.getBrackets()).toHaveLength(0);
        const program = (creates()[0] as Extract<UserCommand, { op: 'create' }>).program;
        expect(program.kind).toBe('bracket');
        expect(program.levels[0]!.entry).toEqual({ type: 'external', orderId: 'fixture-f1' });
        expect(program.levels[0]!.exit).toMatchObject({ type: 'oco', stop: { price: 48000, condition: 'below' },
            take: { price: 48600, condition: 'above' }, order: { priceType: 'MKT', octype: 'Cover' } });
        expect(plan.id).toBe(program.id);
        expect(bracket.getDisplayBrackets().map(p => bracket.isNativeBracket(p))).toEqual([true]);
        // no OCO pair is armed in the TS trigger engine
        expect(engine.getTriggers()).toHaveLength(0);
    });

    it('a native bracket is refused BEFORE the entry is sent when the engine is not live', async () => {
        await boot({ enabled: true, live: false });
        await expect(bracket.ensureBracketHost()).rejects.toThrow('原生執行引擎尚未連上伺服器');
        m.env = 'http://sim.invalid|production';
        await boot({ enabled: true });
        await expect(bracket.ensureBracketHost()).rejects.toThrow('模式與目前不同');
    });
});

describe('native programs in the UI shape', () => {
    it('a holding bracket shows its OCO legs as bracket trigger rows; finished triggers are dropped', async () => {
        const view = await import('./native-view');
        const program = view.programForNewBracket({ env: 'http://s|simulation', account: { account_type: 'F', broker_id: 'b', account_id: 'a' },
            orderId: 'E1', seqno: '', quoteCode: 'TXFR1', orderCode: 'TXFJ6', securityType: 'FUT', exchange: 'TAIFEX',
            action: 'Buy', quantity: 2, stopPrice: 100, takePrice: 120 }, 'nb-1', 5)!;
        const lv = program.levels[0]!;
        expect(view.triggerRowsFromPrograms([program])).toHaveLength(0); // nothing filled yet
        lv.position = 1; lv.entryFilled = 1; lv.phase = 'holding';
        lv.orders[0]!.filled = 1;
        const rows = view.triggerRowsFromPrograms([program]);
        expect(rows.map(r => [r.kind, r.condition, r.price, r.action, r.quantity, r.bracketId])).toEqual([
            ['stop', 'below', 100, 'Sell', 1, 'brk:nb-1'], ['take', 'above', 120, 'Sell', 1, 'brk:nb-1']]);
        const [plan] = view.bracketPlansFromPrograms([program]);
        expect(plan).toMatchObject({ id: 'brk:nb-1', orderId: 'E1', filled: 1, quantity: 2, stopPrice: 100, takePrice: 120,
            entryClosed: false, exit: null, env: 'http://s|simulation' });
        expect(view.programFinished(program)).toBe(false);
        const trig = view.programForNewTrigger({ id: 't', code: 'TXFR1', condition: 'above', price: 50, action: 'Sell',
            quantity: 1, kind: 'take', env: 'http://s|simulation', account: { account_type: 'F', broker_id: 'b', account_id: 'a' },
            orderCode: 'TXFJ6' })!;
        expect(view.triggerRowsFromPrograms([trig])[0]!.kind).toBe('take');
        trig.levels[0]!.phase = 'done';
        expect(view.programFinished(trig)).toBe(true);
        expect(view.triggerRowsFromPrograms([trig])).toHaveLength(0);
    });
});
