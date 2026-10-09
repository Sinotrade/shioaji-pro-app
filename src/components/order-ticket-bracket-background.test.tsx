// #201 ② — who protects a new bracket is decided before the entry is sent:
// the setting off keeps the window's bracket exactly as before; on, a
// futures bracket goes to the background engine with the entry's trade id;
// a refusal sends no entry at all.
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../lib/types/contract';
const m = vi.hoisted(() => ({
    future: vi.fn(), owner: vi.fn(), create: vi.fn(), register: vi.fn(), host: vi.fn(), notify: vi.fn(),
}));
const h = vi.hoisted(() => ({
    accounts: [{ account_type: 'F', broker_id: 'F002000', account_id: '1234567', signed: true, person_id: '', username: '' }],
}));
vi.mock('../lib/account-store', () => {
    const state = () => ({ accounts: h.accounts, selectedStock: null, selectedFutures: h.accounts[0], loaded: true });
    return { useAccounts: state, getAccountState: state, selectAccount: vi.fn() };
});
vi.mock('../lib/order-confirm', () => ({ requestOrderConfirm: vi.fn(async () => true), accountConfirmLabel: () => 'acct' }));
vi.mock('../lib/risk', () => ({ checkOrderAllowed: () => null, getRiskSettings: () => ({ confirmManualOrders: false }) }));
vi.mock('../lib/shioaji', () => ({ fetchInfo: () => new Promise(() => undefined), placeFuturesOrder: m.future, placeStockOrder: vi.fn() }));
vi.mock('../lib/trade', () => ({ notify: m.notify }));
vi.mock('../lib/bracket', () => ({ ensureBracketHost: m.host, registerBracket: m.register, registrationFailureText: String,
    validateBracketRequest: () => null }));
vi.mock('./bracket-status', () => ({ BracketStatusList: () => null }));
vi.mock('./background-bracket-status', () => ({ BackgroundBracketList: () => null }));
vi.mock('../lib/execution/background', () => ({ backgroundOwnerForNew: m.owner, createBackgroundBracket: m.create }));
vi.mock('../lib/protection-env', () => ({ currentProtectionEnv: () => 'http://127.0.0.1:1|simulation' }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => ({ tick: { close: '100' } }), useTradingLive: () => true }));
vi.mock('../lib/price-sync', () => ({ usePickedPrice: () => null }));
vi.mock('../lib/allocation', () => ({ allocateByRatio: (t: number, w: number[]) => w.map(() => t), loadAllocPresets: () => [],
    saveAllocPreset: () => [], deleteAllocPreset: () => [] }));
import { OrderTicket } from './order-ticket';

const contract = { code: 'TXFR1', target_code: 'TXFJ6', name: 'TXF', security_type: 'FUT', exchange: 'TAIFEX', reference: 100 } as unknown as ContractInfo;
const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
let view!: ReactTestRenderer;
const button = (re: RegExp) => view.root.findAllByType('button').find(b => re.test(text(b)))!;
const feedback = () => view.root.findAll(n => n.type === 'span').map(text).join('|');

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    m.future.mockResolvedValue({ status: { status: 'Submitted' }, order: { id: 'T-entry', seqno: 'S1', ordno: '' },
        contract: { code: 'TXFJ6', target_code: 'TXFJ6' } });
    m.create.mockResolvedValue('created');
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

async function sendBracket() {
    await act(async () => { view = create(createElement(OrderTicket, { contract, onPlaced: vi.fn() })); });
    await act(async () => { button(/停損停利保護/).props.onClick(); });
    const stop = view.root.findAll(n => n.type === 'input' && n.props.placeholder === '停損價')[0]!;
    await act(async () => { stop.props.onChange({ target: { value: '95' } }); });
    await act(async () => { await button(/買進下單|確認買進/).props.onClick(); });
    await act(async () => { await button(/買進下單|確認買進/).props.onClick(); });
}

it('setting off: the window protects it exactly as before', async () => {
    m.owner.mockResolvedValue('window');
    await sendBracket();
    expect(m.host).toHaveBeenCalledOnce();
    expect(m.future).toHaveBeenCalledOnce();
    expect(m.register).toHaveBeenCalledOnce();
    expect(m.create).not.toHaveBeenCalled();
});

it('setting on: the background engine protects it with the entry trade id', async () => {
    m.owner.mockResolvedValue('background');
    await sendBracket();
    expect(m.host).not.toHaveBeenCalled();
    expect(m.register).not.toHaveBeenCalled();
    const req = m.create.mock.calls[0]![0];
    expect(req).toMatchObject({ side: 'Buy', stop: 95, take: null,
        entry: { tradeId: 'T-entry', seqno: 'S1', ordno: null, sentAt: expect.any(Number) },
        binding: { env: 'simulation', serverId: 'http://127.0.0.1:1',
            account: { accountType: 'F', brokerId: 'F002000', accountId: '1234567' },
            contract: { quoteCode: 'TXFR1', orderCode: 'TXFJ6', securityType: 'FUT' } } });
    expect(req.id).toMatch(/^bkt-/);
});

it('the background unavailable: no entry is sent', async () => {
    m.owner.mockResolvedValue({ refused: '背景執行目前無法使用' });
    await sendBracket();
    expect(m.future).not.toHaveBeenCalled();
    expect(feedback()).toContain('進場單未送出');
});

it('the background going away while confirming: no entry is sent', async () => {
    m.owner.mockResolvedValueOnce('background').mockResolvedValueOnce({ refused: '背景執行尚未連上目前的伺服器' });
    await sendBracket();
    expect(m.owner.mock.calls[1]![0]).toEqual({ liveOn: 'http://127.0.0.1:1|simulation' });
    expect(m.future).not.toHaveBeenCalled();
    expect(feedback()).toContain('進場單未送出');
});

it('a bracket the engine refused after the entry went out is said plainly, never resent', async () => {
    m.owner.mockResolvedValue('background');
    m.create.mockResolvedValue({ refused: '這張進場單已有括號單保護' });
    await sendBracket();
    expect(m.future).toHaveBeenCalledOnce();
    expect(feedback()).toContain('背景括號單未建立');
    expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({ title: '括號單保護未確認' }));
});
