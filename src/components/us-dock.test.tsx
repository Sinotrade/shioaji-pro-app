// 美股委託／庫存區段與改價兩步對話框
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const H = { account_type: 'H', person_id: 'P', broker_id: '9A95', account_id: '0000001', signed: true, username: 'u' };
const m = vi.hoisted(() => ({ cancel: vi.fn(), place: vi.fn(), reduce: vi.fn(), state: {} as Record<string, unknown> }));
vi.mock('../lib/account-store', () => ({ useAccounts: () => ({ accounts: [H] }) }));
vi.mock('../lib/account-tradable', () => ({ canTrade: () => true }));
vi.mock('../lib/privacy', () => ({ usePrivacyMode: () => false, usePrivacyMoney: () => false, maskAccountId: (id: string) => id, maskMoney: (t: string) => t }));
vi.mock('../lib/us/us-order-actions', async () => {
    const real = await vi.importActual<typeof import('../lib/us/us-order-actions')>('../lib/us/us-order-actions');
    return { ...real, cancelUsTrade: m.cancel, placeReplacement: m.place, reduceUsTrade: m.reduce };
});
vi.mock('../lib/us/us-trading-state', async () => {
    const real = await vi.importActual<typeof import('../lib/us/us-trading-state')>('../lib/us/us-trading-state');
    return { ...real, useUsTradingState: () => m.state, refreshUsTrades: vi.fn(), refreshUsPositions: vi.fn() };
});
vi.mock('./us-order-panel', () => ({ UsMarketBadge: () => '美股' }));
vi.mock('../lib/risk', () => ({ checkUsOrderAllowed: () => null }));
vi.mock('../lib/stream', () => ({ ensureStream: vi.fn(), getStreamStatus: () => 'down', onOrderEvent: () => () => undefined, subscribeStatusStore: () => () => undefined }));
import { UsOrdersSection, UsPositionsSection } from './us-dock';
import { UsCancelTooEarlyError } from '../lib/us/us-order-actions';

const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
let view!: ReactTestRenderer;
const btn = (re: RegExp) => view.root.findAllByType('button').find(b => re.test(text(b)));
const all = () => text(view.root);
const trade = {
    account: H,
    contract: { security_type: 'STK', exchange: 'NASDAQ', code: 'NVDA', region: 'US' },
    order: { id: 't1', seqno: '21157799', ordno: 'A1', action: 'Buy', price: '173.97', quantity: '10', price_type: 'LMT', time_in_force: 'DAY', trade_date: '20261118' },
    status: { id: 't1', status: 'PartFilled', status_code: '00', order_quantity: '10', deal_quantity: '2', cancel_quantity: '0', msg: '', deals: [], avg_price: '173.95' },
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    m.state = { trades: [trade], loading: false, updatedAt: 1, error: null, hint: null, positions: [], positionsStatus: 'idle', positionsError: null };
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

it('lists H orders with decimal quantities, avg price and the unhealthy hint', async () => {
    m.state = { ...m.state, hint: '美股成交回報可能不完整，以委託查詢為準' };
    await act(async () => { view = create(createElement(UsOrdersSection)); });
    expect(all()).toContain('10 / 2 / 8');
    expect(all()).toContain('173.95');
    expect(all()).toContain('部分成交');
    expect(all()).toContain('美股成交回報可能不完整');
});

it('shows the friendly -2054 message on cancel', async () => {
    m.cancel.mockRejectedValue(new UsCancelTooEarlyError());
    await act(async () => { view = create(createElement(UsOrdersSection)); });
    await act(async () => { await btn(/^刪單$/)!.props.onClick(); });
    expect(all()).toContain('剛送出的委託稍後再刪');
});

it('changes price in two confirmed steps and shows both results', async () => {
    m.cancel.mockResolvedValue({ confirmed: true, cancelled: '8' });
    m.place.mockResolvedValue({ order: { id: 't2', seqno: '21157800' }, status: { status: 'PendingSubmit' } });
    await act(async () => { view = create(createElement(UsOrdersSection)); });
    await act(async () => { btn(/^改價$/)!.props.onClick(); });
    const price = view.root.findAll(n => n.type === 'input' && n.props['aria-label'] === '新價格')[0]!;
    await act(async () => { price.props.onChange({ target: { value: '170.5' } }); });
    await act(async () => { await btn(/確認刪除原委託/)!.props.onClick(); });
    expect(m.cancel).toHaveBeenCalledTimes(1);
    expect(m.place).not.toHaveBeenCalled();
    expect(all()).toContain('原委託已刪除，取消 8 股');
    await act(async () => { await btn(/送出新委託/)!.props.onClick(); });
    expect(m.place.mock.calls[0]![1]).toEqual({ action: 'Buy', price: '170.5', quantity: 8, price_type: 'LMT', time_in_force: 'DAY' });
    expect(all()).toContain('新委託已送出');
});

it('does not re-place when the cancel is unconfirmed', async () => {
    m.cancel.mockResolvedValue({ confirmed: false });
    await act(async () => { view = create(createElement(UsOrdersSection)); });
    await act(async () => { btn(/^改價$/)!.props.onClick(); });
    const price = view.root.findAll(n => n.type === 'input' && n.props['aria-label'] === '新價格')[0]!;
    await act(async () => { price.props.onChange({ target: { value: '170.5' } }); });
    await act(async () => { await btn(/確認刪除原委託/)!.props.onClick(); });
    expect(btn(/送出新委託/)).toBeUndefined();
    expect(all()).toContain('不會重下');
});

it('shows US positions with — for null market fields, or the later-version notice', async () => {
    m.state = { ...m.state, positionsStatus: 'ready', positions: [{ id: 0, code: 'NVDA', direction: 'Buy', quantity: '10.5', price: '170.1',
        market_price: null, market_value: null, pnl: '12.3456', pnl_pct: '5.55', currency: 'USD', account: H }] };
    await act(async () => { view = create(createElement(UsPositionsSection)); });
    expect(all()).toContain('10.5');
    expect(all()).toContain('—');
    expect(all()).toContain('12.35');
    expect(all()).toContain('5.55%');
    await act(async () => view.unmount());
    m.state = { ...m.state, positionsStatus: 'unsupported', positions: [] };
    await act(async () => { view = create(createElement(UsPositionsSection)); });
    expect(all()).toContain('美股庫存將於後續版本提供');
});

it('keeps busy per order: cancelling one row leaves the others usable', async () => {
    const second = { ...trade, order: { ...trade.order, id: 't2', seqno: '21157800' }, status: { ...trade.status, id: 't2' } };
    m.state = { ...m.state, trades: [trade, second] };
    let release!: (v: unknown) => void;
    m.cancel.mockReturnValueOnce(new Promise(r => { release = r; }));
    await act(async () => { view = create(createElement(UsOrdersSection)); });
    await act(async () => { void btn(/^刪單$/)!.props.onClick(); });
    const cancels = view.root.findAllByType('button').filter(b => /^(刪單|處理中…)$/.test(text(b)));
    expect(cancels.map(b => text(b))).toEqual(['處理中…', '刪單']);
    expect(cancels[1]!.props.disabled).toBe(false);
    await act(async () => { release({ confirmed: true, cancelled: '8' }); });
});

it('opens the reprice dialog without a same-price error, and validates after editing', async () => {
    await act(async () => { view = create(createElement(UsOrdersSection)); });
    await act(async () => { btn(/^改價$/)!.props.onClick(); });
    expect(all()).not.toContain('新價格和原價格相同');
    expect(all()).toContain('173.97');
    const price = view.root.findAll(n => n.type === 'input' && n.props['aria-label'] === '新價格')[0]!;
    await act(async () => { price.props.onChange({ target: { value: '173.97' } }); });
    expect(all()).toContain('新價格和原價格相同');
});

it('shows US prices with at least two decimals', async () => {
    m.state = { ...m.state, trades: [{ ...trade, order: { ...trade.order, price: '174' }, status: { ...trade.status, avg_price: '173.9' } }] };
    await act(async () => { view = create(createElement(UsOrdersSection)); });
    expect(all()).toContain('174.00');
    expect(all()).toContain('173.90');
});

it('labels long positions 庫存 and keeps a refresh button on errors', async () => {
    m.state = { ...m.state, positionsStatus: 'ready', positions: [{ id: 0, code: 'NVDA', direction: 'Buy', quantity: '1', price: '170',
        market_price: null, market_value: null, pnl: null, pnl_pct: null, currency: 'USD', account: H }] };
    await act(async () => { view = create(createElement(UsPositionsSection)); });
    expect(all()).toContain('庫存');
    expect(all()).toContain('170.00');
    await act(async () => view.unmount());
    m.state = { ...m.state, positionsStatus: 'error', positions: [], positionsError: '暫時無法確認美股庫存功能，請按更新重試' };
    await act(async () => { view = create(createElement(UsPositionsSection)); });
    expect(all()).toContain('請按更新重試');
    expect(view.root.findAll(n => n.props?.label === '更新美股庫存').length).toBeGreaterThan(0);
});

it('says fully filled before cancel and does not offer a re-place', async () => {
    m.cancel.mockResolvedValue({ confirmed: true, filled: true, cancelled: '0' });
    await act(async () => { view = create(createElement(UsOrdersSection)); });
    await act(async () => { btn(/^改價$/)!.props.onClick(); });
    const price = view.root.findAll(n => n.type === 'input' && n.props['aria-label'] === '新價格')[0]!;
    await act(async () => { price.props.onChange({ target: { value: '170.5' } }); });
    await act(async () => { await btn(/確認刪除原委託/)!.props.onClick(); });
    expect(all()).toContain('刪單前已全部成交');
    expect(btn(/送出新委託/)).toBeUndefined();
});

it('prefills the reprice dialog with a formatted price', async () => {
    m.state = { ...m.state, trades: [{ ...trade, order: { ...trade.order, price: '225.5' } }] };
    await act(async () => { view = create(createElement(UsOrdersSection)); });
    await act(async () => { btn(/^改價$/)!.props.onClick(); });
    const price = view.root.findAll(n => n.type === 'input' && n.props['aria-label'] === '新價格')[0]!;
    expect(price.props.value).toBe('225.50');
    expect(all()).not.toContain('新價格和原價格相同');
});
