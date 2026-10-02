import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from './types/portfolio';

const m = vi.hoisted(() => ({ accounts: [] as Account[], base: 'http://query.invalid', fetch: vi.fn() }));
vi.mock('./account-store', () => ({ getAccountState: () => ({ accounts: m.accounts }), accountFor: (type: string) => m.accounts.find(a => a.account_type === type) }));
vi.mock('./runtime', () => ({ getApiBase: () => m.base, isTauri: false }));
import { createAccountQuery } from './account-query';
import * as api from './shioaji';
import { beginServerInfoRequest, forgetServerInfo, observeServerInfo } from './server-info-store';

const mode = (simulation: boolean) => observeServerInfo(beginServerInfoRequest(), { simulation } as api.ServerInfo);
const queries = [
    ['trades', 'S', () => api.fetchTrades('S', m.accounts[0], { refresh: false })],
    ['trade_cache_health', 'F', () => api.fetchTradeCacheHealth('F', m.accounts[0])],
    ['position_unit', 'S', () => api.fetchPositions('S', m.accounts[0])],
    ['account_balance', 'S', () => api.fetchAccountBalance(m.accounts[0])],
    ['margin', 'F', () => api.fetchMargin(m.accounts[0])],
    ['settlements', 'S', () => api.fetchSettlements(m.accounts[0])],
    ['profit_loss', 'F', () => api.fetchProfitLoss('F', m.accounts[0])],
    ['profitloss_sum', 'S', () => api.fetchProfitLossSummary('S', m.accounts[0])],
    ['trading_limits', 'S', () => api.fetchTradingLimits(m.accounts[0])],
    ['stock_reserve_summary', 'S', () => api.fetchStockReserveSummary(m.accounts[0])],
    ['stock_reserve_detail', 'S', () => api.fetchStockReserveDetail(m.accounts[0])],
    ['earmarking_detail', 'S', () => api.fetchEarmarkingDetail(m.accounts[0])],
    ['combotrades', 'F', () => api.fetchComboTrades()],
] as const;
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => {
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('fetch', m.fetch);
    m.base = 'http://query.invalid';
    m.accounts = [{ account_type: 'S', broker_id: 'fixture', account_id: 'unsigned', signed: false, username: '', person_id: '' }];
    m.fetch.mockReset().mockResolvedValue(new Response('[]'));
    forgetServerInfo(m.base);
    mode(true);
});
afterEach(() => vi.unstubAllGlobals());

describe.each(queries)('account HTTP query %s', (route, type, read) => {
    beforeEach(() => { m.accounts[0]!.account_type = type; });
    it('permits simulation unsigned accounts and sends an explicit current selector', async () => {
        await read();
        expect(m.fetch).toHaveBeenCalledOnce();
        expect(m.fetch.mock.calls[0]![0]).toContain(`/${route}`);
        expect(JSON.parse(m.fetch.mock.calls[0]![1].body)).toMatchObject({ account_type: type, broker_id: 'fixture', account_id: 'unsigned' });
        expect(m.accounts[0]!.signed).toBe(false);
    });
    it.each([false, undefined])('permits current signed accounts in mode %s', async simulation => {
        m.accounts[0]!.signed = true;
        if (simulation === undefined) forgetServerInfo(m.base); else mode(simulation);
        await expect(read()).resolves.toEqual([]);
        expect(m.fetch).toHaveBeenCalledOnce();
    });
    it.each(['production', 'unknown', 'missing'] as const)('refuses %s accounts before HTTP', async change => {
        if (change === 'production') mode(false);
        else if (change === 'unknown') forgetServerInfo(m.base);
        else m.accounts = [];
        await expect(read()).rejects.toThrow('查詢帳戶已不可用');
        expect(m.fetch).not.toHaveBeenCalled();
    });
    it.each(['production', 'unknown', 'roundtrip', 'server', 'removed', 'identity', 'unsigned-row'] as const)('drops a response after %s changes', async change => {
        // Signed accounts must also discard a previous generation's data.
        if (change === 'production') m.accounts[0]!.signed = true;
        if (change === 'unsigned-row') { m.accounts[0]!.signed = true; mode(false); }
        const pending = deferred<Response>();
        m.fetch.mockReturnValueOnce(pending.promise);
        const run = read();
        expect(m.fetch).toHaveBeenCalledOnce();
        const verdict = expect(run).rejects.toThrow('已丟棄回應');
        if (change === 'unknown') forgetServerInfo(m.base);
        else if (change === 'server') m.base = 'http://other-query.invalid';
        else if (change === 'removed') m.accounts = [];
        else if (change === 'identity') m.accounts[0]!.account_id = 'changed';
        else if (change === 'unsigned-row') m.accounts = [{ ...m.accounts[0]!, signed: false }];
        else { mode(false); if (change === 'roundtrip') mode(true); }
        pending.resolve(new Response('[]'));
        await verdict;
    });
});

it('rechecks mode at HTTP dispatch after request serialization', async () => {
    m.accounts[0]!.broker_id = { toJSON() { mode(false); return 'fixture'; } } as unknown as string;
    await expect(api.fetchTrades('S', m.accounts[0])).rejects.toThrow('模式已變更');
    expect(m.fetch).not.toHaveBeenCalled();
});

it('resolves captured signed flags against the current account list', async () => {
    const captured = { ...m.accounts[0]!, signed: true };
    mode(false);
    await expect(api.fetchTrades('S', captured)).rejects.toThrow('查詢帳戶已不可用');
    expect(m.fetch).not.toHaveBeenCalled();
});

it('rechecks previously buffered accounts and stops queued reads', async () => {
    const query = createAccountQuery();
    const account = m.accounts[0]!;
    await query.read('S', account, async () => ['buffered']);
    mode(false); mode(true);
    expect(() => query.assertCurrent()).toThrow('已丟棄回應');
    const next = vi.fn(async () => []);
    await expect(query.read('S', account, next)).rejects.toThrow('已丟棄回應');
    expect(next).not.toHaveBeenCalled();
});
