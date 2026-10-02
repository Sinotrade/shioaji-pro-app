// issue #139 — the order ticket's account is fixed before confirmation; a
// selection change in this window while the dialog is open aborts instead of
// rerouting the order
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';
import type { ContractInfo } from '../lib/types/contract';
const m = vi.hoisted(() => ({ selected: 'A', confirm: vi.fn(), future: vi.fn(), stock: vi.fn(), confirmOn: true, dropped: false, ensure: vi.fn(), admissionGate: vi.fn(), register: vi.fn(), invalidOwner: false, writes: 0 }));
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
vi.mock('../lib/bracket', () => ({ assertBracketAdmission: m.admissionGate, ensureBracketHost: m.ensure, registerBracket: m.register, registrationFailureText: String, validateBracketRequest: () => null }));
vi.mock('./bracket-status', () => ({ BracketStatusList: () => null }));
vi.mock('../lib/protection-env', () => ({ currentProtectionEnv: () => 'sim' }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => ({ tick: { close: '100' } }), useTradingLive: () => true }));
vi.mock('../lib/price-sync', () => ({ usePickedPrice: () => null }));
vi.mock('../lib/allocation', () => ({ allocateByRatio: (t: number, w: number[]) => w.map(() => t), loadAllocPresets: () => [], saveAllocPreset: () => [], deleteAllocPreset: () => [] }));
import { OrderTicket } from './order-ticket';
import { beginServerInfoRequest, forgetServerInfo, observeServerInfo } from '../lib/server-info-store';

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
    m.selected = 'A'; m.confirmOn = true; m.dropped = false; m.invalidOwner = false; m.writes = 0;
    m.ensure.mockResolvedValue(r33Admission);
    m.admissionGate.mockImplementation(() => { if (m.invalidOwner) throw new Error('保護執行環境已變更'); });
    m.register.mockResolvedValue({ id: 'fixture-protection' });
    forgetServerInfo('');
    h.accounts.forEach(a => { a.signed = true; });
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

it('aborts when the selection changes while the confirmation is open', async () => {
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

it.each(['symbol', 'unmount'])('aborts a ticket confirmation on %s change', async change => {
    let release!: () => void;
    m.confirm.mockImplementationOnce(() => new Promise<boolean>(r => { release = () => r(true); }));
    const props = { contract, onPlaced: vi.fn() };
    await act(async () => { view = create(createElement(OrderTicket, props)); });
    await act(async () => { await exec().props.onClick(); });
    let pending!: Promise<unknown>;
    await act(async () => { pending = exec().props.onClick(); });
    if (change === 'unmount') await act(async () => view.unmount());
    else await act(async () => { view.update(createElement(OrderTicket, { ...props, contract: { ...contract, code: 'TXF' } })); });
    await act(async () => { release(); await pending; });
    expect(m.future).not.toHaveBeenCalled();
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

it('split orders stop after the mode changes to production mid-batch', async () => {
    h.accounts.forEach(a => { a.signed = false; });
    observeServerInfo(beginServerInfoRequest(), { simulation: true } as import('../lib/shioaji').ServerInfo);
    m.future.mockImplementationOnce(async () => {
        observeServerInfo(beginServerInfoRequest(), { simulation: false } as import('../lib/shioaji').ServerInfo);
        return { status: { status: 'Submitted' }, order: { id: 'o1', seqno: '1' } };
    });
    await act(async () => { view = create(createElement(OrderTicket, { contract, onPlaced: vi.fn() })); });
    const button = (label: string) => view.root.findAllByType('button').find(b => text(b).includes(label))!;
    await act(async () => { button('多帳戶分倉').props.onClick(); });
    await act(async () => { await button('分倉買進').props.onClick(); });
    await act(async () => { await button('確認分倉').props.onClick(); });
    expect(m.future).toHaveBeenCalledOnce();
    expect(feedback()).toContain('1/2');
});

it.each(['confirmation', 'first order', 'dispatch', 'unmount', 'switch back'])(
    'stops split orders when the symbol changes during %s', async phase => {
        let release!: () => void;
        const wait = new Promise<void>(r => { release = r; });
        const dispatched = vi.fn();
        const result = { status: { status: 'Submitted' }, order: { id: 'o1', seqno: '1' } };
        if (phase === 'confirmation') m.confirm.mockImplementationOnce(async () => { await wait; return true; });
        else m.future.mockImplementationOnce(async (_c, _o, _a, opts) => {
            if (phase !== 'dispatch') dispatched();
            await wait;
            if (phase === 'dispatch') { opts.beforeDispatch(); dispatched(); }
            return result;
        });
        const props = { contract, onPlaced: vi.fn() };
        await act(async () => { view = create(createElement(OrderTicket, props)); });
        const button = (label: string) => view.root.findAllByType('button').find(b => text(b).includes(label))!;
        await act(async () => { button('多帳戶分倉').props.onClick(); });
        await act(async () => { await button('分倉買進').props.onClick(); });
        let pending!: Promise<unknown>;
        await act(async () => { pending = button('確認分倉').props.onClick(); });
        if (phase === 'unmount') await act(async () => view.unmount());
        else {
            await act(async () => { view.update(createElement(OrderTicket, { ...props, contract: { ...contract, code: 'TXF' } })); });
            if (phase === 'switch back') await act(async () => { view.update(createElement(OrderTicket, props)); });
        }
        await act(async () => { release(); await pending; });
        expect(m.future).toHaveBeenCalledTimes(phase === 'confirmation' ? 0 : 1);
        expect(dispatched).toHaveBeenCalledTimes(phase === 'confirmation' || phase === 'dispatch' ? 0 : 1);
    },
);

const r33Admission = { owner: 'window' as const, env: 'sim', orderLot: 'Common' as const, contextGeneration: 1, ownerGeneration: 1, hostId: 'fixture-host' };
async function r33ProtectedTicket() {
    await act(async () => { view = create(createElement(OrderTicket, { contract: { ...contract, code: 'TXF' }, onPlaced: vi.fn() })); });
    const protection = view.root.findAllByType('button').find(b => text(b) === '停損停利保護')!;
    await act(async () => protection.props.onClick());
    const stop = view.root.find(n => n.type === 'input' && n.props.placeholder === '停損價');
    await act(async () => stop.props.onChange({ target: { value: '95' } }));
    await act(async () => { await exec().props.onClick(); });
    await act(async () => { await exec().props.onClick(); });
}
it('r33 ticket rejects owner changes during confirmation before the entry call', async () => {
    m.confirm.mockImplementationOnce(async () => { m.invalidOwner = true; return true; });
    await r33ProtectedTicket();
    expect(m.future).not.toHaveBeenCalled();expect(m.register).not.toHaveBeenCalled();
    expect(feedback()).toContain('保護執行環境已變更');
});
it('r33 ticket passes its admission to the actual delayed dispatch gate', async () => {
    m.future.mockImplementationOnce(async (_contract, _order, _account, dispatch) => {
        m.invalidOwner = true;dispatch.beforeDispatch();m.writes++;
        return { status: { status: 'Submitted' }, order: { id: 'never', seqno: 'never' } };
    });
    await r33ProtectedTicket();
    expect(m.writes).toBe(0);expect(m.register).not.toHaveBeenCalled();
});
it('r33 ticket post-entry registration receives exactly the original admission', async () => {
    m.future.mockImplementationOnce(async (_contract, _order, _account, dispatch) => {
        dispatch.beforeDispatch();m.writes++;m.invalidOwner = true;
        return { status: { status: 'Submitted' }, order: { id: 'fixture-entry', seqno: 'fixture-seq', ordno: 'fixture-ord' } };
    });
    await r33ProtectedTicket();
    expect(m.writes).toBe(1);expect(m.register.mock.calls[0]![1]).toBe(r33Admission);
    expect(m.register.mock.calls[0]![0]).toMatchObject({ orderId: 'fixture-entry', seqno: 'fixture-seq', ordno: 'fixture-ord', env: 'sim' });
});
it('r33 ticket never passes the financial confirmation rejection', async () => {
    m.confirm.mockResolvedValueOnce(false);await r33ProtectedTicket();
    expect(m.future).not.toHaveBeenCalled();expect(m.register).not.toHaveBeenCalled();
});
