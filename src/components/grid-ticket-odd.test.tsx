// #204 鋪單盤中零股：每檔以股計、送出 IntradayOdd 限價 ROD、跟隨只管同單位的網格單
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';
import type { Trade } from '../lib/types/order';
import type { ContractInfo } from '../lib/types/contract';
const m = vi.hoisted(() => ({ confirm: vi.fn(), stock: vi.fn(), cancel: vi.fn(), cancelMany: vi.fn(), notify: vi.fn(), risk: vi.fn() }));
const h = vi.hoisted(() => {
    const account = { account_type: 'S', broker_id: 'BR', account_id: 'A', signed: true, person_id: '', username: '' };
    const accountB = { ...account, account_id: 'B' };
    return { odd: { tick: { close: '100' } } as unknown, account, accountB, accounts: [account, accountB] as unknown[], selected: account as unknown };
});
vi.mock('../lib/account-store', () => ({ getAccountState: () => ({ accounts: h.accounts, selectedStock: h.selected, selectedFutures: null, loaded: true }), useAccounts: () => ({}) }));
vi.mock('../lib/order-confirm', () => ({ requestOrderConfirm: m.confirm, accountConfirmLabel: (a: Account) => `${a.broker_id}-${a.account_id}` }));
vi.mock('../lib/risk', () => ({ checkOrderAllowed: m.risk, getRiskSettings: () => ({ confirmManualOrders: true }) }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: m.cancel, cancelOrders: m.cancelMany, placeFuturesOrder: vi.fn(), placeStockOrder: m.stock }));
vi.mock('../lib/trade', () => ({ notify: m.notify, isFuturesContract: () => false }));
vi.mock('../lib/stream', () => ({ getAliasFor: () => undefined }));
vi.mock('../hooks/use-stream', () => ({ useQuote: (code: string | null, o?: { oddLot?: boolean }) => (o?.oddLot ? (code ? h.odd : undefined) : { tick: { close: '100' } }), useTradingLive: () => true }));
vi.mock('../lib/utils/ticksize', () => ({ stepPrice: (_c: unknown, p: number, step: number) => p + step, roundToTick: (_c: unknown, p: number) => Math.round(p) }));
import { GridTicket, gridBasePrice, gridOwnerOf, recordGridOwner } from './grid-ticket';

const contract = { code: '2330', security_type: 'STK', exchange: 'TSE', reference: 100, limit_up: 0, limit_down: 0 } as unknown as ContractInfo;
const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
let view!: ReactTestRenderer;
const btn = (label: string) => view.root.findAllByType('button').find(b => text(b).includes(label))!;
const gridTrade = (price: number, id: string, lot: string) => ({ account: h.account, contract: { code: '2330' },
    order: { id, account: h.account, action: 'Buy', price, custom_field: 'sjgrid', order_lot: lot }, status: { status: 'Submitted' } }) as unknown as Trade;

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    m.confirm.mockResolvedValue(true);
    let n = 0;
    m.stock.mockImplementation(async () => ({ order: { id: `placed-${++n}` } }));
    m.cancelMany.mockImplementation(async (ids: string[]) => ids.map(() => ({ status: 'fulfilled', value: {} })));
    h.odd = { tick: { close: '100' } };
    h.selected = h.account; h.accounts = [h.account, h.accountB];
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    m.cancel.mockResolvedValue({});
    m.risk.mockReturnValue(null);
});
afterEach(async () => { await act(async () => view?.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('lays an odd-lot grid in shares as IntradayOdd LMT ROD, confirmed and risk-checked in 股', async () => {
    await act(async () => { view = create(createElement(GridTicket, { contract, trades: [] })); });
    await act(async () => { btn('盤中零股').props.onClick(); });
    const qty = view.root.findAllByType('input')[3]!; // 起始檔距, 檔數, 間隔, 每檔量
    await act(async () => { qty.props.onChange({ target: { value: '250' } }); });
    expect(text(view.root)).toContain('每檔量(股)');
    expect(text(view.root)).toContain('× 250 股・盤中零股限價');
    await act(async () => { btn('解鎖鋪單').props.onClick(); });
    await act(async () => { await btn('鋪 ').props.onClick(); });
    expect(m.risk).toHaveBeenCalledWith(1250, 'IntradayOdd');
    expect(m.confirm.mock.calls[0]![0]).toMatchObject({ unit: '股', quantity: 1250, note: expect.stringContaining('盤中零股') });
    expect(m.stock).toHaveBeenCalledTimes(5);
    expect(m.stock.mock.calls.every(c => c[1].order_lot === 'IntradayOdd' && c[1].quantity === 250 && c[1].price_type === 'LMT' && c[1].order_type === 'ROD')).toBe(true);
});

it('odd-lot follow ignores whole-lot grid orders at the same prices', async () => {
    // whole-lot grid orders at 99/98 must not count as the odd grid, and the stray whole-lot 90 is not cancelled
    const trades = [gridTrade(99, 'c99', 'Common'), gridTrade(98, 'c98', 'Common'), gridTrade(90, 'c90', 'Common'), gridTrade(99, 'o99', 'IntradayOdd')];
    await act(async () => { view = create(createElement(GridTicket, { contract, trades })); });
    await act(async () => { btn('盤中零股').props.onClick(); });
    await act(async () => { btn('解鎖鋪單').props.onClick(); });
    await act(async () => { btn('動態跟隨現價').props.onClick(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2600); });
    expect(m.cancel).not.toHaveBeenCalled();
    expect(m.stock.mock.calls.map(c => [c[1].price, c[1].order_lot])).toEqual([[98, 'IntradayOdd'], [97, 'IntradayOdd'], [96, 'IntradayOdd'], [95, 'IntradayOdd']]);
    expect(m.risk).toHaveBeenCalledWith(1, 'IntradayOdd');
});

it('a batch keeps the unit and quantity it was confirmed with; unit buttons are locked while sending', async () => {
    let approve!: (v: boolean) => void;
    m.confirm.mockReturnValue(new Promise<boolean>(r => { approve = r; }));
    await act(async () => { view = create(createElement(GridTicket, { contract, trades: [] })); });
    await act(async () => { btn('盤中零股').props.onClick(); });
    await act(async () => { view.root.findAllByType('input')[3]!.props.onChange({ target: { value: '250' } }); });
    await act(async () => { btn('解鎖鋪單').props.onClick(); });
    let pending!: Promise<unknown>;
    await act(async () => { pending = btn('鋪 ').props.onClick(); });
    const unitBtn = (label: string) => view.root.findAll(n => n.type === 'button' && n.props.role === 'radio' && text(n) === label)[0]!;
    expect(unitBtn('整股').props.disabled).toBe(true);
    expect(unitBtn('盤中零股').props['aria-checked']).toBe(true);
    // even if the quantity is edited during the confirm, the batch sends what was confirmed
    await act(async () => { view.root.findAllByType('input')[3]!.props.onChange({ target: { value: '7' } }); });
    await act(async () => { approve(true); await pending; });
    expect(m.stock).toHaveBeenCalledTimes(5);
    expect(m.stock.mock.calls.every(c => c[1].order_lot === 'IntradayOdd' && c[1].quantity === 250)).toBe(true);
    expect(unitBtn('整股').props.disabled).toBe(false);
    expect(unitBtn('整股').props['aria-checked']).toBe(false);
});

it('a follow cycle in flight when the unit is switched sends nothing in the new unit', async () => {
    let release!: () => void;
    m.cancel.mockReturnValue(new Promise(r => { release = () => r({}); }));
    // this panel's own odd stray at 90 makes the cycle cancel first, and that cancel hangs
    recordGridOwner(h.account as Account, 'o90', 'grid:p1');
    const trades = [gridTrade(90, 'o90', 'IntradayOdd')];
    await act(async () => { view = create(createElement(GridTicket, { panelId: 'p1', contract, trades })); });
    await act(async () => { btn('盤中零股').props.onClick(); });
    await act(async () => { view.root.findAllByType('input')[3]!.props.onChange({ target: { value: '300' } }); });
    await act(async () => { btn('解鎖鋪單').props.onClick(); });
    await act(async () => { btn('動態跟隨現價').props.onClick(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2600); });
    expect(m.cancel).toHaveBeenCalledWith('o90');
    // user switches to 整股 while the cycle waits on the cancel
    await act(async () => { view.root.findAll(n => n.type === 'button' && n.props.role === 'radio' && text(n) === '整股')[0]!.props.onClick(); });
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(3000); });
    expect(m.stock).not.toHaveBeenCalled();
});

it('a follow cycle uses the quantity it started with', async () => {
    await act(async () => { view = create(createElement(GridTicket, { contract, trades: [] })); });
    await act(async () => { btn('盤中零股').props.onClick(); });
    await act(async () => { view.root.findAllByType('input')[3]!.props.onChange({ target: { value: '300' } }); });
    let first!: () => void;
    m.stock.mockImplementationOnce(() => new Promise(r => { first = () => r({ order: { id: 'p1' } }); }));
    await act(async () => { btn('解鎖鋪單').props.onClick(); });
    await act(async () => { btn('動態跟隨現價').props.onClick(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2600); });
    await act(async () => { view.root.findAllByType('input')[3]!.props.onChange({ target: { value: '5' } }); });
    await act(async () => { first(); await vi.advanceTimersByTimeAsync(10); });
    expect(m.stock.mock.calls.slice(0, 4).map(c => [c[1].quantity, c[1].order_lot])).toEqual(Array(4).fill([300, 'IntradayOdd']));
});

it('odd-lot grid prices come from the odd-lot market only; without odd quotes it waits', async () => {
    const r = (p: number) => Math.round(p);
    expect(gridBasePrice(true, { tick: { close: 100 } }, undefined, 100, r)).toBeNull();
    expect(gridBasePrice(true, { tick: { close: 100 } }, { bidask: { bid_price: ['96'], ask_price: ['98'] } }, 100, r)).toBe(97);
    expect(gridBasePrice(true, { tick: { close: 100 } }, { bidask: { bid_price: [], ask_price: ['98'] } }, 100, r)).toBe(98);
    expect(gridBasePrice(true, { tick: { close: 100 } }, { tick: { close: 95 } }, 100, r)).toBe(95);
    expect(gridBasePrice(false, { tick: { close: 100 } }, { tick: { close: 95 } }, 90, r)).toBe(100);
    h.odd = undefined;
    await act(async () => { view = create(createElement(GridTicket, { contract, trades: [] })); });
    await act(async () => { btn('盤中零股').props.onClick(); });
    await act(async () => { btn('解鎖鋪單').props.onClick(); });
    const lay = btn('等待零股行情');
    expect(lay.props.disabled).toBe(true);
    await act(async () => { btn('動態跟隨現價').props.onClick(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(m.stock).not.toHaveBeenCalled();
});

it('全撤 only cancels this panel\'s own grid orders of its unit and account', async () => {
    m.confirm.mockResolvedValue(true);
    const views: ReactTestRenderer[] = [];
    const rootOf = (i: number) => views[i]!.root;
    const b = (i: number, label: string) => rootOf(i).findAllByType('button').find(x => text(x).includes(label))!;
    for (let i = 0; i < 2; i++) await act(async () => { views.push(create(createElement(GridTicket, { contract, trades: [] }))); });
    // panel 0: odd grid; panel 1: whole-lot grid — same symbol, same account
    await act(async () => { b(0, '盤中零股').props.onClick(); });
    await act(async () => { b(0, '解鎖鋪單').props.onClick(); });
    await act(async () => { await b(0, '鋪 ').props.onClick(); });
    await act(async () => { b(1, '解鎖鋪單').props.onClick(); });
    await act(async () => { await b(1, '鋪 ').props.onClick(); });
    const placed = m.stock.mock.results.map((r, i) => ({ id: `placed-${i + 1}`, lot: m.stock.mock.calls[i]![1].order_lot, price: m.stock.mock.calls[i]![1].price }));
    // a third panel (another instance) at the same unit as panel 1, plus an unowned leftover
    const trades = [...placed.map(p => gridTrade(p.price, p.id, p.lot)), gridTrade(80, 'leftover', 'Common')];
    for (let i = 0; i < 2; i++) await act(async () => { views[i]!.update(createElement(GridTicket, { contract, trades })); });
    await act(async () => { await b(0, '全撤').props.onClick(); });
    expect(m.cancelMany).toHaveBeenCalledTimes(1);
    expect(m.cancelMany.mock.calls[0]![0]).toEqual(placed.filter(p => p.lot === 'IntradayOdd').map(p => p.id));
    await act(async () => { await b(1, '全撤').props.onClick(); });
    expect(m.cancelMany.mock.calls[1]![0]).toEqual(placed.filter(p => p.lot === 'Common').map(p => p.id));
    for (const v of views) await act(async () => v.unmount());
});

it('after a reload, follow only cancels orders this panel owns; ownerless and other-panel orders are never cancelled', async () => {
    // before the reload: panel p1 owned 90 (stray) and 99; panel p2 owns 97; 96 is an ownerless leftover
    recordGridOwner(h.account as Account, 'mine90', 'grid:p1');
    recordGridOwner(h.account as Account, 'mine99', 'grid:p1');
    recordGridOwner(h.account as Account, 'p2-97', 'grid:p2');
    const trades = [gridTrade(90, 'mine90', 'IntradayOdd'), gridTrade(99, 'mine99', 'IntradayOdd'),
        gridTrade(97, 'p2-97', 'IntradayOdd'), gridTrade(96, 'orphan96', 'IntradayOdd'), gridTrade(80, 'orphan80', 'IntradayOdd')];
    // "reload": a fresh module state is not needed — ownership comes from storage, the panel id is the block id
    await act(async () => { view = create(createElement(GridTicket, { panelId: 'p1', contract, trades })); });
    await act(async () => { btn('盤中零股').props.onClick(); });
    await act(async () => { btn('解鎖鋪單').props.onClick(); });
    await act(async () => { btn('動態跟隨現價').props.onClick(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2600); });
    // desired 99..95: only its own stray 90 is cancelled; orphan 80 and p2's 97 are left alone
    expect(m.cancel.mock.calls.map(c => c[0])).toEqual(['mine90']);
    // 99 (own) and 96 (ownerless) count as present; 97 belongs to p2, so p1 places its own there
    expect(m.stock.mock.calls.map(c => c[1].price).sort()).toEqual([95, 97, 98]);
    // new orders are recorded for p1 and survive in storage
    expect(gridOwnerOf(h.account as Account, 'placed-1')).toBe('grid:p1');
});

it('全撤 uses the account selected at click time and cancels nothing without an account', async () => {
    await act(async () => { view = create(createElement(GridTicket, { panelId: 'p1', contract, trades: [] })); });
    await act(async () => { btn('解鎖鋪單').props.onClick(); });
    await act(async () => { await btn('鋪 ').props.onClick(); });
    const trades = m.stock.mock.calls.map((c, i) => gridTrade(c[1].price, `placed-${i + 1}`, 'Common'));
    await act(async () => { view.update(createElement(GridTicket, { panelId: 'p1', contract, trades })); });
    // switch the selected account A → B: A's grid is not B's
    h.selected = h.accountB;
    await act(async () => { await btn('全撤').props.onClick(); });
    expect(m.cancelMany).not.toHaveBeenCalled();
    // no usable account: nothing is cancelled and the reason is shown
    h.selected = null;
    await act(async () => { await btn('全撤').props.onClick(); });
    expect(m.cancelMany).not.toHaveBeenCalled();
    expect(m.notify.mock.calls.at(-1)![0]).toMatchObject({ kind: 'err', body: expect.stringContaining('沒有可用的下單帳戶') });
    // back to A: exactly this panel's five orders
    h.selected = h.account;
    await act(async () => { view.update(createElement(GridTicket, { panelId: 'p1', contract, trades })); });
    await act(async () => { await btn('全撤').props.onClick(); });
    expect(m.cancelMany.mock.calls[0]![0]).toEqual(trades.map(t => t.order.id));
});
