// 美股逐筆操作（刪單／減量／兩步改價）
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const H = { account_type: 'H', person_id: 'P', broker_id: '9A95', account_id: '0000001', signed: true, username: 'u' };
const m = vi.hoisted(() => ({ cancel: vi.fn(), place: vi.fn(), reduce: vi.fn(), state: {} as Record<string, unknown>,
    accounts: [] as unknown[], accountListeners: new Set<() => void>() }));
vi.mock('../lib/account-store', () => ({
    useAccounts: () => ({ accounts: [H] }),
    getAccountState: () => ({ accounts: m.accounts, loaded: true }),
    subscribeAccounts: (l: () => void) => { m.accountListeners.add(l); return () => { m.accountListeners.delete(l); }; },
}));
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
vi.mock('../lib/risk', () => ({ checkUsOrderAllowed: () => null }));
vi.mock('../lib/stream', () => ({ ensureStream: vi.fn(), getStreamStatus: () => 'down', onOrderEvent: () => () => undefined, subscribeStatusStore: () => () => undefined }));
import { Fragment } from 'react';
import { fmtUsPnl, getUsRepriceTarget, openUsReprice, resetUsRepriceForTest, UsOrderActions, usOrderRowKey, usPositionRowKey, UsRepriceHost } from './bottom-dock-us';
import { UsCancelTooEarlyError } from '../lib/us/us-order-actions';

const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
let view!: ReactTestRenderer;
const btn = (re: RegExp) => view.root.findAllByType('button').find(b => re.test(text(b)));
const all = () => text(view.root);
const dialogs = () => view.root.findAll(n => typeof n.type === 'string' && n.props?.role === 'dialog');
const trade = {
    account: H,
    contract: { security_type: 'STK', exchange: 'NASDAQ', code: 'NVDA', region: 'US' },
    order: { id: 't1', seqno: '21157799', ordno: 'A1', action: 'Buy', price: '173.97', quantity: '10', price_type: 'LMT', time_in_force: 'DAY', trade_date: '20261118' },
    status: { id: 't1', status: 'PartFilled', status_code: '00', order_quantity: '10', deal_quantity: '2', cancel_quantity: '0', msg: '', deals: [], avg_price: '173.95' },
};

beforeEach(() => {
    vi.clearAllMocks();
    m.accounts = [H];
    resetUsRepriceForTest();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

// 改價對話框由 App 層的 UsRepriceHost 顯示，不掛在委託列裡
const tree = (rows: unknown[]) => createElement(Fragment, null,
    ...rows.map(t => createElement(UsOrderActions, { key: (t as typeof trade).order.id, t: t as never })), createElement(UsRepriceHost));
const mount = async (t: unknown = trade) => { await act(async () => { view = create(tree([t])); }); };
const openReprice = async (value: string) => {
    await act(async () => { btn(/^改價$/)!.props.onClick(); });
    const price = view.root.findAll(n => n.type === 'input' && n.props['aria-label'] === '新價格')[0]!;
    await act(async () => { price.props.onChange({ target: { value } }); });
};

it('shows the friendly -2054 message on cancel', async () => {
    m.cancel.mockRejectedValue(new UsCancelTooEarlyError());
    await mount();
    await act(async () => { await btn(/^刪單$/)!.props.onClick(); });
    expect(all()).toContain('剛送出的委託稍後再刪');
});

it('reduces by whole shares through the US reduce action', async () => {
    m.reduce.mockResolvedValue({});
    await mount();
    await act(async () => { btn(/^減量$/)!.props.onClick(); });
    const input = view.root.findAll(n => n.type === 'input' && n.props['aria-label'] === '減少股數')[0]!;
    await act(async () => { input.props.onChange({ target: { value: '3' } }); });
    await act(async () => { await btn(/確認減量/)!.props.onClick(); });
    expect(m.reduce).toHaveBeenCalledWith(trade, 3);
    expect(all()).toContain('減量 3 股已送出');
});

it('changes price in two confirmed steps and shows both results', async () => {
    m.cancel.mockResolvedValue({ confirmed: true, cancelled: '8' });
    m.place.mockResolvedValue({ order: { id: 't2', seqno: '21157800' }, status: { status: 'PendingSubmit' } });
    await mount();
    await openReprice('170.5');
    await act(async () => { await btn(/確認刪除原委託/)!.props.onClick(); });
    expect(m.cancel).toHaveBeenCalledTimes(1);
    expect(m.place).not.toHaveBeenCalled();
    expect(all()).toContain('原委託已刪除，取消 8 股');
    await act(async () => { await btn(/送出新委託/)!.props.onClick(); });
    expect(m.place.mock.calls[0]![1]).toEqual({ action: 'Buy', price: '170.5', quantity: 8, price_type: 'LMT', time_in_force: 'DAY' });
    expect(all()).toContain('新委託已送出');
});

it('keeps step 2 after step 1 removes the row from the working list', async () => {
    m.cancel.mockResolvedValue({ confirmed: true, cancelled: '8' });
    m.place.mockResolvedValue({ order: { id: 't2', seqno: '21157800' }, status: { status: 'PendingSubmit' } });
    await mount();
    await openReprice('170.5');
    await act(async () => { await btn(/確認刪除原委託/)!.props.onClick(); });
    // 有效篩選：刪單成功後原委託離開清單，委託列卸載
    await act(async () => { view.update(tree([])); });
    expect(btn(/^改價$/)).toBeUndefined();
    expect(all()).toContain('原委託已刪除，取消 8 股');
    await act(async () => { await btn(/送出新委託/)!.props.onClick(); });
    expect(m.place).toHaveBeenCalledTimes(1);
    expect(m.place.mock.calls[0]![1]).toMatchObject({ price: '170.5', quantity: 8 });
    expect(all()).toContain('新委託已送出');
    await act(async () => { btn(/^關閉$/)!.props.onClick(); });
    expect(getUsRepriceTarget()).toBeNull();
    expect(dialogs()).toHaveLength(0);
});

it('does not replace an open reprice with a second one', async () => {
    const second = { ...trade, order: { ...trade.order, id: 't2', seqno: '21157800' }, status: { ...trade.status, id: 't2' } };
    await mount();
    await act(async () => { expect(openUsReprice(trade as never)).toBe(true); });
    await act(async () => { expect(openUsReprice(second as never)).toBe(false); });
    expect(getUsRepriceTarget()!.row.order.id).toBe('t1');
});

it('closes the reprice dialog when the H account is no longer tradable', async () => {
    await mount();
    await act(async () => { openUsReprice(trade as never); });
    expect(dialogs()).toHaveLength(1);
    m.accounts = [];
    await act(async () => { m.accountListeners.forEach(l => l()); });
    expect(getUsRepriceTarget()).toBeNull();
    expect(dialogs()).toHaveLength(0);
});

it('does not re-place when the cancel is unconfirmed', async () => {
    m.cancel.mockResolvedValue({ confirmed: false });
    await mount();
    await openReprice('170.5');
    await act(async () => { await btn(/確認刪除原委託/)!.props.onClick(); });
    expect(btn(/送出新委託/)).toBeUndefined();
    expect(all()).toContain('不會重下');
});

it('says fully filled before cancel and does not offer a re-place', async () => {
    m.cancel.mockResolvedValue({ confirmed: true, filled: true, cancelled: '0' });
    await mount();
    await openReprice('170.5');
    await act(async () => { await btn(/確認刪除原委託/)!.props.onClick(); });
    expect(all()).toContain('刪單前已全部成交');
    expect(btn(/送出新委託/)).toBeUndefined();
});

it('opens the reprice dialog without a same-price error, prefilled and validated after editing', async () => {
    await mount({ ...trade, order: { ...trade.order, price: '225.5' } });
    await act(async () => { btn(/^改價$/)!.props.onClick(); });
    const price = view.root.findAll(n => n.type === 'input' && n.props['aria-label'] === '新價格')[0]!;
    expect(price.props.value).toBe('225.50');
    expect(all()).not.toContain('新價格和原價格相同');
    await act(async () => { price.props.onChange({ target: { value: '225.50' } }); });
    expect(all()).toContain('新價格和原價格相同');
});

it('keeps busy per order: cancelling one row leaves the others usable', async () => {
    const second = { ...trade, order: { ...trade.order, id: 't2', seqno: '21157800' }, status: { ...trade.status, id: 't2' } };
    let release!: (v: unknown) => void;
    m.cancel.mockReturnValueOnce(new Promise(r => { release = r; }));
    await act(async () => { view = create(tree([trade, second])); });
    await act(async () => { void btn(/^刪單$/)!.props.onClick(); });
    const cancels = view.root.findAllByType('button').filter(b => /^(刪單|處理中…)$/.test(text(b)));
    expect(cancels.map(b => text(b))).toEqual(['處理中…', '刪單']);
    expect(cancels[1]!.props.disabled).toBe(false);
    await act(async () => { release({ confirmed: true, cancelled: '8' }); });
});

it.each([
    ['Failed', { status: 'Failed' }],
    ['Cancelled', { status: 'Cancelled', cancel_quantity: '8' }],
    ['Filled', { status: 'Filled', deal_quantity: '10' }],
    ['remaining 0', { status: 'PartFilled', deal_quantity: '4', cancel_quantity: '6' }],
])('offers no 減量 for a %s order (reduce-only, working orders only)', async (_name, over) => {
    await mount({ ...trade, status: { ...trade.status, ...over } });
    expect(btn(/^減量$/)).toBeUndefined();
});

it('shows no actions for a finished order', async () => {
    await mount({ ...trade, status: { ...trade.status, status: 'Filled', deal_quantity: '10' } });
    expect(btn(/^刪單$/)).toBeUndefined();
});

it('keys US rows by account and order, never by the bare code', () => {
    expect(usOrderRowKey(trade as never)).toBe('us:9A95:0000001:t1');
    expect(usPositionRowKey({ id: 0, code: '2330', direction: 'Buy', quantity: '1', price: '1', account: H } as never)).toBe('us:9A95:0000001:2330:Buy:0');
    expect(fmtUsPnl('12.3456')).toBe('+12.35');
    expect(fmtUsPnl('-3')).toBe('-3.00');
    expect(fmtUsPnl(null)).toBe('—');
});
