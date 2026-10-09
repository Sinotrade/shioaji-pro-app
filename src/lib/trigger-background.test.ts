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
    engineDown: false,
    settingUnreadable: false,
    create: null as null | ((a: { program: OrderProgram }) => Promise<unknown>),
    programs: [] as unknown[],
}));

vi.mock('./runtime', () => ({ getApiBase: () => 'http://sim.invalid' }));
vi.mock('./stream', () => ({
    getStreamStatus: () => 'live',
    subscribeStatusStore: () => () => undefined,
    onOrderEvent: () => () => undefined,
    onAnyTick: (cb: (typeof m.tick)[number]) => { m.tick.push(cb); return () => undefined; },
    onOddLotTick: () => () => undefined,
    onAnyBidAsk: () => () => undefined,
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
    m.engineDown = false;
    m.settingUnreadable = false;
    m.create = null;
    m.invoke.mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === 'execution_create' && m.create) { const f = m.create; m.create = null; return f(args as { program: OrderProgram }); }
        if (cmd === 'execution_get_enabled') {
            if (m.settingUnreadable) throw new Error('背景持續執行的設定無法讀取');
            return m.enabled;
        }
        if (m.engineDown && cmd.startsWith('execution_')) throw new Error('背景執行尚未啟動');
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

    it('is not affected when the background engine cannot be reached', async () => {
        m.engineDown = true;
        await boot();
        await engine.addTrigger(stop(), TXF as never);
        expect(engine.getTriggers()).toHaveLength(1);
        await tick('TXFR1', 19900);
        expect(m.place).toHaveBeenCalledTimes(1);
        expect(m.notify.mock.calls.some(([n]) => (n as { title: string }).title === '觸價單未建立')).toBe(false);
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

    it('the engine cannot be reached: refused with a clear message, never silently run here', async () => {
        m.enabled = true;
        m.engineDown = true;
        await boot();
        expect(await engine.addTrigger(stop(), TXF as never)).toBeNull();
        expect(engine.getTriggers()).toHaveLength(0);
        expect(calls('execution_create')).toHaveLength(0);
        const bodies = m.notify.mock.calls.map(([n]) => (n as { body: string }).body);
        expect(bodies).toContain('背景執行目前無法使用，請稍後再試或關閉背景持續執行改用本視窗');
        // a stock trigger is not the engine's: unaffected
        await engine.addTrigger({ ...stop(), code: '2330', price: 900 }, STK as never);
        expect(engine.getTriggers()).toHaveLength(1);
    });

    it('the setting cannot be read: unknown, refused, never taken as off', async () => {
        m.settingUnreadable = true;
        await boot();
        expect(await engine.addTrigger(stop(), TXF as never)).toBeNull();
        expect(engine.getTriggers()).toHaveLength(0);
        expect(calls('execution_create')).toHaveLength(0);
        const bodies = m.notify.mock.calls.map(([n]) => (n as { body: string }).body);
        expect(bodies.some(b => b.includes('開關狀態不明'))).toBe(true);
    });

    it('reads the setting fresh for every new trigger: a change made in another window counts at once', async () => {
        await boot();
        await bg.refreshBackground(); // this window has seen OFF
        m.enabled = true; // turned on elsewhere; no event has reached this window yet
        await engine.addTrigger(stop(), TXF as never);
        expect(calls('execution_create')).toHaveLength(1);
        expect(engine.getTriggers()).toHaveLength(0);
        m.enabled = false; // and off again
        await engine.addTrigger(stop(), TXF as never);
        expect(engine.getTriggers()).toHaveLength(1);
    });

    it('a failed setting read is unknown even after OFF was seen, and the shown setting becomes unknown', async () => {
        await boot();
        await bg.refreshBackground();
        expect(bg.getBackgroundSetting()).toBe(false);
        m.settingUnreadable = true;
        expect(await engine.addTrigger(stop(), TXF as never)).toBeNull();
        expect(engine.getTriggers()).toHaveLength(0);
        expect(bg.getBackgroundSetting()).toBeNull();
        await bg.refreshBackground();
        expect(bg.getBackgroundSetting()).toBeNull();
    });

    it('a failed status read refuses even after a good one, and the shown status is dropped', async () => {
        m.enabled = true;
        await boot();
        await bg.refreshBackground();
        expect(bg.getBackgroundHealth()).not.toBeNull();
        m.engineDown = true;
        expect(await engine.addTrigger(stop(), TXF as never)).toBeNull();
        expect(calls('execution_create')).toHaveLength(0);
        expect(bg.getBackgroundHealth()).toBeNull();
    });

    it('seen ON, engine down, but now OFF: runs here, not refused', async () => {
        m.enabled = true;
        await boot();
        await bg.refreshBackground();
        m.engineDown = true;
        m.enabled = false;
        await engine.addTrigger(stop(), TXF as never);
        expect(engine.getTriggers()).toHaveLength(1);
        expect(m.notify.mock.calls.some(([n]) => (n as { title: string }).title === '觸價單未建立')).toBe(false);
    });

    it('a failed save is re-read: the shown setting is what the file says', async () => {
        await boot();
        m.invoke.mockImplementationOnce(async () => { m.enabled = true; throw new Error('目錄同步失敗'); });
        await expect(bg.setBackgroundEnabled(true)).rejects.toThrow('目錄同步失敗');
        expect(bg.getBackgroundSetting()).toBe(true);
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

    it('decides with the App\'s setting even before the first status arrived', async () => {
        m.enabled = true;
        await boot();
        bg.__setBackgroundInvokeForTest(m.invoke as never, { desktop: true }); // status not read yet
        await engine.addTrigger(stop(), TXF as never);
        expect(calls('execution_create')).toHaveLength(1);
        expect(engine.getTriggers()).toHaveLength(0);
    });

    it('a lost create answer is checked against the App before saying it was not created', async () => {
        m.enabled = true;
        await boot();
        m.create = async (a: { program: OrderProgram }) => {
            m.programs = [a.program]; // the App kept it, the answer was lost
            throw new Error('ipc closed');
        };
        const t = await engine.addTrigger(stop(), TXF as never);
        expect(t?.id.startsWith('bg:')).toBe(true);
        expect(m.notify.mock.calls.some(([n]) => (n as { title: string }).title === '觸價單未建立')).toBe(false);
        expect(engine.getTriggers()).toHaveLength(0);
    });

    it('an unconfirmed create is never reported as not created', async () => {
        m.enabled = true;
        await boot();
        m.create = async () => { throw new Error('ipc closed'); };
        expect(await engine.addTrigger(stop(), TXF as never)).toBeNull();
        const titles = m.notify.mock.calls.map(([n]) => (n as { title: string }).title);
        expect(titles).toContain('觸價單建立結果未確認');
        expect(titles).not.toContain('觸價單未建立');
        expect(engine.getTriggers()).toHaveLength(0);
    });

    it('a refused create is reported and nothing is created anywhere', async () => {
        m.enabled = true;
        await boot();
        m.create = async () => ({ accepted: false, notices: [{ code: 'rejected.duplicateProgram', programId: null, levelId: null, detail: '' }], revision: 1 });
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

    it('#226 modify: paused, re-created with the same order (Cover kept, first tick decides), then removed; a crossed price is refused', async () => {
        m.programs = [program({ entry: { type: 'touch', condition: 'below', price: 19800, order: { priceType: 'MKT', timeInForce: 'IOC', octype: 'Cover' } } })];
        await boot();
        await bg.refreshBackground();
        await expect(engine.modifyTrigger('bg:trg:p1:L1', { price: 20100 })).rejects.toThrow('已穿過目前價格');
        expect(calls('execution_pause')).toHaveLength(0);
        m.create = async ({ program: p }) => { m.programs = [...m.programs, p]; return { accepted: true, notices: [], revision: 10 }; };
        await engine.modifyTrigger('bg:trg:p1:L1', { price: 19700, quantity: 2 });
        expect(calls('execution_pause').map(([, a]) => a)).toEqual([{ programId: 'trg:p1' }]);
        const created = calls('execution_create')[0]![1] as { program: OrderProgram };
        const lv = created.program.levels[0]!;
        expect(lv.check).toBe('resume');
        expect(lv.qty).toBe(2);
        expect(lv.entry).toMatchObject({ type: 'touch', price: 19700, order: { octype: 'Cover' } });
        expect(calls('execution_remove').map(([, a]) => a)).toEqual([{ programId: 'trg:p1' }]);
        expect(m.place).not.toHaveBeenCalled();
    });

    it('a trigger turned back on in a new session that is already past says so', async () => {
        m.programs = [{ ...program({ phase: 'needsConfirm', pending: { leg: 'entry', price: 19790, ts: 5, reason: 'resume' } }),
            id: 'rearm:trg:p1:9' }];
        await boot();
        await bg.refreshBackground();
        expect(engine.getDisplayTriggers()[0]?.pending?.reason).toBe('rearm');
        expect(engine.RESTORE_REASON_TEXT.rearm).toContain('重新啟用');
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

    it('a program whose order outcome is unknown is never dropped', async () => {
        m.programs = [{ ...program({ phase: 'needsConfirm', pending: { leg: 'entry', price: 1, ts: 5, reason: 'unknownNotSent' } }),
            status: 'stopped' }];
        await boot();
        await bg.refreshBackground();
        await flush();
        expect(calls('execution_remove')).toHaveLength(0);
    });

    it('finished background triggers are dropped by the main window', async () => {
        m.programs = [program({ phase: 'done' })];
        await boot();
        await bg.refreshBackground();
        await flush();
        expect(calls('execution_remove').map(([, a]) => a)).toEqual([{ programId: 'trg:p1' }]);
    });
});
