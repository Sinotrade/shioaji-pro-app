// #204 單位是面板自己的：同一檔的零股面板與整股面板並排時，行情、數量與
// 下單各自獨立 — 零股面板讀零股 store（五檔／成交以股計），整股面板不受影響
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';
import type { ContractInfo } from '../lib/types/contract';
const mocks = vi.hoisted(() => ({ place: vi.fn(), notify: vi.fn(), useQuote: vi.fn() }));
const accounts: Account[] = [{ account_type: 'S', broker_id: 'BR', account_id: 'A', signed: true, person_id: '', username: '' }];
vi.mock('../lib/account-store', () => ({ ensureAccounts: () => undefined, useAccounts: () => ({ loaded: true, accounts, selectedStock: accounts[0], selectedFutures: undefined }) }));
vi.mock('../hooks/use-stream', () => ({ useQuote: mocks.useQuote, useTradingLive: () => true }));
// regular-lot (整股) book and last trade: lots
vi.mock('../hooks/use-display-book', () => ({ useDisplayBook: () => ({
    quote: { tick: { close: '100', volume: 7 } }, snapshot: { close: 100 },
    book: { bids: [{ price: 100, vol: 591 }], asks: [{ price: 101, vol: 432 }], source: 'stream' } }) }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: vi.fn(), cancelOrders: vi.fn() }));
vi.mock('../lib/trade', () => ({ notify: mocks.notify, placeQuickOrder: mocks.place, placeStockExitByShares: vi.fn() }));
vi.mock('../lib/stream', () => ({ getAliasFor: () => undefined }));
vi.mock('../lib/tick-bands', () => ({ useTickBandsVersion: () => 0 }));
vi.mock('../lib/utils/ticksize', () => ({ roundToTick: (_c: unknown, p: number) => p, stepPrice: (_c: unknown, p: number, step: number) => p + step }));
import { FlashOrder } from './flash-order';

const contract = { code: '2330', security_type: 'STK', reference: 100, limit_up: 110, limit_down: 90 } as unknown as ContractInfo;
// 盤中零股 store (intraday_odd): shares, its own last trade and match time
const oddQuote = {
    tick: { code: '2330', date: '2026/09/30', time: '11:02:25.000000', close: '99', volume: 125, intraday_odd: true },
    bidask: { code: '2330', date: '2026/09/30', time: '11:02:25.000000', bid_price: ['99'], bid_volume: [104264], ask_price: ['100'], ask_volume: [2500], intraday_odd: true },
};
const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
let view!: ReactTestRenderer;
const panels = () => view.root.findAllByType(FlashOrder);
const button = (panel: ReactTestInstance, label: string) => panel.findAllByType('button').find(b => text(b).includes(label))!;
const buyCell = (panel: ReactTestInstance, price: number) => panel.findAll(n => n.type === 'div' && n.props.title === `限價買 ${price.toFixed(2)}`)[0]!;
const setUnit = async (panel: ReactTestInstance, lot: 'Common' | 'IntradayOdd') => {
    await act(async () => { panel.findAll(n => n.type === 'button' && n.props['aria-label'] === '閃電下單設定')[0]!.props.onClick(); });
    const pop = panel.findAll(n => n.props.role === 'dialog')[0]!;
    await act(async () => { pop.findAll(n => n.type === 'button' && text(n) === (lot === 'IntradayOdd' ? '盤中零股（股）' : '整股（張）'))[0]!.props.onClick(); });
    await act(async () => { pop.findAll(n => n.type === 'button' && text(n) === '完成')[0]!.props.onClick(); });
};
const qtyInput = (panel: ReactTestInstance) => panel.findAll(n => n.type === 'input' && String(n.props['aria-label']).startsWith('數量'))[0]!;

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    mocks.place.mockResolvedValue({ status: { status: 'PendingSubmit' } });
    mocks.useQuote.mockImplementation((code: string | null, options?: { oddLot?: boolean }) => (code && options?.oddLot ? oddQuote : undefined));
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

it('an odd-lot and a round-lot panel on the same stock keep their own unit, quotes, quantity and orders', async () => {
    await act(async () => {
        view = create(createElement('div', null,
            createElement(FlashOrder, { contract, trades: [], positions: [] }),
            createElement(FlashOrder, { contract, trades: [], positions: [] })));
    });
    const [odd, round] = panels() as [ReactTestInstance, ReactTestInstance];
    await setUnit(odd, 'IntradayOdd');

    // unit is per panel: only the first switched
    expect(qtyInput(odd).props['aria-label']).toBe('數量（股）');
    expect(qtyInput(round).props['aria-label']).toBe('數量');
    // the odd panel asks for the odd-lot feed; the round panel never does
    const oddCalls = mocks.useQuote.mock.calls.filter(c => c[1]?.oddLot);
    expect(oddCalls.some(c => c[0] === '2330')).toBe(true);
    // quotes: odd-lot book in shares (compact) + last odd match time; round-lot book in lots
    expect(text(odd)).toContain('10.4萬');
    expect(text(odd)).toContain('×125');
    expect(text(odd)).toContain('最近撮合 11:02:25');
    expect(text(odd)).not.toContain('591');
    expect(text(round)).toContain('591');
    expect(text(round)).toContain('×7');
    expect(text(round)).not.toContain('10.4萬');
    expect(text(round)).not.toContain('盤中零股');

    // quantities are independent
    await act(async () => { qtyInput(odd).props.onChange({ target: { value: '250' } }); });
    await act(async () => { qtyInput(round).props.onChange({ target: { value: '3' } }); });
    expect(qtyInput(odd).props.value).toBe(250);
    expect(qtyInput(round).props.value).toBe(3);

    // orders: odd panel sends 盤中零股 shares, round panel whole lots
    await act(async () => { button(odd, '啟用閃電下單').props.onClick(); });
    await act(async () => { button(round, '啟用閃電下單').props.onClick(); });
    await act(async () => { buyCell(odd, 99).props.onClick(); });
    await act(async () => { buyCell(round, 100).props.onClick(); });
    expect(mocks.place).toHaveBeenCalledTimes(2);
    expect(mocks.place.mock.calls[0]!.slice(1, 4)).toEqual(['Buy', 99, 250]);
    expect(mocks.place.mock.calls[0]![4]).toMatchObject({ orderLot: 'IntradayOdd' });
    expect(mocks.place.mock.calls[1]!.slice(1, 4)).toEqual(['Buy', 100, 3]);
    expect(mocks.place.mock.calls[1]![4].orderLot).toBeUndefined();

    // switching the round panel to odd does not flip the odd one back
    await setUnit(round, 'IntradayOdd');
    await setUnit(odd, 'Common');
    expect(qtyInput(round).props['aria-label']).toBe('數量（股）');
    expect(qtyInput(odd).props['aria-label']).toBe('數量');
});

it('an odd-lot panel without any odd-lot quote yet shows no round-lot book as if it were odd', async () => {
    mocks.useQuote.mockImplementation(() => undefined);
    await act(async () => { view = create(createElement(FlashOrder, { contract, trades: [], positions: [] })); });
    const [panel] = panels() as [ReactTestInstance];
    await setUnit(panel, 'IntradayOdd');
    expect(text(panel)).not.toContain('591');
    expect(text(panel)).toContain('等待零股行情');
});
