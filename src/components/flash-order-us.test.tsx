// 美股閃電：FlashOrder 遇到美股合約改畫美股梯形。參考價置中、第一筆成交後改以成交價置中；
// 點價＝H 帳戶整股 LMT DAY（不帶台股欄位）；Kill Switch 擋單；點自己的委託＝刪單。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';
import type { ContractInfo } from '../lib/types/contract';
import type { AccountedUsTrade } from '../lib/types/us';

const mocks = vi.hoisted(() => ({
    snap: null as unknown,
    quote: undefined as unknown,
    live: true,
    locked: null as string | null,
    confirmManual: false,
    trades: [] as unknown[],
    place: vi.fn(),
    cancel: vi.fn(),
    observe: vi.fn(),
    notify: vi.fn(),
    confirm: vi.fn(),
}));
const { H, H2, S } = vi.hoisted(() => {
    const H = { account_type: 'H', broker_id: '9A95', account_id: '1234567', signed: true, person_id: 'P', username: 'U' } as Account;
    const H2 = { ...H, account_id: '7654321' } as Account;
    const S = { account_type: 'S', broker_id: '9A95', account_id: '1234567', signed: true, person_id: 'P', username: 'U' } as Account;
    return { H, H2, S };
});
vi.mock('../hooks/use-stream', () => ({ useQuote: () => mocks.quote, useTradingLive: () => mocks.live }));
vi.mock('../lib/account-store', () => {
    const state = () => ({ loaded: true, accounts: [S, H, H2], selectedStock: S, selectedFutures: null, selectedIntl: H });
    return { ensureAccounts: () => undefined, useAccounts: state, getAccountState: state, subscribeAccounts: () => () => undefined };
});
vi.mock('../hooks/use-us-snapshot', async importOriginal => ({ ...(await importOriginal<object>()), useUsSnapshot: () => mocks.snap }));
vi.mock('../lib/privacy', () => ({ usePrivacyMode: () => false, maskAccountId: (id: string) => id, maskName: (n: string) => n, usePrivacyMoney: () => false, maskMoney: (v: string) => v }));
vi.mock('../lib/risk', () => ({ checkUsOrderAllowed: () => mocks.locked, getRiskSettings: () => ({ confirmManualOrders: mocks.confirmManual }) }));
vi.mock('../lib/order-confirm', () => ({ requestOrderConfirm: mocks.confirm, accountConfirmLabel: (a: Account) => a.account_id }));
vi.mock('../lib/server-info-store', async importOriginal => ({ ...(await importOriginal<object>()), captureServerMode: () => () => true, SERVER_MODE_CHANGED_MESSAGE: 'changed' }));
vi.mock('../lib/trade', () => ({ notify: mocks.notify, placeQuickOrder: vi.fn(), placeStockExitByShares: vi.fn() }));
vi.mock('../lib/us/us-api', () => ({
    placeUsOrder: mocks.place,
    usErrorText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock('../lib/us/us-order-actions', () => ({
    cancelUsTrade: mocks.cancel,
    UsCancelTooEarlyError: class extends Error { constructor() { super('剛送出的委託稍後再刪'); } },
}));
vi.mock('../lib/us/us-trading-state', async importOriginal => {
    const real = await importOriginal<typeof import('../lib/us/us-trading-state')>();
    return { usIsWorking: real.usIsWorking, usRemaining: real.usRemaining, observeUsTrade: mocks.observe, useUsTradingState: () => ({ trades: mocks.trades }) };
});
import { FlashOrder } from './flash-order';
import { UsCancelTooEarlyError } from '../lib/us/us-order-actions';

const aapl = {
    code: 'AAPL', name: 'Apple', region: 'US', exchange: 'NASDAQ', security_type: 'STK', currency: 'USD',
    reference: 187.5, limit_up: 0, limit_down: 0, us_reference: '187.5', reference_date: '2026-11-17',
} as unknown as ContractInfo;

const text = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : text(c))).join('');
let view!: ReactTestRenderer;
const render = async (contract: ContractInfo = aapl, props: Record<string, unknown> = {}) => {
    await act(async () => { view = create(createElement(FlashOrder, { contract, ...props } as never)); });
    // 美股分支是 lazy 載入：等它換掉 Suspense fallback
    for (let i = 0; i < 20 && !view.root.findAll(n => n.props['data-testid'] === 'flash-us').length; i++) {
        await act(async () => { await new Promise(r => setTimeout(r, 5)); });
    }
};
const rowPrices = () => view.root.findAll(n => typeof n.type === 'string' && n.props['data-price'] !== undefined).map(n => n.props['data-price'] as string);
const row = (price: string) => view.root.find(n => typeof n.type === 'string' && n.props['data-price'] === price);
const cell = (price: string, side: 'buy' | 'sell') => row(price).find(n => typeof n.type === 'string' && n.props['data-side'] === side);
const button = (label: string) => view.root.findAllByType('button').find(b => text(b).includes(label))!;
const arm = async () => { await act(async () => { button('啟用閃電下單').props.onClick(); }); };
const middle = () => { const p = rowPrices(); return p[Math.floor(p.length / 2)]; };
const working = (id: string, action: 'Buy' | 'Sell', price: string, qty = '5', account = H): AccountedUsTrade => ({
    account,
    contract: { security_type: 'STK', exchange: 'NASDAQ', code: 'AAPL', region: 'US' },
    order: { id, seqno: id, ordno: id, action, price, quantity: qty, price_type: 'LMT', time_in_force: 'DAY' },
    status: { id, status: 'Submitted', status_code: '', order_quantity: qty, deal_quantity: '0', cancel_quantity: '0', msg: '', deals: [] },
}) as AccountedUsTrade;

beforeEach(() => {
    vi.clearAllMocks();
    mocks.quote = undefined;
    mocks.live = true;
    mocks.locked = null;
    mocks.confirmManual = false;
    mocks.trades = [];
    mocks.place.mockImplementation(async () => ({ order: { id: 'new' }, status: { status: 'Submitted' } }));
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

it('uses the snapshot reference over a stale contract reference, like the quote board', async () => {
    mocks.snap = { reference: 188, tradeDate: '2026-11-19' };
    await render();
    expect(middle()).toBe('188');
    expect(text(view.root.find(n => n.props['data-testid'] === 'flash-us-ref'))).toBe('參考 188.00・尚無即時報價');
    mocks.snap = null;
});

it('before the first quote the ladder centers on the reference price and says so', async () => {
    await render();
    expect(view.root.findAll(n => n.props['data-testid'] === 'flash-us').length).toBe(1);
    expect(middle()).toBe('187.5');
    expect(rowPrices()[0]).toBe('187.57');
    expect(text(view.root.find(n => n.props['data-testid'] === 'flash-us-ref'))).toBe('參考 187.50（2026-11-17）・尚無即時報價');
    // 美股沒有市價、平倉、零股、信用
    const all = text(view.root);
    for (const word of ['市價', '平倉', '零股', '融資']) expect(all).not.toContain(word);
});

it('after a quote the ladder centers on the last price and marks best bid／ask volumes only', async () => {
    await render();
    const rerender = async () => { await act(async () => { view.update(createElement(FlashOrder, { contract: aapl } as never)); }); };
    // 第一筆成交價就在參考價視窗內：仍改以成交價置中
    mocks.quote = { tick: { close: '187.52', volume: 1 } };
    await rerender();
    expect(middle()).toBe('187.52');
    mocks.quote = {
        tick: { close: '190.25', volume: 3 },
        bidask: { bid_price: ['190.24'], bid_volume: [12], ask_price: ['190.26'], ask_volume: [7] },
    };
    await rerender();
    expect(middle()).toBe('190.25');
    expect(view.root.findAll(n => n.props['data-testid'] === 'flash-us-ref').length).toBe(0);
    expect(text(cell('190.24', 'buy'))).toBe('12');
    expect(text(cell('190.26', 'sell'))).toBe('7');
    expect(text(cell('190.23', 'buy'))).toBe('');
    expect(text(row('190.25'))).toContain('×3');
});

it('clicking a buy cell sends an H-account LMT DAY order at the row price, without TW fields', async () => {
    await render();
    await arm();
    await act(async () => { cell('187.52', 'buy').props.onClick(); });
    expect(mocks.place).toHaveBeenCalledTimes(1);
    const [contract, order, account, opts] = mocks.place.mock.calls[0]!;
    expect(contract).toEqual({ code: 'AAPL', exchange: 'NASDAQ' });
    expect(order).toEqual({ action: 'Buy', price: '187.52', quantity: 1, price_type: 'LMT', time_in_force: 'DAY' });
    for (const k of ['order_lot', 'order_cond', 'daytrade_short', 'custom_field']) expect(order).not.toHaveProperty(k);
    expect(account).toBe(H);
    expect(typeof opts.beforeDispatch).toBe('function');
    expect(mocks.observe).toHaveBeenCalledWith(expect.objectContaining({ order: { id: 'new' } }), H);
});

it('does nothing until armed, and asks for confirmation when manual confirm is on', async () => {
    await render();
    await act(async () => { cell('187.5', 'sell').props.onClick(); });
    expect(mocks.place).not.toHaveBeenCalled();
    mocks.confirmManual = true;
    mocks.confirm.mockResolvedValue(false);
    await arm();
    await act(async () => { cell('187.5', 'sell').props.onClick(); });
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ code: 'AAPL', action: 'Sell', priceLabel: '187.5 USD', unit: '股', quantity: 1 }), expect.anything());
    expect(mocks.place).not.toHaveBeenCalled();
});

it('Kill Switch blocks before sending and again right before dispatch', async () => {
    await render();
    await arm();
    mocks.locked = '風控鎖啟動中 — 所有下單已封鎖';
    await act(async () => { cell('187.5', 'buy').props.onClick(); });
    expect(mocks.place).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'err', body: '風控鎖啟動中 — 所有下單已封鎖' }));

    mocks.locked = null;
    mocks.place.mockImplementation(async (_c: unknown, _o: unknown, _a: unknown, opts: { beforeDispatch: () => void }) => {
        mocks.locked = '風控鎖啟動中 — 所有下單已封鎖';
        opts.beforeDispatch();
        return { order: { id: 'x' } };
    });
    await act(async () => { cell('187.5', 'buy').props.onClick(); });
    expect(mocks.observe).not.toHaveBeenCalled();
});

it('disabled when trading is not live or the stock is suspended', async () => {
    mocks.live = false;
    await render();
    expect(button('未連線').props.disabled).toBe(true);
    mocks.live = true;
    await act(async () => view.unmount());
    await render({ ...aapl, trading_suspended: true } as ContractInfo);
    expect(button('啟用閃電下單').props.disabled).toBe(true);
});

it('working orders of this account show on their rows; clicking the marker cancels via cancelUsTrade', async () => {
    const mine = working('w1', 'Buy', '187.48', '5');
    mocks.trades = [mine, working('w2', 'Sell', '187.53', '3'), working('other', 'Buy', '187.48', '9', H2)];
    mocks.cancel.mockResolvedValue({ confirmed: true, cancelled: '5' });
    await render();
    const chip = row('187.48').find(n => n.props['data-testid'] === 'flash-us-chip-buy');
    expect(text(chip)).toBe('5');
    expect(text(row('187.53').find(n => n.props['data-testid'] === 'flash-us-chip-sell'))).toBe('3');
    await act(async () => { chip.props.onClick(); });
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    expect(mocks.cancel).toHaveBeenCalledWith(mine);
    expect(mocks.notify).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'ok', body: expect.stringContaining('已刪 5 股') }));

    mocks.cancel.mockRejectedValue(new UsCancelTooEarlyError());
    await act(async () => { chip.props.onClick(); });
    expect(mocks.notify).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'err', body: expect.stringContaining('剛送出的委託稍後再刪') }));
});

it('a double click on the same price sends only one order while the first is in flight', async () => {
    await render();
    let resolve!: (v: unknown) => void;
    mocks.place.mockImplementation(() => new Promise(r => { resolve = r; }));
    await arm();
    await act(async () => {
        cell('187.5', 'buy').props.onClick();
        cell('187.5', 'buy').props.onClick();
    });
    expect(mocks.place).toHaveBeenCalledTimes(1);
    await act(async () => { resolve({ order: { id: 'n' }, status: { status: 'Submitted' } }); });
    await act(async () => { cell('187.5', 'buy').props.onClick(); });
    expect(mocks.place).toHaveBeenCalledTimes(2);
});

it('re-locks on symbol change (also after switching back) and on disconnect', async () => {
    const msft = { ...aapl, code: 'MSFT', name: 'Microsoft', us_reference: '410', reference: 410 } as unknown as ContractInfo;
    await render();
    await arm();
    expect(text(view.root)).not.toContain('啟用閃電下單');
    await act(async () => { view.update(createElement(FlashOrder, { contract: msft } as never)); });
    await act(async () => { view.update(createElement(FlashOrder, { contract: aapl } as never)); });
    expect(text(view.root)).toContain('啟用閃電下單');
    await arm();
    mocks.live = false;
    await act(async () => { view.update(createElement(FlashOrder, { contract: aapl } as never)); });
    mocks.live = true;
    await act(async () => { view.update(createElement(FlashOrder, { contract: aapl } as never)); });
    expect(text(view.root)).toContain('啟用閃電下單');
    await act(async () => { cell('187.5', 'buy').props.onClick(); });
    expect(mocks.place).not.toHaveBeenCalled();
});
