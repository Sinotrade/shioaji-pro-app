// 買全刪／賣全刪：點底部合計列的買單／賣單合計，刪掉這個面板顯示的那一邊委託
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../hooks/use-flash-ladder', () => ({ useFlashLadder: () => ({ marks: new Map(), protectedQty: 0, background: false }) }));
vi.mock('../lib/flash-conditional', () => ({ flashStopProtections: vi.fn(async () => ({ stopped: 0, blocked: [], failed: [], restore: [] })) }));
import type { Account } from '../lib/types/portfolio';
import type { Trade } from '../lib/types/order';
import type { ContractInfo } from '../lib/types/contract';
const mocks = vi.hoisted(() => ({ cancel: vi.fn(), notify: vi.fn(), trace: vi.fn(), hold: null as Promise<void> | null }));
const accounts: Account[] = [['S', 'A'], ['S', 'B'], ['F', 'FA']].map(([account_type, account_id]) => ({ account_type, broker_id: 'BR', account_id, signed: true, person_id: '', username: '' }) as Account);
vi.mock('../lib/account-store', () => ({ ensureAccounts: () => undefined, useAccounts: () => ({ loaded: true, accounts, selectedStock: accounts[0], selectedFutures: accounts[2] }) }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => undefined, useTradingLive: () => true }));
vi.mock('../hooks/use-display-book', () => ({ useDisplayBook: () => ({ quote: undefined, snapshot: { close: 100 }, book: undefined }) }));
// like the real cancelOrders: the guard runs right before each send
vi.mock('../lib/shioaji', () => ({ cancelOrder: vi.fn(), cancelOrders: (ids: string[], _s: unknown, beforeSend?: () => void) =>
    Promise.allSettled(ids.map(async id => { if (mocks.hold) await mocks.hold; beforeSend?.(); return mocks.cancel(id); })) }));
vi.mock('../lib/trade', () => ({ notify: mocks.notify, placeQuickOrder: vi.fn(), placeStockExitByShares: vi.fn() }));
vi.mock('../lib/order-trace', () => ({ noteOrderTraceEntry: mocks.trace }));
vi.mock('../lib/stream', () => ({ getAliasFor: () => undefined }));
vi.mock('../lib/tick-bands', () => ({ useTickBandsVersion: () => 0 }));
vi.mock('../lib/utils/ticksize', () => ({ roundToTick: (_c: unknown, p: number) => p, stepPrice: (_c: unknown, p: number, step: number) => p + step }));
import { FlashOrder } from './flash-order';
import { flashStopProtections } from '../lib/flash-conditional';

const contract = { code: '2317', security_type: 'STK', exchange: 'TSE', reference: 100, limit_up: 110, limit_down: 90, day_trade: 'Yes' } as unknown as ContractInfo;
const order = (id: string, acct: Account, action: 'Buy' | 'Sell', price: number, opts: { lot?: string; deal?: number; qty?: number } = {}) => {
    const qty = opts.qty ?? 2;
    const deal = opts.deal ?? 0;
    return { account: acct, contract: { code: '2317', security_type: 'STK' },
        order: { id, seqno: id, ordno: id, account: acct, action, price, quantity: qty, order_lot: opts.lot ?? 'Common', order_cond: 'Cash', daytrade_short: false },
        status: { id, status: deal >= qty ? 'Filled' : deal ? 'PartFilled' : 'Submitted', order_ts: Date.now() / 1000, order_quantity: qty, deal_quantity: deal, cancel_quantity: 0,
            deals: deal ? [{ seq: id, price, quantity: deal, ts: Date.now() / 1000 }] : [] } } as unknown as Trade;
};
const [A, B] = accounts as [Account, Account];
const trades = [
    order('a-buy-1', A, 'Buy', 99), order('a-buy-2', A, 'Buy', 98), order('a-buy-odd', A, 'Buy', 99, { lot: 'IntradayOdd', qty: 300 }),
    order('a-buy-filled', A, 'Buy', 97, { deal: 2 }),
    order('a-sell-1', A, 'Sell', 101), order('a-sell-2', A, 'Sell', 102),
    order('b-buy-1', B, 'Buy', 99), order('b-sell-1', B, 'Sell', 101),
];

const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
let view!: ReactTestRenderer;
const cell = (side: 'buy' | 'sell') => view.root.findAll(x => typeof x.type === 'string' && x.props['data-testid'] === `flash-tot-${side}`)[0]!;
const button = (label: string) => view.root.findAllByType('button').find(b => text(b).includes(label))!;
const arm = async () => { await act(async () => { button('啟用閃電下單').props.onClick(); }); };
const render = async (props: Record<string, unknown> = {}) => { await act(async () => { view = create(createElement(FlashOrder, { contract, trades, positions: [], ...props } as never)); }); };
const cancelled = () => mocks.cancel.mock.calls.map(c => c[0]);

beforeEach(() => {
    vi.clearAllMocks();
    mocks.hold = null;
    mocks.cancel.mockImplementation(async (id: string) => ({ ...trades.find(t => t.order.id === id)!, status: { status: 'Cancelled', cancel_quantity: 2, deal_quantity: 0 } }));
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

it('the totals are buttons with an aria-label and a count of the working orders shown', async () => {
    await render();
    await arm();
    expect(cell('buy').type).toBe('button');
    expect(cell('buy').props['aria-label']).toBe('刪除全部買單（2 筆）');
    expect(cell('buy').props.title).toMatch(/^點一下刪除全部買單（2 筆）/);
    expect(cell('sell').props['aria-label']).toBe('刪除全部賣單（2 筆）');
});

it('買全刪 cancels only this account’s working buy orders in the shown unit, never sells, and keeps 停損停利', async () => {
    await render();
    await arm();
    await act(async () => { cell('buy').props.onClick(); });
    expect(cancelled()).toEqual(['a-buy-1', 'a-buy-2']);
    expect(mocks.trace).toHaveBeenCalledWith(['a-buy-1', 'a-buy-2'], 'flash 買全刪');
    expect(mocks.notify).toHaveBeenLastCalledWith(expect.objectContaining({ title: '⚡ 買全刪' }));
    expect(flashStopProtections).not.toHaveBeenCalled();
});

it('賣全刪 cancels only the sells', async () => {
    await render();
    await arm();
    await act(async () => { cell('sell').props.onClick(); });
    expect(cancelled()).toEqual(['a-sell-1', 'a-sell-2']);
    expect(mocks.notify).toHaveBeenLastCalledWith(expect.objectContaining({ title: '⚡ 賣全刪' }));
});

it('in 盤中零股 it cancels only the odd-lot buys', async () => {
    await render({ lot: 'IntradayOdd', onLotChange: () => {} });
    await arm();
    expect(cell('buy').props['aria-label']).toBe('刪除全部買單（1 筆）');
    await act(async () => { cell('buy').props.onClick(); });
    expect(cancelled()).toEqual(['a-buy-odd']);
});

it('sends nothing while the flash panel is locked or paused', async () => {
    await render();
    expect(cell('buy').props['aria-disabled']).toBe(true);
    expect(cell('buy').props.title).toMatch(/^先啟用閃電下單/);
    await act(async () => { cell('buy').props.onClick(); });
    expect(mocks.cancel).not.toHaveBeenCalled();
    await act(async () => view.update(createElement(FlashOrder, { contract, trades, positions: [], paused: '查詢中' })));
    expect(view.root.findAll(x => x.props['data-testid'] === 'flash-tot-buy')).toHaveLength(0); // paused: no totals row at all
    expect(mocks.cancel).not.toHaveBeenCalled();
});

it('is not clickable without working orders (all filled or none)', async () => {
    await render({ trades: [order('f', A, 'Buy', 97, { deal: 2 })] });
    await arm();
    expect(cell('buy').type).toBe('span');
    expect(text(cell('buy'))).toBe('2(2)');
    expect(cell('sell').type).toBe('span');
    expect(text(cell('sell'))).toBe('—');
});

it('does not resend while the same side is in flight', async () => {
    let release!: () => void;
    mocks.hold = new Promise<void>(r => { release = r; });
    await render();
    await arm();
    let first!: Promise<void>;
    await act(async () => { first = Promise.resolve(cell('buy').props.onClick()); });
    await act(async () => { cell('buy').props.onClick(); });
    await act(async () => { release(); await first; });
    expect(cancelled()).toEqual(['a-buy-1', 'a-buy-2']);
});

it('an account switch midway never cancels the other account’s orders, and disarms the panel', async () => {
    let release!: () => void;
    mocks.hold = new Promise<void>(r => { release = r; });
    await render();
    await arm();
    await act(async () => { cell('buy').props.onClick(); });
    // the panel moves to account B while A's cancels are still waiting
    await act(async () => { view.root.findByType('select').props.onChange({ target: { value: 'S:BR:B' } }); });
    await act(async () => { release(); });
    expect(cancelled()).toEqual(['a-buy-1', 'a-buy-2']);
    // B is not armed yet: clicking sends nothing
    mocks.hold = null;
    await act(async () => { cell('buy').props.onClick(); });
    expect(cancelled()).toEqual(['a-buy-1', 'a-buy-2']);
    await arm();
    await act(async () => { cell('buy').props.onClick(); });
    expect(cancelled()).toEqual(['a-buy-1', 'a-buy-2', 'b-buy-1']);
});

it('a product switch midway cancels nothing (the click’s context guard)', async () => {
    let release!: () => void;
    mocks.hold = new Promise<void>(r => { release = r; });
    await render();
    await arm();
    await act(async () => { cell('buy').props.onClick(); });
    await act(async () => view.update(createElement(FlashOrder, { contract: { ...contract, code: '2330' }, trades, positions: [] })));
    await act(async () => { release(); });
    expect(mocks.cancel).not.toHaveBeenCalled();
});

it('has no 買全刪／賣全刪 when 顯示委託合計 is off', async () => {
    await render({ orderOpts: { orderType: 'ROD', octype: 'Auto', futuresPriceType: 'MKT', showTotals: false }, onOrderOptsChange: () => {} });
    await arm();
    expect(view.root.findAll(x => x.props['data-testid'] === 'flash-tot-buy')).toHaveLength(0);
    expect(view.root.findAll(x => typeof x.props['aria-label'] === 'string' && x.props['aria-label'].startsWith('刪除全部'))).toHaveLength(0);
});

// PR #400 review round 4 P1: the targets are the totals' working orders (same real month), not the chip rule
const mxf = (code: string, target: string | null) => ({ code, target_code: target, security_type: 'FUT', exchange: 'TAIFEX', reference: 20000, limit_up: 22000, limit_down: 18000 }) as unknown as ContractInfo;
const fut = (id: string, contract: Record<string, unknown>, action: 'Buy' | 'Sell') => {
    const t = order(id, accounts[2]!, action, 19990, {});
    return { ...t, contract: { security_type: 'FUT', ...contract }, order: { ...t.order, order_lot: undefined, order_cond: undefined, daytrade_short: undefined } } as unknown as Trade;
};
const futTrades = [
    fut('old-i6', { code: 'MXFR1', target_code: 'MXFI6' }, 'Buy'), // last month, placed on the alias
    fut('j6-direct', { code: 'MXFJ6' }, 'Buy'),
    fut('j6-alias', { code: 'MXFR1', target_code: 'MXFJ6' }, 'Buy'),
    fut('j6-sell', { code: 'MXFJ6' }, 'Sell'),
];

it('買全刪 on MXFR1→MXFJ6 cancels exactly the totals’ working buys: never the old MXFI6 month', async () => {
    await render({ contract: mxf('MXFR1', 'MXFJ6'), trades: futTrades });
    await arm();
    expect(cell('buy').props['aria-label']).toBe('刪除全部買單（2 筆）');
    expect(text(cell('buy'))).toBe('4(0)'); // 2 orders × 2; the count matches the totals' working orders
    await act(async () => { cell('buy').props.onClick(); });
    expect(cancelled()).toEqual(['j6-direct', 'j6-alias']);
});

// PR #400 review round 4 P2: a real-month rollover (I6→J6) on the same alias aborts a pending cancel
it('a rollover of the continuous month while cancels wait sends nothing', async () => {
    let release!: () => void;
    mocks.hold = new Promise<void>(r => { release = r; });
    await render({ contract: mxf('MXFR1', 'MXFI6'), trades: [fut('i6', { code: 'MXFR1', target_code: 'MXFI6' }, 'Buy')] });
    await arm();
    await act(async () => { cell('buy').props.onClick(); });
    await act(async () => view.update(createElement(FlashOrder, { contract: mxf('MXFR1', 'MXFJ6'), trades: [fut('i6', { code: 'MXFR1', target_code: 'MXFI6' }, 'Buy')], positions: [] })));
    await act(async () => { release(); });
    expect(mocks.cancel).not.toHaveBeenCalled();
});
