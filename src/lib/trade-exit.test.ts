import { beforeEach, expect, it, vi } from 'vitest';
import type { Account } from './types/portfolio';
import type { ContractBase } from './types/contract';
const m = vi.hoisted(() => ({ base: 'fixture', live: 'live', confirm: vi.fn(), stock: vi.fn(), future: vi.fn(), fetch: vi.fn(), cancel: vi.fn(), health: vi.fn(), continuous: false, risk: vi.fn(), accounts: [] as Account[], selected: undefined as Account | undefined }));
vi.mock('./runtime', () => ({ getApiBase: () => m.base }));
vi.mock('./account-store', () => ({ getAccountState: () => ({ accounts: m.accounts, selectedStock: m.selected, selectedFutures: m.selected?.account_type === 'F' ? m.selected : undefined }) }));
vi.mock('./activity', () => ({ trackActivity: vi.fn() }));
vi.mock('./order-confirm', () => ({ requestOrderConfirm: m.confirm, accountConfirmLabel: (a: Account) => `${a.broker_id}-${a.account_id}` }));
vi.mock('./risk', () => ({ checkOrderAllowed: m.risk, getRiskSettings: () => ({ confirmManualOrders: true }) }));
vi.mock('./stream', () => ({ getStreamStatus: () => m.live }));
vi.mock('./shioaji', () => ({ placeStockOrder: m.stock, placeFuturesOrder: m.future, fetchTrades: m.fetch, cancelOrder: m.cancel, cancelOrders: (ids: string[]) => Promise.allSettled(ids.map(id => m.cancel(id))), fetchTradeCacheHealth: m.health }));
vi.mock('./trading-state', () => ({ tradeCacheContinuous: () => m.continuous }));
import { placeStockExitByShares, placeQuickOrder, cancelAllOrders, onNotice } from './trade';
import { beginServerInfoRequest, forgetServerInfo, observeServerInfo } from './server-info-store';
const account = { account_type:'S', account_id:'a', broker_id:'b', signed:true, person_id:'fixture', username:'fixture' };
const contract = { code:'2330',security_type:'STK',exchange:'TSE',limit_down:90,limit_up:110 } as ContractBase & {limit_down:number;limit_up:number};
beforeEach(() => { vi.clearAllMocks(); m.continuous=false; m.health.mockReset().mockResolvedValue({ state: 'Healthy', reasons: [] }); m.base='fixture'; m.live='live'; m.accounts=[account]; m.selected=account; m.risk.mockReturnValue(null); m.confirm.mockResolvedValue(true); m.stock.mockResolvedValue({}); m.future.mockResolvedValue({}); });
beforeEach(() => { forgetServerInfo(m.base); });
const setSimulation = (simulation: boolean) => observeServerInfo(beginServerInfoRequest(), { simulation } as import('./shioaji').ServerInfo);

it.each(['S', 'F'] as const)('sends an unsigned %s account unchanged in simulation (#228)', async type => {
    setSimulation(true);
    const unsigned = { ...account, signed: false, account_type: type };
    m.accounts = [unsigned]; m.selected = unsigned;
    const product = type === 'S' ? contract : { ...contract, security_type: 'FUT', exchange: 'TAIFEX' } as ContractBase;
    await placeQuickOrder(product, 'Buy', 100, 1);
    const send = type === 'S' ? m.stock : m.future;
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![2]).toBe(unsigned);
    expect(unsigned.signed).toBe(false);
});
it.each([false, undefined])('blocks unsigned orders when simulation=%s (#228)', async simulation => {
    if (simulation !== undefined) setSimulation(simulation);
    const unsigned = { ...account, signed: false };
    m.accounts = [unsigned]; m.selected = unsigned;
    await expect(placeQuickOrder(contract, 'Buy', 100, 1)).rejects.toMatchObject({ mutationNotStarted: true });
    expect(m.confirm).not.toHaveBeenCalled();
    expect(m.stock).not.toHaveBeenCalled();
});
it('blocks an unsigned order if mode changes to production during confirmation (#228)', async () => {
    setSimulation(true);
    const unsigned = { ...account, signed: false };
    m.accounts = [unsigned]; m.selected = unsigned;
    m.confirm.mockImplementation(async () => { setSimulation(false); return true; });
    await expect(placeQuickOrder(contract, 'Buy', 100, 1)).rejects.toMatchObject({ mutationNotStarted: true });
    expect(m.confirm).toHaveBeenCalledOnce();
    expect(m.stock).not.toHaveBeenCalled();
});
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

it.each(['context', 'account'])('rechecks %s before the odd remainder of a stock exit', async change => {
    let current = true;
    const dispatched = vi.fn();
    m.stock.mockImplementation(async (_c, _o, _a, opts) => {
        opts.beforeDispatch();
        dispatched();
        current = false; // the first leg's response arrives after the panel changed
        return {};
    });
    await expect(placeStockExitByShares(contract, 'Sell', 1500, account, {
        isAccountCurrent: () => change !== 'account' || current,
        beforeSend: () => { if (change === 'context' && !current) throw new Error('商品已變更'); },
    })).rejects.toMatchObject({ mutationNotStarted: true });
    expect(dispatched).toHaveBeenCalledOnce();
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

it('confirms with the explicit order account, not the app-wide selection (#139)', async () => {
    const other = { ...account, account_id: 'panel' };
    m.accounts = [account, other];
    await placeQuickOrder(contract, 'Buy', 100, 1, { account: other });
    expect(m.confirm.mock.calls[0]![0]).toMatchObject({ accountLabel: 'b-panel' });
    expect(m.stock.mock.calls[0]![2]).toEqual(other);
});
it('aborts when the caller account changes during confirmation (#139)', async () => {
    let current = true;
    m.confirm.mockImplementation(async () => { current = false; return true; });
    await expect(placeQuickOrder(contract, 'Buy', 100, 1, { account, isAccountCurrent: () => current })).rejects.toMatchObject({ mutationNotStarted: true, message: expect.stringContaining('帳戶已變更') });
    await expect(placeStockExitByShares(contract, 'Sell', 1000, account, { isAccountCurrent: () => current })).rejects.toMatchObject({ mutationNotStarted: true });
    expect(m.stock).not.toHaveBeenCalled();
});
it('aborts when the explicit account becomes unavailable during confirmation (#139)', async () => {
    m.confirm.mockImplementation(async () => { m.accounts = []; return true; });
    await expect(placeQuickOrder(contract, 'Buy', 100, 1, { account })).rejects.toMatchObject({ mutationNotStarted: true });
    expect(m.stock).not.toHaveBeenCalled();
});
it('the confirmation shows the captured account, not the selected one', async () => {
    const bound = { ...account, account_id: 'bound' };
    m.accounts = [account, bound];
    await placeQuickOrder(contract, 'Buy', null, 1, { account: bound });
    expect(m.confirm.mock.calls[0]![0].accountLabel).toBe('b-bound');
});
it('passes a pending trigger quote code into the manual confirmation', async () => {
    await placeQuickOrder(contract, 'Buy', null, 1, { confirmLivePriceCode: '2330' });
    expect(m.confirm.mock.calls[0]![0].livePriceCode).toBe('2330');
});
it('beforeSend runs after confirmation; its refusal is mutationNotStarted and nothing is sent', async () => {
    const order: string[] = [];
    const dispatch = vi.fn();
    m.stock.mockImplementationOnce(async (_contract, _order, _account, opts) => {
        opts.beforeDispatch();
        dispatch();
        return {};
    });
    m.confirm.mockImplementation(async () => { order.push('confirm'); return true; });
    await expect(placeQuickOrder(contract, 'Buy', null, 1, { beforeSend: () => { order.push('before'); throw new Error('gone'); } }))
        .rejects.toMatchObject({ mutationNotStarted: true, message: 'gone' });
    expect(order).toEqual(['confirm', 'before']);
    expect(dispatch).not.toHaveBeenCalled();
});

// #204 零股：沒有市價單；限價送出帶 IntradayOdd，風控以零股單位檢查
it('odd lots: a market order is refused before confirmation or sending', async () => {
    await expect(placeQuickOrder(contract, 'Buy', null, 100, { orderLot: 'IntradayOdd' })).rejects.toMatchObject({ mutationNotStarted: true, message: expect.stringContaining('限價') });
    expect(m.confirm).not.toHaveBeenCalled(); expect(m.stock).not.toHaveBeenCalled();
});
it('odd lots: a limit order goes out as IntradayOdd LMT ROD in shares; risk sees the lot', async () => {
    await placeQuickOrder(contract, 'Buy', 100, 300, { orderLot: 'IntradayOdd' });
    expect(m.risk).toHaveBeenCalledWith(300, 'IntradayOdd');
    expect(m.confirm.mock.calls[0]![0]).toMatchObject({ unit: '股', quantity: 300, note: expect.stringContaining('盤中零股') });
    expect(m.stock.mock.calls[0]![1]).toMatchObject({ quantity: 300, price: 100, price_type: 'LMT', order_type: 'ROD', order_lot: 'IntradayOdd' });
});
it('sends the chosen order type on limit orders, keeps ROD by default and IOC for market orders (#204 chart settings)', async () => {
    await placeQuickOrder(contract,'Buy',100,2,{orderType:'FOK'});
    await placeQuickOrder(contract,'Buy',100,2);
    await placeQuickOrder(contract,'Buy',null,2,{orderType:'FOK'});
    expect(m.stock.mock.calls.map(c => [c[1].price_type, c[1].order_type])).toEqual([['LMT','FOK'],['LMT','ROD'],['MKT','IOC']]);
    expect(m.confirm.mock.calls[0]![0].note).toBe('限價 FOK');
    const future = {...contract,security_type:'FUT',exchange:'TAIFEX'} as ContractBase;
    m.selected = {...account, account_type:'F'}; m.accounts=[m.selected];
    await placeQuickOrder(future,'Sell',100,1,{orderType:'IOC',ocType:'New'});
    expect(m.future.mock.calls[0]![1]).toMatchObject({order_type:'IOC',price_type:'LMT',octype:'New'});
});
