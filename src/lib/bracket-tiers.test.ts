// #226 panel brackets: 分批停利 tiers, stop / take from the actual fill
// price, 移動停損 and 保本. All broker I/O is mocked: no order is sent.
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
    onAnyBidAsk: (cb: (b: unknown) => void) => { (m as Record<string, unknown>).bidask = cb; return () => undefined; },
    onStreamEvent: (name: string, cb: () => void) => { if (name === 'heartbeat') m.heartbeat = cb; return () => undefined; },
}));
vi.mock('./account-store', () => ({ getAccountState: () => ({ accounts: m.accounts, selectedFutures: m.accounts.find(a => a.account_type === 'F') ?? null,
    selectedStock: m.accounts.find(a => a.account_type === 'S') ?? null }) }));
vi.mock('./trade', () => ({ notify: m.notify, placeQuickOrder: m.place }));
vi.mock('./contracts-cache', () => ({ ensureContract: m.ensure, getCachedContract: () => ({ ...TXF_C, tick: 1 }) }));
const TXF_C = vi.hoisted(() => ({ code: 'TXFR1', target_code: 'TXFJ6', security_type: 'FUT', exchange: 'TAIFEX' }));
vi.mock('./quote-ownership', () => ({ retainQuote: () => () => undefined }));
vi.mock('./trading-state', () => ({ tradeCacheContinuous: () => m.continuous, checkTradeCacheHealth: m.healthCheck, getTradingState: () => ({ positions: m.positions.rows,
    queries: { positions: { updatedAt: m.positions.updatedAt, needsReconcile: m.positions.needsReconcile, error: null } } }) }));
vi.mock('./shioaji', () => ({
    fetchTrades: (_type: string, account: unknown, opts: { refresh: boolean }) => opts.refresh ? m.refreshed(account) : m.cached(account),
    fetchTradeCacheHealth: (_type: string, account: unknown) => m.health(account),
    cancelOrder: m.cancel,
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
        return { order: { id: `exit-${++n}` }, status: { status: 'PendingSubmit' } };
    });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });


const PLAN = (over: Partial<import('./trigger-engine').BracketEntryPlan> = {}) => ({
    tiers: [{ quantity: 1, takeTicks: 30 }, { quantity: 1, takeTicks: null }],
    stopTicks: 40,
    trail: { activateTicks: 20, distanceTicks: 15, stepTicks: 5 },
    breakeven: { afterTier: 1, offsetTicks: 0 },
    ...over,
});

async function tiered(planOver: Partial<import('./trigger-engine').BracketEntryPlan> = {}) {
    await boot();
    const specs = bracket.tierSpecs({ env: m.env!, account: { account_type: 'F', broker_id: F1.broker_id, account_id: F1.account_id },
        orderId: 'fixture-f1', seqno: 'fixture-f1', quoteCode: 'TXFR1', orderCode: 'TXFJ6', securityType: 'FUT', exchange: 'TAIFEX',
        action: 'Buy' }, PLAN(planOver));
    for (const s of specs) await bracket.registerBracket(s);
    await flush();
    return bracket.getBrackets().slice().sort((a, b) => a.tier!.index - b.tier!.index);
}
const legsOf = (id: string) => engine.getTriggers().filter(t => t.bracketId === id).map(t => [t.kind, t.price, t.quantity]);

describe('panel brackets (#226)', () => {
    it('tiers protect fills in order; prices come from the fill price, not the order', async () => {
        const [t0, t1] = await tiered();
        expect(legsOf(t0!.id)).toEqual([]);
        await emit(edit(fDeal1!, { price: 48150 }));
        // tier 1 takes the first lot: stop −40 ticks, take +30; tier 2 still waits
        expect(legsOf(t0!.id)).toEqual([['stop', 48110, 1], ['take', 48180, 1]]);
        expect(legsOf(t1!.id)).toEqual([]);
        await emit(edit(fDeal2!, { price: 48160 }));
        // tier 2 (移動停損, no take): stop from the average fill 48,155
        expect(legsOf(t1!.id)).toEqual([['stop', 48115, 1]]);
        expect(bracket.getBrackets().find(p => p.id === t0!.id)!.base).toBe(48150); // frozen
    });

    it('a partial fill never protects more than what filled (one lot, two tiers)', async () => {
        const [t0, t1] = await tiered({ tiers: [{ quantity: 1, takeTicks: 30 }, { quantity: 1, takeTicks: 80 }], trail: null });
        await emit(edit(fDeal1!, { price: 48150 }));
        const total = [...legsOf(t0!.id), ...legsOf(t1!.id)].filter(l => l[0] === 'stop').reduce((s, l) => s + (l[2] as number), 0);
        expect(total).toBe(1);
    });

    it('移動停損 moves the stop only up and fires once when crossed', async () => {
        const [, t1] = await tiered({ tiers: [{ quantity: 2, takeTicks: null }], breakeven: null });
        await emit(edit(fDeal1!, { price: 48000 }));
        await emit(edit(fDeal2!, { price: 48000 }));
        const plan = bracket.getBrackets()[0]!;
        void t1;
        expect(legsOf(plan.id)).toEqual([['stop', 47960, 2]]);
        await tick(48020); // +20: active → 48,005
        expect(legsOf(plan.id)).toEqual([['stop', 48005, 2]]);
        await tick(48050); // jump → 48,035
        await tick(48040);
        expect(legsOf(plan.id)).toEqual([['stop', 48035, 2]]);
        expect(m.place).not.toHaveBeenCalled();
        await tick(48034);
        expect(m.place).toHaveBeenCalledTimes(1);
        expect(m.place.mock.calls[0]![3]).toBe(2);
        await tick(48000);
        expect(m.place).toHaveBeenCalledTimes(1);
    });

    it('保本: tier 1 takes profit → the other tier\'s stop moves to cost, never back', async () => {
        const [t0, t1] = await tiered();
        await emit(edit(fDeal1!, { price: 48150 }));
        await emit(edit(fDeal2!, { price: 48150 }));
        expect(legsOf(t1!.id)).toEqual([['stop', 48110, 1]]);
        await tick(48180); // tier 1 take fires (the trail of tier 2 activates at +20 → 48,165)
        expect(m.place).toHaveBeenCalledTimes(1);
        expect(legsOf(t1!.id)).toEqual([['stop', 48165, 1]]);
        const rec = engine.getExits().find(e => e.bracketId === t0!.id)!;
        engine.applyExitTrade({ order: { id: rec.orderId, account: null }, status: { status: 'Filled', deal_quantity: 1, cancel_quantity: 0,
            deals: [{ seq: 'x1', quantity: 1, price: 48180, ts: 1 }] } } as never);
        await flush();
        // cost 48,150 is below the trailed stop 48,165: the tighter stop stays
        expect(legsOf(t1!.id)).toEqual([['stop', 48165, 1]]);
    });

    it('保本 without a trail moves the stop up to cost + N', async () => {
        const [t0, t1] = await tiered({ tiers: [{ quantity: 1, takeTicks: 30 }, { quantity: 1, takeTicks: 80 }], trail: null,
            breakeven: { afterTier: 1, offsetTicks: 2 } });
        await emit(edit(fDeal1!, { price: 48150 }));
        await emit(edit(fDeal2!, { price: 48150 }));
        await tick(48180);
        const rec = engine.getExits().find(e => e.bracketId === t0!.id)!;
        engine.applyExitTrade({ order: { id: rec.orderId, account: null }, status: { status: 'Filled', deal_quantity: 1, cancel_quantity: 0,
            deals: [{ seq: 'x1', quantity: 1, price: 48180, ts: 1 }] } } as never);
        await flush();
        expect(legsOf(t1!.id)).toEqual([['stop', 48152, 1], ['take', 48230, 1]]);
        expect(bracket.getBrackets().find(p => p.id === t1!.id)!.stopPrice).toBe(48152);
    });

    it('rules are checked before anything is sent', () => {
        return import('./bracket').then(b => {
            expect(b.bracketPlanProblem(PLAN({ tiers: [{ quantity: 1, takeTicks: null }], trail: null }))).toContain('移動停損');
            expect(b.bracketPlanProblem(PLAN({ stopTicks: 0 }))).toContain('停損');
            expect(b.bracketPlanProblem(PLAN({ tiers: [1, 2, 3, 4].map(() => ({ quantity: 1, takeTicks: 10 })) }))).toContain('3 層');
            expect(b.bracketPlanProblem(PLAN({ breakeven: { afterTier: 2, offsetTicks: 0 } }))).toContain('保本');
            expect(b.bracketPlanProblem(PLAN())).toBeNull();
        });
    });
});

describe('panel brackets — review fixes (#226)', () => {
    it('a basis taken from the order price is replaced by the real fill price', async () => {
        await boot();
        const [spec] = bracket.tierSpecs({ env: m.env!, account: { account_type: 'F', broker_id: F1.broker_id, account_id: F1.account_id },
            orderId: 'fixture-f1', seqno: 'fixture-f1', quoteCode: 'TXFR1', orderCode: 'TXFJ6', securityType: 'FUT', exchange: 'TAIFEX',
            action: 'Buy', refPrice: 48200 }, PLAN({ tiers: [{ quantity: 2, takeTicks: 30 }], trail: null, breakeven: null }));
        await bracket.registerBracket(spec!);
        await flush();
        await emit(edit(fDeal1!, { price: 0 })); // a fill report without a price
        const id = bracket.getBrackets()[0]!.id;
        expect(legsOf(id)).toEqual([['stop', 48160, 1], ['take', 48230, 1]]);
        await emit(edit(fDeal2!, { price: 48150 }));
        // take follows the real fill; the stop is never loosened by the re-price (kept at the tighter 48,160)
        expect(legsOf(id)).toEqual([['stop', 48160, 2], ['take', 48180, 2]]);
        expect(bracket.getBrackets()[0]!.baseProvisional).toBe(false);
    });

    it('保本 due before a tier had its prices applies once it is priced', async () => {
        const [t0, t1] = await tiered({ tiers: [{ quantity: 1, takeTicks: 30 }, { quantity: 1, takeTicks: 80 }], trail: null,
            breakeven: { afterTier: 1, offsetTicks: 0 } });
        await emit(edit(fDeal1!, { price: 48150 }));
        await tick(48180); // tier 1 takes profit before tier 2 is filled
        const rec = engine.getExits().find(e => e.bracketId === t0!.id)!;
        engine.applyExitTrade({ order: { id: rec.orderId, account: null }, status: { status: 'Filled', deal_quantity: 1, cancel_quantity: 0,
            deals: [{ seq: 'x1', quantity: 1, price: 48180, ts: 1 }] } } as never);
        await flush();
        await emit(edit(fDeal2!, { price: 48170 }));
        // basis: the average fill 48,160; 保本 puts the stop at cost (instead of −40 ticks)
        expect(legsOf(t1!.id)).toEqual([['stop', 48160, 1], ['take', 48240, 1]]);
    });

    it('while trailing, an edit can only tighten the stop; the trail keeps its state', async () => {
        await tiered({ tiers: [{ quantity: 2, takeTicks: null }], breakeven: null });
        await emit(edit(fDeal1!, { price: 48000 }));
        await emit(edit(fDeal2!, { price: 48000 }));
        const plan = bracket.getBrackets()[0]!;
        await tick(48050); // trail active: stop 48,035
        await expect(bracket.modifyBracket(plan.id, 48005, null)).rejects.toThrow('只能收緊');
        await bracket.modifyBracket(plan.id, 48040, null);
        const stop = engine.getTriggers().find(t => t.bracketId === plan.id && t.kind === 'stop')!;
        expect(stop.price).toBe(48040);
        expect(stop.trail?.active).toBe(true);
    });
});

describe('panel brackets — tick ladder (#226)', () => {
    it('no stop / take while the exchange band table is not loaded (never a guessed tick)', async () => {
        (TXF_C as Record<string, unknown>).tick_rule = 'not-loaded-rule';
        try {
            const [t0] = await tiered({ tiers: [{ quantity: 2, takeTicks: 30 }], trail: null, breakeven: null });
            await emit(edit(fDeal1!, { price: 48150 }));
            expect(legsOf(t0!.id)).toEqual([]);
            const plan = bracket.getBrackets()[0]!;
            expect(plan.base).toBeUndefined();
            expect(plan.issues.at(-1)?.detail).toContain('級距');
        } finally {
            delete (TXF_C as Record<string, unknown>).tick_rule;
        }
    });
});

describe('panel brackets — trailing after a re-price (#226)', () => {
    it('activation is measured from the real fill price once it arrives', async () => {
        await boot();
        const [spec] = bracket.tierSpecs({ env: m.env!, account: { account_type: 'F', broker_id: F1.broker_id, account_id: F1.account_id },
            orderId: 'fixture-f1', seqno: 'fixture-f1', quoteCode: 'TXFR1', orderCode: 'TXFJ6', securityType: 'FUT', exchange: 'TAIFEX',
            action: 'Buy', refPrice: 48000 }, PLAN({ tiers: [{ quantity: 2, takeTicks: null }], breakeven: null }));
        await bracket.registerBracket(spec!);
        await flush();
        await emit(edit(fDeal1!, { price: 0 }));
        await emit(edit(fDeal2!, { price: 48050 }));
        const stop = () => engine.getTriggers().find(t => t.kind === 'stop')!;
        expect(stop().trail?.base).toBe(48050);
        const before = stop().price;
        await tick(48060); // +10 from the real basis: not active yet (activation +20 = 48,070)
        expect(stop().price).toBe(before);
        expect(stop().trail?.active).toBe(false);
        await tick(48070);
        expect(stop().trail?.active).toBe(true);
    });
});
