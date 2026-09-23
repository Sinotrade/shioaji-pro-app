// Mock-verified bracket / trigger runtime (#102). All broker I/O is mocked:
// no network, no real or simulated order is sent. Wire payloads come from
// the de-identified 1.7.6 simulation capture.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeOrderEvent, type OrderEventReport } from './order-report';
import fixture from './fixtures/native-simulation-bracket-reports-1.7.6.json';
import type { Trade } from './types/order';
import type { Account } from './types/portfolio';

const acct = (type: 'S' | 'F', id: string): Account => ({ account_type: type, broker_id: `fixture-broker-${type}`,
    account_id: id, person_id: '', signed: true, username: '' });
const F1 = acct('F', 'fixture-account-F');
const F2 = acct('F', 'fixture-account-F2');
const S1 = acct('S', 'fixture-account-S');

const m = vi.hoisted(() => ({
    status: 'live' as string,
    order: null as ((r: OrderEventReport) => void) | null,
    tick: null as ((t: { code: string; close: number; simtrade?: boolean }) => void) | null,
    statusChanged: [] as (() => void)[],
    accounts: [] as Account[],
    place: vi.fn(),
    notify: vi.fn(),
    cached: vi.fn(),
    refreshed: vi.fn(),
    health: vi.fn(),
    subscribe: vi.fn(),
    ensure: vi.fn(),
    positions: { rows: [] as unknown[], updatedAt: null as number | null, needsReconcile: false },
    base: 'http://sim.invalid',
    search: '',
}));

vi.mock('./runtime', () => ({ getApiBase: () => m.base }));
vi.mock('./stream', () => ({
    getStreamStatus: () => m.status,
    subscribeStatusStore: (cb: () => void) => { m.statusChanged.push(cb); return () => undefined; },
    onOrderEvent: (cb: (r: OrderEventReport) => void) => { m.order = cb; return () => undefined; },
    onAnyTick: (cb: typeof m.tick) => { m.tick = cb; return () => undefined; },
}));
vi.mock('./account-store', () => ({ getAccountState: () => ({ accounts: m.accounts, selectedFutures: m.accounts.find(a => a.account_type === 'F') ?? null,
    selectedStock: m.accounts.find(a => a.account_type === 'S') ?? null }) }));
vi.mock('./trade', () => ({ notify: m.notify, placeQuickOrder: m.place }));
vi.mock('./contracts-cache', () => ({ ensureContract: m.ensure }));
vi.mock('./quote-ownership', () => ({ retainQuote: () => () => undefined }));
vi.mock('./trading-state', () => ({ getTradingState: () => ({ positions: m.positions.rows,
    queries: { positions: { updatedAt: m.positions.updatedAt, needsReconcile: m.positions.needsReconcile, error: null } } }) }));
vi.mock('./bracket-api', () => ({ fetchCachedTrades: m.cached, fetchReconciledTrades: m.refreshed, fetchTradeCacheHealth: m.health }));
vi.mock('./shioaji', () => ({ subscribeTradeEvents: m.subscribe }));

const wire = (fixture as unknown[]).map(f => normalizeOrderEvent(f)!);
const [fDeal1, fNew1, fDeal2, fCoverNew, fCoverDeal1, fCoverDeal2] = wire;

function edit(r: OrderEventReport, patch: Record<string, unknown>): OrderEventReport {
    const raw = r.raw as { state: string; data: Record<string, Record<string, unknown>> };
    return normalizeOrderEvent({ ...raw, data: { [raw.state]: { ...raw.data[raw.state], ...patch } } })!;
}

const TXF = { code: 'TXFR1', target_code: 'TXFJ6', security_type: 'FUT', exchange: 'TAIFEX' };
const healthy = { state: 'Healthy', reasons: [] };

function spec(account: Account, orderId = 'fixture-f1', over: Record<string, unknown> = {}) {
    return { env: m.base, account: { account_type: account.account_type as 'F', broker_id: account.broker_id, account_id: account.account_id },
        orderId, seqno: orderId, quoteCode: 'TXFR1', orderCode: 'TXFJ6', securityType: 'FUT' as const, exchange: 'TAIFEX',
        action: 'Buy' as const, quantity: 2, stopPrice: 48000, takePrice: 48600, ...over };
}

function cacheTrade(id: string, account: Account, deals: { seq: string; quantity: number }[]): Trade {
    return { contract: { code: 'TXFJ6', security_type: 'FUT', exchange: 'TAIFEX', target_code: null },
        order: { id, seqno: id, ordno: 'o', action: 'Buy', price: 0, quantity: 2,
            account: { account_type: 'F', broker_id: account.broker_id, account_id: account.account_id } },
        status: { id, status: deals.length ? 'PartFilled' : 'Submitted', status_code: '00', order_quantity: 2,
            deal_quantity: deals.reduce((s, d) => s + d.quantity, 0), cancel_quantity: 0, modified_price: 0, msg: '',
            deals: deals.map(d => ({ ...d, price: 1, ts: 1 })) } } as unknown as Trade;
}

let store = new Map<string, string>();
type Engine = typeof import('./trigger-engine');
type Bracket = typeof import('./bracket');
let engine: Engine;
let bracket: Bracket;

async function boot(opts: { keepStore?: boolean } = {}) {
    vi.resetModules();
    if (!opts.keepStore) store = new Map();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    vi.stubGlobal('location', { search: m.search });
    m.order = null; m.tick = null; m.statusChanged = [];
    engine = await import('./trigger-engine');
    bracket = await import('./bracket');
    engine.startTriggerEngine();
    bracket.startBracketRuntime();
    await flush();
}
async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); }
const emit = async (r: OrderEventReport) => { m.order!(r); await flush(); };
const tick = async (close: number, simtrade = false) => { m.tick!({ code: 'TXFR1', close, simtrade }); await flush(); };
const triggersOf = (planId: string) => engine.getTriggers().filter(t => t.bracketId === planId);
const planOf = (id: string) => bracket.getBrackets().find(p => p.id === id)!;

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('BroadcastChannel', undefined);
    m.status = 'live'; m.accounts = [F1, F2, S1]; m.base = 'http://sim.invalid'; m.search = '';
    m.positions = { rows: [], updatedAt: null, needsReconcile: false };
    for (const f of [m.place, m.notify, m.cached, m.refreshed, m.health, m.subscribe, m.ensure]) f.mockReset();
    m.cached.mockResolvedValue([cacheTrade('fixture-f1', F1, []), cacheTrade('fixture-f9', F2, [])]); m.refreshed.mockResolvedValue([]); m.health.mockResolvedValue(healthy);
    m.subscribe.mockResolvedValue({}); m.ensure.mockResolvedValue(TXF);
    let n = 0;
    m.place.mockImplementation(async () => ({ order: { id: `exit-${++n}` }, status: { status: 'PendingSubmit' } }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('bracket registration and partial-fill accumulation', () => {
    it('uses one cache-only lookup (refresh:false API) + health, never refresh polling', async () => {
        await boot();
        m.cached.mockResolvedValue([cacheTrade('fixture-f1', F1, [])]);
        const plan = await bracket.registerBracket(spec(F1));
        await flush();
        expect(m.cached).toHaveBeenCalledTimes(1);
        expect(m.cached).toHaveBeenCalledWith(spec(F1).account);
        expect(m.health).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(120_000); // the old code polled every 4s
        expect(m.cached).toHaveBeenCalledTimes(1);
        expect(m.refreshed).not.toHaveBeenCalled();
        expect(triggersOf(plan.id)).toHaveLength(0); // nothing filled yet
    });

    it('arms OCO for the first partial fill and resizes it on the next fill; duplicates ignored', async () => {
        await boot();
        const plan = await bracket.registerBracket(spec(F1));
        await flush();
        await emit(fDeal1!);
        expect(triggersOf(plan.id).map(t => [t.kind, t.quantity, t.action, t.octype])).toEqual([
            ['stop', 1, 'Sell', 'Cover'], ['take', 1, 'Sell', 'Cover']]);
        await emit(fDeal1!); // same event_id redelivered
        await emit(edit(fDeal1!, { event_id: 'v1:FD:FIXTURESTREAMFD:OTHERRESET:1' })); // new id (new reset), same fill identity
        expect(planOf(plan.id).filled).toBe(1);
        await emit(fNew1!);
        await emit(fDeal2!);
        expect(triggersOf(plan.id).map(t => t.quantity)).toEqual([2, 2]);
        expect(planOf(plan.id).issues).toEqual([]);
    });

    it('catches fills that arrived BEFORE registration (buffer + cache) without double counting', async () => {
        await boot();
        await emit(fDeal1!);
        await emit(fNew1!);
        m.cached.mockResolvedValue([cacheTrade('fixture-f1', F1, [{ seq: '000001', quantity: 1 }])]);
        const plan = await bracket.registerBracket(spec(F1));
        await flush();
        expect(planOf(plan.id).filled).toBe(1);
        expect(triggersOf(plan.id).map(t => t.quantity)).toEqual([1, 1]);
    });

    it('isolates two accounts trading the same product', async () => {
        await boot();
        const a = await bracket.registerBracket(spec(F1));
        const b = await bracket.registerBracket(spec(F2, 'fixture-f9'));
        await flush();
        await emit(fDeal1!);
        await emit(edit(fDeal1!, { trade_id: 'fixture-f9', account_id: 'fixture-account-F2', event_id: 'v1:FD:FIXTURESTREAMFD:FIXTURERESET:5' }));
        await emit(edit(fDeal2!, { trade_id: 'fixture-f9', account_id: 'fixture-account-F2', event_id: 'v1:FD:FIXTURESTREAMFD:FIXTURERESET:6' }));
        expect(planOf(a.id).filled).toBe(1);
        expect(planOf(b.id).filled).toBe(2);
        expect(triggersOf(a.id).every(t => t.account?.account_id === 'fixture-account-F')).toBe(true);
        expect(triggersOf(b.id).every(t => t.account?.account_id === 'fixture-account-F2')).toBe(true);
    });

    it('re-registering the same order is idempotent (dedup of the command effect)', async () => {
        await boot();
        const a = await bracket.registerBracket(spec(F1));
        const b = await bracket.registerBracket(spec(F1));
        expect(b.id).toBe(a.id);
        expect(bracket.getBrackets()).toHaveLength(1);
    });
});

describe('protection confirmation state', () => {
    it('disconnect marks NOT confirmed; reconnect does a cache-only lookup but keeps the issue', async () => {
        await boot();
        const plan = await bracket.registerBracket(spec(F1));
        await flush();
        m.status = 'down'; m.statusChanged.forEach(cb => cb()); await flush();
        expect(planOf(plan.id).issues.map(i => i.code)).toEqual(['disconnect']);
        m.cached.mockResolvedValue([cacheTrade('fixture-f1', F1, [{ seq: '000001', quantity: 1 }])]);
        m.status = 'live'; m.statusChanged.forEach(cb => cb()); await flush();
        expect(m.cached).toHaveBeenCalledTimes(2);
        expect(m.refreshed).not.toHaveBeenCalled();
        expect(planOf(plan.id).filled).toBe(1); // fill missed during the outage recovered from cache
        expect(planOf(plan.id).issues.map(i => i.code)).toEqual(['disconnect']);
    });

    it('a sequence gap on the futures stream marks futures plans NOT confirmed', async () => {
        await boot();
        const plan = await bracket.registerBracket(spec(F1));
        await flush();
        await emit(fDeal1!); // FD:4 baseline
        await emit(edit(fCoverDeal2!, { trade_id: 'unrelated' })); // FD:7 → 5,6 not observed
        expect(planOf(plan.id).issues.map(i => i.code)).toContain('gap');
    });

    it('Degraded cache health and NotSubscribed are surfaced (subscribe attempted once)', async () => {
        await boot();
        m.health.mockResolvedValueOnce({ state: 'Degraded', reasons: [{ event_type: 'FuturesDeal', reason: 'SequenceGap' }] });
        const plan = await bracket.registerBracket(spec(F1));
        await flush();
        expect(planOf(plan.id).issues.map(i => i.code)).toEqual(['cache-degraded']);
        m.health.mockResolvedValue({ state: 'Unknown', reasons: [{ event_type: 'FuturesDeal', reason: 'NotSubscribed' }] });
        const other = await bracket.registerBracket(spec(F2, 'fixture-f9'));
        await flush();
        expect(m.subscribe).toHaveBeenCalledTimes(1);
        expect(planOf(other.id).issues.map(i => i.code)).toEqual(['not-subscribed']);
    });

    it('untrackable (no event_id, e.g. 1.7.5) reports still count fills but never look confirmed', async () => {
        await boot();
        const plan = await bracket.registerBracket(spec(F1));
        await flush();
        await emit(edit(fDeal1!, { event_id: '' }));
        expect(planOf(plan.id).filled).toBe(1);
        expect(planOf(plan.id).issues.map(i => i.code)).toEqual(['untrackable']);
    });

    it('only an explicit reconcile (refresh:true) + Healthy cache clears the issues', async () => {
        await boot();
        const plan = await bracket.registerBracket(spec(F1));
        await flush();
        m.status = 'down'; m.statusChanged.forEach(cb => cb()); await flush();
        m.status = 'live'; m.statusChanged.forEach(cb => cb()); await flush();
        m.refreshed.mockResolvedValue([cacheTrade('fixture-f1', F1, [{ seq: '000001', quantity: 1 }, { seq: '000002', quantity: 1 }])]);
        await expect(bracket.reconcileBracket(plan.id)).resolves.toEqual({ health: 'Healthy' });
        expect(m.refreshed).toHaveBeenCalledTimes(1);
        expect(planOf(plan.id).issues).toEqual([]);
        expect(planOf(plan.id).filled).toBe(2);
        expect(triggersOf(plan.id).map(t => t.quantity)).toEqual([2, 2]);
    });

    it('a reload marks live plans NOT confirmed and looks them up cache-only', async () => {
        await boot();
        await bracket.registerBracket(spec(F1));
        await flush();
        m.cached.mockClear();
        await boot({ keepStore: true });
        const plan = bracket.getBrackets()[0]!;
        expect(plan.issues.map(i => i.code)).toContain('reload');
        expect(m.cached).toHaveBeenCalledTimes(1);
    });
});

describe('trigger execution (main window only)', () => {
    async function armed(filled: 1 | 2 = 2) {
        await boot();
        const plan = await bracket.registerBracket(spec(F1));
        await flush();
        await emit(fDeal1!);
        if (filled === 2) await emit(fDeal2!);
        return plan;
    }

    it('stop fires once across repeated ticks, with the fixed account, market IOC and Cover', async () => {
        const plan = await armed();
        const t = triggersOf(plan.id);
        expect(t).toHaveLength(2);
        const stop = t.find(x => x.kind === 'stop')!;
        await tick(stop.price - 500);
        await tick(stop.price - 600); // repeated tick
        expect(m.place).toHaveBeenCalledTimes(1);
        const [, action, price, qty, opts] = m.place.mock.calls[0]!;
        expect([action, price, qty, opts.ocType, opts.account.account_id]).toEqual(['Sell', null, 2, 'Cover', 'fixture-account-F']);
        expect(triggersOf(plan.id)).toHaveLength(0);
    });

    it('same-tick sibling cannot fire even when both conditions match', async () => {
        await boot();
        const plan = await bracket.registerBracket(spec(F1, 'fixture-f1', { stopPrice: 48500, takePrice: 48400, action: 'Buy' }));
        await flush();
        await emit(fDeal1!);
        // stop: below 48500, take: above 48400 → 48450 satisfies both
        await tick(48450);
        expect(m.place).toHaveBeenCalledTimes(1);
        expect(planOf(plan.id).exit?.kind).toBe('stop');
    });

    it('a processed group is never re-armed or re-sent, including after reload', async () => {
        const plan = await armed(1);
        await tick(47000);
        expect(m.place).toHaveBeenCalledTimes(1);
        await emit(fDeal2!); // late entry fill after the exit fired
        expect(triggersOf(plan.id)).toHaveLength(0);
        expect(planOf(plan.id).filled).toBe(2);
        const { unprotectedQuantity } = await import('./bracket-core');
        expect(unprotectedQuantity(planOf(plan.id))).toBe(1);
        await boot({ keepStore: true });
        expect(engine.isGroupProcessed(m.base, planOf(plan.id).group)).toBe(true);
        await emit(fDeal2!);
        await tick(47000);
        expect(triggersOf(plan.id)).toHaveLength(0);
        expect(m.place).toHaveBeenCalledTimes(1); // still only the original exit
    });

    it('an exit still in flight when the app reloads becomes unknown (never resent)', async () => {
        const plan = await armed();
        m.place.mockImplementationOnce(() => new Promise(() => undefined)); // response never arrives
        await tick(47000);
        expect(planOf(plan.id).exit?.status).toBe('sending');
        await boot({ keepStore: true });
        expect(engine.getExits()[0]!.status).toBe('unknown');
        expect(planOf(plan.id).exit?.status).toBe('unknown');
        await tick(46000);
        expect(m.place).toHaveBeenCalledTimes(1);
    });

    it('explicit reconcile resolves a working exit from the refreshed Trade', async () => {
        const plan = await armed();
        await tick(47000);
        expect(planOf(plan.id).exit?.status).toBe('working');
        const exitTrade = { ...cacheTrade('exit-1', F1, [{ seq: '000001', quantity: 2 }]),
            order: { id: 'exit-1', seqno: 'exit-1', ordno: 'o', action: 'Sell', price: 0, quantity: 2,
                account: { account_type: 'F', broker_id: F1.broker_id, account_id: F1.account_id } } } as unknown as Trade;
        m.refreshed.mockResolvedValue([cacheTrade('fixture-f1', F1, [{ seq: '000001', quantity: 1 }, { seq: '000002', quantity: 1 }]), exitTrade]);
        await bracket.reconcileBracket(plan.id);
        expect(planOf(plan.id).exit).toMatchObject({ status: 'filled', filled: 2 });
    });

    it('a bracket trigger cannot be removed on its own (only via the plan)', async () => {
        const plan = await armed();
        await engine.removeTrigger(triggersOf(plan.id)[0]!.id);
        expect(triggersOf(plan.id)).toHaveLength(2);
        expect(m.notify.mock.calls.some(([n]) => n.title === '觸價單移除未確認')).toBe(true);
        await bracket.dismissBracket(plan.id);
        expect(triggersOf(plan.id)).toHaveLength(0);
        expect(bracket.getBrackets()).toHaveLength(0);
    });

    it('simtrade (試撮) ticks never fire', async () => {
        await armed();
        await tick(47000, true);
        expect(m.place).not.toHaveBeenCalled();
    });

    it('unknown dispatch outcome is shown and never resent; exit fills resolve reservation', async () => {
        const plan = await armed();
        m.place.mockRejectedValueOnce(new Error('timeout'));
        await tick(47000);
        await tick(46900);
        expect(m.place).toHaveBeenCalledTimes(1);
        expect(planOf(plan.id).exit?.status).toBe('unknown');
        expect(m.notify.mock.calls.some(([n]) => n.title === '觸價單結果未知')).toBe(true);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(m.place).toHaveBeenCalledTimes(1);
        await bracket.acknowledgeBracketExit(plan.id);
        expect(engine.getExits()[0]!.acknowledged).toBe(true);
        expect(m.place).toHaveBeenCalledTimes(1);
    });

    it('refused before sending (mutationNotStarted) → not-sent + all quantity unprotected', async () => {
        const plan = await armed();
        m.place.mockRejectedValueOnce(Object.assign(new Error('行情未連線'), { mutationNotStarted: true }));
        await tick(47000);
        const { unprotectedQuantity } = await import('./bracket-core');
        expect(planOf(plan.id).exit?.status).toBe('not-sent');
        expect(unprotectedQuantity(planOf(plan.id))).toBe(2);
    });

    it('tracks the exit order from reports that arrive before the HTTP response', async () => {
        const plan = await armed();
        let resolve!: (v: unknown) => void;
        m.place.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
        await tick(47000);
        await emit(edit(fCoverDeal1!, { trade_id: 'x-exit' }));
        await emit(edit(fCoverDeal2!, { trade_id: 'x-exit' }));
        resolve({ order: { id: 'x-exit' }, status: { status: 'PendingSubmit' } });
        await flush();
        expect(planOf(plan.id).exit).toMatchObject({ status: 'filled', filled: 2, orderId: 'x-exit' });
        expect(engine.reservedQuantity(`${m.base}|F:fixture-broker-F:fixture-account-F|TXFJ6|Sell`)).toBe(0);
        void fCoverNew;
    });

    it('caps a bracket exit by the confirmed position minus reserved exits', async () => {
        const plan = await armed();
        m.positions = { rows: [{ code: 'TXFJ6', direction: 'Buy', quantity: 1, account: F1 }], updatedAt: 1, needsReconcile: false };
        await tick(47000);
        expect(m.place.mock.calls[0]![3]).toBe(1);
        const { unprotectedQuantity } = await import('./bracket-core');
        expect(unprotectedQuantity(planOf(plan.id))).toBe(1);
    });

    it('refuses a second stock exit while position is unknown and another exit is unresolved', async () => {
        const { planExitQuantity } = await import('./trigger-engine');
        const account = { account_type: 'S' as const, broker_id: 'b', account_id: 'a' };
        expect(planExitQuantity({ quantity: 2, bracketId: 'x', account }, 1, null).quantity).toBe(0);
        expect(planExitQuantity({ quantity: 2, bracketId: 'x', account: { ...account, account_type: 'F' } }, 1, null).quantity).toBe(2);
        expect(planExitQuantity({ quantity: 2, bracketId: 'x', account }, 1, 2)).toMatchObject({ quantity: 1 });
        expect(planExitQuantity({ quantity: 2, account }, 5, 0).quantity).toBe(2); // manual trigger sizing unchanged
    });

    it('popout windows never evaluate ticks or send orders', async () => {
        m.search = '?popout=flash&code=TXFR1';
        await boot();
        expect(m.tick).toBeNull();
        expect(m.order).toBeNull();
    });

    it('legacy persisted stop without account is suspended, not routed to the selected account', async () => {
        store = new Map([['sj-pro-triggers', JSON.stringify([{ id: 'old', code: 'TXFR1', condition: 'below', price: 48000,
            action: 'Sell', quantity: 1, kind: 'stop' }])]]);
        await boot({ keepStore: true });
        expect(engine.getTriggers()[0]!.suspended).toBe(engine.LEGACY_SUSPENDED);
        await tick(47000);
        expect(m.place).not.toHaveBeenCalled();
    });

    it('a trigger from another server (env) does not fire here', async () => {
        await armed();
        m.base = 'http://prod.invalid';
        await tick(47000);
        expect(m.place).not.toHaveBeenCalled();
    });
});

describe('pre-order bracket validation (entry is not sent when invalid)', () => {
    const base = { isFutures: true, action: 'Buy' as const, referencePrice: 48300, stopPrice: 48000, takePrice: 48600, octype: 'Auto' as const };
    it('accepts a sane long/short futures bracket', async () => {
        const { validateBracketRequest } = await import('./bracket');
        expect(validateBracketRequest(base)).toBeNull();
        expect(validateBracketRequest({ ...base, action: 'Sell', stopPrice: 48600, takePrice: 48000 })).toBeNull();
        expect(validateBracketRequest({ ...base, takePrice: null })).toBeNull();
    });
    it('rejects wrong-side prices, missing reference and unsupported conditions', async () => {
        const { validateBracketRequest } = await import('./bracket');
        expect(validateBracketRequest({ ...base, stopPrice: 48400 })).toMatch('停損價必須低於');
        expect(validateBracketRequest({ ...base, action: 'Sell' })).toMatch('停損價必須高於');
        expect(validateBracketRequest({ ...base, referencePrice: null })).toMatch('參考價');
        expect(validateBracketRequest({ ...base, stopPrice: null, takePrice: null })).toMatch('需要停損價或停利價');
        expect(validateBracketRequest({ ...base, octype: 'Cover' })).toMatch('Cover');
        expect(validateBracketRequest({ ...base, isFutures: false, orderLot: 'IntradayOdd' })).toMatch('現股整張');
        expect(validateBracketRequest({ ...base, isFutures: false, orderCond: 'MarginTrading' })).toMatch('現股整張');
        expect(validateBracketRequest({ ...base, isFutures: false, orderLot: 'Common', orderCond: 'Cash' })).toBeNull();
    });
});
