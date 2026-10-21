// 閃電連動：換標的、換對應商品、換群組（linkKey 變了）同一次 render 解除點價
// 下單，確認視窗開著時的那筆不送；商品列的種類標籤；價差對照列。
import { createElement, useLayoutEffect } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../hooks/use-flash-ladder', () => ({ useFlashLadder: () => ({ marks: new Map(), protectedQty: 0, background: false }) }));
vi.mock('../lib/flash-conditional', () => ({ flashStopProtections: async () => ({ stopped: 0, blocked: [], failed: [], restore: [] }) }));
import type { Account } from '../lib/types/portfolio';
import type { ContractInfo } from '../lib/types/contract';
const mocks = vi.hoisted(() => ({ place: vi.fn(), notify: vi.fn(), cancel: vi.fn(), store: new Map<string, string>() }));
const accounts: Account[] = [
    { account_type: 'S', broker_id: 'BR', account_id: 'A1234', signed: true, person_id: '', username: '' },
    { account_type: 'F', broker_id: 'BR', account_id: 'F5678', signed: true, person_id: '', username: '' },
];
vi.mock('../lib/account-store', () => ({ ensureAccounts: () => undefined, useAccounts: () => ({ loaded: true, accounts, selectedStock: accounts[0], selectedFutures: accounts[1] }) }));
vi.mock('../hooks/use-stream', () => ({
    useTradingLive: () => true,
    useQuote: (code: string | null, o?: { oddLot?: boolean }) => (o?.oddLot ? { tick: { close: '1080', volume: 1 } } : code === '2330' ? { tick: { close: '1085', volume: 1 } } : undefined),
}));
vi.mock('../hooks/use-display-book', () => ({
    useDisplayBook: (code: string) => (code === 'CDFK6' ? { quote: undefined, snapshot: undefined, book: undefined }
        : { quote: { tick: { close: code === 'CDFJ6' ? '1095' : '1085', volume: 1 } }, snapshot: undefined, book: undefined }),
}));
vi.mock('../lib/shioaji', () => ({ cancelOrder: vi.fn(), cancelOrders: mocks.cancel }));
vi.mock('../lib/trade', () => ({ notify: mocks.notify, placeQuickOrder: mocks.place, placeStockExitByShares: vi.fn() }));
vi.mock('../lib/stream', () => ({ getAliasFor: () => undefined }));
vi.mock('../lib/tick-bands', () => ({ useTickBandsVersion: () => 0 }));
vi.mock('../lib/utils/ticksize', () => ({ roundToTick: (_c: unknown, p: number) => p, stepPrice: (_c: unknown, p: number, step: number) => p + step }));
import { FlashOrder } from './flash-order';

const stk = { code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', day_trade: 'Yes', reference: 1085, limit_up: 1190, limit_down: 980 } as unknown as ContractInfo;
const cdf = { code: 'CDFJ6', name: '台積電期貨 202610', security_type: 'FUT', exchange: 'TAIFEX', delivery_month: '202610', last_trading_date: '2026-10-21', underlying_code: '2330', underlying_kind: 'S', multiplier: 2000, reference: 1095, limit_up: 1200, limit_down: 990 } as unknown as ContractInfo;
const txf = { code: 'TXFJ6', name: '臺股期貨 202610', security_type: 'FUT', exchange: 'TAIFEX', delivery_month: '202610', underlying_code: 'IX0001', underlying_kind: 'I', multiplier: 200, reference: 100 } as unknown as ContractInfo;

const text = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : text(c))).join('');
const roots: ReactTestRenderer[] = [];
const button = (r: ReactTestRenderer, label: string) => r.root.findAllByType('button').find(b => text(b).includes(label))!;
const buyCell = (r: ReactTestRenderer) => r.root.findAll(n => n.type === 'div' && n.props['data-side'] === 'buy')[0]!;
const byTestId = (r: ReactTestRenderer, id: string) => r.root.findAll(n => n.props['data-testid'] === id && typeof n.type === 'string')[0];
const props = (contract: ContractInfo, extra: Record<string, unknown> = {}) => ({ contract, trades: [], positions: [], ...extra });
const mount = async (contract: ContractInfo, extra: Record<string, unknown> = {}) => {
    let r!: ReactTestRenderer;
    await act(async () => { r = create(createElement(FlashOrder, props(contract, extra))); });
    roots.push(r);
    return r;
};
const show = async (r: ReactTestRenderer, contract: ContractInfo, extra: Record<string, unknown> = {}) => {
    await act(async () => { r.update(createElement(FlashOrder, props(contract, extra))); });
};
const arm = async (r: ReactTestRenderer) => { await act(async () => { button(r, '啟用閃電下單').props.onClick(); }); };

beforeEach(() => {
    vi.clearAllMocks();
    // cdf's last trading date is 2026-10-21 and stock futures lock at 13:30 that day, so a
    // real clock makes every cdf order test fail from that afternoon on. Pin the clock to a
    // normal trading morning before it; tests about the expiry set their own time.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T10:00:00+08:00'));
    mocks.store.clear();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: (k: string) => mocks.store.get(k) ?? null, setItem: (k: string, v: string) => { mocks.store.set(k, v); } });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    mocks.place.mockResolvedValue({ status: { status: 'PendingSubmit' } });
});
afterEach(async () => {
    for (const r of roots.splice(0)) await act(async () => r.unmount());
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

it('a new link key (mapping or group changed, same contract) disarms in the same render and never revives', async () => {
    const r = await mount(stk, { linkKey: 'main|select|2330' });
    await arm(r);
    expect(text(r.root)).toContain('點價即下單');
    await show(r, stk, { linkKey: 'A|stock|2330' });
    expect(text(r.root)).not.toContain('點價即下單');
    await act(async () => { buyCell(r).props.onClick(); });
    await show(r, stk, { linkKey: 'main|select|2330' });
    await act(async () => { buyCell(r).props.onClick(); });
    expect(mocks.place).not.toHaveBeenCalled();
});

it('an order waiting in the confirmation dialog is not sent once the link key changes', async () => {
    let guard!: () => void;
    mocks.place.mockImplementation((_c: unknown, _a: unknown, _p: unknown, _q: unknown, opts: { beforeSend: () => void }) => {
        guard = opts.beforeSend;
        return new Promise(() => undefined);
    });
    const r = await mount(stk, { linkKey: 'A|stock|2330' });
    await arm(r);
    await act(async () => { buyCell(r).props.onClick(); });
    expect(mocks.place).toHaveBeenCalledOnce();
    expect(() => guard()).not.toThrow();
    await show(r, stk, { linkKey: 'A|stock|2317' });
    await show(r, stk, { linkKey: 'A|stock|2330' });
    expect(() => guard()).toThrow();
});

it('shows the kind of product and its unit on the symbol row', async () => {
    const r = await mount(stk);
    expect(text(byTestId(r, 'flash-kind')!)).toBe('整股張');
    await show(r, cdf);
    expect(text(byTestId(r, 'flash-kind')!)).toBe('股期口');
    await show(r, txf);
    expect(text(byTestId(r, 'flash-kind')!)).toBe('期貨口');
    const odd = await mount(stk, { lot: 'IntradayOdd', onLotChange: () => undefined });
    expect(text(byTestId(odd, 'flash-kind')!)).toBe('零股股');
});

it('odd-lot panel shows the odd/round-lot spread; stock-future panel the basis and 1口=N張', async () => {
    const odd = await mount(stk, { lot: 'IntradayOdd', onLotChange: () => undefined });
    expect(text(byTestId(odd, 'flash-ref')!)).toBe('整股 1,085整零差 −5 (−0.46%)');
    const f = await mount(cdf);
    expect(text(byTestId(f, 'flash-ref')!)).toBe('現股 1,085期現差 +10 (+0.92%)1口=2張');
    // round-lot stock and index futures have no spread row
    const round = await mount(stk);
    expect(byTestId(round, 'flash-ref')).toBeUndefined();
    const idx = await mount(txf);
    expect(byTestId(idx, 'flash-ref')).toBeUndefined();
    // hidden in settings
    const hidden = await mount(cdf, { showRef: false });
    expect(byTestId(hidden, 'flash-ref')).toBeUndefined();
});

it('the basis uses traded prices only — a future with no trade shows —, not its reference price', async () => {
    const r = await mount({ ...cdf, code: 'CDFK6', reference: 1100 } as ContractInfo);
    expect(text(byTestId(r, 'flash-ref')!)).toBe('現股 1,085期現差 —1口=2張');
});

it('a mapped future that has reached its expiry is not sent, also when the confirmation is still open', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T13:29:00+08:00'));
    let guard!: () => void;
    mocks.place.mockImplementation((_c: unknown, _a: unknown, _p: unknown, _q: unknown, opts: { beforeSend: () => void }) => {
        guard = opts.beforeSend;
        return new Promise(() => undefined);
    });
    const expiresAt = Date.parse('2026-10-21T13:30:00+08:00');
    const r = await mount(cdf, { expiresAt });
    await arm(r);
    await act(async () => { buyCell(r).props.onClick(); });
    expect(mocks.place).toHaveBeenCalledOnce();
    vi.setSystemTime(new Date('2026-10-21T13:30:05+08:00'));
    expect(() => guard()).toThrow(/到期/);
    // a click after the expiry instant is refused before anything is sent
    await act(async () => { buyCell(r).props.onClick(); });
    expect(mocks.place).toHaveBeenCalledOnce();
    vi.useRealTimers();
});

it('the ladder already shows locked in the commit where the link key changes (before effects)', async () => {
    let r!: ReactTestRenderer;
    const seen: boolean[] = [];
    const Wrapped = ({ linkKey, look }: { linkKey: string; look: boolean }) => {
        useLayoutEffect(() => { if (look) seen.push(text(r.root).includes('點價即下單')); }, [look]);
        return createElement(FlashOrder, props(stk, { linkKey }));
    };
    await act(async () => { r = create(createElement(Wrapped, { linkKey: 'A|future|2330', look: false })); });
    roots.push(r);
    await arm(r);
    await act(async () => { r.update(createElement(Wrapped, { linkKey: 'A|future|2317', look: true })); });
    expect(seen).toEqual([false]);
});

it('flatten is also refused once the mapped future has expired, including a pending confirmation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T13:29:00+08:00'));
    let guard!: () => void;
    mocks.place.mockImplementation((_c: unknown, _a: unknown, _p: unknown, _q: unknown, opts: { beforeSend: () => void }) => {
        guard = opts.beforeSend;
        return new Promise(() => undefined);
    });
    const position = { code: 'CDFJ6', direction: 'Buy', quantity: 1, price: 1090, pnl: 0, last_price: 1095, account: accounts[1] };
    const r = await mount(cdf, { expiresAt: Date.parse('2026-10-21T13:30:00+08:00'), positions: [position] });
    await arm(r);
    await act(async () => { button(r, '平倉').props.onClick(); });
    expect(mocks.place).toHaveBeenCalledOnce();
    vi.setSystemTime(new Date('2026-10-21T13:30:05+08:00'));
    expect(() => guard()).toThrow(/到期/);
    vi.useRealTimers();
});

it('other futures (UDF, index) are not judged expired by this feature — they trade after 13:30 on their last day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T15:01:00+08:00'));
    const udf = { code: 'UDFJ6', name: '美國道瓊期貨 202610', security_type: 'FUT', exchange: 'TAIFEX', delivery_month: '202610', last_trading_date: '2026-10-21', underlying_kind: 'I', multiplier: 20, reference: 100, limit_up: 200, limit_down: 1 } as unknown as ContractInfo;
    const r = await mount(udf);
    await arm(r);
    await act(async () => { buyCell(r).props.onClick(); });
    expect(mocks.place).toHaveBeenCalledOnce();
    vi.useRealTimers();
});

it('a paused panel (lookup in progress) cannot be armed or send, and shows the reason instead of the ladder', async () => {
    const r = await mount(stk, { linkKey: 'A|future|2330' });
    await arm(r);
    await show(r, stk, { linkKey: 'A|future|2317', paused: '載入個股期…' });
    expect(text(r.root)).toContain('載入個股期…');
    expect(text(r.root)).not.toContain('台積電');
    await arm(r);
    expect(text(r.root)).not.toContain('點價即下單');
    await act(async () => { buyCell(r)?.props.onClick(); });
    expect(mocks.place).not.toHaveBeenCalled();
});

it('a real-month future without a mapping (popout, 照選取) is also locked after its last trading close', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T13:31:00+08:00'));
    const r = await mount({ ...cdf, last_trading_date: '2026-10-21' } as ContractInfo);
    await arm(r);
    await act(async () => { buyCell(r).props.onClick(); });
    expect(mocks.place).not.toHaveBeenCalled();
    vi.useRealTimers();
});

it('entering the paused state voids an order waiting in confirmation, and a paused panel cannot cancel the old contract', async () => {
    let guard!: () => void;
    mocks.place.mockImplementation((_c: unknown, _a: unknown, _p: unknown, _q: unknown, opts: { beforeSend: () => void }) => {
        guard = opts.beforeSend;
        return new Promise(() => undefined);
    });
    const trade = { contract: { code: 'CDFJ6' }, order: { id: 'o1', action: 'Buy', price: 1090, quantity: 1, order_lot: 'Common', account: accounts[1] }, status: { status: 'Submitted', order_quantity: 1, deal_quantity: 0, cancel_quantity: 0, modified_price: 0, deals: [] }, account: accounts[1] };
    const r = await mount(cdf, { linkKey: 'A|future|next|2330', trades: [trade] });
    await arm(r);
    await act(async () => { buyCell(r).props.onClick(); });
    expect(() => guard()).not.toThrow();
    // same contract and link key, now paused while the list is re-fetched
    await show(r, cdf, { linkKey: 'A|future|next|2330', trades: [trade], paused: '載入個股期…' });
    expect(() => guard()).toThrow();
    const cancelAll = r.root.findAllByType('button').find(b => text(b).startsWith('全刪'))!;
    expect(cancelAll.props.disabled).toBe(true);
});

it('a cancel still waiting to be dispatched is dropped once the panel pauses (or the link changes)', async () => {
    let guard!: () => void;
    mocks.cancel.mockImplementation((_ids: string[], _settled: unknown, beforeSend: () => void) => { guard = beforeSend; return new Promise(() => undefined); });
    const trade = { contract: { code: 'CDFJ6' }, order: { id: 'o1', action: 'Buy', price: 1090, quantity: 1, order_lot: 'Common', account: accounts[1] }, status: { status: 'Submitted', order_quantity: 1, deal_quantity: 0, cancel_quantity: 0, modified_price: 0, deals: [] }, account: accounts[1] };
    const r = await mount(cdf, { linkKey: 'A|future|near|2330', trades: [trade] });
    await act(async () => { r.root.findAllByType('button').find(b => text(b).startsWith('全刪'))!.props.onClick(); });
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(() => guard()).not.toThrow();
    await show(r, cdf, { linkKey: 'A|future|near|2317', trades: [trade], paused: '載入個股期…' });
    expect(() => guard()).toThrow();
});

it('the settings dialog of a paused panel names no contract', async () => {
    const r = await mount(cdf, { paused: '載入個股期…' });
    await act(async () => { r.root.findAll(n => n.type === 'button' && n.props['aria-label'] === '單位與委託條件')[0]!.props.onClick(); });
    const more = r.root.findAll(n => n.type === 'button' && n.props.role === 'menuitem' && text(n).includes('更多設定'))[0];
    if (more) await act(async () => { more.props.onClick(); });
    const dlg = r.root.findAll(n => n.props.role === 'dialog')[0];
    expect(dlg && text(dlg)).not.toContain('CDFJ6');
    expect(text(r.root)).not.toContain('Σ買');
});

it('a real-month stock future without a last trading date (照選取 / popout) is paused and cannot send', async () => {
    const r = await mount({ ...cdf, last_trading_date: undefined } as ContractInfo);
    expect(text(r.root)).toContain('到期日無法確認');
    await arm(r);
    await act(async () => { buyCell(r)?.props.onClick(); });
    expect(mocks.place).not.toHaveBeenCalled();
});

it('a paused panel shows no old-contract info: no order count, no credit banner', async () => {
    const trade = { contract: { code: '2330' }, order: { id: 'o1', action: 'Buy', price: 1080, quantity: 3, order_lot: 'Common', account: accounts[0] }, status: { status: 'Submitted', order_quantity: 3, deal_quantity: 0, cancel_quantity: 0, modified_price: 0, deals: [] }, account: accounts[0] };
    const r = await mount(stk, { trades: [trade], credit: { cond: 'MarginTrading', daytradeShort: false }, onCreditChange: () => undefined, paused: '載入商品…' });
    expect(text(r.root)).not.toContain('全刪 3');
    expect(byTestId(r, 'flash-credit-banner')).toBeUndefined();
});
