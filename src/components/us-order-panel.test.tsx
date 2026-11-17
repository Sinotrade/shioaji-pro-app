// 美股下單面板：H 帳戶、代碼搜尋、參考價、DAY／ATC、只送美股欄位
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    place: vi.fn(), confirm: vi.fn(), confirmOn: false, locked: false, observe: vi.fn(),
    accounts: [
        { account_type: 'S', broker_id: '9A95', account_id: '0000001', signed: true, person_id: 'P', username: 'u' },
        { account_type: 'H', broker_id: '9A95', account_id: '0000001', signed: true, person_id: 'P', username: 'u' },
    ],
    catalog: 'ready' as string,
}));
vi.mock('../lib/account-store', () => {
    const state = () => ({ accounts: m.accounts, selectedStock: m.accounts[0], selectedFutures: null, selectedIntl: m.accounts.find(a => a.account_type === 'H') ?? null, loaded: true });
    return { useAccounts: state, getAccountState: state };
});
vi.mock('../lib/account-tradable', () => ({ canTrade: (a: { signed: boolean }) => a.signed }));
vi.mock('../hooks/use-stream', () => ({ useTradingLive: () => true }));
vi.mock('../hooks/use-us-contracts', () => ({ useUsCatalog: () => ({ status: m.catalog, version: 1 }) }));
vi.mock('../lib/us/us-contracts', () => ({
    searchUsCodes: (q: string) => ['AAPL', 'AAL'].filter(c => c.startsWith(q.toUpperCase())).map(code => ({ code, exchange: 'NASDAQ', region: 'US', security_type: 'STK' })),
    loadUsInfo: vi.fn(() => Promise.resolve()),
    cachedUsInfo: (code: string) => (code === 'AAPL' ? { code, exchange: 'NASDAQ', name: 'Apple Inc.', reference: '230.1', referenceDate: '2026-11-17', currency: 'USD', fetchedOn: 'x' } : undefined),
    getUsContractRecord: (code: string) => ({ code, exchange: 'NASDAQ' }),
    usContractName: (code: string) => (code === 'AAPL' ? 'Apple Inc.' : undefined),
}));
vi.mock('../lib/us/us-api', () => ({ placeUsOrder: m.place, usErrorText: (e: unknown) => (e instanceof Error ? e.message.replace(/^\d{3}\s+/, '') : String(e)) }));
vi.mock('../lib/us/us-trading-state', () => ({ observeUsTrade: m.observe }));
vi.mock('../lib/order-confirm', () => ({ requestOrderConfirm: m.confirm, accountConfirmLabel: (a: { broker_id: string; account_id: string }) => `${a.broker_id}-${a.account_id}` }));
vi.mock('../lib/risk', () => ({ checkUsOrderAllowed: () => (m.locked ? '風控鎖啟動中 — 所有下單已封鎖' : null), getRiskSettings: () => ({ confirmManualOrders: m.confirmOn }) }));
vi.mock('../lib/trade', () => ({ notify: vi.fn() }));
vi.mock('../lib/server-info-store', () => ({ captureServerMode: () => () => true, SERVER_MODE_CHANGED_MESSAGE: 'changed' }));
import { UsOrderPanel } from './us-order-panel';

const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
let view!: ReactTestRenderer;
const btn = (re: RegExp) => view.root.findAllByType('button').find(b => re.test(text(b)));
const input = (label: string) => view.root.findAll(n => n.type === 'input' && n.props['aria-label'] === label)[0]!;
const all = () => text(view.root);

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    m.confirmOn = false; m.locked = false; m.catalog = 'ready';
    m.accounts.forEach(a => { a.signed = true; });
    m.place.mockResolvedValue({ order: { id: 't1' }, status: { status: 'PendingSubmit' } });
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

async function mount() {
    await act(async () => { view = create(createElement(UsOrderPanel)); });
}
async function pickAapl() {
    await act(async () => { input('美股代碼').props.onChange({ target: { value: 'aa' } }); });
    await act(async () => { btn(/^AAPL/)!.props.onClick(); });
}

it('searches by code, shows the market badge and previous-day reference price', async () => {
    await mount();
    expect(all()).toContain('美股');
    await act(async () => { input('美股代碼').props.onChange({ target: { value: 'aa' } }); });
    expect(view.root.findAll(n => n.props.role === 'option')).toHaveLength(2);
    await act(async () => { btn(/^AAPL/)!.props.onClick(); });
    expect(all()).toContain('參考價（前一日）');
    expect(all()).toContain('230.10');
    expect(all()).toContain('Apple Inc.');
});

it('offers DAY and ATC only and disables MKT under ATC', async () => {
    await mount();
    expect(btn(/^DAY$/)).toBeTruthy();
    expect(btn(/^ATC$/)).toBeTruthy();
    expect(btn(/^OPG$/)).toBeUndefined();
    await act(async () => { btn(/^ATC$/)!.props.onClick(); });
    expect(btn(/^市價$/)!.props.disabled).toBe(true);
});

it('arms then sends a US-only order to the H account', async () => {
    await mount();
    await pickAapl();
    await act(async () => { input('價格（USD）').props.onChange({ target: { value: '229.5' } }); });
    await act(async () => { input('數量（股）').props.onChange({ target: { value: '3' } }); });
    expect(all()).toContain('預估金額 688.50 USD');
    await act(async () => { await btn(/買進下單/)!.props.onClick(); });
    expect(m.place).not.toHaveBeenCalled();
    await act(async () => { await btn(/確認買進/)!.props.onClick(); });
    expect(m.place).toHaveBeenCalledTimes(1);
    const [contract, order, account] = m.place.mock.calls[0]!;
    expect(contract).toEqual({ code: 'AAPL', exchange: 'NASDAQ' });
    expect(order).toEqual({ action: 'Buy', price: '229.5', quantity: 3, price_type: 'LMT', time_in_force: 'DAY' });
    expect(account.account_type).toBe('H');
    expect(m.observe).toHaveBeenCalled();
    expect(all()).toContain('委託已送出');
});

it('uses the manual-order confirmation setting', async () => {
    m.confirmOn = true;
    m.confirm.mockResolvedValue(false);
    await mount();
    await pickAapl();
    await act(async () => { input('價格（USD）').props.onChange({ target: { value: '229.5' } }); });
    await act(async () => { await btn(/買進下單/)!.props.onClick(); });
    await act(async () => { await btn(/確認買進/)!.props.onClick(); });
    expect(m.confirm).toHaveBeenCalledWith(expect.objectContaining({ code: 'AAPL', unit: '股', priceLabel: '229.5 USD' }), expect.anything());
    expect(m.place).not.toHaveBeenCalled();
});

it('honours the kill switch and shows rejection text verbatim', async () => {
    m.locked = true;
    await mount();
    await pickAapl();
    await act(async () => { btn(/^市價$/)!.props.onClick(); });
    await act(async () => { await btn(/買進下單/)!.props.onClick(); });
    await act(async () => { await btn(/確認買進/)!.props.onClick(); });
    expect(m.place).not.toHaveBeenCalled();
    expect(all()).toContain('風控鎖啟動中');
    m.locked = false;
    m.place.mockRejectedValueOnce(new Error('400 V016 ATC 不接受市價'));
    await act(async () => { await btn(/買進下單/)!.props.onClick(); });
    await act(async () => { await btn(/確認買進/)!.props.onClick(); });
    expect(m.place.mock.calls[0]![1]).toMatchObject({ price_type: 'MKT', price: '0' });
    expect(all()).toContain('V016 ATC 不接受市價');
});

it('degrades without H accounts or US contracts', async () => {
    m.catalog = 'unsupported';
    await mount();
    expect(all()).toContain('尚未提供美股商品');
    await act(async () => view.unmount());
    m.accounts.forEach(a => { if (a.account_type === 'H') a.signed = false; });
    await mount();
    expect(all()).toContain('沒有可交易的複委託（H）帳戶');
});
