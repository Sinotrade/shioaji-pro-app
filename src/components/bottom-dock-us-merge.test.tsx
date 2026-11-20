// 美股列併入 dock 的委託／持倉表：同表顯示、連動 US:CODE、期貨篩選隱藏、USD 不併入台幣
import '../test/mock-order-reconciliation';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Trade } from '../lib/types/order';
import type { AccountedPosition } from '../lib/types/portfolio';

const H = { account_type: 'H', person_id: 'P', broker_id: '9A95', account_id: '0000001', signed: true, username: 'u' };
const S = { ...H, account_type: 'S' };
const m = vi.hoisted(() => ({ cancelTw: vi.fn(), cancelUs: vi.fn(), us: null as unknown, funds: undefined as unknown }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: m.cancelTw, cancelOrders: vi.fn(), updateOrderPrice: vi.fn(), updateOrderQty: vi.fn() }));
vi.mock('../lib/trade', () => ({ notify: vi.fn(), placeQuickOrder: vi.fn(), placeStockExitByShares: vi.fn() }));
vi.mock('../hooks/use-stream', () => ({ useTradingLive: () => true }));
vi.mock('../lib/contracts-cache', () => ({ ensureContract: async (code: string) => ({ code, name: '', security_type: code === 'TXFL6' ? 'FUT' : 'STK' }) }));
vi.mock('../lib/server-info-store', () => ({ useServerInfo: () => null, yesterdayQuantityNotice: () => null, knownServerInfo: () => ({}) }));
vi.mock('../lib/privacy', () => ({ usePrivacyMode: () => false, usePrivacyMoney: () => false, maskAccountId: (id: string) => id, maskMoney: (t: string) => t, secretMoney: (t: string) => t }));
vi.mock('../lib/account-store', () => ({ useAccounts: () => ({ accounts: [S, H], selectedStock: S, selectedFutures: null }), ensureAccounts: () => undefined, selectAccount: vi.fn(), getAccountState: () => ({ accounts: [S, H] }) }));
vi.mock('../lib/account-tradable', () => ({ canTrade: () => true }));
vi.mock('../lib/us/us-order-actions', async () => {
    const real = await vi.importActual<typeof import('../lib/us/us-order-actions')>('../lib/us/us-order-actions');
    return { ...real, cancelUsTrade: m.cancelUs };
});
vi.mock('../lib/risk', () => ({ checkUsOrderAllowed: () => null }));
vi.mock('./us-account-panels', () => ({ UsPositionDetail: ({ detailId }: { detailId: number }) => `DETAIL#${detailId}` }));
vi.mock('./tw-account-detail', () => ({
    TwPositionDetail: ({ market, row, version }: { market: string; row: { id: number; code: string; direction: string; cond?: string; quantity: number }; version: number }) =>
        `TWDETAIL#${market}:${row.id}:${row.code}:${row.direction}:${row.cond ?? '-'}:${row.quantity}:v${version}`,
}));
vi.mock('./bottom-dock-shared', async original => ({ ...await original<object>(), useMeasuredWidth: () => ({ ref: () => undefined, width: 1400 }) }));
import { OrdersPane, mergeNewestFirst, type OrderRow } from './bottom-dock-orders';
import { PositionsPane } from './bottom-dock-positions';

const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
let view: ReactTestRenderer | undefined;
const all = () => text(view!.root);
const rowOf = (code: string) => view!.root.findAll(n => n.type === 'tr' && typeof n.props.onClick === 'function' && text(n).includes(code))[0]!;

const twTrade = {
    account: S,
    contract: { security_type: 'STK', exchange: 'TSE', code: '2330' },
    order: { id: 'tw1', seqno: '1', ordno: 'A', action: 'Buy', price: 1000, quantity: 1, price_type: 'LMT', order_type: 'ROD', account: { account_type: 'S', broker_id: '9A95', account_id: '0000001' } },
    status: { id: 'tw1', status: 'Submitted', status_code: '00', order_ts: 1790000000, order_quantity: 1, deal_quantity: 0, cancel_quantity: 0, modified_price: 0, msg: '', deals: [] },
} as unknown as Trade;
const futTrade = {
    ...twTrade,
    contract: { security_type: 'FUT', exchange: 'TAIFEX', code: 'TXFL6' },
    order: { ...twTrade.order, id: 'f1', account: { account_type: 'F', broker_id: 'F002', account_id: '9' } },
    status: { ...twTrade.status, id: 'f1', order_ts: 1790000005 },
} as unknown as Trade;
const usTrade = {
    account: H,
    contract: { security_type: 'STK', exchange: 'NASDAQ', code: 'AAPL', region: 'US' },
    order: { id: 'u1', seqno: '21157799', ordno: 'A1', action: 'Buy', price: '173.97', quantity: '10', price_type: 'LMT', time_in_force: 'DAY', trade_date: '20261118' },
    status: { id: 'u1', status: 'PartFilled', status_code: '00', order_ts: 1790000010, order_quantity: '10', deal_quantity: '2', cancel_quantity: '0', msg: '', deals: [], avg_price: '173.95' },
};

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(async () => { await act(async () => view?.unmount()); view = undefined; vi.unstubAllGlobals(); vi.clearAllMocks(); });

const ordersProps = (over: Record<string, unknown> = {}) => ({
    trades: [twTrade, futTrade], initialStatus: 'ready' as const, mode: 'merged' as const, market: 'all' as const,
    scopeKey: '', fallback: { stock: null, futures: null }, onChanged: vi.fn(), onSelectCode: vi.fn(),
    us: { trades: [usTrade], hint: null, error: null } as never, ...over,
});

it('renders TW and US orders in one table, newest first, with USD price and shares', async () => {
    await act(async () => { view = create(createElement(OrdersPane, ordersProps())); });
    expect(view!.root.findAllByType('table')).toHaveLength(1);
    const codes = view!.root.findAll(n => n.type === 'tr' && typeof n.props.onClick === 'function').map(r => text(r));
    expect(codes[0]).toContain('AAPL');
    expect(codes[0]).toContain('美股');
    expect(codes[1]).toContain('TXFL6');
    expect(codes[2]).toContain('2330');
    const us = text(rowOf('AAPL'));
    expect(us).toContain('173.97');
    expect(us).toContain('USD');
    expect(us).toContain('未成交 8 股');
    expect(us).toContain('成 173.95');
    expect(all()).toContain('有效 3');
});

it('links a US order row as US:AAPL and TW rows by bare code', async () => {
    const props = ordersProps();
    await act(async () => { view = create(createElement(OrdersPane, props)); });
    rowOf('AAPL').props.onClick();
    rowOf('2330').props.onClick();
    expect(props.onSelectCode.mock.calls).toEqual([['US:AAPL'], ['2330']]);
});

it('cancels a US row with the US action, never the TW cancel', async () => {
    m.cancelUs.mockResolvedValue({ confirmed: true, cancelled: '8' });
    await act(async () => { view = create(createElement(OrdersPane, ordersProps())); });
    const cancel = rowOf('AAPL').findAllByType('button').find(b => text(b) === '刪單')!;
    await act(async () => { await cancel.props.onClick(); });
    expect(m.cancelUs).toHaveBeenCalledWith(usTrade);
    expect(m.cancelTw).not.toHaveBeenCalled();
    expect(all()).toContain('已刪單（取消 8 股）');
});

it('hides US orders on the futures filter and when a single TW account is scoped', async () => {
    await act(async () => { view = create(createElement(OrdersPane, ordersProps({ market: 'F' }))); });
    expect(all()).not.toContain('AAPL');
    expect(all()).toContain('TXFL6');
    await act(async () => { view!.update(createElement(OrdersPane, ordersProps({ scopeKey: '9A95-0000001' }))); });
    expect(all()).not.toContain('AAPL');
});

it('does not match a US code against a TW code with the same text', async () => {
    const twSame = { ...twTrade, contract: { ...twTrade.contract, code: 'AAPL' }, order: { ...twTrade.order, id: 'u1' } } as unknown as Trade;
    const props = ordersProps({ trades: [twSame] });
    await act(async () => { view = create(createElement(OrdersPane, props)); });
    const rows = view!.root.findAll(n => n.type === 'tr' && typeof n.props.onClick === 'function');
    expect(rows).toHaveLength(2);
    rows.forEach(r => r.props.onClick());
    expect(props.onSelectCode.mock.calls.map(c => c[0]).sort()).toEqual(['AAPL', 'US:AAPL']);
});

it('merges by order time and keeps TW order when a TW row has no time', () => {
    const r = (kind: 'tw' | 'us', key: string, ts?: number) => ({ kind, key, ts }) as unknown as OrderRow;
    expect(mergeNewestFirst([r('tw', 'a', 5), r('tw', 'b', 1)], [r('us', 'x', 3)]).map(x => x.key)).toEqual(['a', 'x', 'b']);
    expect(mergeNewestFirst([r('tw', 'a')], [r('us', 'x', 3)]).map(x => x.key)).toEqual(['a', 'x']);
});

// ---- 持倉 ----

const twPos = { account: S, id: 1, code: '2330', direction: 'Buy', quantity: 1000, price: 1000, last_price: 1100, pnl: 100000, yd_quantity: 1000, cond: 'Cash' } as AccountedPosition;
const usPos = { account: H, id: 0, code: 'AAPL', direction: 'Buy', quantity: '10', price: '170.1', market_price: '175.5', market_value: '1755', pnl: '54', pnl_pct: '3.17', currency: 'USD' };
const posProps = (over: Record<string, unknown> = {}) => ({
    positions: [twPos], initialStatus: 'ready' as const, mode: 'merged' as const, market: 'all' as const,
    scopeKey: '', fallback: { stock: null, futures: null }, onChanged: vi.fn(), onSelectCode: vi.fn(),
    us: { positions: [usPos], status: 'ready', error: null } as never, ...over,
});

it('renders TW and US positions in one table with USD values in shares', async () => {
    const props = posProps();
    await act(async () => { view = create(createElement(PositionsPane, props)); });
    expect(view!.root.findAllByType('table')).toHaveLength(1);
    const us = text(rowOf('AAPL'));
    expect(us).toContain('10 股');
    expect(us).toContain('170.10');
    expect(us).toContain('175.50');
    expect(us).toContain('+54.00');
    expect(us).toContain('USD');
    expect(us).toContain('+3.17%');
    // US 列沒有平／反（只有展開庫存明細）
    expect(rowOf('AAPL').findAllByType('button').map(b => b.props['aria-label'])).toEqual(['展開庫存明細']);
    rowOf('AAPL').props.onClick();
    expect(props.onSelectCode).toHaveBeenCalledWith('US:AAPL');
});

it('keeps USD and TWD subtotals separate in grouped mode', async () => {
    await act(async () => { view = create(createElement(PositionsPane, posProps({ mode: 'grouped' }))); });
    const headers = view!.root.findAll(n => n.type === 'button' && /\[(證|美)\]/.test(text(n))).map(text);
    expect(headers.find(h => h.includes('[美]'))).toContain('+54.00USD');
    const tw = headers.find(h => h.includes('[證]'))!;
    expect(tw).toContain('+100,000');
    expect(tw).not.toContain('100,054');
});

it('hides US positions on the futures filter and shows the later-version notice when unsupported', async () => {
    await act(async () => { view = create(createElement(PositionsPane, posProps({ market: 'F' }))); });
    expect(all()).not.toContain('AAPL');
    await act(async () => { view!.update(createElement(PositionsPane, posProps({ us: { positions: [], status: 'unsupported', error: null } }))); });
    expect(all()).toContain('美股庫存將於後續版本提供');
});

it('expands a US position row into its lot detail without selecting the symbol', async () => {
    const props = posProps();
    await act(async () => { view = create(createElement(PositionsPane, props)); });
    expect(all()).not.toContain('DETAIL#0');
    const toggle = rowOf('AAPL').findAll(n => n.type === 'button' && n.props['aria-label'] === '展開庫存明細')[0]!;
    const stop = vi.fn();
    await act(async () => { toggle.props.onClick({ stopPropagation: stop }); });
    expect(stop).toHaveBeenCalled();
    expect(props.onSelectCode).not.toHaveBeenCalled();
    expect(all()).toContain('DETAIL#0');
    expect(all()).not.toContain('TWDETAIL');
    const close = view!.root.findAll(n => n.type === 'button' && n.props['aria-label'] === '收合庫存明細')[0]!;
    await act(async () => { close.props.onClick({ stopPropagation: vi.fn() }); });
    expect(all()).not.toContain('DETAIL#0');
});

it('expands a TW position row into its lot detail with the same toggle, keyed by the positions version', async () => {
    const fut = { account: { ...S, account_type: 'F', broker_id: 'F002' }, id: 0, code: 'TXFL6', direction: 'Sell', quantity: 2, price: 23000, last_price: 22900, pnl: 20000 } as AccountedPosition;
    const projected = { ...twPos, id: -1790000000000, code: '2317' } as AccountedPosition;
    const props = posProps({ positions: [twPos, fut, projected], twVersion: 42 });
    await act(async () => { view = create(createElement(PositionsPane, props)); });
    // 同一顆展開鈕、在代碼欄；本地推估的新列（負 id）沒有明細
    expect(rowOf('2330').findAll(n => n.type === 'button' && n.props['aria-label'] === '展開庫存明細')).toHaveLength(1);
    expect(rowOf('TXFL6').findAll(n => n.type === 'button' && n.props['aria-label'] === '展開庫存明細')).toHaveLength(1);
    expect(rowOf('2317').findAll(n => n.type === 'button' && n.props['aria-label'] === '展開庫存明細')).toHaveLength(0);
    await act(async () => { rowOf('2330').findAll(n => n.type === 'button' && n.props['aria-label'] === '展開庫存明細')[0]!.props.onClick({ stopPropagation: vi.fn() }); });
    expect(props.onSelectCode).not.toHaveBeenCalled();
    expect(all()).toContain('TWDETAIL#S:1:2330:Buy:Cash:1000:v42');
    await act(async () => { rowOf('TXFL6').findAll(n => n.type === 'button' && n.props['aria-label'] === '展開庫存明細')[0]!.props.onClick({ stopPropagation: vi.fn() }); });
    expect(all()).toContain('TWDETAIL#F:0:TXFL6:Sell:-:2:v42');
    // 明細列橫跨表格其餘欄位
    const detailCell = view!.root.findAll(n => n.type === 'td' && n.props.colSpan === 11);
    expect(detailCell).toHaveLength(2);
});

// 美股帳務另見 us-account-panels.test.tsx

