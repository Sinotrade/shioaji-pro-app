// #204 閃電下單盤中零股：單位切換、只限價、委託與持倉以正確單位顯示
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';
import type { Trade } from '../lib/types/order';
import type { ContractInfo } from '../lib/types/contract';
const mocks = vi.hoisted(() => ({ cancel: vi.fn(), place: vi.fn(), stockExit: vi.fn(), notify: vi.fn() }));
const accounts: Account[] = [{ account_type: 'S', broker_id: 'BR', account_id: 'A', signed: true, person_id: '', username: '' }];
vi.mock('../lib/account-store', () => ({ ensureAccounts: () => undefined, useAccounts: () => ({ loaded: true, accounts, selectedStock: accounts[0], selectedFutures: undefined }) }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => undefined, useTradingLive: () => true }));
vi.mock('../hooks/use-display-book', () => ({ useDisplayBook: () => ({ quote: undefined, snapshot: { close: 100 }, book: undefined }) }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: mocks.cancel, cancelOrders: (ids: string[]) => Promise.allSettled(ids.map(id => mocks.cancel(id))) }));
vi.mock('../lib/trade', () => ({ notify: mocks.notify, placeQuickOrder: mocks.place, placeStockExitByShares: mocks.stockExit }));
vi.mock('../lib/stream', () => ({ getAliasFor: () => undefined }));
vi.mock('../lib/tick-bands', () => ({ useTickBandsVersion: () => 0 }));
vi.mock('../lib/utils/ticksize', () => ({ roundToTick: (_c: unknown, p: number) => p, stepPrice: (_c: unknown, p: number, step: number) => p + step }));
import { FlashOrder } from './flash-order';

const contract = { code: '2330', security_type: 'STK', reference: 100, limit_up: 110, limit_down: 90 } as unknown as ContractInfo;
const order = (id: string, lot: string, quantity: number) => ({ account: accounts[0], contract, order: { id, account: accounts[0], price: 100, action: 'Buy', quantity, order_lot: lot },
    status: { status: 'Submitted', order_quantity: quantity, deal_quantity: 0, cancel_quantity: 0, deals: [] } }) as unknown as Trade;
const trades = [order('lot', 'Common', 2), order('odd', 'IntradayOdd', 300)];
const chip = (label: string) => view.root.findAllByType('button').find(b => String(b.props.title ?? '').startsWith('刪除') && text(b) === label)!;
const positions = [{ account: accounts[0], id: 0, code: '2330', direction: 'Buy' as const, quantity: 1500, price: 100, last_price: 100, pnl: 0, cond: 'Cash' }];
const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
let view!: ReactTestRenderer;
const button = (label: string) => view.root.findAllByType('button').find(b => text(b).includes(label))!;
const chips = () => view.root.findAllByType('button').filter(b => String(b.props.title ?? '').startsWith('刪除')).map(text);
// 單位在「閃電下單設定」彈出面板裡（#204）
const settings = (root: ReactTestInstance = view.root) => root.findAll(n => n.type === 'button' && n.props['aria-label'] === '閃電下單設定')[0];
const setUnit = async (lot: 'Common' | 'IntradayOdd', root: ReactTestInstance = view.root) => {
    await act(async () => { settings(root)!.props.onClick(); });
    const pop = root.findAll(n => n.props.role === 'dialog')[0]!;
    await act(async () => { pop.findAll(n => n.type === 'button' && text(n) === (lot === 'IntradayOdd' ? '盤中零股（股）' : '整股（張）'))[0]!.props.onClick(); });
    await act(async () => { pop.findAll(n => n.type === 'button' && text(n) === '完成')[0]!.props.onClick(); });
};
const buyCell = () => view.root.findAll(n => n.type === 'div' && String(n.props.title ?? '').startsWith('限價買 '))[0]!;
const cellPrice = () => Number(String(buyCell().props.title).slice(4).replace(/,/g, ''));

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    mocks.place.mockResolvedValue({ status: { status: 'PendingSubmit' } });
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

it.each(['symbol', 'switch back', 'unit', 'unmount'])(
    'refuses a pending flash order at dispatch after %s changes', async change => {
        let release!: () => void;
        const wait = new Promise<void>(r => { release = r; });
        const dispatched = vi.fn();
        mocks.place.mockImplementation(async (_c, _s, _p, _q, opts) => {
            await wait;
            opts.beforeSend();
            dispatched();
            return { status: { status: 'Submitted' } };
        });
        const props = { contract, trades: [], positions: [] };
        await act(async () => { view = create(createElement(FlashOrder, props)); });
        await setUnit('IntradayOdd');
        await act(async () => { button('啟用閃電下單').props.onClick(); });
        await act(async () => { buyCell().props.onClick(); });
        expect(mocks.place).toHaveBeenCalledOnce();
        if (change === 'unmount') await act(async () => view.unmount());
        else if (change === 'unit') await setUnit('Common');
        else {
            await act(async () => { view.update(createElement(FlashOrder, { ...props, contract: { ...contract, code: '2317' } })); });
            if (change === 'switch back') await act(async () => { view.update(createElement(FlashOrder, props)); });
        }
        await act(async () => { release(); });
        expect(dispatched).not.toHaveBeenCalled();
        expect(mocks.notify.mock.calls.at(-1)![0]).toMatchObject({ title: '⚡ 閃電下單失敗' });
    },
);

it('invalidates a pending stock exit when the flash panel changes symbol', async () => {
    let release!: () => void;
    const wait = new Promise<void>(r => { release = r; });
    const dispatched = vi.fn();
    mocks.stockExit.mockImplementationOnce(async (_c, _s, _q, _a, opts) => {
        await wait;
        opts.beforeSend();
        dispatched();
    });
    const props = { contract, trades: [], positions };
    await act(async () => { view = create(createElement(FlashOrder, props)); });
    await act(async () => { button('啟用閃電下單').props.onClick(); });
    let pending!: Promise<unknown>;
    await act(async () => { pending = button('平倉').props.onClick(); });
    expect(mocks.stockExit).toHaveBeenCalledOnce();
    await act(async () => { view.update(createElement(FlashOrder, { ...props, contract: { ...contract, code: '2317' } })); });
    await act(async () => { release(); await pending; });
    expect(dispatched).not.toHaveBeenCalled();
});

it('switches to 盤中零股: unit 股, limit-only, sends IntradayOdd shares and keeps each unit on its own ladder', async () => {
    await act(async () => { view = create(createElement(FlashOrder, { contract, trades, positions })); });
    // stock position is shown in 張＋股, not raw shares
    expect(text(view.root)).toContain('多 1張+500股');
    // whole-lot mode: only the 2-張 order is a chip; the odd one is counted aside
    expect(chips()).toEqual(['2']);
    expect(text(view.root)).toContain('另有零股委託 1 筆');
    await setUnit('IntradayOdd');
    expect(chips()).toEqual(['300']);
    expect(text(view.root)).toContain('另有整股委託 1 筆');
    expect(text(view.root)).toContain('盤中零股 · 以股計');
    expect(button('市價買').props.disabled).toBe(true);
    const qty = view.root.findAll(n => n.type === 'input' && n.props['aria-label'] === '數量（股）')[0]!;
    await act(async () => { qty.props.onChange({ target: { value: '1000' } }); }); // over 999: ignored
    await act(async () => { qty.props.onChange({ target: { value: '250' } }); });
    await act(async () => { button('啟用閃電下單').props.onClick(); });
    const price = cellPrice();
    expect(price).toBeGreaterThan(0);
    await act(async () => { buyCell().props.onClick(); });
    expect(mocks.place).toHaveBeenCalledTimes(1);
    expect(mocks.place.mock.calls[0]!.slice(1, 4)).toEqual(['Buy', price, 250]);
    expect(mocks.place.mock.calls[0]![4]).toMatchObject({ orderLot: 'IntradayOdd', account: accounts[0] });
    expect(mocks.notify.mock.calls.at(-1)![0]).toMatchObject({ title: '⚡ 零股買進已送出', body: expect.stringContaining('250 股') });
    // back to whole lots: quantity resets (250 股 must never become 250 張) and orders carry no odd lot
    await setUnit('Common');
    expect(view.root.findAll(n => n.type === 'input' && n.props['aria-label'] === '數量')[0]!.props.value).toBe(1);
    await act(async () => { button('啟用閃電下單').props.onClick(); });
    await act(async () => { buyCell().props.onClick(); });
    expect(mocks.place.mock.calls[1]!.slice(1, 4)).toEqual(['Buy', price, 1]);
    expect(mocks.place.mock.calls[1]![4].orderLot).toBeUndefined();
});

it('futures panels have no odd-lot toggle', async () => {
    const fut = { code: 'TMF', security_type: 'FUT', reference: 100 } as unknown as ContractInfo;
    await act(async () => { view = create(createElement(FlashOrder, { contract: fut, trades: [], positions: [] })); });
    // the settings popover has no 單位 row for futures
    await act(async () => { settings()!.props.onClick(); });
    const pop = view.root.findAll(n => n.props.role === 'dialog')[0]!;
    expect(text(pop)).not.toContain('盤中零股');
    expect(text(pop)).toContain('口');
});

it('cancelling a chip only cancels orders of the shown unit at that price', async () => {
    mocks.cancel.mockResolvedValue({});
    await act(async () => { view = create(createElement(FlashOrder, { contract, trades, positions })); });
    await setUnit('IntradayOdd');
    await act(async () => { await chip('300').props.onClick({ stopPropagation() {}, preventDefault() {} }); });
    expect(mocks.cancel.mock.calls.map(c => c[0])).toEqual(['odd']);
    mocks.cancel.mockClear();
    await setUnit('Common');
    await act(async () => { await chip('2').props.onClick({ stopPropagation() {}, preventDefault() {} }); });
    expect(mocks.cancel.mock.calls.map(c => c[0])).toEqual(['lot']);
});
