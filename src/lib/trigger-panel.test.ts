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
    onAnyBidAsk: (cb: (b: unknown) => void) => { (m as Record<string, unknown>).bidask = cb; return () => undefined; },
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

const bidask = async (bid: number, ask: number) => {
    (m as unknown as { bidask: (b: unknown) => void }).bidask({ code: 'TXFR1', bid_price: [String(bid)], ask_price: [String(ask)] });
    await flush();
};
const placeOpts = (i = 0) => m.place.mock.calls[i]![4] as Record<string, unknown>;

describe('condition kinds (#226)', () => {
    it('下穿 fires only on a crossing: a first tick already below does not fire', async () => {
        await boot();
        await entry({ cross: true });
        await tick(47900); // already below: no baseline yet
        expect(m.place).not.toHaveBeenCalled();
        await tick(48100); // seen above
        await tick(48000); // crosses down (≤)
        expect(m.place).toHaveBeenCalledTimes(1);
    });

    it('a crossing trigger after a reload needs a fresh crossing (never held as 待確認)', async () => {
        await boot();
        await entry({ cross: true });
        await tick(48100);
        await boot({ keepStore: true });
        await tick(47900);
        expect(m.place).not.toHaveBeenCalled();
        expect(only().pending).toBeUndefined();
        await tick(48050);
        await tick(47990);
        expect(m.place).toHaveBeenCalledTimes(1);
    });

    it('對手價: a sell watches the best bid, not the last trade', async () => {
        await boot();
        await entry({ source: 'opposite' });
        await tick(48300);
        await tick(47900); // a trade below does not matter
        expect(m.place).not.toHaveBeenCalled();
        await bidask(48100, 48105);
        expect(m.place).not.toHaveBeenCalled();
        await bidask(47999, 48002);
        expect(m.place).toHaveBeenCalledTimes(1);
    });

    it('觸價後限價: trigger price moved N ticks, ROD, no IOC settle; 範圍市價 goes as MKP', async () => {
        await boot();
        await entry({ send: { type: 'LMT', ticks: -2 } });
        await entry({ price: 47000, send: { type: 'MKP' } });
        await tick(48300);
        await tick(47950);
        expect(m.place.mock.calls[0]![2]).toBe(47998);
        expect(placeOpts().orderType).toBe('ROD');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(engine.getExits()[0]!.status).toBe('working'); // resting: waits for its reports
        await tick(46990);
        expect(m.place.mock.calls[1]![2]).toBeNull();
        expect(placeOpts(1).futuresPriceType).toBe('MKP');
    });

    it('a limit outside the price band is refused, nothing sent', async () => {
        m.ensure.mockResolvedValue({ ...TXF, limit_up: 49000, limit_down: 47999 });
        await boot();
        await entry({ send: { type: 'LMT', ticks: -5 } });
        await tick(48300);
        await tick(47990);
        expect(m.place).not.toHaveBeenCalled();
        expect(engine.getExits()[0]!.status).toBe('not-sent');
    });

    it('有效期: lapses at its time without sending; a past validity is refused', async () => {
        await boot();
        await entry({ validity: { type: 'session', until: Date.now() + 60_000 } });
        await tick(48300);
        await vi.advanceTimersByTimeAsync(65_000);
        expect(engine.getTriggers()).toHaveLength(0);
        expect(titles()).toContain('條件單已到期');
        await tick(47900);
        expect(m.place).not.toHaveBeenCalled();
        const made = await entry({ validity: { type: 'date', until: Date.now() - 1 } });
        expect(made).toBeNull();
    });
});

describe('二擇一 (#226)', () => {
    const pair = (mode: 'trigger' | 'fill', qty = 3) => engine.addTriggerGroup([
        { code: 'TXFR1', condition: 'above', price: 48400, action: 'Buy', quantity: qty, kind: 'stop', role: 'entry', group: 'g', ocoMode: mode },
        { code: 'TXFR1', condition: 'below', price: 47900, action: 'Sell', quantity: qty, kind: 'stop', role: 'entry', group: 'g', ocoMode: mode },
    ], TXF as never);

    it('both legs are created together; 觸發就刪 removes the other side at once', async () => {
        await boot();
        await pair('trigger');
        expect(engine.getTriggers()).toHaveLength(2);
        await tick(48200);
        await tick(48400);
        expect(m.place).toHaveBeenCalledTimes(1);
        expect(engine.getTriggers()).toHaveLength(0);
    });

    it('成交後刪對應口數: the other side waits, then loses exactly what filled (2 of 3)', async () => {
        await boot();
        await pair('fill');
        await tick(48200);
        await tick(48400); // buy side fires for 3
        expect(m.place).toHaveBeenCalledTimes(1);
        const other = only();
        expect(other.ocoLock).toBeTruthy();
        await tick(47800); // locked: never fires meanwhile
        expect(m.place).toHaveBeenCalledTimes(1);
        // the IOC check finds the exit cancelled after 2 filled
        const rec = engine.getExits()[0]!;
        engine.applyExitTrade({ order: { id: rec.orderId, account: null }, status: { status: 'Cancelled', deal_quantity: 2, cancel_quantity: 1,
            deals: [{ seq: 's1', quantity: 2, price: 48400, ts: 1 }] } } as never);
        await flush();
        expect(only().quantity).toBe(1);
        expect(only().ocoLock).toBeUndefined();
        await tick(48000); // first tick after unlocking decides (not past)
        await tick(47900);
        expect(m.place).toHaveBeenCalledTimes(2);
        expect(m.place.mock.calls[1]![3]).toBe(1);
    });

    it('成交後刪對應口數: fully filled removes the other side', async () => {
        await boot();
        await pair('fill', 2);
        await tick(48200);
        await tick(48400);
        const rec = engine.getExits()[0]!;
        engine.applyExitTrade({ order: { id: rec.orderId, account: null }, status: { status: 'Filled', deal_quantity: 2, cancel_quantity: 0,
            deals: [{ seq: 's1', quantity: 2, price: 48400, ts: 1 }] } } as never);
        await flush();
        expect(engine.getTriggers()).toHaveLength(0);
    });
});

describe('時間條件 (#226)', () => {
    it('指定時間送單: nothing before the time, one send at the time, never again', async () => {
        await boot();
        await engine.addTrigger({ code: 'TXFR1', condition: 'above', price: 0, action: 'Buy', quantity: 2, kind: 'stop', role: 'entry',
            time: { kind: 'send', at: Date.now() + 5_000 } }, TXF as never);
        await tick(48000); // prices never fire a time order
        expect(m.place).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(6_000);
        expect(m.place).toHaveBeenCalledTimes(1);
        expect(m.place.mock.calls[0]![3]).toBe(2);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(m.place).toHaveBeenCalledTimes(1);
        expect(engine.getTriggers()).toHaveLength(0);
    });

    it('a time missed while the App was not running lapses instead of sending late', async () => {
        await boot();
        await engine.addTrigger({ code: 'TXFR1', condition: 'above', price: 0, action: 'Buy', quantity: 1, kind: 'stop', role: 'entry',
            time: { kind: 'send', at: Date.now() + 1_000 } }, TXF as never);
        m.status = 'down'; // cannot send at the time
        await vi.advanceTimersByTimeAsync(70_000);
        expect(m.place).not.toHaveBeenCalled();
        expect(engine.getTriggers()).toHaveLength(0);
        expect(titles()).toContain('時間條件單沒有執行');
    });

    it('收盤前平倉 hands over to 全平並取消 at the time (no order from the engine itself)', async () => {
        await boot();
        const seen: string[] = [];
        engine.onTimedFlatten(t => seen.push(t.code));
        await engine.addTrigger({ code: 'TXFR1', condition: 'above', price: 0, action: 'Sell', quantity: 0, kind: 'stop',
            time: { kind: 'flatten', at: Date.now() + 2_000, scope: 'code' } }, TXF as never);
        await vi.advanceTimersByTimeAsync(3_000);
        expect(seen).toEqual(['TXFR1']);
        expect(m.place).not.toHaveBeenCalled();
        expect(engine.getTriggers()).toHaveLength(0);
    });

    it('a time already past is refused', async () => {
        await boot();
        const made = await engine.addTrigger({ code: 'TXFR1', condition: 'above', price: 0, action: 'Buy', quantity: 1, kind: 'stop',
            time: { kind: 'send', at: Date.now() - 1 } }, TXF as never);
        expect(made).toBeNull();
    });
});
