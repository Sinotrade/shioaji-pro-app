import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from './types/portfolio';
import type { AccountedTrade } from './types/order';
const m = vi.hoisted(() => ({ base: 'fixture', rows: [] as AccountedTrade[], accounts: [] as Account[], post: vi.fn(), baseline: true }));
vi.mock('./runtime', async original => ({ ...await original<object>(), getApiBase: () => m.base }));
vi.mock('./api', () => ({ apiPost: m.post, apiGet: vi.fn(), apiPut: vi.fn(), apiDelete: vi.fn() }));
vi.mock('./account-store', () => ({ accountFor: vi.fn(() => { throw new Error('no selected fallback'); }), getAccountState: () => ({ accounts: m.accounts }) }));
vi.mock('./trading-state', () => ({ getTradingState: () => ({ trades: m.rows }), hasOrdersBaseline: () => m.baseline }));
import { cancelOrder, fetchTradeCacheHealth, fetchTrades, updateOrderPrice, updateOrderQty } from './shioaji';
const account: Account = { account_type: 'F', broker_id: 'fixture', account_id: 'owner', signed: true, username: '', person_id: '' };
const row = (): AccountedTrade => ({ account, contract: { code: 'QEFI6', security_type: 'FUT', exchange: 'TAIFEX', target_code: null }, order: { id: 'fixture', action: 'Buy', price: 489, seqno: 'seq', ordno: 'ord', quantity: 3, account }, status: { status: 'Submitted', id: 'fixture', status_code: '00', msg: '', order_ts: 1700000000, order_quantity: 3, modified_price: 0, deals: [], deal_quantity: 0, cancel_quantity: 0 } } as AccountedTrade);
beforeEach(() => {
    vi.clearAllMocks(); m.baseline = true; m.base = 'fixture'; m.accounts = [account]; m.rows = [row()];
    m.post.mockImplementation(async () => row());
    vi.stubGlobal('navigator', { locks: { request: (_n: string, _o: unknown, cb: (v: object) => unknown) => cb({}) } });
});
afterEach(() => vi.unstubAllGlobals());

// Shioaji#235 was fixed in 1.7.6: futures change/cancel no longer runs the
// temporary same-account update_status first. Verified on a 1.7.6 simulation
// sidecar (UpdatePrice, UpdateQty and Cancel succeeded with no trades call).
it.each([
    ['cancel', () => cancelOrder('fixture'), '/api/v1/order/cancel_order', { trade_id: 'fixture' }],
    ['price', () => updateOrderPrice('fixture', 489), '/api/v1/order/update_price', { trade_id: 'fixture', price: 489 }],
    ['quantity', () => updateOrderQty('fixture', 1), '/api/v1/order/update_qty', { trade_id: 'fixture', quantity: 1 }],
] as const)('sends futures %s directly without an update_status preflight', async (_name, call, path, body) => {
    await call();
    expect(m.post).toHaveBeenCalledTimes(1);
    expect(m.post.mock.calls[0]![0]).toBe(path);
    expect(m.post.mock.calls[0]![1]).toEqual(body);
    expect(m.post.mock.calls.some(c => c[0] === '/api/v1/order/trades')).toBe(false);
});
it('sends stock mutations directly as before', async () => {
    const stock = { ...account, account_type: 'S' }; m.accounts = [stock];
    m.rows = [{ ...row(), account: stock, order: { ...row().order, account: stock }, contract: { code: '2330', security_type: 'STK', exchange: 'TSE', target_code: null } } as AccountedTrade];
    await cancelOrder('fixture');
    expect(m.post).toHaveBeenCalledTimes(1); expect(m.post.mock.calls[0]![0]).toBe('/api/v1/order/cancel_order');
});
it('does not guess an unknown trade or account', async () => { m.rows = []; await expect(cancelOrder('fixture')).rejects.toMatchObject({ mutationNotStarted: true }); expect(m.post).not.toHaveBeenCalled(); });
it('refuses an ambiguous local order', async () => { m.rows = [row(), { ...row(), account: { ...account, account_id: 'other' } }]; await expect(cancelOrder('fixture')).rejects.toMatchObject({ mutationNotStarted: true }); expect(m.post).not.toHaveBeenCalled(); });
it('rejects contradictory embedded account identity', async () => {
    m.rows = [{ ...row(), order: { ...row().order, account: { ...account, account_id: 'other' } } }];
    await expect(cancelOrder('fixture')).rejects.toThrow('矛盾'); expect(m.post).not.toHaveBeenCalled();
});
it('refuses an unsigned or unknown owner account', async () => {
    m.accounts = [{ ...account, signed: false }];
    await expect(updateOrderPrice('fixture', 490)).rejects.toMatchObject({ mutationNotStarted: true }); expect(m.post).not.toHaveBeenCalled();
});
it('refuses a product whose market does not match the owner account', async () => {
    m.rows = [{ ...row(), contract: { code: '2330', security_type: 'STK', exchange: 'TSE', target_code: null } } as AccountedTrade];
    await expect(cancelOrder('fixture')).rejects.toThrow('不符'); expect(m.post).not.toHaveBeenCalled();
});
it('refuses when the server switched before dispatch', async () => {
    m.rows = new Proxy([row()], { get(target, key, receiver) { if (key === 'filter') m.base = 'other'; return Reflect.get(target, key, receiver); } });
    await expect(cancelOrder('fixture')).rejects.toMatchObject({ mutationNotStarted: true }); expect(m.post).not.toHaveBeenCalled();
});
it('holds the local gate while a mutation is in flight and never queues a second one', async () => {
    let resolve!: (v: AccountedTrade) => void; m.post.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const first = cancelOrder('fixture'); await vi.waitFor(() => expect(m.post).toHaveBeenCalledTimes(1));
    await expect(updateOrderQty('fixture', 1)).rejects.toThrow('已有'); resolve(row()); await first; expect(m.post).toHaveBeenCalledTimes(1);
});

it('sends refresh only when explicitly chosen and keeps the server default otherwise', async () => {
    m.post.mockResolvedValue([]);
    await fetchTrades('F', account);
    await fetchTrades('F', account, { refresh: false });
    await fetchTrades('S', { broker_id: 'b', account_id: 'a' }, { refresh: true });
    expect(m.post.mock.calls.map(c => c[1])).toEqual([
        { account_type: 'F', broker_id: 'fixture', account_id: 'owner' },
        { account_type: 'F', broker_id: 'fixture', account_id: 'owner', refresh: false },
        { account_type: 'S', broker_id: 'b', account_id: 'a', refresh: true },
    ]);
});
it('reads trade cache health for an explicit account', async () => {
    m.post.mockResolvedValue({ state: 'Healthy', reasons: [] });
    await expect(fetchTradeCacheHealth('F', account)).resolves.toEqual({ state: 'Healthy', reasons: [] });
    expect(m.post).toHaveBeenCalledWith('/api/v1/order/trade_cache_health', { account_type: 'F', broker_id: 'fixture', account_id: 'owner' });
});

// Review finding: after a sidecar restart outside the App the new process does
// not know the old trade_id. Without a baseline on this instance, reconcile
// that one account authoritatively once and re-resolve the id by identifiers.
describe('mutation without an authoritative baseline on this sidecar', () => {
    const restarted = (id = 'new-id', patch: Partial<AccountedTrade['order']> = {}, status: Partial<AccountedTrade['status']> = {}) =>
        ({ ...row(), order: { ...row().order, id, ...patch }, status: { ...row().status, id, ...status } });
    it.each([
        ['cancel', () => cancelOrder('fixture'), '/api/v1/order/cancel_order'],
        ['price', () => updateOrderPrice('fixture', 490), '/api/v1/order/update_price'],
        ['quantity', () => updateOrderQty('fixture', 1), '/api/v1/order/update_qty'],
    ] as const)('runs one refresh:true for the owner account and sends the re-resolved id: %s', async (_n, call, path) => {
        m.baseline = false;
        m.post.mockImplementation(async (p: string) => p === '/api/v1/order/trades' ? [restarted()] : row());
        await call();
        expect(m.post.mock.calls.map(c => c[0])).toEqual(['/api/v1/order/trades', path]);
        expect(m.post.mock.calls[0]![1]).toEqual({ account_type: 'F', broker_id: 'fixture', account_id: 'owner', refresh: true });
        expect(m.post.mock.calls[1]![1].trade_id).toBe('new-id');
    });
    it.each([
        ['missing', () => []],
        ['ambiguous', () => [restarted('a'), restarted('b')]],
        ['other action', () => [restarted('x', { action: 'Sell' })]],
        ['no longer working', () => [restarted('x', {}, { status: 'Cancelled', cancel_quantity: 3 })]],
        ['other account', () => [restarted('x', { account: { ...account, account_id: 'other' } })]],
        ['query failure', () => { throw new Error('offline'); }],
    ] as const)('refuses before dispatch when the reconcile is %s', async (_n, rows) => {
        m.baseline = false;
        m.post.mockImplementation(async (p: string) => p === '/api/v1/order/trades' ? rows() : row());
        await expect(cancelOrder('fixture')).rejects.toMatchObject({ mutationNotStarted: true });
        expect(m.post.mock.calls.map(c => c[0])).toEqual(['/api/v1/order/trades']);
    });
    it('keeps the local identity checks before any query', async () => {
        m.baseline = false; m.accounts = [{ ...account, signed: false }];
        await expect(cancelOrder('fixture')).rejects.toMatchObject({ mutationNotStarted: true });
        expect(m.post).not.toHaveBeenCalled();
    });
});
