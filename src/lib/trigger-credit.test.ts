// #263 觸價單的股票信用條件：建立時固定（融資、融券、現股當沖先賣），觸發時照
// 建立時的條件送出，之後面板怎麼切都不影響；引擎不支援的組合建立時就擋並說明。
// All broker I/O is mocked: no order is sent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from './types/portfolio';
import { triggerCreditFields, triggerCreditProblem, triggerCreditText } from './trigger-credit';

const S1: Account = { account_type: 'S', broker_id: 'fixture-broker-S', account_id: 'fixture-account-S',
    person_id: '', signed: true, username: '' };
const F1: Account = { ...S1, account_type: 'F', account_id: 'fixture-account-F' };
const STK = { code: '2330', security_type: 'STK', exchange: 'TSE', limit_up: 1100, limit_down: 900 };
const SIM = 'http://sim.invalid|simulation';
const ACCT = { account_type: 'S' as const, broker_id: S1.broker_id, account_id: S1.account_id };

const m = vi.hoisted(() => ({
    tick: null as ((t: { code: string; close: number; simtrade?: boolean }) => void) | null,
    oddTick: null as ((t: { code: string; close: number; simtrade?: boolean }) => void) | null,
    accounts: [] as Account[],
    positions: [] as unknown[],
    positionsAt: null as number | null,
    place: vi.fn(),
    notify: vi.fn(),
    ensure: vi.fn(),
    retain: vi.fn(),
}));

vi.mock('./runtime', () => ({ getApiBase: () => 'http://sim.invalid' }));
vi.mock('./stream', () => ({
    getStreamStatus: () => 'live',
    subscribeStatusStore: () => () => undefined,
    onOrderEvent: () => () => undefined,
    onAnyTick: (cb: typeof m.tick) => { m.tick = cb; return () => undefined; },
    onOddLotTick: (cb: typeof m.tick) => { m.oddTick = cb; return () => undefined; },
    onAnyBidAsk: (cb: (b: unknown) => void) => { (m as Record<string, unknown>).bidask = cb; return () => undefined; },
    onStreamEvent: () => () => undefined,
}));
vi.mock('./account-store', () => ({ getAccountState: () => ({ accounts: m.accounts,
    selectedStock: m.accounts.find(a => a.account_type === 'S') ?? null,
    selectedFutures: m.accounts.find(a => a.account_type === 'F') ?? null }) }));
vi.mock('./trade', () => ({ notify: m.notify, placeQuickOrder: m.place }));
vi.mock('./contracts-cache', () => ({ ensureContract: m.ensure, getCachedContract: () => undefined }));
vi.mock('./quote-ownership', () => ({ retainQuote: (...args: unknown[]) => { m.retain(...args); return () => undefined; } }));
vi.mock('./trading-state', () => ({ getTradingState: () => ({ positions: m.positions,
    queries: { positions: { updatedAt: m.positionsAt, needsReconcile: false, error: null } } }) }));
vi.mock('./shioaji', () => ({ fetchTrades: async () => [] }));
vi.mock('./protection-env', () => ({
    currentProtectionEnv: () => SIM,
    refreshProtectionEnv: async () => undefined,
    onProtectionEnvChange: () => () => undefined,
    envBase: (env: string) => env.slice(0, env.lastIndexOf('|')),
    reportEnvMatches: () => true,
    watchProtectionEnv: () => undefined,
}));

let engine: typeof import('./trigger-engine');
async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); }
async function boot() {
    vi.resetModules();
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    vi.stubGlobal('location', { search: '' });
    vi.stubGlobal('navigator', { locks: { request: (_n: string, a: unknown, b?: (lock: object | null) => unknown) => {
        const cb = (typeof a === 'function' ? a : b) as (lock: object | null) => unknown;
        if (typeof a === 'function' || !(a as { ifAvailable?: boolean }).ifAvailable) return new Promise(() => undefined);
        const r = cb({}); return Promise.resolve(r instanceof Promise ? undefined : r); } } });
    engine = await import('./trigger-engine');
    engine.startTriggerEngine();
    await flush();
    // the first tick after start decides (#144): not past → normal firing
    m.tick!({ code: '2330', close: 1000 });
    await flush();
}
const tick = async (close: number) => { m.tick!({ code: '2330', close }); await flush(); };
// 盤中零股成交（intraday_odd）：零股觸價單只看這個價格來源
const oddTick = async (close: number) => { m.oddTick!({ code: '2330', close }); await flush(); };
const bodies = () => m.notify.mock.calls.map(([n]) => `${(n as { title: string }).title}：${(n as { body: string }).body}`);

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('BroadcastChannel', undefined);
    m.accounts = [S1, F1]; m.positions = []; m.positionsAt = null;
    for (const f of [m.place, m.notify, m.ensure, m.retain]) f.mockReset();
    m.ensure.mockResolvedValue(STK);
    let n = 0;
    m.place.mockImplementation(async () => ({ order: { id: `exit-${++n}` }, status: { status: 'PendingSubmit' } }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });


const S = { account_type: 'S' as const, broker_id: 'B', account_id: '1' };
const base = { kind: 'take' as const, action: 'Sell' as const, account: S, role: 'entry' as const };

describe('triggerCreditProblem (the engines\' rules)', () => {
    it('allows 現股當沖先賣 sells, 融資 both ways and 融券 sells on a whole-lot entry', () => {
        expect(triggerCreditProblem({ ...base, daytradeShort: true })).toBeNull();
        expect(triggerCreditProblem({ ...base, orderCond: 'MarginTrading' })).toBeNull();
        expect(triggerCreditProblem({ ...base, action: 'Buy', orderCond: 'MarginTrading' })).toBeNull();
        expect(triggerCreditProblem({ ...base, orderCond: 'ShortSelling' })).toBeNull();
        expect(triggerCreditProblem({ ...base, orderCond: 'Cash', daytradeShort: false })).toBeNull();
        // no credit: nothing to check, whatever the trigger is
        expect(triggerCreditProblem({ kind: 'stop', action: 'Buy', account: { ...S, account_type: 'F' } })).toBeNull();
    });

    it('refuses what neither engine sends, naming the condition', () => {
        expect(triggerCreditProblem({ ...base, orderCond: 'SBLShort' })).toContain('借券');
        expect(triggerCreditProblem({ ...base, orderCond: 'SBLShortPriceExempt' })).toContain('借券');
        expect(triggerCreditProblem({ ...base, action: 'Buy', orderCond: 'ShortSelling' })).toContain('融券、借券只能賣出');
        expect(triggerCreditProblem({ ...base, action: 'Buy', daytradeShort: true })).toContain('只能用在賣出');
        expect(triggerCreditProblem({ ...base, orderCond: 'MarginTrading', daytradeShort: true })).toContain('只限現股');
        expect(triggerCreditProblem({ ...base, orderLot: 'IntradayOdd', daytradeShort: true })).toContain('零股不能現股當沖先賣');
        expect(triggerCreditProblem({ ...base, orderLot: 'IntradayOdd', orderCond: 'MarginTrading' })).toContain('零股只能以現股');
        expect(triggerCreditProblem({ ...base, role: undefined, daytradeShort: true })).toContain('只以現股出場');
        expect(triggerCreditProblem({ ...base, bracketPlan: { tiers: [{ quantity: 1, takeTicks: 2 }], stopTicks: 1, trail: null, breakeven: null },
            daytradeShort: true })).toContain('括號單');
        expect(triggerCreditProblem({ ...base, account: { ...S, account_type: 'F' }, orderCond: 'MarginTrading' })).toContain('只適用股票');
        expect(triggerCreditProblem({ ...base, kind: 'alert', daytradeShort: true })).toContain('警示');
    });

    it('the panel credit a new trigger stores: 當沖先賣 only on a sell; a buy is a cash buy', () => {
        expect(triggerCreditFields({ cond: 'Cash', daytradeShort: true }, 'Sell')).toEqual({ daytradeShort: true });
        expect(triggerCreditFields({ cond: 'Cash', daytradeShort: true }, 'Buy')).toEqual({});
        expect(triggerCreditFields({ cond: 'Cash', daytradeShort: false }, 'Sell')).toEqual({});
        expect(triggerCreditFields({ cond: 'MarginTrading', daytradeShort: false }, 'Buy')).toEqual({ orderCond: 'MarginTrading' });
        expect(triggerCreditText({ daytradeShort: true })).toBe('現股當沖先賣');
        expect(triggerCreditText({ orderCond: 'ShortSelling' })).toBe('融券');
        expect(triggerCreditText({})).toBe('');
    });
});

describe('the window engine sends a trigger with the credit it was created with', () => {
    it('現股當沖先賣: stored on the trigger, announced, and sent with daytradeShort when it fires', async () => {
        await boot();
        const t = await engine.addTrigger({ code: '2330', condition: 'below', price: 950, action: 'Sell', quantity: 2,
            kind: 'stop', role: 'entry', daytradeShort: true }, STK as never);
        expect(t).toMatchObject({ daytradeShort: true, role: 'entry' });
        // persisted with the trigger (a reload keeps it)
        const stored = JSON.parse(localStorage.getItem('sj-pro-triggers') ?? '[]') as { daytradeShort?: boolean }[];
        expect(stored[0]?.daytradeShort).toBe(true);
        expect(bodies().some(b => b.includes('市價賣 2（現股當沖先賣）'))).toBe(true);
        await tick(949);
        expect(m.place).toHaveBeenCalledTimes(1);
        const [, action, price, qty, opts] = m.place.mock.calls[0]!;
        expect([action, price, qty]).toEqual(['Sell', null, 2]);
        expect(opts).toMatchObject({ daytradeShort: true, source: 'auto', bypassRisk: false });
        expect(opts.orderCond).toBeUndefined();
        expect(bodies().some(b => b.includes('觸價單觸發') && b.includes('（現股當沖先賣）'))).toBe(true);
    });

    it('融資 / 融券 go out as created; a cash trigger carries no credit', async () => {
        await boot();
        await engine.addTrigger({ code: '2330', condition: 'above', price: 1050, action: 'Buy', quantity: 1,
            kind: 'stop', role: 'entry', orderCond: 'MarginTrading' }, STK as never);
        await engine.addTrigger({ code: '2330', condition: 'below', price: 950, action: 'Sell', quantity: 1,
            kind: 'stop', role: 'entry', orderCond: 'ShortSelling' }, STK as never);
        await engine.addTrigger({ code: '2330', condition: 'below', price: 940, action: 'Sell', quantity: 1, kind: 'stop', role: 'entry' }, STK as never);
        await tick(1050);
        await tick(930);
        const sent = m.place.mock.calls.map(([, action, , , opts]) => [action, opts.orderCond, opts.daytradeShort]);
        expect(sent).toEqual(expect.arrayContaining([['Buy', 'MarginTrading', undefined], ['Sell', 'ShortSelling', undefined], ['Sell', undefined, undefined]]));
        expect(sent).toHaveLength(3);
    });

    it('refuses combinations the engines do not send, with the reason; nothing stored', async () => {
        await boot();
        const sell = { code: '2330', condition: 'below' as const, price: 950, action: 'Sell' as const, quantity: 1, kind: 'stop' as const, role: 'entry' as const };
        expect(await engine.addTrigger({ ...sell, orderCond: 'SBLShort' }, STK as never)).toBeNull();
        expect(await engine.addTrigger({ ...sell, action: 'Buy', condition: 'above', price: 1050, daytradeShort: true }, STK as never)).toBeNull();
        expect(await engine.addTrigger({ ...sell, orderLot: 'IntradayOdd', quantity: 100, daytradeShort: true }, STK as never)).toBeNull();
        // a protective stop (no entry role) closes in cash
        expect(await engine.addTrigger({ ...sell, role: undefined, orderCond: 'MarginTrading' }, STK as never)).toBeNull();
        // a warrant trades in cash only
        expect(await engine.addTrigger({ ...sell, code: '051231', daytradeShort: true },
            { code: '051231', security_type: 'WRT', exchange: 'TSE' } as never)).toBeNull();
        expect(engine.getTriggers()).toHaveLength(0);
        const text = bodies().join('\n');
        expect(text).toContain('不支援借券賣出');
        expect(text).toContain('現股當沖先賣只能用在賣出');
        expect(text).toContain('零股不能現股當沖先賣');
        expect(text).toContain('停損停利觸價只以現股出場');
        expect(text).toContain('權證只能現股買賣');
    });
});
