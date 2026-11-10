// 梯子底部合計列：對齊欄位、整股（張）含回補狀態、零股（股）、期貨（口，無回補）、遮金額、設定開關、窄面板退讓的結構
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../hooks/use-flash-ladder', () => ({ useFlashLadder: () => ({ marks: new Map(), protectedQty: 0, background: false }) }));
vi.mock('../lib/flash-conditional', () => ({ flashStopProtections: async () => ({ stopped: 0, blocked: [], failed: [], restore: [] }) }));
import type { Account } from '../lib/types/portfolio';
import type { Trade } from '../lib/types/order';
import type { ContractInfo } from '../lib/types/contract';
import type { FlashOrderOpts } from '../lib/flash-account';
const mocks = vi.hoisted(() => ({ priv: false }));
const accounts: Account[] = [
    { account_type: 'S', broker_id: 'BR', account_id: 'S1', signed: true, person_id: '', username: '' },
    { account_type: 'F', broker_id: 'BR', account_id: 'F1', signed: true, person_id: '', username: '' },
];
vi.mock('../lib/account-store', () => ({ ensureAccounts: () => undefined, useAccounts: () => ({ loaded: true, accounts, selectedStock: accounts[0], selectedFutures: accounts[1] }) }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => undefined, useTradingLive: () => true }));
vi.mock('../hooks/use-display-book', () => ({ useDisplayBook: () => ({ quote: undefined, snapshot: { close: 100 }, book: undefined }) }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: vi.fn(), cancelOrders: vi.fn() }));
vi.mock('../lib/trade', () => ({ notify: vi.fn(), placeQuickOrder: vi.fn(), placeStockExitByShares: vi.fn() }));
vi.mock('../lib/stream', () => ({ getAliasFor: () => undefined }));
vi.mock('../lib/tick-bands', () => ({ useTickBandsVersion: () => 0 }));
vi.mock('../lib/utils/ticksize', () => ({ roundToTick: (_c: unknown, p: number) => p, stepPrice: (_c: unknown, p: number, step: number) => p + step }));
vi.mock('../lib/privacy', async (orig) => ({ ...(await orig<typeof import('../lib/privacy')>()), usePrivacyMoney: () => mocks.priv }));
import { FlashOrder } from './flash-order';
import { noteStockOrderConditions, resetStockOrderConditionsForTest } from '../lib/stock-order-conditions';
import * as styles from './flash-order.css';

const stock = { code: '2317', security_type: 'STK', exchange: 'TSE', reference: 100, limit_up: 110, limit_down: 90, day_trade: 'Yes' } as unknown as ContractInfo;
const futures = { code: 'TXFL6', security_type: 'FUT', exchange: 'TAIFEX', reference: 100, limit_up: 110, limit_down: 90, multiplier: 200 } as unknown as ContractInfo;
let n = 0;
const now = () => Date.now() / 1000;
const trade = (c: ContractInfo, acct: Account, action: 'Buy' | 'Sell', quantity: number, deal: number, extra: Record<string, unknown> = {},
    opts: { ts?: number; contract?: Record<string, unknown> } = {}) => {
    const id = `t${++n}`;
    const ts = opts.ts ?? now();
    return { contract: { code: c.code, security_type: c.security_type, ...opts.contract }, account: acct,
        order: { id, account: acct, action, price: 100, quantity, order_lot: 'Common', order_cond: c.security_type === 'FUT' ? undefined : 'Cash',
            ...(action === 'Sell' && c.security_type !== 'FUT' ? { daytrade_short: false } : {}), ...extra },
        status: { id, status: deal >= quantity ? 'Filled' : deal > 0 ? 'PartFilled' : 'Submitted', order_ts: ts, order_quantity: quantity, deal_quantity: deal, cancel_quantity: 0,
            deals: deal > 0 ? [{ seq: id, price: 100, quantity: deal, ts }] : [] } } as unknown as Trade;
};
const S = accounts[0]!;
const F = accounts[1]!;
// 客戶情境：買 32（20）、賣 40（30，現股當沖先賣）→ 待回補 10
const stockTrades = [
    trade(stock, S, 'Buy', 20, 20), trade(stock, S, 'Buy', 12, 0),
    // 先賣在前（回補依成交時間重播）
    trade(stock, S, 'Sell', 30, 30, { daytrade_short: true }, { ts: now() - 120 }), trade(stock, S, 'Sell', 10, 0, { daytrade_short: true }),
    trade(stock, S, 'Buy', 300, 100, { order_lot: 'IntradayOdd' }),
];

const text = (node: ReactTestInstance): string => node.children.map(c => typeof c === 'string' ? c : text(c)).join('');
let view!: ReactTestRenderer;
const byId = (id: string) => view.root.findAll(x => x.props['data-testid'] === id && typeof x.type === 'string');
const one = (id: string) => byId(id)[0]!;
const render = async (props: Record<string, unknown>) => { await act(async () => { view = create(createElement(FlashOrder, props as never)); }); };

beforeEach(() => {
    mocks.priv = false;
    resetStockOrderConditionsForTest();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

it('aligns my 整股 totals under 買單／賣單 in 張, market volume totals under 買量／賣量, cover status under 價格', async () => {
    await render({ contract: stock, trades: stockTrades, positions: [] });
    const row = one('flash-totals');
    // same 7-column grid as the ladder (觸買 買單 買量 價格 賣量 賣單 觸賣); no 買／賣／Σ words
    expect(row.props.className).toContain(styles.cols7);
    const cells = (row.children as ReactTestInstance[]).map(c => (typeof c.type === 'string' ? c : c.findAll(x => typeof x.type === 'string')[0]!));
    expect(cells).toHaveLength(7);
    expect(cells.map(c => c.props['data-testid'])).toEqual([undefined, 'flash-tot-buy', 'flash-tot-bidvol', 'flash-tot-cover', 'flash-tot-askvol', 'flash-tot-sell', undefined]);
    expect(text(one('flash-tot-buy'))).toBe('32(20)');
    expect(text(one('flash-tot-sell'))).toBe('40(30)');
    expect(one('flash-tot-buy').props.title).toContain('我的委託買進 32 張');
    expect(one('flash-tot-buy').props.title).toContain('未成交 12 張');
    expect(text(one('flash-tot-cover'))).toBe('待補10');
    expect(one('flash-tot-cover').props['data-state']).toBe('open');
    expect(one('flash-tot-cover').props.title).toContain('已用現股買進回補 20 張');
    expect(text(row)).not.toMatch(/[買賣Σ]/);
});

it('uses the 5-column grid with Alt＋點 triggers', async () => {
    await render({ contract: stock, trades: stockTrades, positions: [], orderOpts: { orderType: 'ROD', octype: 'Auto', futuresPriceType: 'MKT', triggerLayout: 'modifier' }, onOrderOptsChange: () => {} });
    expect(one('flash-totals').props.className).toContain(styles.totCols5);
    expect(one('flash-totals').children).toHaveLength(5);
});

it('says 補齊 once every day-trade short is covered, and stays empty with no short sale', async () => {
    await render({ contract: stock, trades: [trade(stock, S, 'Sell', 5, 5, { daytrade_short: true }, { ts: now() - 60 }), trade(stock, S, 'Buy', 5, 5)], positions: [] });
    expect(text(one('flash-tot-cover'))).toBe('補齊');
    await act(async () => view.update(createElement(FlashOrder, { contract: stock, trades: [trade(stock, S, 'Buy', 5, 5)], positions: [] })));
    expect(text(one('flash-tot-cover'))).toBe('');
});

it('narrow fallback structure: (filled), the cover label and comma numbers each have a class CSS hides at ≤230px', async () => {
    await render({ contract: stock, trades: stockTrades, positions: [] });
    expect(one('flash-tot-buy').findAll(x => x.props.className === styles.totMineFill).map(text)).toEqual(['(20)']);
    expect(one('flash-tot-cover').findAll(x => x.props.className === styles.totCoverLabel).map(text)).toEqual(['待補']);
    const bid = one('flash-tot-bidvol');
    expect(bid.findAll(x => x.props.className === styles.totWide)).toHaveLength(1);
    expect(bid.findAll(x => x.props.className === styles.totNarrow)).toHaveLength(1);
});

it('盤中零股 counts only odd-lot orders, in 股, and leaves the 價格 cell empty', async () => {
    await render({ contract: stock, trades: stockTrades, positions: [], lot: 'IntradayOdd', onLotChange: () => {} });
    expect(text(one('flash-tot-buy'))).toBe('300(100)');
    expect(one('flash-tot-buy').props.title).toContain('股');
    expect(text(one('flash-tot-sell'))).toBe('—');
    expect(byId('flash-tot-cover')).toHaveLength(0);
});

it('futures show 口 and never a cover status', async () => {
    const trades = [trade(futures, F, 'Buy', 3, 2), trade(futures, F, 'Sell', 2, 2, { daytrade_short: true })];
    await render({ contract: futures, trades, positions: [] });
    expect(text(one('flash-tot-buy'))).toBe('3(2)');
    expect(one('flash-tot-sell').props.title).toContain('我的委託賣出 2 口');
    expect(byId('flash-tot-cover')).toHaveLength(0);
});

it('masks my quantities and the cover count with 遮金額 (market volume totals stay)', async () => {
    mocks.priv = true;
    await render({ contract: stock, trades: stockTrades, positions: [] });
    for (const id of ['flash-tot-buy', 'flash-tot-sell', 'flash-tot-cover']) {
        expect(text(one(id))).not.toMatch(/\d/);
        expect(one(id).props.title ?? '').not.toMatch(/\d/);
    }
    expect(text(one('flash-tot-buy'))).toContain('•••••');
    expect(byId('flash-tot-bidvol')).toHaveLength(1);
});

it('the gear menu toggles 顯示委託合計 (default on), saved with the panel', async () => {
    let saved: FlashOrderOpts | undefined;
    const props = () => ({ contract: stock, trades: stockTrades, positions: [], orderOpts: saved, onOrderOptsChange: (o: FlashOrderOpts) => { saved = o; } });
    await render(props());
    expect(byId('flash-tot-buy')).toHaveLength(1);
    const gear = view.root.findAll(x => x.type === 'button' && x.props['data-testid'] === 'flash-settings')[0]!;
    await act(async () => { gear.props.onClick(); });
    const item = () => view.root.findAll(x => x.type === 'button' && x.props.role === 'menuitemcheckbox' && text(x).includes('顯示委託合計'))[0]!;
    expect(item().props['aria-checked']).toBe(true);
    await act(async () => { item().props.onClick(); });
    expect(saved?.showTotals).toBe(false);
    await act(async () => view.update(createElement(FlashOrder, props())));
    // off: my totals and cover status go; the market volume totals stay, one line high
    expect(byId('flash-tot-buy')).toHaveLength(0);
    expect(byId('flash-tot-cover')).toHaveLength(0);
    expect(byId('flash-tot-bidvol')).toHaveLength(1);
    expect(one('flash-totals').props.className).not.toContain(styles.totGridTall);
    await act(async () => { gear.props.onClick(); });
    expect(item().props['aria-checked']).toBe(false);
    await act(async () => { item().props.onClick(); });
    expect(saved).not.toHaveProperty('showTotals');
    await act(async () => view.update(createElement(FlashOrder, props())));
    expect(byId('flash-tot-buy')).toHaveLength(1);
});

// PR #400 review P1: 回報投影的委託沒有 daytrade_short，不能猜成現股
it('a sell whose day-trade flag is unknown makes the cover status 待確認 instead of 補齊', async () => {
    const unknownSell = trade(stock, S, 'Sell', 5, 5, { daytrade_short: undefined });
    await render({ contract: stock, trades: [trade(stock, S, 'Sell', 5, 5, { daytrade_short: true }), trade(stock, S, 'Buy', 5, 5), unknownSell], positions: [] });
    const cover = one('flash-tot-cover');
    expect(cover.props['data-state']).toBe('unknown');
    expect(text(cover)).toBe('待確認');
    expect(cover.props.title).toContain('另有賣出成交 5 張 無法確認是否為現股當沖先賣');
});

it('uses the conditions this app recorded when it sent the order, matched by broker seqno / ordno', async () => {
    const sell = trade(stock, S, 'Sell', 6, 6, { daytrade_short: undefined, order_cond: undefined, seqno: 'Q1', ordno: 'W001' });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    noteStockOrderConditions(S, { seqno: 'Q1', ordno: 'W001' }, { daytrade_short: true });
    await render({ contract: stock, trades: [sell], positions: [] });
    expect(text(one('flash-tot-cover'))).toBe('待補6');
    // sidecar restarted: the same seqno now names another order (different ordno) → unknown
    const reused = trade(stock, S, 'Sell', 6, 6, { daytrade_short: undefined, order_cond: undefined, seqno: 'Q1', ordno: 'Z777' });
    await act(async () => view.update(createElement(FlashOrder, { contract: stock, trades: [reused], positions: [] })));
    expect(one('flash-tot-cover').props['data-state']).toBe('unknown');
});

// PR #400 review round 2 P2: 股票不能套期貨 15:00 的交易日邊界
it('keeps stock totals after 15:00 (stock day starts at Taipei midnight)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 10, 8))); // 16:00 Taipei
    try {
        const morning = Date.UTC(2026, 10, 10, 2) / 1000; // 10:00 Taipei
        await render({ contract: stock, trades: [trade(stock, S, 'Buy', 4, 4, {}, { ts: morning }), trade(stock, S, 'Buy', 3, 3, {}, { ts: morning - 86400 })], positions: [] });
        expect(text(one('flash-tot-buy'))).toBe('4(4)');
    } finally { vi.useRealTimers(); }
});

// PR #400 review P2
it('leaves out the previous session', async () => {
    const yesterday = now() - 2 * 86400;
    await render({ contract: stock, trades: [trade(stock, S, 'Buy', 9, 9, {}, { ts: yesterday }), trade(stock, S, 'Buy', 2, 1)], positions: [] });
    expect(text(one('flash-tot-buy'))).toBe('2(1)');
});

// PR #400 review P3
it('counts a continuous-month order (MXFR1 → MXFI6) on the MXFI6 panel', async () => {
    const mxfi6 = { ...futures, code: 'MXFI6', target_code: null } as unknown as ContractInfo;
    const r1 = trade(mxfi6, F, 'Buy', 2, 1, {}, { contract: { code: 'MXFR1', target_code: 'MXFI6' } });
    await render({ contract: mxfi6, trades: [r1, trade(mxfi6, F, 'Buy', 1, 0)], positions: [] });
    expect(text(one('flash-tot-buy'))).toBe('3(1)');
});

// PR #400 review round 3 P1: a notice appearing must not change the ladder height
it('the notice strip is always there (fixed height), with or without a notice', async () => {
    await render({ contract: stock, trades: [], positions: [] });
    expect(byId('flash-notices')).toHaveLength(1);
    expect(text(one('flash-notices'))).toBe('');
    await act(async () => view.update(createElement(FlashOrder, { contract: stock, trades: stockTrades, positions: [] })));
    expect(byId('flash-notices')).toHaveLength(1);
    expect(text(one('flash-notices'))).toContain('另有零股委託 1 筆');
    expect(one('flash-notices').props.className).toBe(styles.totalsRow);
});

// PR #400 review round 4 P3: a fill with no deal detail time makes the cover status 待確認
it('a day-trade short fill without deal details shows 待確認, not a guessed 補齊', async () => {
    const sell = trade(stock, S, 'Sell', 5, 5, { daytrade_short: true }, { ts: now() - 60 });
    const noDetail = { ...sell, status: { ...sell.status, deals: [] } } as Trade;
    await render({ contract: stock, trades: [noDetail, trade(stock, S, 'Buy', 5, 5)], positions: [] });
    expect(one('flash-tot-cover').props['data-state']).toBe('unknown');
    expect(one('flash-tot-cover').props.title).toContain('時間未知');
});
