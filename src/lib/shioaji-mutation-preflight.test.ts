import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from './types/portfolio';
import type { AccountedTrade } from './types/order';
const m = vi.hoisted(() => ({ base: 'fixture', rows: [] as AccountedTrade[], accounts: [] as Account[], post: vi.fn(), trusted: true, baseline: true, lostMark: 0,
    readback: null as null | ((body: Record<string, unknown>) => unknown) }));
vi.mock('./runtime', async original => ({ ...await original<object>(), getApiBase: () => m.base }));
vi.mock('./api', () => ({ apiPost: m.post, apiGet: vi.fn(), apiPut: vi.fn(), apiDelete: vi.fn() }));
vi.mock('./account-store', () => ({ accountFor: vi.fn(() => { throw new Error('no selected fallback'); }), getAccountState: () => ({ accounts: m.accounts }) }));
vi.mock('./trading-state', () => ({ getTradingState: () => ({ trades: m.rows }), cancelCacheTrusted: () => m.trusted, locallyCancelled: () => false, hasOrdersBaseline: () => m.baseline, ordersBaselineLostMark: () => m.lostMark }));
import { cancelOrder, cancelOrders, fetchTradeCacheHealth, fetchTrades, updateOrderPrice, updateOrderQty } from './shioaji';
import { beginServerInfoRequest, observeServerInfo } from './server-info-store';
const account: Account = { account_type: 'F', broker_id: 'fixture', account_id: 'owner', signed: true, username: '', person_id: '' };
const row = (): AccountedTrade => ({ account, contract: { code: 'QEFI6', security_type: 'FUT', exchange: 'TAIFEX', target_code: null }, order: { id: 'fixture', action: 'Buy', price: 489, seqno: 'seq', ordno: 'ord', quantity: 3, account }, status: { status: 'Submitted', id: 'fixture', status_code: '00', msg: '', order_ts: 1700000000, order_quantity: 3, modified_price: 0, deals: [], deal_quantity: 0, cancel_quantity: 0 } } as AccountedTrade);
beforeEach(async () => {
    // Baseline lost "now": no earlier authoritative read may be shared.
    m.lostMark = (await import('./cancel-verification')).readMark();
    vi.clearAllMocks(); m.base = `fixture-${Math.random()}`; m.accounts = [account]; m.rows = [row()]; m.trusted = true; m.baseline = true;
    // cancel_order answers like 1.7.6 (still Submitted); the cache read-back
    // shows the projected Cancel for the same order and account.
    m.readback = () => [{ ...row(), account: undefined, status: { ...row().status, status: 'Cancelled', cancel_quantity: 3, order_quantity: 0 } }];
    m.post.mockImplementation(async (path: string, body: Record<string, unknown>) => path === '/api/v1/order/trades' ? m.readback!(body)
        : path === '/api/v1/order/trade_cache_health' ? { state: 'Healthy', reasons: [] } : row());
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
    expect(m.post.mock.calls[0]![0]).toBe(path);
    expect(m.post.mock.calls[0]![1]).toEqual(body);
    // No broker reconciliation before the request; a cancel only reads the
    // sidecar cache afterwards to confirm it.
    expect(m.post.mock.calls.some(c => c[0] === '/api/v1/order/trades' && c[1].refresh !== false)).toBe(false);
    if (path !== '/api/v1/order/cancel_order') expect(m.post).toHaveBeenCalledTimes(1);
});
it('refuses a price update on an odd-lot order before sending; reduce quantity still goes out (#204)', async () => {
    const stock = { ...account, account_type: 'S' }; m.accounts = [stock];
    for (const lot of ['IntradayOdd', 'Odd']) {
        m.post.mockClear();
        m.rows = [{ ...row(), account: stock, order: { ...row().order, account: stock, order_lot: lot, quantity: 300 }, contract: { code: '2330', security_type: 'STK', exchange: 'TSE', target_code: null } } as AccountedTrade];
        await expect(updateOrderPrice('fixture', 490)).rejects.toMatchObject({ mutationNotStarted: true, message: '零股委託不能改價，只能減量或刪單' });
        expect(m.post.mock.calls.some(c => c[0] === '/api/v1/order/update_price')).toBe(false);
        await updateOrderQty('fixture', 100);
        expect(m.post.mock.calls.some(c => c[0] === '/api/v1/order/update_qty')).toBe(true);
    }
});
it('sends stock mutations directly as before', async () => {
    const stock = { ...account, account_type: 'S' }; m.accounts = [stock];
    m.rows = [{ ...row(), account: stock, order: { ...row().order, account: stock }, contract: { code: '2330', security_type: 'STK', exchange: 'TSE', target_code: null } } as AccountedTrade];
    m.readback = () => [{ ...m.rows[0]!, status: { ...m.rows[0]!.status, status: 'Cancelled', cancel_quantity: 3 } }];
    await cancelOrder('fixture');
    expect(m.post.mock.calls.map(c => c[0])).toEqual(['/api/v1/order/cancel_order', '/api/v1/order/trades']);
    expect(m.post.mock.calls[1]![1]).toMatchObject({ account_type: 'S', refresh: false });
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
    await expect(updateOrderQty('fixture', 1)).rejects.toThrow('已有'); resolve(row()); await first;
    expect(m.post.mock.calls.filter(c => c[0] !== '/api/v1/order/trades').map(c => c[0])).toEqual(['/api/v1/order/cancel_order']);
});

describe('cancel confirmation (#120 / #116)', () => {
    // Shared read-backs are scoped by API base; isolate each case.
    beforeEach(() => { m.base = `fixture-${Math.random()}`; });
    afterEach(() => vi.useRealTimers());
    it('resolves with the read-back Cancelled row of the same account, read from the cache only', async () => {
        const { onTradeMutation } = await import('./trade-mutations');
        const events: { phase: string; confirmed?: boolean }[] = [];
        const off = onTradeMutation(e => events.push(e));
        try {
            const trade = await cancelOrder('fixture');
            expect(trade.status).toMatchObject({ status: 'Cancelled', cancel_quantity: 3 });
            expect(trade).toMatchObject({ account });
            expect(m.post.mock.calls.map(c => c[0])).toEqual(['/api/v1/order/cancel_order', '/api/v1/order/trades']);
            expect(m.post.mock.calls[1]![1]).toEqual({ account_type: 'F', broker_id: 'fixture', account_id: 'owner', refresh: false });
            expect(events.map(e => [e.phase, e.confirmed])).toEqual([['begin', undefined], ['settled', true]]);
        } finally { off(); }
    });
    it('rejects CANCEL_UNCONFIRMED after one refresh:true when the order stays Submitted, and never resends', async () => {
        vi.useFakeTimers();
        m.readback = () => [row()];
        const settled = cancelOrder('fixture').catch(e => e);
        await vi.advanceTimersByTimeAsync(5_000);
        const error = await settled;
        expect(error).toMatchObject({ code: 'CANCEL_UNCONFIRMED', mutationOutcomeUnknown: true });
        expect(error).not.toHaveProperty('mutationNotStarted');
        const paths = m.post.mock.calls.map(c => [c[0], c[1].refresh]);
        expect(paths.filter(([p]) => p === '/api/v1/order/cancel_order')).toHaveLength(1);
        expect(paths.filter(([p, r]) => p === '/api/v1/order/trades' && r === true)).toHaveLength(1);
        expect(paths.filter(([p]) => p === '/api/v1/order/trade_cache_health')).toHaveLength(1);
    });
    it('goes straight to one refresh:true read when the cache baseline is not continuous', async () => {
        vi.useFakeTimers();
        m.trusted = false;
        const settled = cancelOrder('fixture');
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(settled).resolves.toMatchObject({ status: { status: 'Cancelled' } });
        const reads = m.post.mock.calls.filter(c => c[0] === '/api/v1/order/trades').map(c => c[1].refresh);
        expect(reads).toEqual([true]);
        expect(m.post.mock.calls.some(c => c[0] === '/api/v1/order/trade_cache_health')).toBe(false);
    });
    it('a batch of 30 unconfirmed cancels spends at most one refresh:true for the account', async () => {
        vi.useFakeTimers();
        const ids = Array.from({ length: 30 }, (_, i) => `b${i}`);
        m.rows = ids.map(id => ({ ...row(), order: { ...row().order, id }, status: { ...row().status, id } }));
        m.readback = () => m.rows.map(r => ({ ...r, account: undefined }));
        const settled = Promise.allSettled(ids.map(id => cancelOrder(id)));
        await vi.advanceTimersByTimeAsync(10_000);
        const results = await settled;
        expect(results.every(r => r.status === 'rejected' && (r.reason as { code?: string }).code === 'CANCEL_UNCONFIRMED')).toBe(true);
        const posts = m.post.mock.calls.map(c => [c[0], c[1].refresh]);
        expect(posts.filter(([p]) => p === '/api/v1/order/cancel_order')).toHaveLength(30);
        expect(posts.filter(([p, r]) => p === '/api/v1/order/trades' && r === true)).toHaveLength(1);
    });
    // Final-gate finding: after a sidecar restart a 4-order batch made 7
    // refresh:true (4 pre-send + 3 confirmation) because the Web Lock and the
    // sidecar serialise the sends, staggering each cancel's read mark.
    describe.each([4, 12, 30])('batch of %i cancels on one account with serialised sends', (n) => {
        const ids = Array.from({ length: n }, (_, i) => `q${i}`);
        const working = () => ids.map(id => ({ ...row(), order: { ...row().order, id, seqno: `s-${id}`, ordno: `o-${id}` }, status: { ...row().status, id } }));
        function serialisedSidecar(confirmRows: () => AccountedTrade[]) {
            let queue = Promise.resolve();
            let sent = 0;
            m.post.mockImplementation(async (path: string, body: Record<string, unknown>) => {
                if (path === '/api/v1/order/cancel_order') {
                    // The sidecar answers cancels one at a time, 150ms each.
                    const turn = queue.then(() => new Promise<void>(r => setTimeout(r, 150)));
                    queue = turn;
                    await turn;
                    sent += 1;
                    return row();
                }
                if (path === '/api/v1/order/trades') return body.refresh === false || sent === n ? confirmRows() : working();
                if (path === '/api/v1/order/trade_cache_health') return { state: 'Healthy', reasons: [] };
                return row();
            });
        }
        const refreshes = () => m.post.mock.calls.filter(c => c[0] === '/api/v1/order/trades' && c[1].refresh === true).length;
        it('no baseline: at most one pre-send and one confirmation refresh:true for the account', async () => {
            vi.useFakeTimers();
            m.baseline = false; m.trusted = false; m.rows = working();
            serialisedSidecar(() => working().map(r => ({ ...r, status: { ...r.status, status: 'Cancelled', cancel_quantity: 3 } })));
            const settled = cancelOrders(ids);
            await vi.advanceTimersByTimeAsync(n * 150 + 20_000);
            const results = await settled;
            expect(results.map(r => r.status)).toEqual(ids.map(() => 'fulfilled'));
            expect(m.post.mock.calls.filter(c => c[0] === '/api/v1/order/cancel_order')).toHaveLength(n);
            expect(refreshes()).toBeLessThanOrEqual(2);
        });
        it('no baseline, never confirmed: still at most two refresh:true, all CANCEL_UNCONFIRMED', async () => {
            vi.useFakeTimers();
            m.baseline = false; m.trusted = false; m.rows = working();
            serialisedSidecar(() => working());
            const settled = cancelOrders(ids);
            await vi.advanceTimersByTimeAsync(n * 150 + 20_000);
            const results = await settled;
            expect(results.every(r => r.status === 'rejected' && (r.reason as { code?: string }).code === 'CANCEL_UNCONFIRMED')).toBe(true);
            expect(refreshes()).toBeLessThanOrEqual(2);
        });
        it('trusted cache: no refresh:true at all', async () => {
            vi.useFakeTimers();
            m.baseline = true; m.trusted = true; m.rows = working();
            serialisedSidecar(() => working().map(r => ({ ...r, status: { ...r.status, status: 'Cancelled', cancel_quantity: 3 } })));
            const settled = cancelOrders(ids);
            await vi.advanceTimersByTimeAsync(n * 150 + 20_000);
            const results = await settled;
            expect(results.map(r => r.status)).toEqual(ids.map(() => 'fulfilled'));
            expect(refreshes()).toBe(0);
        });
    });
    it('keeps a missing order unconfirmed instead of fabricating a cancellation', async () => {
        vi.useFakeTimers();
        m.readback = () => [];
        const settled = cancelOrder('fixture').catch(e => e);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(await settled).toMatchObject({ code: 'CANCEL_UNCONFIRMED', details: { missing: true } });
    });
});

it('sends refresh only when explicitly chosen and keeps the server default otherwise', async () => {
    m.post.mockResolvedValue([]);
    await fetchTrades('F', account);
    await fetchTrades('F', account, { refresh: false });
    m.accounts.push({ ...account, account_type: 'S', broker_id: 'b', account_id: 'a' });
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
    expect(m.post).toHaveBeenCalledWith('/api/v1/order/trade_cache_health', { account_type: 'F', broker_id: 'fixture', account_id: 'owner' }, { beforeDispatch: expect.any(Function) });
});

it('does not reuse a completed authoritative preflight from an earlier mode generation', async () => {
    const mode = (simulation: boolean) => observeServerInfo(beginServerInfoRequest(), { simulation } as import('./shioaji').ServerInfo);
    mode(true);
    m.baseline = false;
    m.readback = () => [row()];
    await updateOrderPrice('fixture', 100);
    mode(false); mode(true);
    await updateOrderPrice('fixture', 101);
    expect(m.post.mock.calls.filter(c => c[0] === '/api/v1/order/trades')).toHaveLength(2);
});

// Review finding: after a sidecar restart outside the App the new process does
// not know the old trade_id. Without a baseline on this instance, reconcile
// that one account authoritatively once and re-resolve the id by identifiers.
describe('mutation without an authoritative baseline on this sidecar', () => {
    const restarted = (id = 'new-id', patch: Partial<AccountedTrade['order']> = {}, status: Partial<AccountedTrade['status']> = {}) =>
        ({ ...row(), order: { ...row().order, id, ...patch }, status: { ...row().status, id, ...status } });
    it('cancel: one refresh:true preflight, sends the re-resolved id, then confirms it with one refresh:true (no cache reads)', async () => {
        vi.useFakeTimers();
        try {
            m.baseline = false;
            let reads = 0;
            m.post.mockImplementation(async (p: string) => p !== '/api/v1/order/trades' ? row()
                : reads++ === 0 ? [restarted()] : [restarted('new-id', {}, { status: 'Cancelled', cancel_quantity: 3, order_quantity: 0 })]);
            const settled = cancelOrder('fixture');
            await vi.advanceTimersByTimeAsync(5_000);
            // Reported under the caller's id; the request used the re-resolved one.
            await expect(settled).resolves.toMatchObject({ order: { id: 'fixture' }, status: { status: 'Cancelled' } });
            expect(m.post.mock.calls.map(c => [c[0], c[1].refresh])).toEqual([
                ['/api/v1/order/trades', true], ['/api/v1/order/cancel_order', undefined], ['/api/v1/order/trades', true]]);
            expect(m.post.mock.calls[1]![1].trade_id).toBe('new-id');
        } finally { vi.useRealTimers(); }
    });
    it.each([
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
    it('after a restart, a rejected pre-send read (429) is not reused: the next cancel reads again and proceeds', async () => {
        m.baseline = false;
        let reads = 0;
        m.post.mockImplementation(async (p: string, body: Record<string, unknown>) => {
            if (p === '/api/v1/order/trades' && body.refresh === true) {
                reads += 1;
                if (reads === 1) throw Object.assign(new Error('429 Too Many Requests'), { status: 429 });
                return reads === 2 ? [restarted()] : [restarted('new-id', {}, { status: 'Cancelled', cancel_quantity: 3 })];
            }
            if (p === '/api/v1/order/trades') return [restarted('new-id', {}, { status: 'Cancelled', cancel_quantity: 3 })];
            return row();
        });
        m.trusted = false;
        await expect(cancelOrder('fixture')).rejects.toMatchObject({ mutationNotStarted: true, message: expect.stringContaining('429') });
        vi.useFakeTimers();
        try {
            const second = cancelOrder('fixture');
            await vi.advanceTimersByTimeAsync(5_000);
            await expect(second).resolves.toMatchObject({ status: { status: 'Cancelled' } });
        } finally { vi.useRealTimers(); }
        expect(m.post.mock.calls.filter(c => c[0] === '/api/v1/order/cancel_order')).toHaveLength(1);
        expect(m.post.mock.calls[m.post.mock.calls.findIndex(c => c[0] === '/api/v1/order/cancel_order')]![1].trade_id).toBe('new-id');
    });
    it('keeps the local identity checks before any query', async () => {
        m.baseline = false; m.accounts = [{ ...account, signed: false }];
        await expect(cancelOrder('fixture')).rejects.toMatchObject({ mutationNotStarted: true });
        expect(m.post).not.toHaveBeenCalled();
    });
});
it('cancel beforeSend runs right before the HTTP send; throwing refuses it (not started)', async () => {
    const dispatch = vi.fn();
    m.post.mockImplementationOnce(async (_path, _body, opts) => { opts.beforeDispatch(); dispatch(); });
    await expect(cancelOrder('fixture', { beforeSend: () => { throw new Error('環境已切換'); } })).rejects.toMatchObject({ mutationNotStarted: true, message: '環境已切換' });
    expect(dispatch).not.toHaveBeenCalled();
});

it('cancelVerifiedOrder cancels exactly the supplied server row, never resolving through local rows', async () => {
    const { cancelVerifiedOrder } = await import('./shioaji');
    const stock = { ...account, account_type: 'S' }; m.accounts = [stock];
    // Local trading-state holds a stale row X that actually belongs to another order Y
    m.rows = [{ ...row(), account: stock, order: { ...row().order, id: 'X', seqno: 'seqY', ordno: 'ordY', account: stock } } as AccountedTrade];
    m.baseline = false; // would force the local re-resolution path in cancelOrder
    const ours = { ...row(), account: undefined, order: { ...row().order, id: 'X', seqno: 'seqOurs', ordno: 'ordOurs', custom_field: 'oabc00', account: stock } } as unknown as AccountedTrade;
    m.readback = () => [{ ...ours, status: { ...ours.status, status: 'Cancelled', cancel_quantity: 3, order_quantity: 0 } }];
    await cancelVerifiedOrder(ours, stock);
    expect(m.post.mock.calls[0]).toEqual(['/api/v1/order/cancel_order', { trade_id: 'X' }, expect.objectContaining({ beforeDispatch: expect.any(Function) })]);
    // no authoritative re-resolution by the stale row's seqno/ordno before the cancel
    expect(m.post.mock.calls.findIndex(c => c[0] === '/api/v1/order/trades')).toBeGreaterThan(0);
});

it('cancelVerifiedOrder: beforeSend refusal sends nothing', async () => {
    const dispatch = vi.fn();
    m.post.mockImplementationOnce(async (_path, _body, opts) => { opts.beforeDispatch(); dispatch(); });
    const { cancelVerifiedOrder } = await import('./shioaji');
    const stock = { ...account, account_type: 'S' }; m.accounts = [stock];
    await expect(cancelVerifiedOrder({ ...row(), order: { ...row().order, id: 'X' } }, stock, { beforeSend: () => { throw new Error('環境已切換'); } }))
        .rejects.toMatchObject({ mutationNotStarted: true, message: '環境已切換' });
    expect(dispatch).not.toHaveBeenCalled();
});

describe('#244 cancel of an order placed outside this sidecar (iLeader)', () => {
    const unsignable = () => Object.assign(new Error('400 CA not activated for:'), { status: 400 });
    const brokerRow = (personId: string) => ({ ...row(), account: undefined,
        order: { ...row().order, account: { ...account, person_id: personId } } });
    it('reconciles the account once and resends after the sidecar refused to sign the report-only row', async () => {
        let cancels = 0;
        m.post.mockImplementation(async (path: string, body: Record<string, unknown>) => {
            if (path === '/api/v1/order/cancel_order') { if (cancels++ === 0) throw unsignable(); return row(); }
            if (path === '/api/v1/order/trades') return body.refresh === true ? [brokerRow('P123')] : m.readback!(body);
            return { state: 'Healthy', reasons: [] };
        });
        await expect(cancelOrder('fixture')).resolves.toMatchObject({ status: { status: 'Cancelled' } });
        const calls = m.post.mock.calls.map(c => [c[0], c[1].refresh]);
        expect(calls.slice(0, 3)).toEqual([['/api/v1/order/cancel_order', undefined],
            ['/api/v1/order/trades', true], ['/api/v1/order/cancel_order', undefined]]);
        expect(cancels).toBe(2);
    });
    it('sends nothing more when the reconciled row still cannot be signed', async () => {
        m.post.mockImplementation(async (path: string, body: Record<string, unknown>) => {
            if (path === '/api/v1/order/cancel_order') throw unsignable();
            if (path === '/api/v1/order/trades') return body.refresh === true ? [brokerRow('')] : m.readback!(body);
            return { state: 'Healthy', reasons: [] };
        });
        await expect(cancelOrder('fixture')).rejects.toMatchObject({ mutationNotStarted: true });
        expect(m.post.mock.calls.filter(c => c[0] === '/api/v1/order/cancel_order')).toHaveLength(1);
    });
    it('does not resend when the reconciled id now names a different order', async () => {
        m.post.mockImplementation(async (path: string, body: Record<string, unknown>) => {
            if (path === '/api/v1/order/cancel_order') throw unsignable();
            if (path === '/api/v1/order/trades') return body.refresh === true
                ? [{ ...brokerRow('P123'), order: { ...brokerRow('P123').order, seqno: 'other', ordno: 'other' } }] : m.readback!(body);
            return { state: 'Healthy', reasons: [] };
        });
        await expect(cancelOrder('fixture')).rejects.toMatchObject({ mutationNotStarted: true });
        expect(m.post.mock.calls.filter(c => c[0] === '/api/v1/order/cancel_order')).toHaveLength(1);
    });
    it('reports a second local refusal as not sent', async () => {
        m.post.mockImplementation(async (path: string, body: Record<string, unknown>) => {
            if (path === '/api/v1/order/cancel_order') throw unsignable();
            if (path === '/api/v1/order/trades') return body.refresh === true ? [brokerRow('P123')] : m.readback!(body);
            return { state: 'Healthy', reasons: [] };
        });
        await expect(cancelOrder('fixture')).rejects.toMatchObject({ mutationNotStarted: true });
        expect(m.post.mock.calls.filter(c => c[0] === '/api/v1/order/cancel_order')).toHaveLength(2);
    });
    it('shares one update_status across a batch of external orders on the same account', async () => {
        const second = (): AccountedTrade => ({ ...row(), order: { ...row().order, id: 'fixture-2', seqno: 'seq2', ordno: 'ord2' },
            status: { ...row().status, id: 'fixture-2' } } as AccountedTrade);
        m.rows = [row(), second()];
        const sent = new Map<string, number>();
        m.post.mockImplementation(async (path: string, body: Record<string, unknown>) => {
            if (path === '/api/v1/order/cancel_order') {
                const id = String(body.trade_id); const n = sent.get(id) ?? 0; sent.set(id, n + 1);
                if (n === 0) throw unsignable();
                return id === 'fixture' ? row() : second();
            }
            if (path === '/api/v1/order/trades') {
                const rows = [brokerRow('P123'), { ...second(), account: undefined, order: { ...second().order, account: { ...account, person_id: 'P123' } } }];
                return body.refresh === true ? rows
                    : rows.map(r => ({ ...r, status: { ...r.status, status: 'Cancelled', cancel_quantity: 3, order_quantity: 0 } }));
            }
            return { state: 'Healthy', reasons: [] };
        });
        const results = await cancelOrders(['fixture', 'fixture-2']);
        expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);
        expect(m.post.mock.calls.filter(c => c[0] === '/api/v1/order/trades' && c[1].refresh === true)).toHaveLength(1);
    });
    it('does not resend other cancel errors', async () => {
        m.post.mockImplementation(async (path: string) => {
            if (path === '/api/v1/order/cancel_order') throw Object.assign(new Error('400 Trade fixture not found in cache'), { status: 400 });
            return [];
        });
        await expect(cancelOrder('fixture')).rejects.toThrow('not found in cache');
        expect(m.post.mock.calls.map(c => c[0])).toEqual(['/api/v1/order/cancel_order']);
    });
});
it('#244 does not resend after the server mode changed while the first cancel was refused', async () => {
    const mode = (simulation: boolean) => observeServerInfo(beginServerInfoRequest(), { simulation } as import('./shioaji').ServerInfo);
    mode(false);
    m.post.mockImplementation(async (path: string, body: Record<string, unknown>) => {
        if (path === '/api/v1/order/cancel_order') { mode(true); throw Object.assign(new Error('400 CA not activated for:'), { status: 400 }); }
        if (path === '/api/v1/order/trades') return body.refresh === true
            ? [{ ...row(), account: undefined, order: { ...row().order, account: { ...account, person_id: 'P123' } } }] : [];
        return { state: 'Healthy', reasons: [] };
    });
    await expect(cancelOrder('fixture')).rejects.toMatchObject({ mutationNotStarted: true });
    expect(m.post.mock.calls.filter(c => c[0] === '/api/v1/order/cancel_order')).toHaveLength(1);
});
it('#244 does not resend when the orders baseline was rebuilt (sidecar restart) during reconciliation', async () => {
    let dispatched = 0;
    m.post.mockImplementation(async (path: string, body: Record<string, unknown>, opts?: { beforeDispatch?: () => void }) => {
        if (path === '/api/v1/order/cancel_order') { opts?.beforeDispatch?.(); dispatched++; throw Object.assign(new Error('400 CA not activated for:'), { status: 400 }); }
        if (path === '/api/v1/order/trades') {
            if (body.refresh === true) m.lostMark += 1;
            return body.refresh === true ? [{ ...row(), account: undefined, order: { ...row().order, account: { ...account, person_id: 'P123' } } }] : [];
        }
        return { state: 'Healthy', reasons: [] };
    });
    await expect(cancelOrder('fixture')).rejects.toMatchObject({ mutationNotStarted: true });
    expect(dispatched).toBe(1);
});
it('#244 a staggered batch joins the reconciliation already in flight', async () => {
    const second = (): AccountedTrade => ({ ...row(), order: { ...row().order, id: 'fixture-2', seqno: 'seq2', ordno: 'ord2' },
        status: { ...row().status, id: 'fixture-2' } } as AccountedTrade);
    m.rows = [row(), second()];
    const signable = [row(), second()].map(r => ({ ...r, account: undefined, order: { ...r.order, account: { ...account, person_id: 'P123' } } }));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const sent = new Map<string, number>();
    m.post.mockImplementation(async (path: string, body: Record<string, unknown>) => {
        if (path === '/api/v1/order/cancel_order') {
            const id = String(body.trade_id); const n = sent.get(id) ?? 0; sent.set(id, n + 1);
            if (n === 0) throw Object.assign(new Error('400 CA not activated for:'), { status: 400 });
            return id === 'fixture' ? row() : second();
        }
        if (path === '/api/v1/order/trades') {
            if (body.refresh === true) { setTimeout(release, 20); await gate; return signable; }
            return signable.map(r => ({ ...r, status: { ...r.status, status: 'Cancelled', cancel_quantity: 3, order_quantity: 0 } }));
        }
        return { state: 'Healthy', reasons: [] };
    });
    // The second order gets its local mutation lock only after the first one's reconciliation started.
    vi.stubGlobal('navigator', { locks: { request: async (name: string, _o: unknown, cb: (v: object) => unknown) => {
        if (name.includes('fixture-2')) await new Promise(resolve => setTimeout(resolve, 10));
        return cb({});
    } } });
    const results = await cancelOrders(['fixture', 'fixture-2']);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(m.post.mock.calls.filter(c => c[0] === '/api/v1/order/trades' && c[1].refresh === true)).toHaveLength(1);
});
