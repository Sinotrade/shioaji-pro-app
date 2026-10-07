import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from './types/portfolio';
import type { Trade } from './types/order';
import type { ContractBase } from './types/contract';

const m = vi.hoisted(() => ({ accounts: [] as Account[], trades: [] as Trade[], baseline: vi.fn() }));
vi.mock('./account-store', () => ({ getAccountState: () => ({ accounts: m.accounts }), accountFor: () => m.accounts[0] }));
vi.mock('./trading-state', () => ({ getTradingState: () => ({ trades: m.trades }), hasOrdersBaseline: m.baseline, cancelCacheTrusted: vi.fn(), locallyCancelled: vi.fn(), ordersBaselineLostMark: () => 0 }));
import { cancelComboOrder, cancelOrder, cancelVerifiedOrder, placeComboOrder, placeFuturesOrder, placeStockOrder, updateOrderPrice, updateOrderQty, type ServerInfo } from './shioaji';
import { beginServerInfoRequest, forgetServerInfo, observeServerInfo } from './server-info-store';

const mode = (simulation: boolean) => observeServerInfo(beginServerInfoRequest(), { simulation } as ServerInfo);
const contract = { code: 'fixture', security_type: 'FUT', exchange: 'TAIFEX' } as ContractBase;
const order = { action: 'Buy' as const, price: 100, quantity: 1, price_type: 'LMT' as const, order_type: 'ROD' as const, octype: 'Auto' as const };
const fetchMock = vi.fn();
beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('navigator', { locks: { request: (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}) } });
    m.accounts = [{ account_type: 'F', broker_id: 'fixture', account_id: 'unsigned', signed: false, username: '', person_id: '' }];
    m.trades = [{ account: m.accounts[0], contract, order: { ...order, account: m.accounts[0], id: 'id' }, status: { status: 'Submitted' } } as unknown as Trade];
    m.baseline.mockReturnValue(true);
    forgetServerInfo('');
    mode(true);
    fetchMock.mockResolvedValue(new Response(JSON.stringify(m.trades[0])));
});
afterEach(() => vi.unstubAllGlobals());

it.each(['F', 'S'] as const)('dispatches an unsigned %s account in simulation without rewriting signed', async type => {
    m.accounts[0]!.account_type = type;
    if (type === 'F') await placeFuturesOrder(contract, order, m.accounts[0]);
    else await placeStockOrder({ ...contract, security_type: 'STK' }, { ...order, order_lot: 'Common' }, m.accounts[0]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect((body.futures_order ?? body.stock_order).account.signed).toBe(false);
    expect(m.accounts[0]!.signed).toBe(false);
});

it.each([false, undefined])('all placement paths reject unsigned accounts in mode %s without HTTP', async simulation => {
    if (simulation === undefined) forgetServerInfo(''); else mode(simulation);
    await expect(placeFuturesOrder(contract, order, m.accounts[0])).rejects.toMatchObject({ mutationNotStarted: true, tradingGateRejected: true });
    m.accounts[0]!.account_type = 'S';
    await expect(placeStockOrder(contract, { ...order, order_lot: 'Common' }, m.accounts[0])).rejects.toMatchObject({ mutationNotStarted: true });
    m.accounts[0]!.account_type = 'F';
    await expect(placeComboOrder({ legs: [] }, order, m.accounts[0])).rejects.toMatchObject({ mutationNotStarted: true });
    await expect(cancelComboOrder('id')).rejects.toMatchObject({ mutationNotStarted: true });
    expect(fetchMock).not.toHaveBeenCalled();
});

it('checks mode again at the actual HTTP boundary after request serialization', async () => {
    const account = m.accounts[0]!;
    Object.assign(account, { toJSON: () => { mode(false); return { ...account, toJSON: undefined }; } });
    await expect(placeFuturesOrder(contract, order, account)).rejects.toMatchObject({ mutationNotStarted: true, tradingGateRejected: true });
    expect(fetchMock).not.toHaveBeenCalled();
});

it('uses the current account row rather than a captured signed flag', async () => {
    const captured = { ...m.accounts[0]!, signed: true };
    mode(false);
    await expect(placeFuturesOrder(contract, order, captured)).rejects.toMatchObject({ mutationNotStarted: true });
    expect(fetchMock).not.toHaveBeenCalled();
});

it.each(['Common', 'IntradayOdd'] as const)('rechecks each spread %s placement at dispatch and preserves instance response headers', async order_lot => {
    const account = m.accounts[0]!;
    account.account_type = 'S';
    const onResponse = vi.fn();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(m.trades[0]), { headers: { 'X-Shioaji-Instance': 'fixture-instance' } }));
    await placeStockOrder({ ...contract, security_type: 'STK' }, { ...order, order_lot }, account, { onResponse });
    expect(onResponse.mock.calls[0]![0].headers.get('X-Shioaji-Instance')).toBe('fixture-instance');

    Object.assign(account, { toJSON: () => { mode(false); return { ...account, toJSON: undefined }; } });
    await expect(placeStockOrder({ ...contract, security_type: 'STK' }, { ...order, order_lot }, account, { onResponse }))
        .rejects.toMatchObject({ mutationNotStarted: true, tradingGateRejected: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onResponse).toHaveBeenCalledOnce();
});

it('permits verified cancellation of an unsigned simulation account using the supplied server row', async () => {
    const row = m.trades[0]!;
    const cancelled = { ...row, status: { ...row.status, status: 'Cancelled', cancel_quantity: 1, deal_quantity: 0 } };
    fetchMock.mockImplementation(async (url: string) => new Response(JSON.stringify(url.endsWith('/trades') ? [cancelled] : row)));
    const onResponse = vi.fn();
    await expect(cancelVerifiedOrder(row, m.accounts[0]!, { onResponse })).resolves.toMatchObject({ status: { status: 'Cancelled' } });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ trade_id: row.order.id });
    expect(onResponse).toHaveBeenCalledOnce();
    expect(m.accounts[0]!.signed).toBe(false);
});

it.each(['production', 'unknown', 'removed'] as const)('refuses a verified cancellation when its current account is %s', async change => {
    const account = m.accounts[0]!;
    if (change === 'production') mode(false);
    else if (change === 'unknown') forgetServerInfo('');
    else m.accounts = [];
    await expect(cancelVerifiedOrder(m.trades[0]!, { ...account, signed: true })).rejects.toMatchObject({ mutationNotStarted: true });
    expect(fetchMock).not.toHaveBeenCalled();
});

it.each([cancelOrder, (id: string, opts: { beforeSend: () => void }) => cancelVerifiedOrder({ ...m.trades[0]!, order: { ...m.trades[0]!.order, id } }, m.accounts[0]!, opts)])('rechecks cancel identity preflight at the actual HTTP boundary', async cancel => {
    const beforeSend = vi.fn();
    beforeSend.mockImplementation(() => { throw new Error('伺服器身分已變更'); });
    await expect(cancel('id', { beforeSend })).rejects.toMatchObject({ mutationNotStarted: true, message: '伺服器身分已變更' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(beforeSend).toHaveBeenCalledOnce();
});

it('discards verified cancellation confirmation when the mode changes away and back during dispatch', async () => {
    m.accounts[0]!.signed = true;
    fetchMock.mockImplementation(async () => {
        mode(false); mode(true);
        return new Response(JSON.stringify(m.trades[0]));
    });
    await expect(cancelVerifiedOrder(m.trades[0]!, m.accounts[0]!)).rejects.toMatchObject({ mutationOutcomeUnknown: true });
    expect(fetchMock).toHaveBeenCalledOnce();
});

const mutations = [
    () => cancelOrder('id'),
    () => updateOrderPrice('id', 101),
    () => updateOrderQty('id', 1),
] as const;
it.each(mutations)('revalidates mutations when mode changes after account preflight', async call => {
    m.baseline.mockImplementation(() => { mode(false); return true; });
    await expect(call()).rejects.toMatchObject({ mutationNotStarted: true, tradingGateRejected: true });
    expect(fetchMock).not.toHaveBeenCalled();
});

it.each(mutations)('rejects mutations without Web Locks before account preflight', async call => {
    vi.stubGlobal('navigator', {});
    expect(navigator.locks).toBeUndefined();
    const error = await call().catch(error => error);
    expect(error).toMatchObject({ message: expect.stringContaining('Web Locks'), mutationNotStarted: true });
    expect(error).not.toHaveProperty('tradingGateRejected');
    expect(m.baseline).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
});
