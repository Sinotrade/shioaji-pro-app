// Odd-lot (盤中零股) triggers and bracket exits (#204). All broker I/O is
// mocked: no order is sent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from './types/portfolio';

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
    // This unit harness supplies a bracket owner; the production runtime
    // performs its actual retirement/identity fence in the integrated suite.
    engine.setBracketMutationGuard(() => () => undefined);
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

describe('odd-lot triggers (#204)', () => {
    it('a manual odd-lot stop fires as an IntradayOdd LIMIT at the price limit, in shares', async () => {
        await boot();
        const t = await engine.addTrigger({ code: '2330', condition: 'below', price: 950, action: 'Sell', quantity: 300,
            kind: 'stop', orderLot: 'IntradayOdd' }, STK as never);
        expect(t?.orderLot).toBe('IntradayOdd');
        // a regular-lot trade through the stop does not fire an odd-lot stop:
        // the exit trades in the odd-lot market, so its price decides
        await tick(949);
        expect(m.place).not.toHaveBeenCalled();
        await oddTick(949);
        expect(m.place).toHaveBeenCalledTimes(1);
        const [, action, price, qty, opts] = m.place.mock.calls[0]!;
        expect([action, price, qty]).toEqual(['Sell', 900, 300]);
        expect(opts).toMatchObject({ orderLot: 'IntradayOdd', source: 'auto', bypassRisk: true });
        expect(bodies().some(b => b.includes('零股漲跌停限價賣 300 股'))).toBe(true);
        // ROD limit: the exit keeps working until its reports settle it (no IOC settle)
        expect(engine.getExits()[0]).toMatchObject({ status: 'working', orderLot: 'IntradayOdd' });
    });

    it('holds the 盤中零股 Tick feed for odd-lot triggers, separately from the regular feed', async () => {
        await boot();
        await engine.addTrigger({ code: '2330', condition: 'below', price: 950, action: 'Sell', quantity: 300,
            kind: 'stop', orderLot: 'IntradayOdd' }, STK as never);
        await engine.addTrigger({ code: '2330', condition: 'below', price: 940, action: 'Sell', quantity: 1, kind: 'stop' }, STK as never);
        await flush();
        const holds = m.retain.mock.calls.map(c => [c[1], c[2]?.oddLot === true]);
        expect(holds).toEqual(expect.arrayContaining([['Tick', true], ['Tick', false]]));
        expect(holds).toHaveLength(2);
    });

    it('whole-lot stops stay market orders without an order lot', async () => {
        await boot();
        await engine.addTrigger({ code: '2330', condition: 'below', price: 950, action: 'Sell', quantity: 2, kind: 'stop' }, STK as never);
        // an odd-lot trade never fires a whole-lot stop
        await oddTick(900);
        expect(m.place).not.toHaveBeenCalled();
        await tick(949);
        const [, , price, qty, opts] = m.place.mock.calls[0]!;
        expect([price, qty]).toEqual([null, 2]);
        expect(opts.orderLot).toBeUndefined();
    });

    it('refuses unsupported odd-lot triggers with a plain reason', async () => {
        await boot();
        expect(await engine.addTrigger({ code: '2330', condition: 'below', price: 950, action: 'Sell', quantity: 1500,
            kind: 'stop', orderLot: 'IntradayOdd' }, STK as never)).toBeNull();
        expect(await engine.addTrigger({ code: '2330', condition: 'below', price: 950, action: 'Sell', quantity: 100,
            kind: 'stop', orderLot: 'Odd' }, STK as never)).toBeNull();
        expect(await engine.addTrigger({ code: 'TXFR1', condition: 'below', price: 48000, action: 'Sell', quantity: 1,
            kind: 'stop', orderLot: 'IntradayOdd' }, { code: 'TXFR1', target_code: 'TXFJ6', security_type: 'FUT', exchange: 'TAIFEX' } as never)).toBeNull();
        const text = bodies().join('\n');
        expect(text).toContain('1～999 股');
        expect(text).toContain('盤後零股');
        expect(text).toContain('期貨選擇權沒有零股');
        expect(engine.getTriggers()).toHaveLength(0);
    });

    it('an odd-lot exit without a valid price limit is not sent', async () => {
        await boot();
        m.ensure.mockResolvedValue({ ...STK, limit_down: 0 });
        await engine.addTrigger({ code: '2330', condition: 'below', price: 950, action: 'Sell', quantity: 100,
            kind: 'stop', orderLot: 'IntradayOdd' }, STK as never);
        await oddTick(949);
        expect(m.place).not.toHaveBeenCalled();
        expect(engine.getExits()[0]).toMatchObject({ status: 'not-sent' });
        expect(bodies().join('\n')).toContain('漲跌停價');
    });

    it('odd-lot bracket exits are capped by the Cash holding in shares', async () => {
        m.positions = [{ account: S1, code: '2330', direction: 'Buy', quantity: 300, price: 1000, last_price: 1000, pnl: 0, cond: 'Cash' }];
        m.positionsAt = Date.now();
        await boot();
        engine.armBracketGroup({ group: 'bracket:o', bracketId: 'plan-odd', env: SIM, account: ACCT, code: '2330',
            orderCode: '2330', entryAction: 'Buy', orderLot: 'IntradayOdd', stopPrice: 950, takePrice: null, quantity: 500 });
        expect(engine.getTriggers()[0]).toMatchObject({ orderLot: 'IntradayOdd', quantity: 500 });
        await oddTick(949);
        const [, , price, qty, opts] = m.place.mock.calls[0]!;
        expect([price, qty, opts.orderLot]).toEqual([900, 300, 'IntradayOdd']);
        expect(engine.getExits()[0]!.detail).toContain('可賣出現股僅 300 股');
    });

    it('whole-lot and odd-lot exits share one holding, counted in shares', async () => {
        m.positions = [{ account: S1, code: '2330', direction: 'Buy', quantity: 1500, price: 1000, last_price: 1000, pnl: 0, cond: 'Cash' }];
        m.positionsAt = Date.now();
        await boot();
        // an odd exit of 500 shares is still working …
        engine.armBracketGroup({ group: 'bracket:o', bracketId: 'plan-odd', env: SIM, account: ACCT, code: '2330',
            orderCode: '2330', entryAction: 'Buy', orderLot: 'IntradayOdd', stopPrice: 960, takePrice: null, quantity: 500 });
        await oddTick(959);
        // … so a whole-lot exit of 2 張 can only sell the remaining 1 張
        engine.armBracketGroup({ group: 'bracket:c', bracketId: 'plan-lot', env: SIM, account: ACCT, code: '2330',
            orderCode: '2330', entryAction: 'Buy', stopPrice: 950, takePrice: null, quantity: 2 });
        await tick(949);
        expect(m.place.mock.calls.map(c => [c[2], c[3], c[4].orderLot])).toEqual([[900, 500, 'IntradayOdd'], [null, 1, undefined]]);
    });
});

describe('panel account (#204 chart order settings)', () => {
    it('pins a trigger to the panel account when given, and refuses an account that is not available', async () => {
        const S2 = { ...S1, account_id: 'fixture-account-S2' };
        m.accounts = [S1, F1, S2];
        await boot();
        const t = await engine.addTrigger({ code: '2330', condition: 'below', price: 950, action: 'Sell', quantity: 1, kind: 'stop' }, STK as never, { account: S2 });
        expect(t?.account).toMatchObject({ account_type: 'S', account_id: 'fixture-account-S2' });
        const gone = await engine.addTrigger({ code: '2330', condition: 'below', price: 940, action: 'Sell', quantity: 1, kind: 'stop' }, STK as never,
            { account: { ...S1, account_id: 'gone' } });
        expect(gone).toBeNull();
        expect(bodies().join('\n')).toContain('指定的下單帳戶已不可用');
    });
});

describe('planExitQuantity units', () => {
    it('reports odd-lot shortfalls in 股 and whole lots in 張', async () => {
        const { planExitQuantity } = await import('./trigger-engine');
        const base = { bracketId: 'b', account: ACCT };
        expect(planExitQuantity({ ...base, quantity: 500, orderLot: 'IntradayOdd' }, 0, 200).detail).toBe('可賣出現股僅 200 股，其餘 300 股未保護');
        expect(planExitQuantity({ ...base, quantity: 3 }, 0, 1).detail).toBe('可賣出現股僅 1 張，其餘 2 張未保護');
    });
});
