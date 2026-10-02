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
    oddTick: null as ((t: { code: string; close: number; simtrade?: boolean }) => void) | null,
    heartbeat: null as (() => void) | null,
    statusChanged: [] as (() => void)[],
    accounts: [] as Account[],
    place: vi.fn(),
    notify: vi.fn(),
    cached: vi.fn(),
    refreshed: vi.fn(),
    health: vi.fn(),
    subscribe: vi.fn(),
    healthCheck: vi.fn(),
    ensure: vi.fn(),
    cancel: vi.fn(),
    positions: { rows: [] as unknown[], updatedAt: null as number | null, needsReconcile: false },
    base: 'http://sim.invalid',
    env: 'http://sim.invalid|simulation' as string | null,
    envChanged: [] as (() => void)[],
    search: '',
    lockGranted: true,
    continuous: true,
    queued: null as ((lock: object | null) => unknown) | null,
}));

vi.mock('./runtime', () => ({ getApiBase: () => m.base }));
vi.mock('./stream', () => ({
    getStreamStatus: () => m.status,
    subscribeStatusStore: (cb: () => void) => { m.statusChanged.push(cb); return () => undefined; },
    onOrderEvent: (cb: (r: OrderEventReport) => void) => { m.order = cb; return () => undefined; },
    onAnyTick: (cb: typeof m.tick) => { m.tick = cb; return () => undefined; },
    onOddLotTick: (cb: typeof m.tick) => { m.oddTick = cb; return () => undefined; },
    onStreamEvent: (name: string, cb: () => void) => { if (name === 'heartbeat') m.heartbeat = cb; return () => undefined; },
}));
vi.mock('./account-store', () => ({ getAccountState: () => ({ accounts: m.accounts, selectedFutures: m.accounts.find(a => a.account_type === 'F') ?? null,
    selectedStock: m.accounts.find(a => a.account_type === 'S') ?? null }) }));
vi.mock('./trade', () => ({ notify: m.notify, placeQuickOrder: m.place }));
vi.mock('./contracts-cache', () => ({ ensureContract: m.ensure, getCachedContract: () => undefined }));
vi.mock('./quote-ownership', () => ({ retainQuote: () => () => undefined }));
vi.mock('./trading-state', () => ({ tradeCacheContinuous: () => m.continuous, checkTradeCacheHealth: m.healthCheck, getTradingState: () => ({ positions: m.positions.rows,
    queries: { positions: { updatedAt: m.positions.updatedAt, needsReconcile: m.positions.needsReconcile, error: null } } }) }));
vi.mock('./shioaji', () => ({
    fetchTrades: (_type: string, account: unknown, opts: { refresh: boolean }) => opts.refresh ? m.refreshed(account) : m.cached(account),
    fetchTradeCacheHealth: (_type: string, account: unknown) => m.health(account),
    cancelOrder: m.cancel,
    cancelVerifiedOrder: (row: Trade, _account: unknown, opts: {beforeSend?:()=>void}) => { opts.beforeSend?.(); return m.cancel(row.order.id); },
}));
vi.mock('./boot', () => ({ subscribeTradeReports: m.subscribe }));
vi.mock('./protection-env', () => {
    const envBase = (env: string) => env.slice(0, env.lastIndexOf('|'));
    return {
        currentProtectionEnv: () => m.env,
        protectionEnvLabel: () => '',
        refreshProtectionEnv: async () => undefined,
        onProtectionEnvChange: (cb: () => void) => { m.envChanged.push(cb); return () => undefined; },
        envBase,
        reportEnvMatches: (env: string, base: string) => m.env ? env === m.env : envBase(env) === base,
        watchProtectionEnv: () => undefined,
    };
});

const wire = (fixture as unknown[]).map(f => normalizeOrderEvent(f)!);
const [fDeal1, fNew1, fDeal2, fCoverNew, fCoverDeal1, fCoverDeal2] = wire;

function edit(r: OrderEventReport, patch: Record<string, unknown>): OrderEventReport {
    const raw = r.raw as { state: string; data: Record<string, Record<string, unknown>> };
    return normalizeOrderEvent({ ...raw, data: { [raw.state]: { ...raw.data[raw.state], ...patch } } })!;
}

const TXF = { code: 'TXFR1', target_code: 'TXFJ6', security_type: 'FUT', exchange: 'TAIFEX' };
const healthy = { state: 'Healthy', reasons: [] };

function spec(account: Account, orderId = 'fixture-f1', over: Record<string, unknown> = {}) {
    return { env: m.env!, account: { account_type: account.account_type as 'F', broker_id: account.broker_id, account_id: account.account_id },
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

async function boot(opts: { keepStore?: boolean; noHeartbeat?: boolean } = {}) {
    vi.resetModules();
    if (!opts.keepStore) store = new Map();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    vi.stubGlobal('location', { search: m.search });
    m.order = null; m.tick = null; m.heartbeat = null; m.statusChanged = []; m.envChanged = [];
    m.queued = null;
    vi.stubGlobal('navigator', { locks: { request: (_n: string, a: unknown, b?: (lock: object | null) => unknown) => {
        const cb = (typeof a === 'function' ? a : b) as (lock: object | null) => unknown;
        if (typeof a === 'function' || !(a as { ifAvailable?: boolean }).ifAvailable) { m.queued = cb; return new Promise(() => undefined); }
        const r = cb(m.lockGranted ? {} : null); return Promise.resolve(r instanceof Promise ? undefined : r); } } });
    engine = await import('./trigger-engine');
    bracket = await import('./bracket');
    engine.startTriggerEngine();
    bracket.startBracketRuntime();
    await flush();
    // the connected stream heartbeats: protection is evaluating, so the
    // restore window (#144) closes unless the mode is still unknown
    const beat = m.heartbeat as (() => void) | null; // set by startTriggerEngine
    if (beat && !opts.noHeartbeat) { beat(); await flush(); }
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
    m.env = 'http://sim.invalid|simulation'; m.lockGranted = true; m.continuous = true;
    m.positions = { rows: [], updatedAt: null, needsReconcile: false };
    for (const f of [m.place, m.notify, m.cached, m.refreshed, m.health, m.subscribe, m.ensure, m.cancel, m.healthCheck]) f.mockReset();
    m.healthCheck.mockResolvedValue(undefined);
    m.cancel.mockResolvedValue({});
    m.cached.mockResolvedValue([cacheTrade('fixture-f1', F1, []), cacheTrade('fixture-f9', F2, [])]); m.refreshed.mockResolvedValue([]); m.health.mockResolvedValue(healthy);
    m.subscribe.mockResolvedValue({}); m.ensure.mockResolvedValue(TXF);
    let n = 0;
    // like placeQuickOrder: beforeSend runs right before sending and may refuse
    m.place.mockImplementation(async (...args: unknown[]) => {
        (args[4] as { beforeSend?: () => void } | undefined)?.beforeSend?.();
        const id = `exit-${++n}`;
        return { contract: TXF, order: { id, seqno: id, ordno: 'o' }, status: { status: 'PendingSubmit' } };
    });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('bracket registration and partial-fill accumulation', () => {
    it('uses one cache-only lookup (refresh:false API) + health, never refresh polling', async () => {
        await boot();
        m.cached.mockResolvedValue([cacheTrade('fixture-f1', F1, [])]);
        const plan = await bracket.registerBracket(spec(F1));
        await flush();
        expect(m.cached).toHaveBeenCalledTimes(1);
        expect(m.cached).toHaveBeenCalledWith(F1);
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
        await emit(fDeal1!); // repeat that reached us anyway (stream.ts normally drops it)
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
        await emit(edit(fDeal1!, { trade_id: 'fixture-f9', seqno: 'fixture-f9', account_id: 'fixture-account-F2', event_id: 'v1:FD:FIXTURESTREAMFD:FIXTURERESET:5' }));
        await emit(edit(fDeal2!, { trade_id: 'fixture-f9', seqno: 'fixture-f9', account_id: 'fixture-account-F2', event_id: 'v1:FD:FIXTURESTREAMFD:FIXTURERESET:6' }));
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

    it('a stale stream (heartbeat watchdog) marks protection unconfirmed; reconnecting alone does not clear it', async () => {
        await boot();
        const plan = await bracket.registerBracket(spec(F1));
        await flush();
        expect(planOf(plan.id).issues).toEqual([]);
        m.status = 'stale'; m.statusChanged.forEach(cb => cb()); await flush();
        expect(planOf(plan.id).issues.map(i => i.code)).toEqual(['disconnect']);
        m.status = 'connecting'; m.statusChanged.forEach(cb => cb()); await flush();
        m.status = 'live'; m.statusChanged.forEach(cb => cb()); await flush();
        expect(planOf(plan.id).issues.map(i => i.code)).toEqual(['disconnect']); // reconnect ≠ confirmed
        m.health.mockResolvedValueOnce({ state: 'Degraded', reasons: [{ event_type: 'FuturesDeal', reason: 'SequenceGap' }] });
        m.refreshed.mockResolvedValue([cacheTrade('fixture-f1', F1, [])]);
        await bracket.reconcileBracket(plan.id);
        expect(planOf(plan.id).issues.map(i => i.code)).toContain('disconnect'); // not Healthy → still unconfirmed
        await bracket.reconcileBracket(plan.id);
        expect(planOf(plan.id).issues).toEqual([]); // Healthy reconcile clears
    });

    it('a sequence gap on the futures stream marks futures plans NOT confirmed', async () => {
        await boot();
        const plan = await bracket.registerBracket(spec(F1));
        await flush();
        // stream.ts admits every report into the shared ledger (#128)
        const { reportLedger } = await import('./report-ledger');
        reportLedger.admit({ base: m.base }, fDeal1!.eventId, 'deal'); // FD:4 baseline
        reportLedger.admit({ base: m.base }, fCoverDeal2!.eventId, 'deal'); // FD:7 → 5,6 not observed
        expect(planOf(plan.id).issues.map(i => i.code)).toContain('gap');
    });

    it('without an authoritative continuous baseline, cache-only results stay unconfirmed; a missing order is not filled/cancelled', async () => {
        await boot();
        m.continuous = false;
        m.cached.mockResolvedValue([]);
        const plan = await bracket.registerBracket(spec(F1));
        await flush();
        const p = planOf(plan.id);
        expect(p.issues.map(i => i.code)).toEqual(['no-baseline', 'lookup-failed']);
        expect(p.filled).toBe(0);
        expect(p.entryClosed).toBe(false);
    });

    it('Degraded cache health and NotSubscribed are surfaced; resubscribe is left to trading-state', async () => {
        await boot();
        m.health.mockResolvedValueOnce({ state: 'Degraded', reasons: [{ event_type: 'FuturesDeal', reason: 'SequenceGap' }] });
        const plan = await bracket.registerBracket(spec(F1));
        await flush();
        expect(planOf(plan.id).issues.map(i => i.code)).toEqual(['cache-degraded']);
        m.health.mockResolvedValue({ state: 'Unknown', reasons: [{ event_type: 'FuturesDeal', reason: 'NotSubscribed' }] });
        const other = await bracket.registerBracket(spec(F2, 'fixture-f9'));
        await flush();
        expect(m.subscribe).not.toHaveBeenCalled(); // bracket never calls subscribe_trade itself
        expect(m.healthCheck).toHaveBeenCalledWith('manual'); // trading-state's single-flight path
        expect(planOf(other.id).issues.map(i => i.code)).toEqual(['not-subscribed']);
    });

    it('on reconnect the bracket adds no subscribe_trade of its own (no duplicate with trading-state)', async () => {
        await boot();
        await bracket.registerBracket(spec(F1));
        await bracket.registerBracket(spec(F2, 'fixture-f9'));
        await flush();
        m.health.mockResolvedValue({ state: 'Unknown', reasons: [{ event_type: 'FuturesDeal', reason: 'NotSubscribed' }] });
        m.status = 'down'; m.statusChanged.forEach(cb => cb()); await flush();
        m.status = 'live'; m.statusChanged.forEach(cb => cb()); await flush();
        expect(m.subscribe).not.toHaveBeenCalled();
        // every NotSubscribed read funnels into the one coalescing trading-state check
        expect(m.healthCheck.mock.calls.every(([t]) => t === 'manual')).toBe(true);
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

    it('reconcile while the stream is down, or with a non-Healthy cache, keeps protection unconfirmed', async () => {
        await boot();
        const plan = await bracket.registerBracket(spec(F1));
        await flush();
        m.status = 'down'; m.statusChanged.forEach(cb => cb()); await flush();
        m.refreshed.mockResolvedValue([cacheTrade('fixture-f1', F1, [])]);
        await bracket.reconcileBracket(plan.id);
        expect(planOf(plan.id).issues.map(i => i.code)).toContain('disconnect');
        m.status = 'live'; m.statusChanged.forEach(cb => cb()); await flush();
        m.health.mockResolvedValue({ state: 'Unknown', reasons: [{ event_type: 'FuturesDeal', reason: 'NoBaseline' }] });
        await expect(bracket.reconcileBracket(plan.id)).resolves.toEqual({ health: 'Unknown' });
        expect(planOf(plan.id).issues.map(i => i.code)).toContain('disconnect');
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
        expect(engine.isGroupProcessed(m.env!, planOf(plan.id).group)).toBe(true);
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

    function exitRow(status: string, deals: { seq: string; quantity: number; ts?: number }[], cancel = 0) {
        const row = { ...cacheTrade('exit-1', F1, deals.map(d => ({ seq: d.seq, quantity: d.quantity }))),
            order: { id: 'exit-1', seqno: 'exit-1', ordno: 'o', action: 'Sell', price: 0, quantity: 2, order_type: 'IOC',
                account: { account_type: 'F', broker_id: F1.broker_id, account_id: F1.account_id } } } as unknown as Trade;
        row.status = { ...row.status, status: status as Trade['status']['status'], cancel_quantity: cancel,
            deals: deals.map(d => ({ seq: d.seq, quantity: d.quantity, price: 1, ts: d.ts ?? 1 })) };
        return row;
    }
    const RESERVE = () => `${m.env}|F:fixture-broker-F:fixture-account-F|TXFJ6|Sell`;

    it('IOC exit PartFilled: settles only when a second read is unchanged (2 cache-only reads, never resent)', async () => {
        const plan = await armed();
        await tick(47000);
        await emit(edit(fCoverDeal1!, { trade_id: 'exit-1', seqno: 'exit-1', ordno: 'o' })); // 1 of 2 filled, then silence
        m.cached.mockClear();
        m.cached.mockResolvedValue([exitRow('PartFilled', [{ seq: '000001', quantity: 1, ts: fCoverDeal1!.ts }], 1)]);
        await vi.advanceTimersByTimeAsync(engine.IOC_CHECK_MS); await flush();
        expect(planOf(plan.id).exit?.status).toBe('working'); // one PartFilled read is not proof
        await vi.advanceTimersByTimeAsync(engine.IOC_RECHECK_MS); await flush();
        expect(m.cached).toHaveBeenCalledTimes(2);
        expect(m.refreshed).not.toHaveBeenCalled();
        expect(planOf(plan.id).exit).toMatchObject({ status: 'incomplete', filled: 1 });
        expect(planOf(plan.id).exit?.detail).toMatch('待確認');
        const { unprotectedQuantity } = await import('./bracket-core');
        expect(unprotectedQuantity(planOf(plan.id))).toBe(1);
        expect(engine.reservedQuantity(RESERVE())).toBe(0);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(m.place).toHaveBeenCalledTimes(1);
        expect(m.cached).toHaveBeenCalledTimes(2);
    });

    it('a late exit fill after the IOC settle still applies and removes the unprotected remainder', async () => {
        const plan = await armed();
        await tick(47000);
        m.cached.mockResolvedValue([exitRow('Cancelled', [{ seq: '000001', quantity: 1 }], 1)]); // final status
        await vi.advanceTimersByTimeAsync(engine.IOC_CHECK_MS); await flush();
        expect(planOf(plan.id).exit?.status).toBe('incomplete');
        await emit(edit(fCoverDeal2!, { trade_id: 'exit-1', seqno: 'exit-1', ordno: 'o' })); // multi-level exit: a late second deal
        const { unprotectedQuantity } = await import('./bracket-core');
        expect(planOf(plan.id).exit).toMatchObject({ filled: 2, status: 'filled' });
        expect(unprotectedQuantity(planOf(plan.id))).toBe(0);
    });

    it('PartFilled that changes between the two reads stays 待確認 (no third read)', async () => {
        const plan = await armed();
        await tick(47000);
        m.cached.mockResolvedValueOnce([exitRow('PartFilled', [{ seq: '000001', quantity: 1 }])]);
        m.cached.mockResolvedValueOnce([exitRow('PartFilled', [{ seq: '000001', quantity: 1 }], 1)]);
        m.cached.mockClear();
        await vi.advanceTimersByTimeAsync(engine.IOC_CHECK_MS + engine.IOC_RECHECK_MS + 30_000); await flush();
        expect(m.cached).toHaveBeenCalledTimes(2);
        expect(planOf(plan.id).exit?.status).toBe('working');
        expect(planOf(plan.id).exit?.detail).toMatch('待確認');
    });

    it('IOC check that does not find the exit order changes nothing (missing ≠ filled/cancelled)', async () => {
        const plan = await armed();
        await tick(47000);
        m.cached.mockClear();
        m.cached.mockResolvedValue([]);
        await vi.advanceTimersByTimeAsync(engine.IOC_CHECK_MS + engine.IOC_RECHECK_MS + 30_000); await flush();
        expect(m.cached).toHaveBeenCalledTimes(2);
        expect(planOf(plan.id).exit?.status).toBe('working');
    });

    it('entry still working after the exit fired: one cancel on request; unconfirmed → 待確認, never resent', async () => {
        const plan = await armed(1); // 1 of 2 filled, entry still working
        await tick(47000);
        const { workingEntryAfterExit } = await import('./bracket-core');
        expect(workingEntryAfterExit(planOf(plan.id))).toBe(1);
        expect(m.cancel).not.toHaveBeenCalled();
        m.cancel.mockRejectedValueOnce(Object.assign(new Error('刪單已送出但未確認取消'), { code: 'CANCEL_UNCONFIRMED', mutationOutcomeUnknown: true }));
        await expect(bracket.cancelRemainingEntry(planOf(plan.id))).resolves.toBe('unconfirmed');
        expect(m.cancel).toHaveBeenCalledTimes(1);
        expect(m.cancel).toHaveBeenCalledWith('fixture-f1');
        expect(planOf(plan.id).entryCancel).toBe('unconfirmed');
        await expect(bracket.cancelRemainingEntry(planOf(plan.id))).rejects.toThrow('勿重送');
        expect(m.cancel).toHaveBeenCalledTimes(1);
        // reconcile shows the entry cancelled → closed, state cleared
        const cancelled = cacheTrade('fixture-f1', F1, [{ seq: '000001', quantity: 1 }]);
        cancelled.status = { ...cancelled.status, status: 'Cancelled', cancel_quantity: 1 };
        m.refreshed.mockResolvedValue([cancelled]);
        await bracket.reconcileBracket(plan.id);
        expect(planOf(plan.id).entryClosed).toBe(true);
        expect(planOf(plan.id).entryCancel).toBeUndefined();
        expect(workingEntryAfterExit(planOf(plan.id))).toBe(0);
    });

    it('a read-back-confirmed Cancelled trade from cancelOrder closes the entry; a Submitted response does not', async () => {
        const plan = await armed(1);
        await tick(47000);
        const submitted = cacheTrade('fixture-f1', F1, [{ seq: '000001', quantity: 1 }]);
        m.cancel.mockResolvedValueOnce(submitted);
        await expect(bracket.cancelRemainingEntry(planOf(plan.id))).resolves.toBe('unconfirmed');
        expect(planOf(plan.id).entryClosed).toBe(false);
        const other = await (async () => { await boot(); const p = await bracket.registerBracket(spec(F2, 'fixture-f9')); await flush(); return p; })();
        await emit(edit(fDeal1!, { trade_id: 'fixture-f9', seqno: 'fixture-f9', account_id: 'fixture-account-F2', event_id: 'v1:FD:Z:R:1' }));
        await tick(47000);
        const confirmed = cacheTrade('fixture-f9', F2, [{ seq: '000001', quantity: 1 }]);
        confirmed.status = { ...confirmed.status, status: 'Cancelled', cancel_quantity: 1 };
        m.cancel.mockResolvedValueOnce(confirmed);
        await expect(bracket.cancelRemainingEntry(planOf(other.id))).resolves.toBe('cancelled');
        expect(planOf(other.id).entryClosed).toBe(true);
    });

    it('a reload during an entry cancel becomes 刪單待確認 and the done plan still reconciles', async () => {
        const plan = await armed(1);
        await tick(47000);
        m.cancel.mockImplementationOnce(() => new Promise(() => undefined)); // app dies mid-cancel
        void bracket.cancelRemainingEntry(planOf(plan.id));
        await flush();
        expect(planOf(plan.id).entryCancel).toBe('sending');
        await boot({ keepStore: true });
        const reloaded = planOf(plan.id);
        expect(reloaded.entryCancel).toBe('unconfirmed');
        const { isLive, bracketPhase } = await import('./bracket-core');
        expect(bracketPhase(reloaded)).toBe('done'); // unresolved exit identity stays unknown and live
        expect(reloaded.exit?.status).toBe('unknown');
        expect(isLive(reloaded)).toBe(true);
        // exit completes → plan is done, entry cancel unconfirmed → still live for 對帳
        const exitRow = { ...cacheTrade('exit-1', F1, [{ seq: '000001', quantity: 1 }]),
            order: { id: 'exit-1', seqno: 'exit-1', ordno: 'o', action: 'Sell', price: 0, quantity: 1,
                account: { account_type: 'F', broker_id: F1.broker_id, account_id: F1.account_id } } } as unknown as Trade;
        exitRow.status = { ...exitRow.status, status: 'Filled' };
        const cancelled = cacheTrade('fixture-f1', F1, [{ seq: '000001', quantity: 1 }]);
        cancelled.status = { ...cancelled.status, status: 'Cancelled', cancel_quantity: 1 };
        m.refreshed.mockResolvedValue([exitRow]);
        await bracket.reconcileBracket(plan.id);
        expect(bracketPhase(planOf(plan.id))).toBe('done');
        expect(isLive(planOf(plan.id))).toBe(true);
        m.refreshed.mockResolvedValue([exitRow, cancelled]);
        await bracket.reconcileBracket(plan.id);
        expect(planOf(plan.id).entryClosed).toBe(true);
        expect(planOf(plan.id).entryCancel).toBeUndefined();
        expect(isLive(planOf(plan.id))).toBe(false);
        expect(m.cancel).toHaveBeenCalledTimes(1); // never resent
    });

    it('a cancel refused before sending leaves no pending state', async () => {
        const plan = await armed(1);
        await tick(47000);
        m.cancel.mockRejectedValueOnce(Object.assign(new Error('伺服器已切換'), { mutationNotStarted: true }));
        await expect(bracket.cancelRemainingEntry(planOf(plan.id))).rejects.toThrow('伺服器已切換');
        expect(planOf(plan.id).entryCancel).toBeUndefined();
    });

    it('a failed or unacknowledged registration never tells the user to add a manual stop', async () => {
        const { CommandNotAcknowledged } = await import('./main-window-commands');
        await boot();
        expect(bracket.REGISTER_TIMEOUT_MS).toBe(60_000);
        const late = bracket.registrationFailureText(new CommandNotAcknowledged());
        expect(late).toMatch('括號單狀態');
        expect(late).not.toMatch('請手動設定停損');
        expect(bracket.registrationFailureText(new Error('x'))).not.toMatch('請手動設定停損');
    });

    it('a mirror without a recent main snapshot reports itself stale; the executor never does', async () => {
        await boot();
        expect(bracket.bracketSnapshotStale()).toBe(false);
        m.search = '?popout=flash&code=TXFR1';
        await boot();
        expect(bracket.bracketSnapshotStale()).toBe(true);
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
        const { isLive, needsAttention } = await import('./bracket-core');
        expect(isLive(planOf(plan.id))).toBe(false);
        expect(needsAttention(planOf(plan.id))).toBe(false);
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
        await emit(edit(fCoverDeal1!, { trade_id: 'x-exit', seqno: 'x-exit', ordno: 'o' }));
        await emit(edit(fCoverDeal2!, { trade_id: 'x-exit', seqno: 'x-exit', ordno: 'o' }));
        resolve({ contract: TXF, order: { id: 'x-exit', seqno: 'x-exit', ordno: 'o' }, status: { status: 'PendingSubmit' } });
        await flush();
        expect(planOf(plan.id).exit).toMatchObject({ status: 'filled', filled: 2, orderId: 'x-exit' });
        expect(engine.reservedQuantity(`${m.env}|F:fixture-broker-F:fixture-account-F|TXFJ6|Sell`)).toBe(0);
        void fCoverNew;
    });

    it('never shrinks a futures Cover stop because of a lagging position snapshot (broker checks Cover)', async () => {
        const plan = await armed();
        m.positions = { rows: [{ code: 'TXFJ6', direction: 'Buy', quantity: 0, account: F1 }], updatedAt: 1, needsReconcile: false };
        await tick(47000);
        expect(m.place.mock.calls[0]![3]).toBe(2);
        expect(m.place.mock.calls[0]![4].ocType).toBe('Cover');
        expect(planOf(plan.id).exit?.detail).toMatch('Cover');
    });

    it('caps a stock bracket exit by the confirmed Cash position minus reserved exits', async () => {
        await boot();
        const stockSpec = { ...spec(S1, 'fixture-s1'), account: { account_type: 'S' as const, broker_id: S1.broker_id, account_id: S1.account_id },
            quoteCode: '2890', orderCode: '2890', securityType: 'STK' as const, exchange: 'TSE', stopPrice: 44, takePrice: 46 };
        m.cached.mockResolvedValue([]);
        const plan = await bracket.registerBracket(stockSpec);
        await flush();
        const sDeal = wire[7]!;
        await emit(sDeal);
        await emit(edit(sDeal, { exchange_seq: '000002', event_id: 'v1:SD:FIXTURESTREAMSD:FIXTURERESET:3' }));
        expect(triggersOf(plan.id).map(t => [t.quantity, t.octype])).toEqual([[2, undefined], [2, undefined]]);
        m.positions = { rows: [
            { code: '2890', direction: 'Buy', quantity: 1000, cond: 'Cash', account: S1 },
            { code: '2890', direction: 'Buy', quantity: 5000, cond: 'MarginTrading', account: S1 },
        ], updatedAt: 1, needsReconcile: false };
        m.ensure.mockResolvedValue({ code: '2890', target_code: null, security_type: 'STK', exchange: 'TSE' });
        m.tick!({ code: '2890', close: 43.5 }); await flush();
        expect(m.place).toHaveBeenCalledTimes(1);
        expect(m.place.mock.calls[0]![3]).toBe(1); // margin shares are not sellable by a Cash exit
        const { unprotectedQuantity } = await import('./bracket-core');
        expect(unprotectedQuantity(planOf(plan.id))).toBe(1);
    });

    it('refuses a second stock exit while position is unknown and another exit is unresolved', async () => {
        const { planExitQuantity } = await import('./trigger-engine');
        const account = { account_type: 'S' as const, broker_id: 'b', account_id: 'a' };
        expect(planExitQuantity({ quantity: 2, bracketId: 'x', account }, 1, null).quantity).toBe(0);
        expect(planExitQuantity({ quantity: 2, bracketId: 'x', account: { ...account, account_type: 'F' } }, 1, null).quantity).toBe(2);
        expect(planExitQuantity({ quantity: 2, bracketId: 'x', account }, 1, 2)).toMatchObject({ quantity: 1 });
        expect(planExitQuantity({ quantity: 2, bracketId: 'x', account: { ...account, account_type: 'F' } }, 1, 0).quantity).toBe(2);
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
        m.env = 'http://prod.invalid|production';
        await tick(47000);
        expect(m.place).not.toHaveBeenCalled();
    });

    it('a simulation stop never fires after the same port restarts in production', async () => {
        const plan = await armed();
        m.env = `${m.base}|production`;
        await boot({ keepStore: true });
        await tick(47000);
        expect(m.place).not.toHaveBeenCalled();
        expect(triggersOf(plan.id)).toHaveLength(2); // kept, shown as another environment
    });

    it('with the server mode unknown, nothing is registered or executed', async () => {
        await armed();
        m.env = null;
        await tick(47000);
        expect(m.place).not.toHaveBeenCalled();
        await expect(bracket.registerBracket({ ...spec(F2, 'fixture-f9'), env: 'x|simulation' })).rejects.toThrow('未確認');
    });

    it('a second main tab without the executor lock is a read-only mirror and takes over later', async () => {
        await armed();
        const saved = store.get('sj-pro-triggers');
        m.lockGranted = false;
        await boot({ keepStore: true });
        expect(m.tick).toBeNull();
        expect(m.order).toBeNull();
        expect(engine.getTriggers()).toEqual([]); // no stale private copy
        await engine.addTrigger({ code: 'TXFR1', condition: 'above', price: 1, action: 'Buy', quantity: 0, kind: 'alert' });
        expect(store.get('sj-pro-triggers')).toBe(saved); // never writes shared state
        await expect(bracket.ensureBracketHost()).rejects.toThrow();
        // the executor tab closes → the queued lock is granted → take over
        m.queued!({}); await flush();
        expect(m.tick).not.toBeNull();
        expect(engine.getTriggers()).toHaveLength(2);
        await tick(48300); // handover is a restore (#144): the first tick decides
        await tick(47000);
        expect(m.place).toHaveBeenCalledTimes(1);
    });
});

describe('restore confirmation for bracket exits armed after a restart (#144)', () => {
    it('entry fill found in the startup cache lookup arms exits that wait for their first tick', async () => {
        await boot();
        const plan = await bracket.registerBracket(spec(F1));
        await flush();
        let answer!: (rows: Trade[]) => void;
        m.cached.mockImplementation(() => new Promise<Trade[]>(r => { answer = r; }));
        await boot({ keepStore: true }); // heartbeat already arrived before the lookup answers
        answer([cacheTrade('fixture-f1', F1, [{ seq: '000001', quantity: 1 }])]);
        await flush();
        expect(triggersOf(plan.id)).toHaveLength(2);
        await tick(47000);
        expect(m.place).not.toHaveBeenCalled();
        expect(triggersOf(plan.id).find(t => t.kind === 'stop')!.pending?.price).toBe(47000);
    });

    it('entry fill before mode is known needs a strict current listing before restore arming', async () => {
        await boot();
        const plan = await bracket.registerBracket(spec(F1));
        await flush();
        m.env = null;
        await boot({ keepStore: true });
        await emit(fDeal1!);
        expect(triggersOf(plan.id)).toHaveLength(0); // mode unknown: nothing armed
        expect(planOf(plan.id).filled).toBe(0);
        m.cached.mockResolvedValue([cacheTrade('fixture-f1', F1, [{seq:'000001',quantity:1}])]);
        m.env = 'http://sim.invalid|simulation';
        m.envChanged.forEach(cb => cb()); await flush();
        expect(triggersOf(plan.id)).toHaveLength(2);
        await tick(47000);
        expect(m.place).not.toHaveBeenCalled();
        expect(triggersOf(plan.id).find(t => t.kind === 'stop')!.pending).toBeTruthy();
    });

    it('a LIVE fill before the first real tick (only 試撮 so far) arms exits that fire at the opening gap', async () => {
        await boot();
        const plan = await bracket.registerBracket(spec(F1));
        await flush();
        await tick(48300, true); // 試撮
        await emit(fDeal1!);
        await tick(47000); // opens past the stop
        expect(m.place).toHaveBeenCalledTimes(1);
        expect(triggersOf(plan.id)).toHaveLength(0);
    });

    it('quiet market: a live fill 10 s after the mode became known (no heartbeat yet) fires immediately', async () => {
        m.env = null;
        await boot({ noHeartbeat: true });
        m.env = 'http://sim.invalid|simulation';
        m.envChanged.forEach(cb => cb()); await flush();
        await vi.advanceTimersByTimeAsync(10_000);
        const plan = await bracket.registerBracket(spec(F1));
        await flush();
        await emit(fDeal1!);
        await tick(47000);
        expect(m.place).toHaveBeenCalledTimes(1);
        expect(triggersOf(plan.id)).toHaveLength(0);
    });

    it('fill during a 61 s outage, found by the reconnect lookup after a past tick → 待確認', async () => {
        await boot();
        const plan = await bracket.registerBracket(spec(F1));
        await flush();
        await tick(48300);
        m.status = 'down'; m.statusChanged.forEach(cb => cb());
        m.env = null; m.envChanged.forEach(cb => cb()); await flush();
        await vi.advanceTimersByTimeAsync(61_000);
        let answer!: (rows: Trade[]) => void;
        m.cached.mockImplementation(() => new Promise<Trade[]>(r => { answer = r; }));
        m.status = 'live'; m.statusChanged.forEach(cb => cb());
        m.env = 'http://sim.invalid|simulation'; m.envChanged.forEach(cb => cb()); await flush();
        await tick(47000); // first tick after the outage, before the lookup answers
        answer([cacheTrade('fixture-f1', F1, [{ seq: '000001', quantity: 1 }])]);
        await flush();
        expect(triggersOf(plan.id)).toHaveLength(2);
        await tick(46900);
        expect(m.place).not.toHaveBeenCalled();
        expect(triggersOf(plan.id).find(t => t.kind === 'stop')!.pending).toBeTruthy();
    });
});

describe('orphaned bracket protection (#144)', () => {
    it('dismissing a bracket whose plan is gone removes its triggers', async () => {
        await boot();
        engine.armBracketGroup({ group: 'bracket:gone', bracketId: 'plan-gone', env: m.env!,
            account: { account_type: 'F', broker_id: F1.broker_id, account_id: F1.account_id }, code: 'TXFR1',
            orderCode: 'TXFJ6', entryAction: 'Buy', octype: 'Cover', stopPrice: 48000, takePrice: 48600, quantity: 1 });
        expect(triggersOf('plan-gone')).toHaveLength(2);
        await bracket.dismissBracket('plan-gone');
        expect(triggersOf('plan-gone')).toHaveLength(0);
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
        // #204: 盤中零股（現股）可以掛括號單；盤後零股與信用條件不行
        expect(validateBracketRequest({ ...base, isFutures: false, orderLot: 'IntradayOdd' })).toBeNull();
        expect(validateBracketRequest({ ...base, isFutures: false, orderLot: 'Odd' })).toMatch('盤後零股');
        expect(validateBracketRequest({ ...base, isFutures: false, orderLot: 'IntradayOdd', orderCond: 'MarginTrading' })).toMatch('融資券');
        expect(validateBracketRequest({ ...base, isFutures: false, orderCond: 'MarginTrading' })).toMatch('僅支援現股');
        expect(validateBracketRequest({ ...base, isFutures: false, orderLot: 'Common', orderCond: 'Cash' })).toBeNull();
    });
});

it('r33 mirror admission is invalidated by a main-window generation change, retaining any sent entry', async () => {
    let currentHost = 'fixture-host-1';
    let bracketChannel: FakeChannel | null = null;
    class FakeChannel {
        listener: ((event: { data: unknown }) => void) | null = null;
        constructor(public name: string) { if (name.startsWith('sj-brackets:')) bracketChannel = this; }
        addEventListener(_name: string, cb: (event: { data: unknown }) => void) { this.listener = cb; }
        close() { this.listener = null; }
        state() { this.listener?.({ data: { kind: 'state', state: { hostId: currentHost, plans: [] } } }); }
        postMessage(value: { kind: string; id?: string; cmd?: { op: string; hostId?: string } }) {
            if (!this.name.startsWith('sj-brackets:')) return;
            queueMicrotask(() => {
                this.state();
                if (value.kind === 'cmd') this.listener?.({ data: { kind: 'ack', id: value.id,
                    ok: value.cmd?.op !== 'register' || value.cmd.hostId === currentHost,
                    result: value.cmd?.op === 'ping' ? currentHost : undefined,
                    error: '主視窗已重新載入，保護登記待確認' } });
            });
        }
    }
    m.search = '?popout=flash';vi.stubGlobal('BroadcastChannel', FakeChannel);
    await boot();
    const admission = await bracket.ensureBracketHost();
    expect(() => bracket.assertBracketAdmission(admission)).not.toThrow();
    currentHost = 'fixture-host-2';(bracketChannel as FakeChannel | null)?.state();
    expect(() => bracket.assertBracketAdmission(admission)).toThrow('保護執行環境已變更');
    await expect(bracket.registerBracket({ env: m.env!, account: { account_type: 'F', broker_id: F1.broker_id, account_id: F1.account_id }, orderId: 'fixture-late-entry', seqno: 'fixture-late-seq', quoteCode: 'TXFR1', orderCode: 'TXFJ6', securityType: 'FUT', exchange: 'TAIFEX', action: 'Buy', quantity: 1, stopPrice: 95, takePrice: 110 }, admission)).rejects.toThrow('主視窗已重新載入');
    expect(bracket.getDisplayBrackets()).toMatchObject([{ orderId: 'fixture-late-entry', registrationPending: { owner: 'window' } }]);
    expect(m.place).not.toHaveBeenCalled();
});

// r34 public runtime seam: only fake reports/listing, no broker transport.
it('r34 new stable entry reusing raw ID has its own acknowledged bracket', async () => {
 await boot();
 const old = await bracket.registerBracket(spec(F1, 'R', {seqno:'S1',ordno:'O1'}));
 m.status='disconnected';m.statusChanged.forEach(cb=>cb());
 m.status='live';m.statusChanged.forEach(cb=>cb());
 const admission=await bracket.ensureBracketHost();
 const fresh=await bracket.registerBracket(spec(F1,'R',{seqno:'S2',ordno:'O2'}),admission);
 expect(fresh.id).not.toBe(old.id);expect(fresh.seqno).toBe('S2');
 expect(bracket.getDisplayBrackets().filter(p=>p.registrationPending)).toHaveLength(0);
});
it('r34 conflicting report and listing never fill or close prior raw ID',async()=>{
 await boot();const old=await bracket.registerBracket(spec(F1,'R',{seqno:'S1',ordno:'O1'}));
 await emit(edit(fDeal1!,{trade_id:'R',seqno:'S2',ordno:'O2',exchange_seq:'F2'}));
 expect(planOf(old.id).filled).toBe(0);expect(triggersOf(old.id)).toHaveLength(0);
 const foreign=cacheTrade('R',F1,[{seq:'F2',quantity:1}]);foreign.order.seqno='S2';foreign.order.ordno='O2';foreign.status.status='Filled';
 m.refreshed.mockResolvedValue([foreign]);await bracket.reconcileBracket(old.id);
 expect(planOf(old.id).filled).toBe(0);expect(planOf(old.id).entryClosed).toBe(false);
});
it('r34 positive current stable identity admits and deduplicates a fill',async()=>{
 await boot();const p=await bracket.registerBracket(spec(F1));await emit(fDeal1!);await emit(fDeal1!);
 expect(planOf(p.id).filled).toBe(1);expect(triggersOf(p.id)).toHaveLength(2);
});

const r34Lots = ['Common', 'IntradayOdd'] as const;
function r34Spec(lot: typeof r34Lots[number], seqno: string, ordno: string, orderId = 'r34-raw') {
 return lot === 'Common' ? spec(F1,orderId,{seqno,ordno}) : {...spec(S1,orderId,{seqno,ordno}),
  account:{account_type:'S' as const,broker_id:S1.broker_id,account_id:S1.account_id},quoteCode:'2330',orderCode:'2330',securityType:'STK' as const,exchange:'TSE',orderLot:'IntradayOdd' as const};
}
function r34Deal(lot: typeof r34Lots[number], seqno: string, ordno: string, fill='1', orderId='r34-raw') {
 if(lot==='Common') return edit(fDeal1!,{trade_id:orderId,seqno,ordno,exchange_seq:fill,event_id:`v1:FD:r34:${seqno}:${fill}`});
 return normalizeOrderEvent({state:'StockDeal',data:{StockDeal:{trade_id:orderId,seqno,ordno,exchange_seq:fill,
  event_id:`v1:SD:r34:${seqno}:${fill}`,broker_id:S1.broker_id,account_id:S1.account_id,code:'2330',security_type:'STK',
  order_lot:'IntradayOdd',action:'Buy',quantity:1,ts:1}}})!;
}
function r34Trade(lot: typeof r34Lots[number], seqno: string, ordno: string, filled=0, orderId='r34-raw'): Trade {
 const row=cacheTrade(orderId,lot==='Common'?F1:S1,filled?[{seq:'1',quantity:filled}]:[]);
 row.order.seqno=seqno;row.order.ordno=ordno;
 if(lot==='IntradayOdd') {row.contract={...row.contract,code:'2330',security_type:'STK',exchange:'TSE'};
 row.order.account={...row.order.account!,account_type:'S'};row.order.order_lot='IntradayOdd';}
 return row;
}
it.each(r34Lots)('r34 %s preserves old risk while the new same-raw-ID identity gets its own protection',async(lot)=>{
 await boot();m.cached.mockResolvedValue([]);
 const old=await bracket.registerBracket(r34Spec(lot,'S1','O1'));await emit(r34Deal(lot,'S1','O1'));
 expect(planOf(old.id).filled).toBe(1);
 m.status='down';m.statusChanged.forEach(cb=>cb());await flush();
 m.status='live';m.statusChanged.forEach(cb=>cb());await flush();
 const fresh=await bracket.registerBracket(r34Spec(lot,'S2','O2'),await bracket.ensureBracketHost({orderLot:lot}));
 expect(fresh.id).not.toBe(old.id);
 await emit(r34Deal(lot,'S1','O1','2')); // prior entry, current context unconfirmed
 expect(planOf(old.id).filled).toBe(1);expect(planOf(fresh.id).filled).toBe(0);
 await emit(r34Deal(lot,'S2','O2'));
 expect(planOf(fresh.id).filled).toBe(1);expect(planOf(old.id).filled).toBe(1);
 expect(bracket.getDisplayBrackets().map(p=>p.seqno)).toEqual(['S1','S2']);expect(m.place).not.toHaveBeenCalled();
});
it.each(r34Lots)('r34 %s same stable order can change raw ID without another bracket or fill',async(lot)=>{
 await boot();m.cached.mockResolvedValue([]);
 const old=await bracket.registerBracket(r34Spec(lot,'S1','O1'));
 const same=await bracket.registerBracket(r34Spec(lot,'S1','O1','new-raw'));expect(same.id).toBe(old.id);
 await emit(r34Deal(lot,'S1','O1','1','new-raw'));expect(planOf(old.id).filled).toBe(1);
 m.refreshed.mockResolvedValue([r34Trade(lot,'S1','O1',1,'listed-raw')]);await bracket.reconcileBracket(old.id);
 expect(planOf(old.id).filled).toBe(1);expect(planOf(old.id).currentOrderId).toBe('listed-raw');expect(m.place).not.toHaveBeenCalled();
});
it.each(r34Lots)('r34 %s foreign or ambiguous listing cannot fill or terminate old entry',async(lot)=>{
 await boot();m.cached.mockResolvedValue([]);const old=await bracket.registerBracket(r34Spec(lot,'S1','O1'));
 const foreign=r34Trade(lot,'S2','O2',1);foreign.status.status='Filled';m.refreshed.mockResolvedValue([foreign]);
 await bracket.reconcileBracket(old.id);expect(planOf(old.id).filled).toBe(0);expect(planOf(old.id).entryClosed).toBe(false);
 m.refreshed.mockResolvedValue([r34Trade(lot,'S1','O1',1),r34Trade(lot,'S1','O1',1,'other-raw')]);
 await bracket.reconcileBracket(old.id);expect(planOf(old.id).filled).toBe(0);expect(planOf(old.id).issues.some(i=>i.code==='lookup-failed')).toBe(true);
});
it.each(r34Lots)('r34 %s buffered report needs matching identity and current context',async(lot)=>{
 await boot();m.cached.mockResolvedValue([]);await emit(r34Deal(lot,'S1','O1'));await emit(r34Deal(lot,'S2','O2'));
 const p=await bracket.registerBracket(r34Spec(lot,'S2','O2'));expect(p.filled).toBe(1);
 m.status='down';m.statusChanged.forEach(cb=>cb());await flush();m.status='live';m.statusChanged.forEach(cb=>cb());await flush();
 await expect(bracket.registerBracket(r34Spec(lot,'S2','O2'),await bracket.ensureBracketHost({orderLot:lot}))).rejects.toThrow('連線代次');
 expect(bracket.getDisplayBrackets().filter(p=>p.registrationPending)).toHaveLength(1);
 await emit(r34Deal(lot,'S2','O2','2'));expect(planOf(p.id).filled).toBe(1);expect(m.place).not.toHaveBeenCalled();
});
it.each(r34Lots)('r34 %s reload cannot bind old stable identity to foreign raw-ID listing or late report',async(lot)=>{
 await boot();m.cached.mockResolvedValue([]);const old=await bracket.registerBracket(r34Spec(lot,'S1','O1'));await flush();
 m.cached.mockResolvedValue([r34Trade(lot,'S2','O2',1)]);await boot({keepStore:true});
 await emit(r34Deal(lot,'S1','O1'));expect(planOf(old.id).filled).toBe(0);
 m.refreshed.mockResolvedValue([r34Trade(lot,'S1','O1',1,'rebound')]);await bracket.reconcileBracket(old.id);
 expect(planOf(old.id).filled).toBe(1);expect(planOf(old.id).currentOrderId).toBe('rebound');
 await emit(r34Deal(lot,'S2','O2','2'));expect(planOf(old.id).filled).toBe(1);expect(m.place).not.toHaveBeenCalled();
});
it.each(r34Lots)('r34 %s initial missing stable identity stays durable pending without creating a bracket',async(lot)=>{
 await boot();const admission=await bracket.ensureBracketHost({orderLot:lot});
 await expect(bracket.registerBracket(r34Spec(lot,'',''),admission)).rejects.toThrow('身分');
 expect(bracket.getBrackets()).toHaveLength(0);expect(bracket.getDisplayBrackets().filter(p=>p.registrationPending)).toHaveLength(1);
 await boot({keepStore:true});expect(bracket.getDisplayBrackets().filter(p=>p.registrationPending)).toHaveLength(1);expect(m.place).not.toHaveBeenCalled();
});
it('r34 wrong stable cancel/order terminal never closes an entry',async()=>{
 await boot();m.cached.mockResolvedValue([]);const p=await bracket.registerBracket(spec(F1));
 const raw=fNew1!.raw as {state:string;data:Record<string,Record<string,unknown>>};const body=raw.data[raw.state]!;
 const report=normalizeOrderEvent({...raw,data:{[raw.state]:{...body,order:{...(body.order as object),seqno:'foreign'},operation:{op_type:'Cancel',op_code:'00'}}}})!;
 await emit(report);expect(planOf(p.id).entryClosed).toBe(false);
});
it('r34 foreign listing blocks cancel before any mock dispatch',async()=>{
 await boot();m.cached.mockResolvedValue([]);const p=await bracket.registerBracket(r34Spec('Common','S1','O1'));
 await emit(r34Deal('Common','S1','O1'));await tick(47000);m.cached.mockResolvedValue([r34Trade('Common','S2','O2',1)]);
 await expect(bracket.cancelRemainingEntry(planOf(p.id))).rejects.toThrow('未送出刪單');expect(m.cancel).not.toHaveBeenCalled();
 expect(planOf(p.id).entryCancel).toBeUndefined();expect(planOf(p.id).filled).toBe(1);
});

it('r34 a foreign stable exit report with reused raw ID cannot clear bracket risk',async()=>{
    await boot();const plan=await bracket.registerBracket(spec(F1));await emit(fDeal1!);await emit(fDeal2!);await tick(47000);
    await emit(edit(fCoverDeal1!,{trade_id:'exit-1',seqno:'FOREIGN-EXIT',ordno:'FOREIGN-ORD'}));
    expect(planOf(plan.id).exit?.filled).toBe(0);
});

it('r34 foreign exit listing cannot clear risk but a unique current stable listing rebinds without resend',async()=>{
 await boot();const p=await bracket.registerBracket(spec(F1));await emit(fDeal1!);await emit(fDeal2!);await tick(47000);
 const foreign=cacheTrade('exit-1',F1,[{seq:'E1',quantity:2}]);foreign.order.action='Sell';foreign.order.seqno='FOREIGN';foreign.status.status='Filled';
 m.refreshed.mockResolvedValue([foreign]);await bracket.reconcileBracket(p.id);expect(planOf(p.id).exit?.filled).toBe(0);
 const own={...foreign,order:{...foreign.order,id:'changed-exit',seqno:'exit-1',ordno:'o'}};
 m.refreshed.mockResolvedValue([own, {...own,order:{...own.order,id:'ambiguous'}}]);await bracket.reconcileBracket(p.id);
 expect(planOf(p.id).exit?.filled).toBe(0);
 m.refreshed.mockResolvedValue([own]);await bracket.reconcileBracket(p.id);expect(planOf(p.id).exit).toMatchObject({filled:2,status:'filled'});
 expect(m.place).toHaveBeenCalledTimes(1);
});
it('r34 both real window modules acknowledge fixed TS owner despite different local context tokens',async()=>{
 const channels: Channel[]=[];
 class Channel {
  handlers: ((e:{data:unknown})=>void)[]=[];
  constructor(public name:string){channels.push(this);}
  addEventListener(_name:string,cb:(e:{data:unknown})=>void){this.handlers.push(cb);}
  removeEventListener(_name:string,cb:(e:{data:unknown})=>void){this.handlers=this.handlers.filter(x=>x!==cb);}
  close(){this.handlers=[];}
  postMessage(data:unknown){queueMicrotask(()=>channels.filter(c=>c!==this&&c.name===this.name).forEach(c=>c.handlers.forEach(cb=>cb({data}))));}
 }
 vi.stubGlobal('BroadcastChannel',Channel);await boot();const mainBracket=bracket;
 vi.resetModules();vi.stubGlobal('location',{search:'?popout=chart'});
 const popout=await import('./bracket');await flush();const admission=await popout.ensureBracketHost();
 const result=await popout.registerBracket(spec(F1),admission);await flush();
 expect(result.seqno).toBe('fixture-f1');expect(mainBracket.getBrackets()).toHaveLength(1);
 expect(popout.getDisplayBrackets().filter(p=>p.registrationPending)).toHaveLength(0);expect(m.place).not.toHaveBeenCalled();
});
it('r34 legacy bracket exit without stable identity survives reload as unknown and is never resent',async()=>{
 await boot();const p=await bracket.registerBracket(spec(F1));await emit(fDeal1!);await tick(47000);
 const rows=JSON.parse(store.get('sj-pro-trigger-exits')!);delete rows[0].seqno;delete rows[0].ordno;delete rows[0].reportContext;
 store.set('sj-pro-trigger-exits',JSON.stringify(rows));m.cached.mockResolvedValue([]);await boot({keepStore:true});
 await emit(edit(fCoverDeal1!,{trade_id:'exit-1',seqno:'FOREIGN',ordno:'OTHER'}));
 expect(engine.getExits()[0]).toMatchObject({status:'unknown',filled:0});expect(planOf(p.id).exit?.status).toBe('unknown');
 await tick(47000);expect(m.place).toHaveBeenCalledTimes(1);
});

it.each(['quantity','action','orderLot'] as const)('r34 same stable identity with contradictory %s is pending instead of a second bracket',async(field)=>{
 await boot();m.cached.mockResolvedValue([]);const entry=r34Spec('Common','S1','O1');await bracket.registerBracket(entry);
 const changed: import('./bracket').BracketSpec = {...entry,...(field==='quantity'?{quantity:1}:field==='action'?{action:'Sell' as const}:{orderLot:'IntradayOdd' as const})};
 await expect(bracket.registerBracket(changed,await bracket.ensureBracketHost({orderLot:changed.orderLot}))).rejects.toThrow();
 expect(bracket.getBrackets()).toHaveLength(1);expect(bracket.getDisplayBrackets().filter(p=>p.registrationPending)).toHaveLength(1);expect(m.place).not.toHaveBeenCalled();
});
it.each(r34Lots)('r34 %s stable buffered fill survives a raw ID change before entry HTTP returns',async(lot)=>{
 await boot();m.cached.mockResolvedValue([]);await emit(r34Deal(lot,'S1','O1','1','report-raw'));
 const p=await bracket.registerBracket(r34Spec(lot,'S1','O1','response-raw'));expect(p.filled).toBe(1);expect(m.place).not.toHaveBeenCalled();
});
