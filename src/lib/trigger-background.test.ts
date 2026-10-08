// 「背景持續執行（實驗）」 (#201 ①-3): who owns a new trigger, and that with
// the setting off this window's trigger engine behaves exactly as before.
// All broker I/O and the Tauri host are mocked: no order is sent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderProgram } from './execution/model';
import type { Account } from './types/portfolio';

const F1: Account = { account_type: 'F', broker_id: 'fixture-broker-F', account_id: 'fixture-account-F',
    person_id: '', signed: true, username: '' };
const S1: Account = { ...F1, account_type: 'S', account_id: 'fixture-account-S' };
const TXF = { code: 'TXFR1', target_code: 'TXFJ6', security_type: 'FUT', exchange: 'TAIFEX' };
const TXO = { code: 'TXO23000J6', security_type: 'OPT', exchange: 'TAIFEX' };
const STK = { code: '2330', security_type: 'STK', exchange: 'TSE' };
const SIM = 'http://sim.invalid|simulation';

const m = vi.hoisted(() => ({
    tick: [] as ((t: { code: string; close: number; simtrade?: boolean }) => void)[],
    place: vi.fn(),
    notify: vi.fn(),
    ensure: vi.fn(),
    invoke: vi.fn(),
    enabled: false,
    programs: [] as unknown[],
}));

vi.mock('./runtime', () => ({ getApiBase: () => 'http://sim.invalid' }));
vi.mock('./stream', () => ({
    getStreamStatus: () => 'live',
    subscribeStatusStore: () => () => undefined,
    onOrderEvent: () => () => undefined,
    onAnyTick: (cb: (typeof m.tick)[number]) => { m.tick.push(cb); return () => undefined; },
    onOddLotTick: () => () => undefined,
    onStreamEvent: () => () => undefined,
}));
vi.mock('./account-store', () => ({ getAccountState: () => ({ accounts: [S1, F1], selectedStock: S1, selectedFutures: F1 }) }));
vi.mock('./trade', () => ({ notify: m.notify, placeQuickOrder: m.place }));
vi.mock('./contracts-cache', () => ({ ensureContract: m.ensure, getCachedContract: () => undefined }));
vi.mock('./quote-ownership', () => ({ retainQuote: () => () => undefined }));
vi.mock('./trading-state', () => ({ getTradingState: () => ({ positions: [],
    queries: { positions: { updatedAt: null, needsReconcile: false, error: null } } }) }));
vi.mock('./shioaji', () => ({ fetchTrades: async () => [] }));
vi.mock('./protection-env', () => ({
    currentProtectionEnv: () => SIM,
    refreshProtectionEnv: async () => undefined,
    onProtectionEnvChange: () => () => undefined,
    envBase: (env: string) => env.slice(0, env.lastIndexOf('|')),
    reportEnvMatches: () => true,
    watchProtectionEnv: () => undefined,
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: m.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined }));

let engine: typeof import('./trigger-engine');
let bg: typeof import('./execution/background');
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); }
async function boot(desktop = true) {
    vi.resetModules();
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    vi.stubGlobal('location', { search: '' });
    vi.stubGlobal('navigator', { locks: { request: (_n: string, a: unknown, b?: (lock: object | null) => unknown) => {
        const cb = (typeof a === 'function' ? a : b) as (lock: object | null) => unknown;
        if (typeof a === 'function' || !(a as { ifAvailable?: boolean }).ifAvailable) return new Promise(() => undefined);
        const r = cb({}); return Promise.resolve(r instanceof Promise ? undefined : r); } } });
    engine = await import('./trigger-engine');
    bg = await import('./execution/background');
    bg.__setBackgroundInvokeForTest(m.invoke as never, { desktop });
    engine.startTriggerEngine();
    bg.startBackgroundExecution();
    await flush();
    for (const t of m.tick) t({ code: 'TXFR1', close: 20000 }); // first tick decides (#144): not past
    await flush();
}
const tick = async (code: string, close: number) => { for (const t of m.tick) t({ code, close }); await flush(); };
const calls = (cmd: string) => m.invoke.mock.calls.filter(([c]) => c === cmd);
const stop = (over: Record<string, unknown> = {}) => ({ code: 'TXFR1', condition: 'below' as const, price: 19900,
    action: 'Sell' as const, quantity: 1, kind: 'stop' as const, ...over });

function program(over: Partial<OrderProgram['levels'][number]> = {}): OrderProgram {
    return {
        id: 'trg:p1', kind: 'trigger', version: 3, status: 'running', pauseReason: null, hold: null, ocoLevels: false,
        binding: { env: 'simulation', serverId: 'http://sim.invalid',
            account: { accountType: 'F', brokerId: F1.broker_id, accountId: F1.account_id },
            contract: { market: 'futures', quoteCode: 'TXFR1', orderCode: 'TXFJ6', securityType: 'FUT' } },
        levels: [{ id: 'L1', side: 'Sell', qty: 1, entry: { type: 'touch', condition: 'below', price: 19800,
            order: { priceType: 'MKT', timeInForce: 'IOC' } }, exit: null, phase: 'idle', check: null, recross: [],
            pending: null, orders: [], position: 0, entryFilled: 0, unprotected: 0, cycles: 0, detail: null, ...over }],
        generator: null, cycle: { rearmAfterExit: false, maxCycles: null, partialFill: 'immediate' },
        bounds: { upper: null, lower: null, onBreakUpper: 'none', onBreakLower: 'none' },
        session: { resumeRule: 'confirm', longDisconnectMs: 60000, silentStallMs: 90000 },
        risk: { maxWorkingEntries: null }, hooks: [], intentSeq: 0, issues: [], createdAt: 1, updatedAt: 1,
    };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('BroadcastChannel', undefined);
    m.tick = [];
    m.enabled = false;
    m.programs = [];
    for (const f of [m.place, m.notify, m.ensure, m.invoke]) f.mockReset();
    m.ensure.mockImplementation(async (code: string) => code === '2330' ? STK : code === TXO.code ? TXO : TXF);
    m.place.mockImplementation(async () => ({ order: { id: 'exit-1' }, status: { status: 'PendingSubmit' } }));
    m.invoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'execution_status') return { enabled: m.enabled, state: 'live', env: 'simulation', serverId: 'http://sim.invalid',
            lastError: null, partitionErrors: [], programs: m.programs.length, activePrograms: m.programs.length, revision: 1 };
        if (cmd === 'execution_programs') return { revision: m.programs.length + 1, programs: m.programs };
        if (cmd === 'execution_list_pending_confirm') return { version: 1, runId: 'r', sequence: 1, uncleanShutdown: false, items: [] };
        return { accepted: true, notices: [], revision: 9 };
    });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('setting off: this window runs every trigger exactly as before', () => {
    it('a futures stop is created here, fires here, and nothing is created in the background', async () => {
        await boot();
        const t = await engine.addTrigger(stop(), TXF as never);
        expect(t?.id.startsWith('tg-')).toBe(true);
        expect(engine.getTriggers().map(x => x.id)).toEqual([t!.id]);
        // nothing in the background: the displayed list is this engine's own array
        expect(engine.getDisplayTriggers()).toBe(engine.getTriggers());
        await tick('TXFR1', 19900);
        expect(m.place).toHaveBeenCalledTimes(1);
        expect(calls('execution_create')).toHaveLength(0);
    });

    it('the web build never asks the App', async () => {
        await boot(false);
        m.enabled = true; // even if a host said so
        await engine.addTrigger(stop(), TXF as never);
        expect(m.invoke).not.toHaveBeenCalled();
        expect(engine.getTriggers()).toHaveLength(1);
    });
});

describe('setting on (#201 ①-3)', () => {
    it('a new futures / options stop or take runs in the background and is never evaluated here', async () => {
        m.enabled = true;
        await boot();
        await engine.addTrigger(stop(), TXF as never);
        await engine.addTrigger({ ...stop(), code: TXO.code, condition: 'above', price: 120, action: 'Buy', kind: 'take' }, TXO as never);
        expect(engine.getTriggers()).toHaveLength(0);
        const created = calls('execution_create').map(([, a]) => (a as { program: OrderProgram }).program);
        expect(created).toHaveLength(2);
        expect(created[0]).toMatchObject({ kind: 'trigger', binding: { env: 'simulation', serverId: 'http://sim.invalid',
            account: { accountType: 'F', accountId: F1.account_id },
            contract: { market: 'futures', quoteCode: 'TXFR1', orderCode: 'TXFJ6', securityType: 'FUT' } },
            levels: [{ side: 'Sell', qty: 1, entry: { type: 'touch', condition: 'below', price: 19900,
                order: { priceType: 'MKT', timeInForce: 'IOC' } } }] });
        expect(created[1]!.binding.contract.securityType).toBe('OPT');
        await tick('TXFR1', 19000);
        expect(m.place).not.toHaveBeenCalled();
    });

    it('stocks, alerts and OCO groups stay in this window', async () => {
        m.enabled = true;
        await boot();
        await engine.addTrigger({ ...stop(), code: '2330', price: 900 }, STK as never);
        await engine.addTrigger({ ...stop(), kind: 'alert', quantity: 0 });
        await engine.addTrigger({ ...stop(), group: 'g1' }, TXF as never);
        expect(calls('execution_create')).toHaveLength(0);
        expect(engine.getTriggers()).toHaveLength(3);
    });

    it('a trigger created before the setting was turned on keeps running here', async () => {
        await boot();
        await engine.addTrigger(stop(), TXF as never);
        m.enabled = true;
        await bg.refreshBackground();
        await tick('TXFR1', 19900);
        expect(m.place).toHaveBeenCalledTimes(1);
        expect(calls('execution_create')).toHaveLength(0);
    });

    it('a refused create is reported and nothing is created anywhere', async () => {
        m.enabled = true;
        await boot();
        m.invoke.mockImplementationOnce(async () => { throw new Error('背景執行只支援期貨與選擇權，未建立'); });
        expect(await engine.addTrigger(stop(), TXF as never)).toBeNull();
        expect(engine.getTriggers()).toHaveLength(0);
        expect(m.notify.mock.calls.some(([n]) => (n as { title: string }).title === '觸價單未建立')).toBe(true);
    });
});

describe('background rows', () => {
    it('show as triggers; removing and deciding go to the App, never to this engine', async () => {
        m.programs = [program(), { ...program({ id: 'L1', phase: 'needsConfirm',
            pending: { leg: 'entry', price: 19790, ts: 5, reason: 'restart' } }), id: 'trg:p2' }];
        await boot();
        await bg.refreshBackground();
        const rows = engine.getDisplayTriggers();
        expect(rows.map(r => r.id)).toEqual(['bg:trg:p1:L1', 'bg:trg:p2:L1']);
        expect(rows[1]).toMatchObject({ kind: 'stop', env: SIM, pending: { price: 19790, at: 5, reason: 'restart' } });
        await engine.removeTrigger('bg:trg:p1:L1');
        expect(calls('execution_remove').map(([, a]) => a)).toEqual([{ programId: 'trg:p1' }]);
        await engine.resolvePendingTrigger('bg:trg:p2:L1', 'send', { allowUnpast: true });
        expect(calls('execution_resolve_trigger').map(([, a]) => a)).toEqual([
            { request: { programId: 'trg:p2', levelId: 'L1', choice: 'send', allowUnpast: true } }]);
        expect(m.place).not.toHaveBeenCalled();
    });

    it('an order with an unknown outcome is not a trigger row (the 委託待確認 card decides it)', async () => {
        m.programs = [program({ phase: 'needsConfirm', pending: { leg: 'entry', price: 1, ts: 5, reason: 'unknownNotSent' } })];
        await boot();
        await bg.refreshBackground();
        expect(engine.getDisplayTriggers()).toHaveLength(0);
        // and the card reads the App's real list
        await flush();
        expect(calls('execution_list_pending_confirm').length).toBeGreaterThan(0);
    });

    it('finished background triggers are dropped by the main window', async () => {
        m.programs = [program({ phase: 'done' })];
        await boot();
        await bg.refreshBackground();
        await flush();
        expect(calls('execution_remove').map(([, a]) => a)).toEqual([{ programId: 'trg:p1' }]);
    });
});
