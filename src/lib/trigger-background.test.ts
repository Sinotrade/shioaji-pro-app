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
    bidask: [] as ((b: { code: string; bid_price: string[]; ask_price: string[] }) => void)[],
    pins: [] as string[],
    place: vi.fn(),
    notify: vi.fn(),
    ensure: vi.fn(),
    invoke: vi.fn(),
    enabled: false,
    engineDown: false,
    settingUnreadable: false,
    create: null as null | ((a: { program: OrderProgram }) => Promise<unknown>),
    programs: [] as unknown[],
    trading: { positions: [], queries: { positions: { updatedAt: null as number | null, needsReconcile: false, error: null },
        account: { updatedAt: null, needsReconcile: false, error: null } }, margin: undefined as unknown, marginAccount: undefined as string | undefined },
    refresh: vi.fn(async (_scope?: string) => undefined),
}));

vi.mock('./runtime', () => ({ getApiBase: () => 'http://sim.invalid' }));
vi.mock('./stream', () => ({
    getStreamStatus: () => 'live',
    subscribeStatusStore: () => () => undefined,
    onOrderEvent: () => () => undefined,
    onAnyTick: (cb: (typeof m.tick)[number]) => { m.tick.push(cb); return () => undefined; },
    onOddLotTick: () => () => undefined,
    onAnyBidAsk: (cb: (typeof m.bidask)[number]) => { m.bidask.push(cb); return () => undefined; },
    onStreamEvent: () => () => undefined,
}));
vi.mock('./account-store', () => ({ getAccountState: () => ({ accounts: [S1, F1], selectedStock: S1, selectedFutures: F1 }) }));
vi.mock('./trade', () => ({ notify: m.notify, placeQuickOrder: m.place }));
vi.mock('./contracts-cache', () => ({ ensureContract: m.ensure, getCachedContract: () => undefined }));
vi.mock('./quote-ownership', () => ({ retainQuote: () => () => undefined,
    pinQuote: (c: { code: string }, type: string) => { m.pins.push(`${c.code}|${type}`); return () => { m.pins = m.pins.filter(x => x !== `${c.code}|${type}`); }; } }));
vi.mock('./trading-state', () => ({ refreshTradingState: m.refresh, getTradingState: () => m.trading }));
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
    m.bidask = [];
    m.pins = [];
    m.enabled = false;
    m.programs = [];
    for (const f of [m.place, m.notify, m.ensure, m.invoke]) f.mockReset();
    m.ensure.mockImplementation(async (code: string) => code === '2330' ? STK : code === TXO.code ? TXO : TXF);
    m.place.mockImplementation(async () => ({ order: { id: 'exit-1' }, status: { status: 'PendingSubmit' } }));
    m.engineDown = false;
    m.settingUnreadable = false;
    m.trading = { positions: [], queries: { positions: { updatedAt: null, needsReconcile: false, error: null },
        account: { updatedAt: null, needsReconcile: false, error: null } }, margin: undefined, marginAccount: undefined };
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
        // a stock trigger is the engine's too now (#226 step 5): refused the same way
        expect(await engine.addTrigger({ ...stop(), code: '2330', price: 900 }, STK as never)).toBeNull();
        expect(engine.getTriggers()).toHaveLength(0);
        // an alert never was: unaffected
        await engine.addTrigger({ ...stop(), kind: 'alert', quantity: 0 });
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

    it('alerts and a lone OCO leg stay in this window', async () => {
        m.enabled = true;
        await boot();
        await engine.addTrigger({ ...stop(), kind: 'alert', quantity: 0 });
        await engine.addTrigger({ ...stop(), group: 'g1' }, TXF as never);
        expect(calls('execution_create')).toHaveLength(0);
        expect(engine.getTriggers()).toHaveLength(2);
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

describe('flash ladder (#216): a background trigger shown on the ladder is deleted through the App', () => {
    it('the ladder mark of a background exit trigger is editable and its delete removes the program', async () => {
        m.programs = [program()];
        await boot();
        await bg.refreshBackground();
        const { ladderMarks } = await import('./flash-trigger');
        const marks = ladderMarks(engine.getDisplayTriggers(), [], { code: 'TXFR1', odd: false, env: SIM,
            account: { account_type: 'F', broker_id: F1.broker_id, account_id: F1.account_id } }, true);
        const mark = marks.get('19800.00')!.sell[0]!;
        expect(mark).toMatchObject({ id: 'bg:trg:p1:L1', kind: 'trigger', editable: true, background: true });
        const { flashRemoveTrigger } = await import('./flash-conditional');
        await flashRemoveTrigger(mark.id);
        expect(calls('execution_remove').map(([, a]) => a)).toEqual([{ programId: 'trg:p1' }]);
        expect(m.place).not.toHaveBeenCalled();
    });

    it('a refused removal throws (the ladder then says 刪除未確認, never 已刪除)', async () => {
        m.programs = [program()];
        await boot();
        await bg.refreshBackground();
        const base = m.invoke.getMockImplementation()!;
        m.invoke.mockImplementation(async (cmd: string, args?: unknown) => cmd === 'execution_remove'
            ? { accepted: false, notices: [{ code: 'rejected.inFlight', programId: 'trg:p1', levelId: null, detail: '' }], revision: 9 }
            : base(cmd, args));
        const { flashRemoveTrigger } = await import('./flash-conditional');
        await expect(flashRemoveTrigger('bg:trg:p1:L1')).rejects.toThrow('委託送出中');
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

    it('#226 modify: one engine step (execution_replace) with the same order (Cover kept); a crossed price is refused', async () => {
        m.programs = [program({ entry: { type: 'touch', condition: 'below', price: 19800, order: { priceType: 'MKT', timeInForce: 'IOC', octype: 'Cover' } } })];
        await boot();
        await bg.refreshBackground();
        await expect(engine.modifyTrigger('bg:trg:p1:L1', { price: 20100 })).rejects.toThrow('已穿過目前價格');
        expect(calls('execution_replace')).toHaveLength(0);
        await engine.modifyTrigger('bg:trg:p1:L1', { price: 19700, quantity: 2, send: { type: 'MKP' },
            validity: { type: 'today', until: Date.now() + 3_600_000 } });
        const args = calls('execution_replace')[0]![1] as { programId: string; program: OrderProgram };
        expect(args.programId).toBe('trg:p1');
        const lv = args.program.levels[0]!;
        expect(lv.qty).toBe(2);
        expect(lv.entry).toMatchObject({ type: 'touch', price: 19700, order: { priceType: 'MKP', timeInForce: 'IOC', octype: 'Cover' },
            validity: { type: 'today' } });
        expect(args.program.id).not.toBe('trg:p1');
        // never the old pause / create / remove dance
        for (const cmd of ['execution_pause', 'execution_create', 'execution_remove']) expect(calls(cmd)).toHaveLength(0);
        expect(m.place).not.toHaveBeenCalled();
    });

    it('#226 modify: the engine refuses (it fired meanwhile): nothing changed, said so', async () => {
        m.programs = [program()];
        await boot();
        await bg.refreshBackground();
        const orig = m.invoke.getMockImplementation()!;
        m.invoke.mockImplementation(async (cmd: string, args?: unknown) => cmd === 'execution_replace'
            ? { accepted: false, notices: [{ code: 'rejected.notReplaceable', programId: 'trg:p1', levelId: null, detail: '' }], revision: 9 }
            : orig(cmd, args));
        await expect(engine.modifyTrigger('bg:trg:p1:L1', { price: 19700 })).rejects.toThrow('已觸發');
        expect(calls('execution_create')).toHaveLength(0);
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

describe('#226 conditional orders in the background (step 1: triggers)', () => {
    const TXF1 = { ...TXF, tick: 1 };
    const created = () => calls('execution_create').map(([, a]) => (a as { program: OrderProgram }).program);
    const entry = (over: Record<string, unknown> = {}) => ({ code: 'TXFR1', condition: 'above' as const, price: 20100,
        action: 'Buy' as const, quantity: 1, kind: 'stop' as const, role: 'entry' as const, ...over });

    it('an entry with 上穿, 對手價, 觸價後限價 and 有效期 runs in the background with the App risk checks', async () => {
        m.enabled = true;
        await boot();
        const until = Date.now() + 3_600_000;
        await engine.addTrigger(entry({ cross: true, source: 'opposite', send: { type: 'LMT', ticks: 2 },
            validity: { type: 'session', until } }), TXF1 as never);
        expect(engine.getTriggers()).toHaveLength(0);
        const [p] = created();
        expect(p).toMatchObject({ opens: true, tickTable: [{ min: 0, max: null, tick: 1 }],
            levels: [{ side: 'Buy', entry: { type: 'touch', condition: 'above', price: 20100, cross: true, feed: 'ask',
                limitTicks: 2, validity: { type: 'session', until }, order: { priceType: 'LMT', timeInForce: 'ROD' } } }] });
        // a sell watches the bid; a protective stop does not open
        await engine.addTrigger(stop({ source: 'opposite', send: { type: 'MKP' } }), TXF1 as never);
        const q = created()[1]!;
        expect(q.opens).toBeUndefined();
        expect(q.levels[0]!.entry).toMatchObject({ feed: 'bid', order: { priceType: 'MKP', timeInForce: 'IOC' } });
    });

    it('a 待確認 對手價 row shows (and arms 送出 with) its side of the book', async () => {
        m.programs = [program({ entry: { type: 'touch', condition: 'below', price: 19800, feed: 'bid',
            order: { priceType: 'MKT', timeInForce: 'IOC' } }, phase: 'needsConfirm', pending: { leg: 'entry', price: 19790, ts: 5, reason: 'resume' } })];
        await boot();
        await bg.refreshBackground();
        for (const cb of m.bidask) cb({ code: 'TXFR1', bid_price: ['19795'], ask_price: ['19797'] });
        await flush();
        const [row] = engine.getDisplayTriggers();
        expect(engine.priceKeyOf(row!)).toBe('TXFR1#bid');
        expect(bg.getBackgroundPrices()['TXFR1#bid']).toBe(19795);
    });

    it('the main window keeps the book subscribed for a 對手價 condition (not only ticks)', async () => {
        m.programs = [program({ entry: { type: 'touch', condition: 'below', price: 19800, feed: 'bid',
            order: { priceType: 'MKT', timeInForce: 'IOC' } } })];
        await boot();
        await bg.refreshBackground();
        await flush();
        expect([...m.pins].sort()).toEqual(['TXFR1|BidAsk', 'TXFR1|Tick']);
        m.programs = [program(), { ...program(), id: 'trg:p2' }]; // the 對手價 one is gone (a new revision)
        await bg.refreshBackground();
        await flush();
        expect(m.pins).toEqual(['TXFR1|Tick']);
    });

    it('the rows show the options as the window shows them', async () => {
        m.programs = [{ ...program({ entry: { type: 'touch', condition: 'below', price: 19800, cross: true, feed: 'bid', limitTicks: -1,
            validity: { type: 'today', until: 99 }, order: { priceType: 'LMT', timeInForce: 'ROD' } }, recross: ['entry'] }), opens: true }];
        await boot();
        await bg.refreshBackground();
        const [row] = engine.getDisplayTriggers();
        expect(row).toMatchObject({ role: 'entry', cross: true, source: 'opposite', send: { type: 'LMT', ticks: -1 },
            validity: { type: 'today', until: 99 }, awaitingRecross: true });
    });

    it('the same option checks as this window: a past validity is refused, nothing created', async () => {
        m.enabled = true;
        await boot();
        expect(await engine.addTrigger(entry({ validity: { type: 'date', until: Date.now() - 1 } }), TXF1 as never)).toBeNull();
        expect(created()).toHaveLength(0);
        expect(m.notify.mock.calls.some(([n]) => (n as { body: string }).body.includes('有效期已過'))).toBe(true);
    });

    it('a limit in ticks without a tick table is never created (no guessed price)', async () => {
        m.enabled = true;
        await boot();
        expect(await engine.addTrigger(entry({ send: { type: 'LMT', ticks: -2 } }), TXF as never)).toBeNull();
        expect(created()).toHaveLength(0);
        // 0 ticks needs no table
        await engine.addTrigger(entry({ send: { type: 'LMT', ticks: 0 } }), TXF as never);
        expect(created()).toHaveLength(1);
    });

    it('a trigger that places a window bracket stays in this window (the panel sends background brackets itself)', async () => {
        m.enabled = true;
        await boot();
        await engine.addTrigger(entry({ bracketPlan: { tiers: [{ quantity: 1, takeTicks: 5 }], stopTicks: 4, trail: null, breakeven: null } }), TXF1 as never);
        expect(created()).toHaveLength(0);
        expect(engine.getTriggers()).toHaveLength(1);
    });

    it('the main window pushes the risk settings (with whether the P&L is known) on change and every 2 s', async () => {
        m.enabled = true;
        vi.stubGlobal('window', new EventTarget()); // risk.ts listens for other windows' changes
        await boot();
        await bg.refreshBackground();
        await vi.advanceTimersByTimeAsync(bg.RISK_PUSH_MS + 10);
        const pushed = calls('execution_set_risk').map(([, a]) => (a as { risk: Record<string, unknown> }).risk);
        expect(pushed.length).toBeGreaterThan(0);
        expect(pushed.at(-1)).toMatchObject({ enabled: false, locked: false, pnlKnown: false });
        const { setRiskSettings } = await import('./risk');
        setRiskSettings({ locked: true });
        await flush();
        expect(calls('execution_set_risk').map(([, a]) => (a as { risk: { locked: boolean } }).risk.locked).at(-1)).toBe(true);
    });

    it('the P&L is pushed as known only when read and reconciled, with the account it belongs to', async () => {
        m.enabled = true;
        vi.stubGlobal('window', new EventTarget());
        await boot();
        // the selected futures account F1: −1,500 unrealized, settled −100; another account's gain never offsets it
        const F2 = { ...F1, account_id: 'fixture-account-F2' };
        m.trading = { ...m.trading, margin: { future_settle_profitloss: -100 }, marginAccount: `F:${F1.broker_id}:${F1.account_id}`,
            positions: [{ account: F1, pnl: -1500 }, { account: F2, pnl: 2000 }, { account: S1, pnl: 900 }] as never,
            queries: { ...m.trading.queries, positions: { updatedAt: 5, needsReconcile: false, error: null } } };
        await bg.pushBackgroundRisk(true);
        const last = () => (calls('execution_set_risk').at(-1)![1] as { risk: Record<string, unknown> }).risk;
        expect(last()).toMatchObject({ dailyPnl: -1600, pnlKnown: true, pnlAccount: { brokerId: F1.broker_id, accountId: F1.account_id } });
        // a stream outage / failed read leaves something to reconcile: not trusted until read again
        m.trading = { ...m.trading, queries: { ...m.trading.queries, positions: { updatedAt: 5, needsReconcile: true, error: null } } };
        await bg.pushBackgroundRisk(true);
        expect(last()).toMatchObject({ pnlKnown: false });
    });
});

describe('background fills reach the window (QA 10/12: 持倉暫未套用, stale positions)', () => {
    const slot = (orderId: string, filled: number) => ({ key: `k-${orderId}`, role: 'entry', cycle: 0, index: 0, status: filled ? 'filled' : 'working',
        orderId, filled, fills: {}, fillTs: {}, qty: 1, cancel: null, detail: null, sentAt: 1 });
    it('a new background fill reads positions / orders again; nothing on an unchanged count', async () => {
        m.enabled = true;
        m.programs = [program({ orders: [slot('T1', 0)] as never })];
        await boot();
        m.refresh.mockClear();
        m.programs = [program({ orders: [slot('T1', 0)] as never }), { ...program({ orders: [slot('T2', 0)] as never }), id: 'trg:p2' }];
        await bg.refreshBackground();
        await flush();
        expect(m.refresh).not.toHaveBeenCalled();
        m.programs = [program({ orders: [slot('T1', 1)] as never }), { ...program({ orders: [slot('T2', 0)] as never }), id: 'trg:p2' },
            { ...program(), id: 'trg:p3' }];
        await bg.refreshBackground();
        await flush();
        expect(m.refresh).toHaveBeenCalledWith('all');
        // and once more after the trading store's cooldown (a read in flight would swallow the first)
        m.refresh.mockClear();
        await vi.advanceTimersByTimeAsync(bg.FILL_REFRESH_TRAIL_MS);
        await flush();
        expect(m.refresh).toHaveBeenCalledWith('all');
    });

    it('the report pipeline learns the order code of a trade the engine sent', async () => {
        m.enabled = true;
        m.programs = [program({ orders: [slot('T9', 0)] as never })];
        await boot();
        const { orderCodeHint } = await import('./order-code-hints');
        expect(orderCodeHint('T9')).toBe('TXFJ6');
        expect(orderCodeHint('nope')).toBeNull();
    });
});


describe('#226 二擇一 in the background (step 2)', () => {
    const TXF1 = { ...TXF, tick: 1 };
    const legs = (mode: 'trigger' | 'fill', over: Record<string, unknown> = {}) => [
        { code: 'TXFR1', condition: 'above' as const, price: 20100, action: 'Buy' as const, quantity: 3, kind: 'stop' as const,
            role: 'entry' as const, group: 'g', ocoMode: mode, ...over },
        { code: 'TXFR1', condition: 'below' as const, price: 19900, action: 'Sell' as const, quantity: 3, kind: 'stop' as const,
            role: 'entry' as const, group: 'g', ocoMode: mode, ...over },
    ];
    function groupProgram(mode?: 'fill'): OrderProgram {
        const base = program();
        const lv = base.levels[0]!;
        return { ...base, id: 'grp:g:1', ocoLevels: true, ...(mode ? { ocoMode: mode } : {}), opens: true, levels: [
            { ...lv, id: 'U', side: 'Buy', qty: 3, entry: { type: 'touch', condition: 'above', price: 20100, order: { priceType: 'MKT', timeInForce: 'IOC' } } },
            { ...lv, id: 'D', side: 'Sell', qty: 3, entry: { type: 'touch', condition: 'below', price: 19900, order: { priceType: 'MKT', timeInForce: 'IOC' } } },
        ] };
    }

    it('both legs become one background program; 成交後刪對應口數 sends limits IOC', async () => {
        m.enabled = true;
        await boot();
        await engine.addTriggerGroup(legs('fill', { send: { type: 'LMT', ticks: -1 } }), TXF1 as never);
        expect(engine.getTriggers()).toHaveLength(0);
        const created = calls('execution_create').map(([, a]) => (a as { program: OrderProgram }).program);
        expect(created).toHaveLength(1);
        expect(created[0]).toMatchObject({ ocoLevels: true, ocoMode: 'fill', opens: true, tickTable: [{ min: 0, max: null, tick: 1 }] });
        expect(created[0]!.levels.map(l => [l.side, l.qty, l.entry.type === 'touch' && l.entry.order.timeInForce])).toEqual([
            ['Buy', 3, 'IOC'], ['Sell', 3, 'IOC']]);
        await engine.addTriggerGroup(legs('trigger'), TXF1 as never);
        const second = calls('execution_create').at(-1)![1] as { program: OrderProgram };
        expect(second.program.ocoLevels).toBe(true);
        expect(second.program.ocoMode).toBeUndefined();
    });

    it('rows carry the group, the mode and which side a waiting leg waits for', async () => {
        const p = groupProgram('fill');
        p.levels[0] = { ...p.levels[0]!, ocoLock: 'D' };
        p.levels[1] = { ...p.levels[1]!, phase: 'working' };
        m.programs = [p];
        await boot();
        await bg.refreshBackground();
        const rows = engine.getDisplayTriggers();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ group: 'grp:g:1', ocoMode: 'fill', ocoLock: 'bg:grp:g:1:D', quantity: 3 });
    });

    it('pause / remove / modify act on the one program (modify in one engine step)', async () => {
        const gp = groupProgram();
        gp.levels = gp.levels.map(lv => lv.entry.type === 'touch' ? { ...lv, entry: { ...lv.entry, order: { ...lv.entry.order, octype: 'New' as const } } } : lv);
        m.programs = [gp];
        await boot();
        await bg.refreshBackground();
        const ids = engine.getDisplayTriggers().map(r => r.id);
        expect(ids).toEqual(['bg:grp:g:1:U', 'bg:grp:g:1:D']);
        await engine.setTriggerGroup(ids, 'pause');
        expect(calls('execution_pause').map(([, a]) => a)).toEqual([{ programId: 'grp:g:1' }]);
        await engine.modifyTriggerGroup([{ id: ids[0]!, patch: { price: 20200 } }, { id: ids[1]!, patch: { quantity: 2 } }]);
        const [, args] = calls('execution_replace')[0]! as [string, { programId: string; program: OrderProgram }];
        expect(args.programId).toBe('grp:g:1');
        expect(args.program.levels.map(l => [l.entry.type === 'touch' && l.entry.price, l.qty])).toEqual([[20200, 3], [19900, 2]]);
        expect(args.program.levels.map(l => l.entry.type === 'touch' && l.entry.order.octype)).toEqual(['New', 'New']);
        await expect(engine.modifyTriggerGroup([{ id: ids[0]!, patch: { price: 19800 } }])).rejects.toThrow('上方價格必須高於下方價格');
        await engine.setTriggerGroup(ids, 'remove');
        expect(calls('execution_remove').map(([, a]) => a)).toEqual([{ programId: 'grp:g:1' }]);
    });
});

describe('#226 括號單 with a 觸價 entry in the background (step 3)', () => {
    it('before the entry fires it is a trigger row carrying its plan; cancel removes the program', async () => {
        const base = program({ entry: { type: 'touch', condition: 'above', price: 20100, order: { priceType: 'MKT', timeInForce: 'IOC' } },
            exit: null, qty: 2, side: 'Buy' });
        const tier = (id: string, index: number, takeTicks: number | null) => ({ ...base.levels[0]!, id, qty: 1, exit: { type: 'oco' as const,
            stop: null, take: null, order: { priceType: 'MKT' as const, timeInForce: 'IOC' as const, octype: 'Cover' as const } },
            entry: { type: 'tier' as const, of: 'L1', offset: index, index },
            rules: { stopTicks: 4, takeTicks, ...(takeTicks === null ? { trail: { activateTicks: 5, distanceTicks: 3, stepTicks: 1 } } : {}) } });
        m.programs = [{ ...base, id: 'bkt-x', kind: 'bracket', opens: true, levels: [base.levels[0]!, tier('T1', 0, 5), tier('T2', 1, null)] }];
        await boot();
        await bg.refreshBackground();
        const [row] = engine.getDisplayTriggers();
        expect(row).toMatchObject({ id: 'bg:bkt-x:L1', role: 'entry', price: 20100, quantity: 2,
            bracketPlan: { tiers: [{ quantity: 1, takeTicks: 5 }, { quantity: 1, takeTicks: null }], stopTicks: 4,
                trail: { activateTicks: 5, distanceTicks: 3, stepTicks: 1 }, breakeven: null } });
        await engine.removeTrigger(row!.id);
        expect(calls('execution_remove').map(([, a]) => a)).toEqual([{ programId: 'bkt-x' }]);
    });
});

describe('#226 時間條件 in the background (step 4)', () => {
    it('指定時間送單 and 收盤前平倉 become time programs; rows show them as the window does', async () => {
        m.enabled = true;
        await boot();
        const at = Date.now() + 3_600_000;
        await engine.addTrigger({ code: 'TXFR1', condition: 'below', price: 0, action: 'Buy', quantity: 2, kind: 'stop', role: 'entry',
            send: { type: 'MKP' }, time: { kind: 'send', at } }, TXF as never);
        await engine.addTrigger({ code: 'TXFR1', condition: 'below', price: 0, action: 'Sell', quantity: 0, kind: 'stop',
            time: { kind: 'flatten', at, scope: 'account' } }, TXF as never);
        expect(engine.getTriggers()).toHaveLength(0);
        const [send, flat] = calls('execution_create').map(([, a]) => (a as { program: OrderProgram }).program);
        expect(send).toMatchObject({ opens: true, levels: [{ qty: 2, side: 'Buy', entry: { type: 'time', at, order: { priceType: 'MKP', timeInForce: 'IOC' } } }] });
        expect(flat!.opens).toBeUndefined();
        expect(flat!.levels[0]).toMatchObject({ qty: 1, entry: { type: 'time', at, flatten: 'account' } });
        m.programs = [send!, flat!];
        await bg.refreshBackground();
        const rows = engine.getDisplayTriggers();
        expect(rows.map(r => r.time)).toEqual([{ kind: 'send', at }, { kind: 'flatten', at, scope: 'account' }]);
        expect(rows[1]!.quantity).toBe(0);
    });

    it('a time order sending a limit stays in this window (no price to step from)', async () => {
        m.enabled = true;
        await boot();
        await engine.addTrigger({ code: 'TXFR1', condition: 'below', price: 0, action: 'Buy', quantity: 1, kind: 'stop', role: 'entry',
            send: { type: 'LMT', ticks: 1 }, time: { kind: 'send', at: Date.now() + 60_000 } }, TXF as never);
        expect(calls('execution_create')).toHaveLength(0);
        expect(engine.getTriggers()).toHaveLength(1);
    });
});

describe('#226 window 全平並取消 and the engine share one hold', () => {
    it('a failed or refused renewal loses the hold for good; every send re-checks it', async () => {
        await boot();
        const renew = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValue(true);
        const orig = m.invoke.getMockImplementation()!;
        m.invoke.mockImplementation(async (cmd: string, args?: unknown) => cmd === 'execution_flatten_begin' ? true
            : cmd === 'execution_flatten_renew' ? renew() : orig(cmd, args));
        expect(await bg.beginWindowFlatten()).toBe(true);
        expect(await bg.stillHoldingFlatten()).toBe(true);
        expect(await bg.stillHoldingFlatten()).toBe(false); // the engine took it
        expect(await bg.stillHoldingFlatten()).toBe(false); // never regained by itself
        await bg.endWindowFlatten();
        expect(calls('execution_flatten_end')).toHaveLength(0); // not ours to release
        // an error renewing is a loss too
        m.invoke.mockImplementation(async (cmd: string, args?: unknown) => cmd === 'execution_flatten_begin' ? true
            : cmd === 'execution_flatten_renew' ? Promise.reject(new Error('x')) : orig(cmd, args));
        expect(await bg.beginWindowFlatten()).toBe(true);
        expect(await bg.stillHoldingFlatten()).toBe(false);
    });
});

describe('#226 stocks in the background (step 5)', () => {
    const STK1 = { ...STK, exchange: 'TSE', limit_up: 990, limit_down: 810 };
    const created = () => calls('execution_create').map(([, a]) => (a as { program: OrderProgram }).program);

    it('整股 and 盤中零股 triggers become stock programs (cash, the stock tick table, 零股 watching odd trades)', async () => {
        m.enabled = true;
        await boot();
        await engine.addTrigger({ ...stop(), code: '2330', price: 900, role: 'entry', send: { type: 'LMT', ticks: -1 } }, STK1 as never);
        await engine.addTrigger({ ...stop(), code: '2330', price: 900, quantity: 300, orderLot: 'IntradayOdd' }, STK1 as never);
        expect(engine.getTriggers()).toHaveLength(0);
        const [lot, odd] = created();
        expect(lot).toMatchObject({ opens: true, binding: { account: { accountType: 'S' }, contract: { market: 'stock', securityType: 'STK' } },
            levels: [{ entry: { limitTicks: -1, order: { priceType: 'LMT', timeInForce: 'ROD', stockCond: 'Cash', stockLot: 'Common' } } }] });
        expect(lot!.tickTable![4]).toEqual({ min: 500, max: 1000, tick: 1 });
        expect(odd).toMatchObject({ levels: [{ qty: 300, entry: { feed: 'odd', order: { priceType: 'MKT', timeInForce: 'ROD', stockLot: 'IntradayOdd' } } }] });
        m.programs = [lot!, odd!];
        await bg.refreshBackground();
        const rows = engine.getDisplayTriggers();
        expect(rows[1]).toMatchObject({ orderLot: 'IntradayOdd', quantity: 300 });
        expect(rows[1]!.source).toBeUndefined();
    });

    it('#263 a trigger entry keeps its credit condition: 現股當沖先賣, 融資, 融券 go out as created, also after a modify', async () => {
        m.enabled = true;
        await boot();
        const entry = { ...stop(), code: '2330', price: 900, role: 'entry' as const };
        await engine.addTrigger({ ...entry, daytradeShort: true }, STK1 as never);
        await engine.addTrigger({ ...entry, action: 'Buy', condition: 'above', price: 1000, orderCond: 'MarginTrading' }, STK1 as never);
        await engine.addTrigger({ ...entry, orderCond: 'ShortSelling' }, STK1 as never);
        const [dt, margin, short] = created();
        expect(dt!.levels[0]!.entry).toMatchObject({ order: { priceType: 'MKT', timeInForce: 'IOC', stockCond: 'Cash', stockLot: 'Common', daytradeShort: true } });
        expect(margin!.levels[0]!.entry).toMatchObject({ order: { stockCond: 'MarginTrading', stockLot: 'Common' } });
        expect((margin!.levels[0]!.entry as { order: { daytradeShort?: boolean } }).order.daytradeShort).toBeUndefined();
        expect(short!.levels[0]!.entry).toMatchObject({ order: { stockCond: 'ShortSelling' } });
        expect(m.notify.mock.calls.some(([n]) => String((n as { body: string }).body).includes('（現股當沖先賣）'))).toBe(true);
        // the rows carry it (ladder, list), and a modify rebuilds the program with it
        m.programs = [dt!];
        await bg.refreshBackground();
        const [row] = engine.getDisplayTriggers();
        expect(row).toMatchObject({ daytradeShort: true, role: 'entry' });
        expect(row!.orderCond).toBeUndefined();
        await tick('2330', 950);
        await engine.modifyTrigger(row!.id, { price: 890 });
        const replaced = (calls('execution_replace')[0]![1] as { program: OrderProgram }).program;
        expect(replaced.levels[0]!.entry).toMatchObject({ price: 890, order: { stockCond: 'Cash', daytradeShort: true } });
    });

    it('#263 credit the engine does not take is refused with the reason, nothing created', async () => {
        m.enabled = true;
        await boot();
        const entry = { ...stop(), code: '2330', price: 900, role: 'entry' as const };
        expect(await engine.addTrigger({ ...entry, orderCond: 'SBLShort' }, STK1 as never)).toBeNull();
        expect(await engine.addTrigger({ ...entry, action: 'Buy', condition: 'above', price: 1000, orderCond: 'ShortSelling' }, STK1 as never)).toBeNull();
        expect(await engine.addTrigger({ ...entry, action: 'Buy', condition: 'above', price: 1000, daytradeShort: true }, STK1 as never)).toBeNull();
        // a protective stop (not an entry) closes in cash
        expect(await engine.addTrigger({ ...stop(), code: '2330', price: 900, daytradeShort: true }, STK1 as never)).toBeNull();
        expect(created()).toHaveLength(0);
        const bodies = m.notify.mock.calls.map(([n]) => String((n as { body: string }).body));
        expect(bodies).toEqual(expect.arrayContaining([expect.stringContaining('不支援借券賣出'), expect.stringContaining('融券、借券只能賣出'),
            expect.stringContaining('現股當沖先賣只能用在賣出'), expect.stringContaining('停損停利觸價只以現股出場')]));
    });

    it('a 零股 trigger with another send style is refused like in this window', async () => {
        m.enabled = true;
        await boot();
        expect(await engine.addTrigger({ ...stop(), code: '2330', price: 900, quantity: 300, orderLot: 'IntradayOdd', send: { type: 'LMT', ticks: 1 } },
            STK1 as never)).toBeNull();
        expect(created()).toHaveLength(0);
    });
});

describe('warrants in the background (private engine #217: WRT whole lots in cash)', () => {
    const WRT = { code: '051231', security_type: 'WRT', exchange: 'TSE', limit_up: 15, limit_down: 9 };
    const FOREIGN = { ...WRT, code: '05123F', limit_up: 0, limit_down: 0 };
    const created = () => calls('execution_create').map(([, a]) => (a as { program: OrderProgram }).program);
    const add = (c: typeof WRT, over: Record<string, unknown>) => engine.addTrigger({ ...stop(), code: c.code, condition: 'above', price: 12,
        action: 'Buy', kind: 'take', role: 'entry', ...over }, c as never);

    it('a warrant trigger is a WRT stock program priced on the warrant tick table', async () => {
        m.enabled = true;
        await boot();
        expect(await add(WRT, { send: { type: 'LMT', ticks: 2 } })).not.toBeNull();
        const [p] = created();
        expect(p).toMatchObject({ opens: true, binding: { account: { accountType: 'S' }, contract: { market: 'stock', securityType: 'WRT', orderCode: '051231' } },
            levels: [{ entry: { price: 12, limitTicks: 2, order: { priceType: 'LMT', timeInForce: 'ROD', stockCond: 'Cash', stockLot: 'Common' } } }] });
        // 10–50: 0.1 (the stock table says 0.05)
        expect(p!.tickTable).toContainEqual({ min: 10, max: 50, tick: 0.1 });
        expect(p!.tickTable).toContainEqual({ min: 5, max: 10, tick: 0.05 });
    });

    it('a STK-labelled warrant code keeps its type and the warrant table', async () => {
        m.enabled = true;
        await boot();
        await add({ ...WRT, security_type: 'STK' }, {});
        const [p] = created();
        expect(p!.binding.contract.securityType).toBe('STK');
        expect(p!.levels[0]!.entry).toMatchObject({ order: { priceType: 'MKT', stockLot: 'Common', stockCond: 'Cash' } });
    });

    it('refused before the engine: 零股, a limit off the warrant grid, a foreign warrant at market', async () => {
        m.enabled = true;
        await boot();
        expect(await add(WRT, { orderLot: 'IntradayOdd', quantity: 300 })).toBeNull();
        expect(await add(WRT, { price: 12.05, send: { type: 'LMT', ticks: 1 } })).toBeNull();
        expect(await add(FOREIGN, {})).toBeNull();
        expect(created()).toHaveLength(0);
        const bodies = m.notify.mock.calls.map(c => (c[0] as { body: string }).body);
        expect(bodies).toEqual([
            expect.stringContaining('權證不得零股交易'),
            expect.stringContaining('權證價格不在升降單位上'),
            expect.stringContaining('外國標的權證觸價後不能送市價'),
        ]);
        // a market trigger's threshold is never sent: anywhere is fine; a foreign warrant at a limit is fine
        expect(await add(WRT, { price: 12.05 })).not.toBeNull();
        expect(await add(FOREIGN, { price: 3.01, send: { type: 'LMT', ticks: 0 } })).not.toBeNull();
        expect(created()).toHaveLength(2);
    });

    it('setting off: editing a window warrant trigger keeps the warrant rules (grid, foreign at a limit)', async () => {
        await boot();
        const lmt = await add(WRT, { send: { type: 'LMT', ticks: 1 } });
        const foreign = await add(FOREIGN, { price: 3.01, send: { type: 'LMT', ticks: 0 } });
        expect(lmt?.id.startsWith('tg-')).toBe(true);
        expect(foreign?.id.startsWith('tg-')).toBe(true);
        await expect(engine.modifyTrigger(lmt!.id, { price: 12.05 })).rejects.toThrow('權證價格不在升降單位上');
        await expect(engine.modifyTrigger(foreign!.id, { send: { type: 'MKT' } })).rejects.toThrow('外國標的權證觸價後不能送市價');
        // nothing changed: still the armed, valid ones
        expect(engine.getTriggers().find(t => t.id === lmt!.id)).toMatchObject({ price: 12, send: { type: 'LMT', ticks: 1 } });
        expect(engine.getTriggers().find(t => t.id === foreign!.id)).toMatchObject({ send: { type: 'LMT', ticks: 0 } });
        // a legal edit still goes through
        await engine.modifyTrigger(lmt!.id, { price: 12.1 });
        expect(engine.getTriggers().find(t => t.id === lmt!.id)?.price).toBe(12.1);
    });

    it('setting on: a background warrant trigger edit off the grid or to market is refused before the engine', async () => {
        m.enabled = true;
        await boot();
        await add(WRT, { send: { type: 'LMT', ticks: 1 } });
        await add(FOREIGN, { price: 3.01, send: { type: 'LMT', ticks: 0 } });
        const [p, f] = created();
        m.programs = [p!, f!];
        m.ensure.mockImplementation(async (code: string) => code === FOREIGN.code ? FOREIGN : WRT);
        await bg.refreshBackground();
        await expect(engine.modifyTrigger(`bg:${p!.id}:${p!.levels[0]!.id}`, { price: 12.05 })).rejects.toThrow('權證價格不在升降單位上');
        await expect(engine.modifyTrigger(`bg:${f!.id}:${f!.levels[0]!.id}`, { send: { type: 'MKT' } })).rejects.toThrow('外國標的權證觸價後不能送市價');
        expect(calls('execution_replace')).toHaveLength(0);
    });

    it('the engine refusing a warrant program shows its Chinese reason', async () => {
        m.enabled = true;
        await boot();
        const orig = m.invoke.getMockImplementation()!;
        m.invoke.mockImplementation(async (cmd: string, args?: unknown) => cmd === 'execution_create'
            ? { accepted: false, notices: [{ code: 'rejected.warrantOffTick', programId: null, levelId: null, detail: '' }], revision: 9 }
            : orig(cmd, args));
        expect(await add(WRT, {})).toBeNull();
        expect(m.notify.mock.calls.map(c => (c[0] as { body: string }).body).join('\n')).toContain('價格不在權證升降單位上');
    });
});

describe('#226 step 5 review', () => {
    it('editing a stock 觸價 bracket keeps it a stock bracket; a 零股 time order shows shares', async () => {
        const base = program({ entry: { type: 'touch', condition: 'above', price: 600, order: { priceType: 'MKT', timeInForce: 'IOC', stockCond: 'Cash', stockLot: 'Common' } },
            exit: null, qty: 1, side: 'Buy' });
        const binding = { ...base.binding, account: { ...base.binding.account, accountType: 'S' as const },
            contract: { market: 'stock' as const, quoteCode: '2330', orderCode: '2330', securityType: 'STK' as const } };
        const tier = { ...base.levels[0]!, id: 'T1', exit: { type: 'oco' as const, stop: null, take: null,
            order: { priceType: 'MKT' as const, timeInForce: 'IOC' as const, stockCond: 'Cash' as const, stockLot: 'Common' as const } },
            entry: { type: 'tier' as const, of: 'L1', offset: 0, index: 0 }, rules: { stopTicks: 3, takeTicks: 5 } };
        const odd = { ...program({ entry: { type: 'time', at: Date.now() + 60_000, order: { priceType: 'MKT', timeInForce: 'ROD', stockLot: 'IntradayOdd', stockCond: 'Cash' } },
            qty: 300 }), id: 'trg:odd', binding };
        m.programs = [{ ...base, id: 'bkt-s', kind: 'bracket', opens: true, binding, levels: [base.levels[0]!, tier] }, odd];
        m.ensure.mockImplementation(async () => ({ ...STK, exchange: 'TSE' }));
        await boot();
        await bg.refreshBackground();
        const rows = engine.getDisplayTriggers();
        expect(rows.find(r => r.id === 'bg:trg:odd:L1')).toMatchObject({ orderLot: 'IntradayOdd', quantity: 300 });
        await engine.modifyTrigger('bg:bkt-s:L1', { price: 610 }).catch(() => undefined);
        const req = calls('execution_replace_bracket')[0]![1] as { request: { binding: { contract: { securityType: string; market: string } } } };
        expect(req.request.binding.contract).toMatchObject({ securityType: 'STK', market: 'stock' });
    });
});
