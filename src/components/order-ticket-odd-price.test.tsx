// #204 下單面板盤中零股帶價與括號單參考只看零股行情；沒有零股行情時不帶價、括號單等待
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';
import type { ContractInfo } from '../lib/types/contract';
const m = vi.hoisted(() => ({ confirm: vi.fn(), stock: vi.fn(), risk: vi.fn(), validate: vi.fn(), odd: undefined as unknown }));
const h = vi.hoisted(() => {
    const account = { account_type: 'S', broker_id: 'BR', account_id: '99887766A', signed: true, person_id: '', username: '' };
    return { account, second: { ...account, account_id: '11223344B' }, accounts: [account] as unknown[] };
});
vi.mock('../lib/account-store', () => {
    const state = () => ({ accounts: h.accounts, selectedStock: h.account, selectedFutures: null, loaded: true });
    return { useAccounts: state, getAccountState: state, selectAccount: vi.fn() };
});
vi.mock('../lib/order-confirm', () => ({ requestOrderConfirm: m.confirm, accountConfirmLabel: (a: Account) => `${a.broker_id}-${a.account_id}` }));
vi.mock('../lib/risk', () => ({ checkOrderAllowed: m.risk, getRiskSettings: () => ({ confirmManualOrders: true }) }));
vi.mock('../lib/shioaji', () => ({ fetchInfo: () => new Promise(() => undefined), placeFuturesOrder: vi.fn(), placeStockOrder: m.stock }));
vi.mock('../lib/trade', () => ({ notify: vi.fn() }));
vi.mock('../lib/bracket', () => ({ assertBracketAdmission: vi.fn(), ensureBracketHost: vi.fn(), registerBracket: vi.fn(), registrationFailureText: String, validateBracketRequest: (...a: unknown[]) => m.validate(...a) }));
vi.mock('./bracket-status', () => ({ BracketStatusList: () => null }));
vi.mock('../lib/protection-env', () => ({ currentProtectionEnv: () => 'sim' }));
vi.mock('../hooks/use-stream', () => ({ useQuote: (code: string | null, o?: { oddLot?: boolean }) => (o?.oddLot ? (code ? m.odd : undefined) : { tick: { close: '105' } }), useTradingLive: () => true }));
vi.mock('../lib/utils/ticksize', () => ({ roundToTick: (_c: unknown, p: number) => Math.round(p), stepPrice: (_c: unknown, p: number, s: number) => p + s }));
vi.mock('../lib/price-sync', () => ({ usePickedPrice: () => null }));
vi.mock('../lib/allocation', () => ({ allocateByRatio: (t: number, w: number[]) => w.map(() => t), loadAllocPresets: () => [], saveAllocPreset: () => [], deleteAllocPreset: () => [] }));
import { OrderTicket } from './order-ticket';

const contract = { code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', reference: 100, day_trade: 'Yes' } as unknown as ContractInfo;
const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
let view!: ReactTestRenderer;
const btn = (label: string) => view.root.findAllByType('button').find(b => text(b) === label)!;
const exec = () => view.root.findAllByType('button').find(b => /(買進|賣出)下單|確認(買進|賣出)/.test(text(b)))!;
const qtyInput = () => view.root.findAll(n => n.type === 'input' && String(n.props['aria-label'] ?? '').startsWith('數量'))[0]!;

beforeEach(() => {
    vi.clearAllMocks();
    h.accounts = [h.account];
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    m.confirm.mockResolvedValue(true);
    m.risk.mockReturnValue(null);
    m.validate.mockReturnValue(null);
    m.odd = undefined;
    m.stock.mockResolvedValue({ status: { status: 'Submitted' }, order: { id: 'o1', seqno: '1' } });
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

const priceInput = () => view.root.findAll(n => n.type === 'input' && n.props.className !== undefined && (n.props.value === '' || /^[0-9.]+$/.test(String(n.props.value))) && n.props.disabled === false)[0]!;

it('no odd-lot quote yet: the round-lot price is not carried into the odd-lot limit and the panel says it is waiting', async () => {
    await act(async () => { view = create(createElement(OrderTicket, { contract, onPlaced: vi.fn() })); });
    expect(priceInput().props.value).toBe('105'); // round lot prefilled from the round-lot tick
    await act(async () => { btn('盤中零股').props.onClick(); });
    expect(priceInput().props.value).toBe('');
    expect(text(view.root)).toContain('等待零股行情（不自動帶價）');
});

it.each([
    ['odd last trade', { tick: { close: '99' } }, '99'],
    ['mid of odd best bid/ask', { bidask: { bid_price: ['96'], ask_price: ['98'] } }, '97'],
    ['single odd side', { bidask: { bid_price: [], ask_price: ['98'] } }, '98'],
])('prefills the odd-lot limit from the %s, never the round-lot 105', async (_l, odd, expected) => {
    m.odd = odd;
    await act(async () => { view = create(createElement(OrderTicket, { contract, onPlaced: vi.fn() })); });
    await act(async () => { btn('盤中零股').props.onClick(); });
    expect(priceInput().props.value).toBe(expected);
});

it('an odd-lot bracket without any odd-lot quote is refused with 等待零股行情 and nothing is sent', async () => {
    await act(async () => { view = create(createElement(OrderTicket, { contract, onPlaced: vi.fn() })); });
    await act(async () => { btn('盤中零股').props.onClick(); });
    await act(async () => { priceInput().props.onChange({ target: { value: '100' } }); });
    await act(async () => { btn('停損停利保護').props.onClick(); });
    await act(async () => { await exec().props.onClick(); });
    await act(async () => { await exec().props.onClick(); });
    expect(m.stock).not.toHaveBeenCalled();
    expect(m.validate).not.toHaveBeenCalled();
    expect(text(view.root)).toContain('等待零股行情');
});

it('odd 500 股 → futures → stock: quantity resets per unit and instrument class', async () => {
    const fut = { code: 'TXFR1', name: '臺股期貨', security_type: 'FUT', exchange: 'TAIFEX', reference: 100 } as unknown as ContractInfo;
    await act(async () => { view = create(createElement(OrderTicket, { contract, onPlaced: vi.fn() })); });
    await act(async () => { btn('盤中零股').props.onClick(); });
    await act(async () => { qtyInput().props.onChange({ target: { value: '500' } }); });
    await act(async () => { view.update(createElement(OrderTicket, { contract: fut, onPlaced: vi.fn() })); });
    expect(qtyInput().props.value).toBe(1);
    expect(qtyInput().props['aria-label']).toBe('數量（口）');
    await act(async () => { view.update(createElement(OrderTicket, { contract, onPlaced: vi.fn() })); });
    expect(qtyInput().props.value).toBe(1);
    expect(qtyInput().props['aria-label']).toBe('數量（股）'); // restores the stock preference, with a safe quantity
    await act(async () => { qtyInput().props.onChange({ target: { value: '5' } }); });
    await act(async () => { view.update(createElement(OrderTicket, { contract: fut, onPlaced: vi.fn() })); });
    expect(qtyInput().props.value).toBe(1); // 5 股 never becomes 5 口
});
