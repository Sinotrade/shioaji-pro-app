// issue #139 — the order ticket's account is fixed before confirmation; a
// selection change (e.g. synced from another window) aborts instead of
// rerouting the order
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';
import type { ContractInfo } from '../lib/types/contract';
const m = vi.hoisted(() => ({ selected: 'A', confirm: vi.fn(), future: vi.fn(), stock: vi.fn(), confirmOn: true, dropped: false }));
const h = vi.hoisted(() => {
    const accounts = ['A', 'B'].map(id => ({ account_type: 'F', broker_id: 'BR', account_id: `99887766${id}`, signed: true, person_id: '', username: '' }));
    return { accounts };
});
const accounts = h.accounts as Account[];
vi.mock('../lib/account-store', () => {
    const state = () => ({ accounts: m.dropped ? h.accounts.filter(a => !a.account_id.endsWith(m.selected)) : h.accounts, selectedStock: null, selectedFutures: h.accounts.find(a => a.account_id.endsWith(m.selected)) ?? null, loaded: true });
    return { useAccounts: state, getAccountState: state, selectAccount: vi.fn() };
});
vi.mock('../lib/order-confirm', () => ({ requestOrderConfirm: m.confirm, accountConfirmLabel: (a: Account) => `${a.broker_id}-${a.account_id}` }));
vi.mock('../lib/risk', () => ({ checkOrderAllowed: () => null, getRiskSettings: () => ({ confirmManualOrders: m.confirmOn }) }));
vi.mock('../lib/shioaji', () => ({ fetchInfo: () => new Promise(() => undefined), placeFuturesOrder: m.future, placeStockOrder: m.stock }));
vi.mock('../lib/trade', () => ({ notify: vi.fn() }));
vi.mock('../lib/bracket', () => ({ ensureBracketHost: vi.fn(), registerBracket: vi.fn(), registrationFailureText: String, validateBracketRequest: () => null }));
vi.mock('./bracket-status', () => ({ BracketStatusList: () => null }));
vi.mock('../lib/protection-env', () => ({ currentProtectionEnv: () => 'sim' }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => ({ tick: { close: '100' } }), useTradingLive: () => true }));
vi.mock('../lib/price-sync', () => ({ usePickedPrice: () => null }));
vi.mock('../lib/allocation', () => ({ allocateByRatio: (t: number, w: number[]) => w.map(() => t), loadAllocPresets: () => [], saveAllocPreset: () => [], deleteAllocPreset: () => [] }));
import { OrderTicket } from './order-ticket';

const contract = { code: 'TMF', name: 'TMF', security_type: 'FUT', exchange: 'TAIFEX', reference: 100 } as unknown as ContractInfo;
const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
let view!: ReactTestRenderer;
const exec = () => view.root.findAllByType('button').find(b => /買進下單|確認買進/.test(text(b)))!;
const feedback = () => view.root.findAll(n => n.type === 'span').map(text).join('|');

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    m.selected = 'A'; m.confirmOn = true; m.dropped = false;
    m.confirm.mockResolvedValue(true);
    m.future.mockResolvedValue({ status: { status: 'Submitted' }, order: { id: 'o1', seqno: '1' } });
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

const armAndSend = async () => {
    await act(async () => { view = create(createElement(OrderTicket, { contract, onPlaced: vi.fn() })); });
    await act(async () => { await exec().props.onClick(); });
    await act(async () => { await exec().props.onClick(); });
};

it('sends with the account captured before confirmation and shows it in the dialog', async () => {
    await armAndSend();
    expect(m.confirm.mock.calls[0]![0]).toMatchObject({ accountLabel: 'BR-99887766A' });
    expect(m.future).toHaveBeenCalledTimes(1);
    expect(m.future.mock.calls[0]![2]).toBe(accounts[0]);
});

it('aborts when the selection changes remotely while the confirmation is open', async () => {
    m.confirm.mockImplementation(async () => { m.selected = 'B'; return true; });
    await armAndSend();
    expect(m.future).not.toHaveBeenCalled();
    expect(feedback()).toContain('確認期間帳戶已變更');
});

it('aborts when the captured account becomes unavailable during confirmation', async () => {
    m.confirm.mockImplementation(async () => { m.dropped = true; return true; });
    await armAndSend();
    expect(m.future).not.toHaveBeenCalled();
});

it('passes the captured account explicitly even without the confirmation dialog', async () => {
    m.confirmOn = false;
    await armAndSend();
    expect(m.future.mock.calls[0]![2]).toBe(accounts[0]);
});

it('a selection change while armed disarms the ticket', async () => {
    await act(async () => { view = create(createElement(OrderTicket, { contract, onPlaced: vi.fn() })); });
    await act(async () => { await exec().props.onClick(); });
    expect(text(exec())).toContain('確認買進');
    m.selected = 'B';
    await act(async () => { view.update(createElement(OrderTicket, { contract, onPlaced: vi.fn() })); });
    expect(text(exec())).toBe('買進下單');
    await act(async () => { await exec().props.onClick(); });
    expect(m.confirm).not.toHaveBeenCalled();
    expect(m.future).not.toHaveBeenCalled();
});
