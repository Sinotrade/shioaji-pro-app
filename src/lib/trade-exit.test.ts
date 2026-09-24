import { beforeEach, expect, it, vi } from 'vitest';
import type { Account } from './types/portfolio';
import type { ContractBase } from './types/contract';
const m = vi.hoisted(() => ({ base: 'fixture', live: 'live', confirm: vi.fn(), stock: vi.fn(), future: vi.fn(), fetch: vi.fn(), cancel: vi.fn(), health: vi.fn(), continuous: false, risk: vi.fn(), accounts: [] as Account[], selected: undefined as Account | undefined }));
vi.mock('./runtime', () => ({ getApiBase: () => m.base }));
vi.mock('./account-store', () => ({ getAccountState: () => ({ accounts: m.accounts, selectedStock: m.selected, selectedFutures: m.selected?.account_type === 'F' ? m.selected : undefined }) }));
vi.mock('./activity', () => ({ trackActivity: vi.fn() }));
vi.mock('./order-confirm', () => ({ requestOrderConfirm: m.confirm }));
vi.mock('./risk', () => ({ checkOrderAllowed: m.risk, getRiskSettings: () => ({ confirmManualOrders: true }) }));
vi.mock('./stream', () => ({ getStreamStatus: () => m.live }));
vi.mock('./shioaji', () => ({ placeStockOrder: m.stock, placeFuturesOrder: m.future, fetchTrades: m.fetch, cancelOrder: m.cancel, cancelOrders: (ids: string[]) => Promise.allSettled(ids.map(id => m.cancel(id))), fetchTradeCacheHealth: m.health }));
vi.mock('./trading-state', () => ({ tradeCacheContinuous: () => m.continuous }));
import { placeStockExitByShares, placeQuickOrder, cancelAllOrders, onNotice } from './trade';
const account = { account_type:'S', account_id:'a', broker_id:'b', signed:true, person_id:'fixture', username:'fixture' };
const contract = { code:'2330',security_type:'STK',exchange:'TSE',limit_down:90,limit_up:110 } as ContractBase & {limit_down:number;limit_up:number};
beforeEach(() => { vi.clearAllMocks(); m.continuous=false; m.health.mockReset().mockResolvedValue({ state: 'Healthy', reasons: [] }); m.base='fixture'; m.live='live'; m.accounts=[account]; m.selected=account; m.risk.mockReturnValue(null); m.confirm.mockResolvedValue(true); m.stock.mockResolvedValue({}); m.future.mockResolvedValue({}); });
it('keeps the captured stock account on both legs after selection changes during confirmation', async () => {
    m.confirm.mockImplementation(async () => { m.selected={...account,account_id:'other'}; return true; });
    await placeStockExitByShares(contract,'Sell',1200,account);
    expect(m.stock).toHaveBeenCalledTimes(2);
    expect(m.stock.mock.calls.map(c => c[2])).toEqual([account,account]);
    expect(m.stock.mock.calls[0]![1]).toMatchObject({quantity:1,order_lot:'Common'});
    expect(m.stock.mock.calls[1]![1]).toMatchObject({quantity:200,order_lot:'IntradayOdd',price_type:'LMT'});
});
it('rechecks connection after confirmation and does not send a leg', async () => {
    m.confirm.mockImplementation(async () => { m.live='connecting'; return true; });
    await expect(placeStockExitByShares(contract,'Sell',1000,account)).rejects.toThrow('LIVE'); expect(m.stock).not.toHaveBeenCalled();
});
it('passes explicit Cover and retains Auto default', async () => {
    const future = {...contract,security_type:'FUT',exchange:'TAIFEX'} as ContractBase;
    m.selected = {...account, account_type:'F'}; m.accounts=[m.selected];
    await placeQuickOrder(future,'Sell',null,2,{ocType:'Cover'});
    await placeQuickOrder(future,'Sell',null,2);
    expect(m.future.mock.calls[0]![1].octype).toBe('Cover'); expect(m.future.mock.calls[1]![1].octype).toBe('Auto');
});
it('reports failed account queries even when no cancel requests could be made', async () => {
    m.fetch.mockRejectedValue(new Error('offline')); const notices: {kind:string;body:string}[]=[]; const off=onNotice(n=>notices.push(n));
    try { await cancelAllOrders(); expect(m.cancel).not.toHaveBeenCalled(); expect(notices.at(-1)).toMatchObject({kind:'err'}); expect(notices.at(-1)!.body).toContain('帳戶委託查詢失敗'); } finally { off(); }
});

it('full cancel always reads trades authoritatively and never consults the cache health', async () => {
    const future = { ...account, account_type: 'F', account_id: 'f' };
    m.accounts = [account, future]; m.continuous = true; m.fetch.mockResolvedValue([]);
    await cancelAllOrders();
    expect(m.fetch.mock.calls.map(c => c[2])).toEqual([{ refresh: true }, { refresh: true }]);
    expect(m.health).not.toHaveBeenCalled();
});

it('refuses before confirmation when no account was captured, even if confirmation would select one', async () => {
    m.accounts=[]; m.selected=undefined;
    m.confirm.mockImplementation(async () => { m.accounts=[account]; m.selected=account; return true; });
    await expect(placeQuickOrder(contract,'Buy',100,1)).rejects.toMatchObject({mutationNotStarted:true});
    expect(m.confirm).not.toHaveBeenCalled(); expect(m.stock).not.toHaveBeenCalled();
});
it.each([{...account, signed:false}, {...account, account_type:'F'}, {...account,account_id:'absent'}])('rejects an unusable explicit captured account', async candidate => {
    await expect(placeQuickOrder(contract,'Buy',100,1,{account:candidate})).rejects.toMatchObject({mutationNotStarted:true});
    expect(m.confirm).not.toHaveBeenCalled(); expect(m.stock).not.toHaveBeenCalled();
});
