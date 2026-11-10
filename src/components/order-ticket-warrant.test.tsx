// 權證下單面板
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';
import type { ContractInfo } from '../lib/types/contract';
const m = vi.hoisted(() => ({ confirm: vi.fn(), stock: vi.fn(), risk: vi.fn() }));
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
vi.mock('../lib/bracket', () => ({ ensureBracketHost: vi.fn(), registerBracket: vi.fn(), registrationFailureText: String, validateBracketRequest: () => null }));
vi.mock('./bracket-status', () => ({ BracketStatusList: () => null }));
vi.mock('../lib/protection-env', () => ({ currentProtectionEnv: () => 'sim' }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => ({ tick: { close: '100' } }), useTradingLive: () => true }));
vi.mock('../lib/price-sync', () => ({ usePickedPrice: () => null }));
vi.mock('../lib/allocation', () => ({ allocateByRatio: (t: number, w: number[]) => w.map(() => t), loadAllocPresets: () => [], saveAllocPreset: () => [], deleteAllocPreset: () => [] }));
import { OrderTicket } from './order-ticket';

// 權證下單面板（docs/qa/warrant-rules.md）：沒有零股、沒有信用；外國標的不收市價
import { WARRANT_FLASH_TEXT, WARRANT_TEXT, WARRANT_TICKET_TEXT } from '../lib/warrant-rules';

const wrt = { code: '030392', name: '台積電群益64購09', security_type: 'WRT', exchange: 'TSE', reference: 5, limit_up: 7.2, limit_down: 3.1, day_trade: '' } as unknown as ContractInfo;
const foreign = { ...wrt, code: '03001F', name: '外國標的購', limit_up: 0, limit_down: 0 } as ContractInfo;
const stk = { code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', reference: 100, day_trade: 'Yes' } as unknown as ContractInfo;
const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
let view!: ReactTestRenderer;
const btn = (label: string) => view.root.findAllByType('button').find(b => text(b) === label);

beforeEach(() => {
    vi.clearAllMocks();
    h.accounts = [h.account];
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    m.confirm.mockResolvedValue(true);
    m.risk.mockReturnValue(null);
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

const mount = async (c: ContractInfo) => {
    await act(async () => { view = create(createElement(OrderTicket, { contract: c, onPlaced: vi.fn() })); });
};

it('權證不提供盤中零股、盤後零股與信用條件；股票照常', async () => {
    await mount(wrt);
    expect(btn('整股')).toBeDefined();
    expect(btn('盤中零股')).toBeUndefined();
    expect(btn('盤後零股')).toBeUndefined();
    expect(btn('融資')).toBeUndefined();
    expect(String(btn('整股')!.props.title)).toContain('權證不得零股交易');
    await act(async () => { view.update(createElement(OrderTicket, { contract: stk, onPlaced: vi.fn() })); });
    expect(btn('盤中零股')).toBeDefined();
    expect(btn('融資')).toBeDefined();
});

it('股票存過盤中零股，換到同一面板的權證仍是整張', async () => {
    await mount(stk);
    await act(async () => { btn('盤中零股')!.props.onClick(); });
    expect(view.root.findAll(n => n.type === 'input' && n.props['aria-label'] === '數量（股）')).toHaveLength(1);
    await act(async () => { view.update(createElement(OrderTicket, { contract: wrt, onPlaced: vi.fn() })); });
    expect(view.root.findAll(n => n.type === 'input' && n.props['aria-label'] === '數量（股）')).toHaveLength(0);
});

it('外國標的權證：市價停用並說明；國內標的權證市價可選', async () => {
    await mount(foreign);
    expect(btn('MKT')!.props.disabled).toBe(true);
    expect(btn('MKT')!.props.title).toBe(WARRANT_TEXT.foreignMarket);
    expect(btn('LMT')!.props.disabled).toBe(false);
    await act(async () => { view.update(createElement(OrderTicket, { contract: wrt, onPlaced: vi.fn() })); });
    expect(btn('MKT')!.props.disabled).toBe(false);
});

it('外國標的權證：價別列下直接寫出不能市價的原因；國內標的與股票沒有', async () => {
    const note = () => view.root.findAll(n => n.props['data-testid'] === 'ticket-warrant-market');
    await mount(foreign);
    expect(note()).toHaveLength(1);
    expect(text(note()[0]!)).toBe(WARRANT_TICKET_TEXT.foreignMarket);
    await act(async () => { view.update(createElement(OrderTicket, { contract: wrt, onPlaced: vi.fn() })); });
    expect(note()).toHaveLength(0);
    await act(async () => { view.update(createElement(OrderTicket, { contract: stk, onPlaced: vi.fn() })); });
    expect(note()).toHaveLength(0);
});

it('括號單：國內標的權證可開（出場市價有漲跌幅）；外國標的停用並寫原因', async () => {
    const toggle = () => view.root.findAll(n => n.type === 'button' && n.props['data-testid'] === 'ticket-bracket-toggle')[0]!;
    await mount(wrt);
    expect(toggle().props.disabled).toBe(false);
    await act(async () => { toggle().props.onClick(); });
    expect(text(toggle())).toContain('成交後自動掛保護');
    await act(async () => { view.update(createElement(OrderTicket, { contract: foreign, onPlaced: vi.fn() })); });
    // 換商品會關掉括號單；外國標的關著就停用
    expect(text(toggle())).not.toContain('成交後自動掛保護');
    expect(toggle().props.disabled).toBe(true);
    expect(toggle().props.title).toBe(WARRANT_FLASH_TEXT.foreignProtect);
    await act(async () => { view.update(createElement(OrderTicket, { contract: stk, onPlaced: vi.fn() })); });
    expect(toggle().props.disabled).toBe(false);
});
