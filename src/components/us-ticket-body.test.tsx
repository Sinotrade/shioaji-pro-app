// 下單面板的美股分支：同一個 OrderTicket，美股合約只走美股下單路徑
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../lib/types/contract';

const m = vi.hoisted(() => ({
    place: vi.fn(), confirm: vi.fn(), confirmOn: false, locked: false, observe: vi.fn(),
    stock: vi.fn(), future: vi.fn(), twRisk: vi.fn(() => null), onPlaced: vi.fn(),
    quote: undefined as unknown,
    snap: null as unknown,
    quoteKeys: [] as (string | null)[],
    accounts: [
        { account_type: 'S', broker_id: '9A95', account_id: '0000001', signed: true, person_id: 'P', username: 'u' },
        { account_type: 'H', broker_id: '9A95', account_id: '0000001', signed: true, person_id: 'P', username: 'u' },
    ],
}));
vi.mock('../lib/account-store', () => {
    const state = () => ({ accounts: m.accounts, selectedStock: m.accounts[0], selectedFutures: null, selectedIntl: m.accounts.find(a => a.account_type === 'H') ?? null, loaded: true });
    return { useAccounts: state, getAccountState: state, selectAccount: vi.fn() };
});
vi.mock('../lib/account-tradable', () => ({ canTrade: (a: { signed: boolean }) => a.signed }));
vi.mock('../hooks/use-stream', () => ({
    useTradingLive: () => true,
    useQuote: (key: string | null) => { m.quoteKeys.push(key); return m.quote; },
}));
vi.mock('../hooks/use-us-snapshot', async importOriginal => ({ ...(await importOriginal<object>()), useUsSnapshot: () => m.snap }));
vi.mock('../lib/us/us-quotes', async importOriginal => ({
    usTickReference: (await importOriginal<typeof import('../lib/us/us-quotes')>()).usTickReference,
    getUsTickMeta: () => ({ session: 'Regular' }),
    US_SESSION_LABEL: { Unknown: '', PreMarket: '盤前', Regular: '盤中', AfterHours: '盤後' },
}));
vi.mock('../lib/us/us-api', () => ({ placeUsOrder: m.place, usErrorText: (e: unknown) => (e instanceof Error ? e.message.replace(/^\d{3}\s+/, '') : String(e)) }));
vi.mock('../lib/us/us-trading-state', () => ({ observeUsTrade: m.observe }));
vi.mock('../lib/order-confirm', () => ({ requestOrderConfirm: m.confirm, accountConfirmLabel: (a: { broker_id: string; account_id: string }) => `${a.broker_id}-${a.account_id}` }));
vi.mock('../lib/risk', () => ({
    checkOrderAllowed: m.twRisk,
    checkUsOrderAllowed: () => (m.locked ? '風控鎖啟動中 — 所有下單已封鎖' : null),
    getRiskSettings: () => ({ confirmManualOrders: m.confirmOn }),
}));
vi.mock('../lib/shioaji', () => ({
    isUsContract: (c: { region?: string } | null | undefined) => c?.region === 'US',
    fetchInfo: () => new Promise(() => undefined),
    placeFuturesOrder: m.future,
    placeStockOrder: m.stock,
}));
vi.mock('../lib/trade', () => ({ notify: vi.fn() }));
vi.mock('../lib/server-info-store', () => ({ captureServerMode: () => () => true, SERVER_MODE_CHANGED_MESSAGE: 'changed' }));
vi.mock('../lib/bracket', () => ({ ensureBracketHost: vi.fn(), registerBracket: vi.fn(), registrationFailureText: String, validateBracketRequest: () => null }));
vi.mock('./bracket-status', () => ({ BracketStatusList: () => null }));
vi.mock('../lib/protection-env', () => ({ currentProtectionEnv: () => 'sim' }));
vi.mock('../lib/price-sync', () => ({ usePickedPrice: () => null }));
vi.mock('../lib/allocation', () => ({ allocateByRatio: (t: number, w: number[]) => w.map(() => t), loadAllocPresets: () => [], saveAllocPreset: () => [], deleteAllocPreset: () => [] }));
import { OrderTicket } from './order-ticket';
import { sanitizeUsPriceInput } from './us-ticket-body';

const aapl = {
    region: 'US', exchange: 'NASDAQ', code: 'AAPL', security_type: 'STK', target_code: null, name: 'Apple Inc.',
    currency: 'USD', limit_up: 0, limit_down: 0, reference: 230.1, day_trade: '', update_date: '', category: '',
    margin_trading_balance: 0, short_selling_balance: 0, us_reference: '230.1', reference_date: '2026-11-17',
} as unknown as ContractInfo;

const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
let view!: ReactTestRenderer;
const btn = (re: RegExp) => view.root.findAllByType('button').find(b => re.test(text(b)));
const input = (label: string) => view.root.findAll(n => n.type === 'input' && n.props['aria-label'] === label)[0]!;
const all = () => text(view.root);

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    m.confirmOn = false; m.locked = false; m.quote = undefined; m.quoteKeys = [];
    m.accounts.forEach(a => { a.signed = true; });
    m.place.mockResolvedValue({ order: { id: 't1' }, status: { status: 'PendingSubmit' } });
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

async function mount(contract: ContractInfo = aapl) {
    await act(async () => { view = create(createElement(OrderTicket, { contract, onPlaced: m.onPlaced })); });
}

it('renders the US body inside the shared ticket, without TW-only fields', async () => {
    await mount();
    const t = all();
    expect(t).toContain('美股');
    expect(t).toContain('AAPL');
    expect(t).toContain('Apple Inc.');
    expect(t).toContain('NASDAQ · USD');
    for (const tw of ['張', '零股', '信用', '融資', '融券', '當沖', 'ROD', 'IOC', 'FOK']) expect(t).not.toContain(tw);
    expect(input('數量（股）')).toBeTruthy();
    // 報價以連動 key 訂閱，不會用裸代碼撞到台股
    expect(m.quoteKeys).toContain('US:AAPL');
    expect(m.quoteKeys).not.toContain('AAPL');
});

it('prefers the snapshot reference over a stale contract reference before the first tick', async () => {
    m.snap = { reference: 231.5 };
    await mount();
    expect(all()).toContain('參考 231.50');
    expect(all()).not.toContain('230.10');
    m.snap = null;
});

it('shows the reference price before the first tick and fills it', async () => {
    await mount();
    expect(all()).toContain('參考 230.10（2026-11-17）');
    await act(async () => { btn(/^參考價$/)!.props.onClick(); });
    expect(input('價格（USD）').props.value).toBe('230.1');
});

it('shows the live price, best bid/ask and session after a quote', async () => {
    m.quote = { tick: { close: '231.2345' }, bidask: { bid_price: ['231.2'], ask_price: ['231.25'] } };
    await mount();
    const t = all();
    expect(t).toContain('231.2345');
    expect(t).toContain('買 231.20 / 賣 231.25');
    expect(t).toContain('盤中');
    expect(t).not.toContain('參考 230.10');
    await act(async () => { btn(/^市價帶入$/)!.props.onClick(); });
    expect(input('價格（USD）').props.value).toBe('231.2345');
});

it('offers DAY and ATC only and disables MKT under ATC', async () => {
    await mount();
    await act(async () => { btn(/^賣出$/)!.props.onClick(); });
    expect(btn(/^OPG$/)).toBeUndefined();
    expect(btn(/^市價$/)!.props.disabled).toBe(false);
    await act(async () => { btn(/^ATC$/)!.props.onClick(); });
    expect(btn(/^市價$/)!.props.disabled).toBe(true);
});

it('market orders are Sell only: Buy disables 市價 and switching to Buy resets to 限價 (spec 11/18)', async () => {
    await mount();
    // 預設買進：市價不能選
    expect(btn(/^市價$/)!.props.disabled).toBe(true);
    expect(btn(/^市價$/)!.props.title).toBe('買進只能限價，市價只能賣出');
    await act(async () => { btn(/^賣出$/)!.props.onClick(); });
    await act(async () => { btn(/^市價$/)!.props.onClick(); });
    expect(input('價格（USD）')).toBeUndefined();
    // 市價下切回買進：回到限價（價格欄重新出現）
    await act(async () => { btn(/^買進$/)!.props.onClick(); });
    expect(btn(/^市價$/)!.props.disabled).toBe(true);
    expect(input('價格（USD）')).toBeDefined();
    await act(async () => { input('價格（USD）').props.onChange({ target: { value: '229.5' } }); });
    await act(async () => { await btn(/買進下單/)!.props.onClick(); });
    await act(async () => { await btn(/確認買進/)!.props.onClick(); });
    expect(m.place.mock.calls[0]![1]).toMatchObject({ action: 'Buy', price_type: 'LMT' });
    expect(all()).toContain('美股 Beta：只能整股；買進只能限價，市價只能賣出；ATC 只能限價；改價會先刪單再重下。');
});

it('sends a Sell market order with price "0"', async () => {
    await mount();
    await act(async () => { btn(/^賣出$/)!.props.onClick(); });
    await act(async () => { btn(/^市價$/)!.props.onClick(); });
    await act(async () => { await btn(/賣出下單/)!.props.onClick(); });
    await act(async () => { await btn(/確認賣出/)!.props.onClick(); });
    expect(m.place.mock.calls[0]![1]).toEqual({ action: 'Sell', price: '0', quantity: 1, price_type: 'MKT', time_in_force: 'DAY' });
});

it('arms then places a US-only order with {code, exchange}', async () => {
    await mount();
    await act(async () => { input('價格（USD）').props.onChange({ target: { value: '229.5' } }); });
    await act(async () => { btn(/增加 1 股|^\+$/)!.props.onClick(); });
    await act(async () => { btn(/^\+$/)!.props.onClick(); });
    expect(input('數量（股）').props.value).toBe('3');
    expect(all()).toContain('預估金額 688.50 USD');
    await act(async () => { await btn(/買進下單/)!.props.onClick(); });
    expect(m.place).not.toHaveBeenCalled();
    await act(async () => { await btn(/確認買進/)!.props.onClick(); });
    expect(m.place).toHaveBeenCalledTimes(1);
    const [contract, order, account] = m.place.mock.calls[0]!;
    expect(contract).toEqual({ code: 'AAPL', exchange: 'NASDAQ' });
    expect(order).toEqual({ action: 'Buy', price: '229.5', quantity: 3, price_type: 'LMT', time_in_force: 'DAY' });
    for (const k of ['order_lot', 'order_cond', 'daytrade_short', 'custom_field']) expect(order).not.toHaveProperty(k);
    expect(account.account_type).toBe('H');
    expect(m.observe).toHaveBeenCalled();
    expect(m.onPlaced).toHaveBeenCalled();
    expect(m.stock).not.toHaveBeenCalled();
    expect(m.future).not.toHaveBeenCalled();
    expect(m.twRisk).not.toHaveBeenCalled();
});

it('asks for confirmation when manual-order confirmation is on', async () => {
    m.confirmOn = true;
    m.confirm.mockResolvedValue(false);
    await mount();
    await act(async () => { input('價格（USD）').props.onChange({ target: { value: '229.5' } }); });
    await act(async () => { await btn(/買進下單/)!.props.onClick(); });
    await act(async () => { await btn(/確認買進/)!.props.onClick(); });
    expect(m.confirm).toHaveBeenCalledWith(expect.objectContaining({ code: 'AAPL', unit: '股', priceLabel: '229.5 USD' }), expect.anything());
    expect(m.place).not.toHaveBeenCalled();
});

it('blocks on the kill switch, before and right before dispatch', async () => {
    m.locked = true;
    await mount();
    await act(async () => { input('價格（USD）').props.onChange({ target: { value: '229.5' } }); });
    await act(async () => { await btn(/買進下單/)!.props.onClick(); });
    await act(async () => { await btn(/確認買進/)!.props.onClick(); });
    expect(m.place).not.toHaveBeenCalled();
    expect(all()).toContain('風控鎖啟動中');

    m.locked = false;
    m.place.mockImplementationOnce(async (_c: unknown, _o: unknown, _a: unknown, opts: { beforeDispatch: () => void }) => {
        m.locked = true;
        opts.beforeDispatch();
        return {};
    });
    await act(async () => { await btn(/買進下單/)!.props.onClick(); });
    await act(async () => { await btn(/確認買進/)!.props.onClick(); });
    expect(m.observe).not.toHaveBeenCalled();
    expect(all()).toContain('風控鎖啟動中');
});

it('marks suspended contracts and disables placing', async () => {
    await mount({ ...aapl, trading_suspended: true } as ContractInfo);
    expect(all()).toContain('暫停交易');
    expect(btn(/暫停交易/)!.props.disabled).toBe(true);
});

it('shows the notice without a tradable H account', async () => {
    m.accounts.forEach(a => { if (a.account_type === 'H') a.signed = false; });
    await mount();
    expect(all()).toContain('沒有可交易的複委託（H）帳戶');
    expect(btn(/買進下單/)).toBeUndefined();
});

it('resets the typed price when the linked contract changes', async () => {
    await mount();
    await act(async () => { input('價格（USD）').props.onChange({ target: { value: '229.5' } }); });
    const msft = { ...aapl, code: 'MSFT', name: 'Microsoft', us_reference: '410' } as ContractInfo;
    await act(async () => { view.update(createElement(OrderTicket, { contract: msft, onPlaced: m.onPlaced })); });
    expect(input('價格（USD）').props.value).toBe('');
    expect(all()).toContain('參考 410.00');
});

it('limits price input to one dot and 4 decimals', () => {
    expect(sanitizeUsPriceInput('12.34567')).toBe('12.3456');
    expect(sanitizeUsPriceInput('1.2.3')).toBe('1.23');
    expect(sanitizeUsPriceInput('a1b')).toBe('1');
});
