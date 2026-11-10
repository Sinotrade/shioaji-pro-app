import '../test/mock-order-reconciliation';
// #263 閃電下單的觸價單帶面板的信用條件：現股當沖先賣的觸賣以當沖先賣掛單、
// 觸買照下單面板規則是現股買進；融資兩邊、融券只賣；借券與不能用的一邊不掛
// （不改成現股）。條件在建立時寫進觸價單，之後切換面板不影響已掛的單。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';
import type { ContractInfo } from '../lib/types/contract';
import type { FlashCredit } from '../lib/flash-account';

const m = vi.hoisted(() => ({ add: vi.fn(), place: vi.fn(), notify: vi.fn(), post: vi.fn(), store: new Map<string, string>() }));
const accounts: Account[] = [
    { account_type: 'S', broker_id: 'BR', account_id: 'A1234', signed: true, person_id: '', username: '' },
    { account_type: 'F', broker_id: 'BR', account_id: 'F5678', signed: true, person_id: '', username: '' },
];
vi.mock('../lib/account-store', () => ({ ensureAccounts: () => undefined, useAccounts: () => ({ loaded: true, accounts, selectedStock: accounts[0], selectedFutures: accounts[1] }) }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => undefined, useTradingLive: () => true }));
vi.mock('../hooks/use-display-book', () => ({ useDisplayBook: () => ({ quote: { tick: { close: '100', volume: 1 } }, snapshot: { close: 100 }, book: undefined }) }));
vi.mock('../hooks/use-flash-ladder', () => ({ useFlashLadder: () => ({ marks: new Map(), protectedQty: 0, background: false }) }));
vi.mock('../lib/flash-conditional', () => ({ flashAddTrigger: m.add, flashStopProtections: async () => ({ stopped: 0, blocked: [], failed: [], restore: [] }) }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: vi.fn(), cancelOrders: vi.fn() }));
vi.mock('../lib/trade', () => ({ notify: m.notify, placeQuickOrder: m.place, placeStockExitByShares: vi.fn() }));
vi.mock('../lib/stream', () => ({ getAliasFor: () => undefined }));
vi.mock('../lib/tick-bands', () => ({ useTickBandsVersion: () => 0 }));
vi.mock('../lib/api', () => ({ apiPost: m.post }));
vi.mock('../lib/runtime', () => ({ getApiBase: () => 'fixture' }));
vi.mock('../lib/utils/ticksize', () => ({ roundToTick: (_c: unknown, p: number) => p, stepPrice: (_c: unknown, p: number, step: number) => p + step }));
import { FlashOrder } from './flash-order';
import { resetCreditEnquireCache } from '../lib/credit-eligibility';

const stk = { code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', day_trade: 'Yes', reference: 100, limit_up: 110, limit_down: 90 } as unknown as ContractInfo;
const onlyBuy = { ...stk, code: '1101', name: '台泥', day_trade: 'OnlyBuy' } as ContractInfo;
const enquire = (code: string) => [{ stock_id: code, system: 'ALL', update_time: '', margin_unit: 100, short_unit: 50, margin_loan_ratio: 60, short_margin_ratio: 90 }];
const text = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : text(c))).join('');
const roots: ReactTestRenderer[] = [];
const button = (r: ReactTestRenderer, label: string) => r.root.findAllByType('button').find(b => text(b) === label);
const props = (contract: ContractInfo, credit: FlashCredit) => ({ contract, trades: [], positions: [], credit, onCreditChange: vi.fn() });
const mount = async (contract: ContractInfo, credit: FlashCredit) => {
    let r!: ReactTestRenderer;
    await act(async () => {
        r = create(createElement(FlashOrder, props(contract, credit)),
            { createNodeMock: () => ({ getBoundingClientRect: () => ({ top: 0 }), clientHeight: 21 * 22, addEventListener() {}, removeEventListener() {} }) });
    });
    roots.push(r);
    await act(async () => { await Promise.resolve(); });
    return r;
};
const show = async (r: ReactTestRenderer, contract: ContractInfo, credit: FlashCredit) => {
    await act(async () => { r.update(createElement(FlashOrder, props(contract, credit))); });
};
const arm = async (r: ReactTestRenderer) => { await act(async () => { button(r, '啟用閃電下單')!.props.onClick(); }); };
// the outer 觸買／觸賣 columns, rows 110 … 90 top to bottom
const trigCell = (r: ReactTestRenderer, side: 'buy' | 'sell', price: number) =>
    r.root.findAll(n => n.type === 'div' && n.props['data-trigger'] === side)[110 - price]!;
const trig = async (r: ReactTestRenderer, side: 'buy' | 'sell', price: number) => {
    await act(async () => { await trigCell(r, side, price).props.onClick(); });
};
const errors = () => m.notify.mock.calls.map(([n]) => n as { kind: string; title: string; body: string }).filter(n => n.kind === 'err');
const DT: FlashCredit = { cond: 'Cash', daytradeShort: true };

beforeEach(() => {
    vi.clearAllMocks();
    m.store.clear();
    resetCreditEnquireCache();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: (k: string) => m.store.get(k) ?? null, setItem: (k: string, v: string) => { m.store.set(k, v); } });
    vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    m.add.mockResolvedValue({ id: 'tg-1' });
    m.post.mockImplementation(async (_p: string, body: { contracts: { code: string }[] }) => enquire(body.contracts[0]!.code));
});
afterEach(async () => {
    for (const r of roots.splice(0)) await act(async () => r.unmount());
    vi.unstubAllGlobals();
});

it('現股當沖先賣: 觸賣 is placed as a 當沖先賣 entry; 觸買 is a cash buy (as on the ticket)', async () => {
    const r = await mount(stk, DT);
    await arm(r);
    expect(trigCell(r, 'sell', 95).props.title).toContain('賣出（現股當沖先賣）');
    expect(trigCell(r, 'buy', 105).props.title).not.toContain('當沖');
    await trig(r, 'sell', 95);
    await trig(r, 'buy', 105);
    expect(errors()).toEqual([]);
    expect(m.add).toHaveBeenCalledTimes(2);
    const [sell, contract, account] = m.add.mock.calls[0]!;
    expect(sell).toMatchObject({ code: '2330', action: 'Sell', condition: 'below', price: 95, role: 'entry', daytradeShort: true });
    expect(sell.orderCond).toBeUndefined();
    expect([contract.code, account.account_id]).toEqual(['2330', 'A1234']);
    const buy = m.add.mock.calls[1]![0];
    expect(buy).toMatchObject({ action: 'Buy', condition: 'above', price: 105, role: 'entry' });
    expect(buy.daytradeShort).toBeUndefined();
    expect(buy.orderCond).toBeUndefined();
});

it('the condition is fixed when placed: switching the panel back to 現股 does not touch the placed one', async () => {
    const r = await mount(stk, DT);
    await arm(r);
    await trig(r, 'sell', 95);
    const placed = structuredClone(m.add.mock.calls[0]![0]);
    await show(r, stk, { cond: 'Cash', daytradeShort: false });
    await arm(r);
    await trig(r, 'sell', 94);
    expect(m.add.mock.calls[0]![0]).toEqual(placed);
    expect(placed.daytradeShort).toBe(true);
    expect(m.add.mock.calls[1]![0].daytradeShort).toBeUndefined();
});

it('融資 both ways; 融券 sells only — its 觸買 column is off and never places a cash buy', async () => {
    const r = await mount(stk, { cond: 'MarginTrading', daytradeShort: false });
    await arm(r);
    await trig(r, 'buy', 105);
    expect(m.add.mock.calls[0]![0]).toMatchObject({ action: 'Buy', orderCond: 'MarginTrading' });
    const s = await mount(stk, { cond: 'ShortSelling', daytradeShort: false });
    await arm(s);
    expect(trigCell(s, 'buy', 105).props.title).toContain('融券、借券只能賣出');
    await trig(s, 'buy', 105);
    await trig(s, 'sell', 95);
    expect(m.add).toHaveBeenCalledTimes(2);
    expect(m.add.mock.calls[1]![0]).toMatchObject({ action: 'Sell', orderCond: 'ShortSelling' });
    expect(errors().map(e => e.body)).toEqual([expect.stringContaining('融券、借券只能賣出')]);
});

it('借券 and a stock that cannot day-trade stay refused, with the exact reason', async () => {
    const r = await mount(stk, { cond: 'SBLShort', daytradeShort: false });
    await arm(r);
    expect(trigCell(r, 'sell', 95).props.title).toContain('不支援借券賣出');
    await trig(r, 'sell', 95);
    const d = await mount(onlyBuy, DT);
    await arm(d);
    await trig(d, 'sell', 95);
    expect(m.add).not.toHaveBeenCalled();
    expect(errors().map(e => e.body)).toEqual([expect.stringContaining('不支援借券賣出'), expect.stringContaining('不能現沖先賣')]);
    // the buy side of a 現沖 panel is a cash buy and still works there
    await trig(d, 'buy', 105);
    expect(m.add).toHaveBeenCalledTimes(1);
});
