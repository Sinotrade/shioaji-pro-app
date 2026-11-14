// #402 梯子每個價位的我的委託格接在真的 FlashOrder 上：分段膠囊（預設）、面板寬度不到 330px
// 整個面板改精簡並在齒輪選單註明、精簡設定存檔、遮金額、同價多筆、刪單送出中、零股萬的寫法
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../hooks/use-flash-ladder', () => ({ useFlashLadder: () => ({ marks: new Map(), protectedQty: 0, background: false }) }));
vi.mock('../lib/flash-conditional', () => ({ flashStopProtections: async () => ({ stopped: 0, blocked: [], failed: [], restore: [] }) }));
import type { Account } from '../lib/types/portfolio';
import type { Trade } from '../lib/types/order';
import type { ContractInfo } from '../lib/types/contract';
import type { FlashOrderOpts } from '../lib/flash-account';
const mocks = vi.hoisted(() => ({ priv: false, cancel: vi.fn() }));
const accounts: Account[] = [
    { account_type: 'S', broker_id: 'BR', account_id: 'S1', signed: true, person_id: '', username: '' },
    { account_type: 'F', broker_id: 'BR', account_id: 'F1', signed: true, person_id: '', username: '' },
];
vi.mock('../lib/account-store', () => ({ ensureAccounts: () => undefined, useAccounts: () => ({ loaded: true, accounts, selectedStock: accounts[0], selectedFutures: accounts[1] }) }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => undefined, useTradingLive: () => true }));
vi.mock('../hooks/use-display-book', () => ({ useDisplayBook: () => ({ quote: undefined, snapshot: { close: 100 }, book: undefined }) }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: vi.fn(), cancelOrders: (ids: string[]) => Promise.allSettled(ids.map(id => mocks.cancel(id))) }));
vi.mock('../lib/trade', () => ({ notify: vi.fn(), placeQuickOrder: vi.fn(), placeStockExitByShares: vi.fn() }));
vi.mock('../lib/stream', () => ({ getAliasFor: () => undefined }));
vi.mock('../lib/tick-bands', () => ({ useTickBandsVersion: () => 0 }));
vi.mock('../lib/utils/ticksize', () => ({ roundToTick: (_c: unknown, p: number) => p, stepPrice: (_c: unknown, p: number, step: number) => p + step }));
vi.mock('../lib/privacy', async (orig) => ({ ...(await orig<typeof import('../lib/privacy')>()), usePrivacyMoney: () => mocks.priv }));
import { FlashOrder } from './flash-order';
import * as styles from './flash-order.css';
import { CANCEL_PENDING_MAX_MS } from '../lib/flash-cells';

const stock = { code: '2317', security_type: 'STK', exchange: 'TSE', reference: 100, limit_up: 110, limit_down: 90, day_trade: 'Yes' } as unknown as ContractInfo;
const S = accounts[0]!;
let n = 0;
const trade = (action: 'Buy' | 'Sell', price: number, quantity: number, deal: number, extra: Record<string, unknown> = {}) => {
    const id = `t${++n}`;
    const ts = Date.now() / 1000;
    return { contract: { code: stock.code, security_type: 'STK' }, account: S,
        order: { id, ordno: `W${n}`, account: S, action, price, quantity, order_lot: 'Common', order_cond: 'Cash', ...(action === 'Sell' ? { daytrade_short: false } : {}), ...extra },
        status: { id, status: deal >= quantity ? 'Filled' : deal > 0 ? 'PartFilled' : 'Submitted', order_ts: ts, order_quantity: quantity, deal_quantity: deal, cancel_quantity: 0,
            deals: deal > 0 ? [{ seq: id, price, quantity: deal, ts }] : [] } } as unknown as Trade;
};
const BASE = { orderType: 'ROD', octype: 'Auto', futuresPriceType: 'MKT' } as FlashOrderOpts;

const text = (node: ReactTestInstance): string => node.children.map(c => typeof c === 'string' ? c : text(c)).join('');
const seg = (n: ReactTestInstance, k: 'filled' | 'working') => { const s = n.findAll(x => x.props['data-seg'] === k)[0]; return s ? text(s) : '0'; };
const capsule = (n: ReactTestInstance) => `${seg(n, 'filled')}|${seg(n, 'working')}`;
/** 寬面板看到的文字（≤230px 才顯示的不加千分位寫法不算） */
const wide = (node: ReactTestInstance): string => node.children.map(c => typeof c === 'string' ? c : c.props.className === styles.totNarrow ? '' : wide(c)).join('');
let view!: ReactTestRenderer;
const cells = (side: 'buy' | 'sell') => view.root.findAll(x => typeof x.type === 'string' && x.props['data-testid'] === `flash-cell-${side}`);
const nodeMock = (width: number) => {
    const base: Record<string, unknown> = { getBoundingClientRect: () => ({ width, height: 400, top: 0, left: 0, right: width, bottom: 400 }), clientHeight: 400, clientWidth: width, offsetTop: 0, offsetHeight: 0 };
    // 其他 DOM 方法（addEventListener 等）一律空函式
    return new Proxy(base, { get: (o, k) => (k in o ? o[k as string] : typeof k === 'string' ? () => {} : undefined) });
};
/** 掛載時面板量到的寬度（createNodeMock：所有 ref 都拿到這個假元素） */
const render = async (props: Record<string, unknown>, width?: number) => {
    await act(async () => {
        view = create(createElement(FlashOrder, props as never), width === undefined ? undefined
            : { createNodeMock: () => nodeMock(width) });
    });
};
const gearOpen = async () => {
    const gear = view.root.findAll(x => x.type === 'button' && x.props['data-testid'] === 'flash-settings')[0]!;
    await act(async () => { gear.props.onClick(); });
};
const segBtn = (label: string) => view.root.findAll(x => x.type === 'button' && x.props.role === 'menuitemradio' && text(x) === label)[0]!;

beforeEach(() => {
    mocks.priv = false;
    mocks.cancel.mockReset();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

it('分段 (default): one capsule per price and side — fills outside, working inside; the ladder uses the split columns', async () => {
    await render({ contract: stock, trades: [trade('Buy', 100, 12, 4), trade('Sell', 101, 6, 6)], positions: [] }, 340);
    const buy = cells('buy');
    expect(buy).toHaveLength(1);
    expect(buy[0]!.props.className).toContain(styles.split);
    expect(capsule(buy[0]!)).toBe('4|8');
    expect(buy[0]!.props.title.split('\n')[0]).toBe('刪除 100.00 買單 8');
    // fully filled: the fill only, not a button
    const sell = cells('sell');
    expect(sell[0]!.type).toBe('span');
    expect(capsule(sell[0]!)).toBe('6|0');
    const head = view.root.findAll(x => typeof x.type === 'string' && String(x.props.className ?? '').includes(styles.headRow))[0]!;
    expect(head.props.className).toContain(styles.colsSplit7);
    // 觸買／觸賣表頭：寬面板寫字，≤230px 改圖示（CSS 切換），全文在 title
    const trig = head.findAll(x => typeof x.type === 'string' && x.props.className === styles.headTrigger);
    expect(trig.map(x => x.props.title.slice(0, 2))).toEqual(['觸買', '觸賣']);
    for (const x of trig) {
        expect(x.findAll(y => y.props.className === styles.totWide).map(text)).toEqual([x.props.title.slice(0, 2)]);
        expect(x.findAll(y => y.props.className === styles.totNarrow)).toHaveLength(1);
    }
    expect(one('flash-totals').props.className).toContain(styles.colsSplit7);
    await gearOpen();
    expect(view.root.findAll(x => x.props['data-testid'] === 'flash-order-cells-fallback')).toHaveLength(0);
});

const one = (id: string) => view.root.findAll(x => typeof x.type === 'string' && x.props['data-testid'] === id)[0]!;

it('a panel narrower than 330px shows the compact cells everywhere and says why in the gear menu', async () => {
    await render({ contract: stock, trades: [trade('Buy', 100, 12, 4), trade('Sell', 101, 6, 6)], positions: [] }, 329);
    const buy = cells('buy')[0]!;
    expect(buy.props.className).toContain(styles.orderChip.buy);
    expect(text(buy)).toBe('8');
    expect(text(cells('sell')[0]!)).toBe('6');
    expect(cells('sell')[0]!.props.className).toContain(styles.fillBadge.sell);
    expect(one('flash-totals').props.className).not.toContain(styles.colsSplit7);
    // totals use the compact form too
    expect(wide(one('flash-tot-buy'))).toBe('12(4)');
    await gearOpen();
    expect(segBtn('分段').props['aria-checked']).toBe(true);
    const note = view.root.findAll(x => typeof x.type === 'string' && x.props['data-testid'] === 'flash-order-cells-fallback')[0]!;
    expect(text(note)).toContain('目前以精簡顯示');
    expect(text(note)).toContain('330px');
});

it('精簡 is saved as orderCells: compact; 分段 removes it (default)', async () => {
    let saved: FlashOrderOpts | undefined;
    const props = () => ({ contract: stock, trades: [trade('Buy', 100, 12, 4)], positions: [], orderOpts: saved, onOrderOptsChange: (o: FlashOrderOpts) => { saved = o; } });
    await render(props());
    await gearOpen();
    await act(async () => { segBtn('精簡').props.onClick(); });
    expect(saved?.orderCells).toBe('compact');
    await act(async () => view.update(createElement(FlashOrder, props())));
    expect(text(cells('buy')[0]!)).toBe('8');
    // compact chosen: no fallback note
    expect(view.root.findAll(x => x.props['data-testid'] === 'flash-order-cells-fallback')).toHaveLength(0);
    await act(async () => { segBtn('分段').props.onClick(); });
    expect(saved).not.toHaveProperty('orderCells');
});

it('several orders at one price: one capsule with the stacked edge; a click cancels them all', async () => {
    mocks.cancel.mockImplementation(async (id: string) => ({ order: { id }, status: { status: 'Cancelled' } }));
    const a = trade('Buy', 100, 2, 0);
    const b = trade('Buy', 100, 3, 0);
    await render({ contract: stock, trades: [a, b], positions: [] }, 340);
    const c = cells('buy')[0]!;
    expect(capsule(c)).toBe('0|5');
    expect(c.props.className).toContain(styles.multiOrders.buy);
    expect(c.props.title).toContain(`委託 ${a.order.ordno}`);
    await act(async () => { await c.props.onClick(); });
    expect(mocks.cancel.mock.calls.map(x => x[0])).toEqual([a.order.id, b.order.id]);
});

it('shows 刪單送出中 (amber, dashed) until the order status says cancelled — not when the request returns', async () => {
    let done!: () => void;
    mocks.cancel.mockImplementation((id: string) => new Promise(r => { done = () => r({ order: { id }, status: { status: 'Cancelled' } }); }));
    const t1 = trade('Buy', 100, 1, 0);
    const props = (trades: Trade[]) => ({ contract: stock, trades, positions: [] });
    await render(props([t1]), 340);
    let click!: Promise<unknown>;
    await act(async () => { click = cells('buy')[0]!.props.onClick(); });
    const working = () => cells('buy')[0]!.findAll(x => x.props['data-seg'] === 'working')[0]!;
    expect(working().props.className).toContain(styles.cancelPending);
    expect(cells('buy')[0]!.props.title).toContain('刪單送出中');
    // the request returned, but the order list still shows it working
    await act(async () => { done(); await click; });
    expect(working().props.className).toContain(styles.cancelPending);
    // the status update: cancelled → the cell goes
    const gone = { ...t1, status: { ...t1.status, status: 'Cancelled', cancel_quantity: 1 } } as unknown as Trade;
    await act(async () => view.update(createElement(FlashOrder, props([gone]) as never)));
    expect(cells('buy')).toHaveLength(0);
    // the same order shown working again later is not pending any more
    await act(async () => view.update(createElement(FlashOrder, props([t1]) as never)));
    expect(working().props.className).not.toContain(styles.cancelPending);
});

it('a failed cancel ends 刪單送出中 at once', async () => {
    mocks.cancel.mockImplementation(async () => { throw new Error('rejected'); });
    await render({ contract: stock, trades: [trade('Buy', 100, 1, 0)], positions: [] }, 340);
    await act(async () => { await cells('buy')[0]!.props.onClick(); });
    const working = cells('buy')[0]!.findAll(x => x.props['data-seg'] === 'working')[0]!;
    expect(working.props.className).not.toContain(styles.cancelPending);
});

it('刪單送出中 never sticks: it ends after CANCEL_PENDING_MAX_MS without a status update', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
        mocks.cancel.mockImplementation(async (id: string) => ({ order: { id }, status: { status: 'Submitted' } }));
        await render({ contract: stock, trades: [trade('Buy', 100, 1, 0)], positions: [] }, 340);
        await act(async () => { await cells('buy')[0]!.props.onClick(); });
        const working = () => cells('buy')[0]!.findAll(x => x.props['data-seg'] === 'working')[0]!;
        expect(working().props.className).toContain(styles.cancelPending);
        await act(async () => { vi.advanceTimersByTime(CANCEL_PENDING_MAX_MS - 1); });
        expect(working().props.className).toContain(styles.cancelPending);
        await act(async () => { vi.advanceTimersByTime(1); });
        expect(working().props.className).not.toContain(styles.cancelPending);
    } finally { vi.useRealTimers(); }
});

it('遮金額 keeps the shapes but no quantities, in the cells, tooltips and totals', async () => {
    mocks.priv = true;
    await render({ contract: stock, trades: [trade('Buy', 100, 12, 4), trade('Sell', 101, 6, 6)], positions: [] }, 340);
    for (const c of [...cells('buy'), ...cells('sell')]) {
        expect(text(c)).toMatch(/^•+$/);
        expect(String(c.props.title).replace(/10[01]\.00/g, '')).not.toMatch(/\d/);
    }
    expect(capsule(cells('buy')[0]!)).toBe('•|•');
    expect(text(one('flash-tot-buy'))).toBe('••');
});

it('odd lots: share counts, 萬 from 10,000, still one capsule', async () => {
    const odd = { order_lot: 'IntradayOdd' };
    await render({ contract: stock, trades: [trade('Buy', 100, 12500, 0, odd), trade('Buy', 99, 999, 1, odd), trade('Buy', 100, 3, 0)], positions: [], lot: 'IntradayOdd', onLotChange: () => {} }, 340);
    const byPrice = cells('buy').map(capsule);
    expect(byPrice).toContain('0|1.3萬');
    expect(byPrice).toContain('1|998');
    // the 整股 order is not on the odd-lot ladder
    expect(byPrice).not.toContain('0|3');
});
