// 委託合計列：整股（張）含當沖回補格、零股（股）、期貨（口，無回補格）、遮金額、設定開關、窄面板退讓的結構
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
    trade(stock, S, 'Sell', 30, 30, { daytrade_short: true }), trade(stock, S, 'Sell', 10, 0, { daytrade_short: true }),
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

it('shows 整股 totals in 張 with working, progress and the day-trade cover cell', async () => {
    await render({ contract: stock, trades: stockTrades, positions: [] });
    expect(text(one('flash-tot-buy'))).toBe('買32（20）未12');
    expect(text(one('flash-tot-sell'))).toBe('賣40（30）未10');
    expect(one('flash-tot-buy').props.title).toContain('委託買進 32 張');
    expect(text(one('flash-tot-cover'))).toBe('待回補待補10');
    expect(one('flash-tot-cover').props.title).toContain('已用現股買進回補 20 張');
    expect(one('flash-totals').props.className).toBe(styles.totRow.cover);
});

it('says 補齊 once every day-trade short is covered, and — with no short sale', async () => {
    await render({ contract: stock, trades: [trade(stock, S, 'Sell', 5, 5, { daytrade_short: true }), trade(stock, S, 'Buy', 5, 5)], positions: [] });
    expect(text(one('flash-tot-cover'))).toBe('先賣已補齊補齊');
    await act(async () => view.update(createElement(FlashOrder, { contract: stock, trades: [trade(stock, S, 'Buy', 5, 5)], positions: [] })));
    expect(text(one('flash-tot-cover'))).toBe('—');
});

it('narrow fallback: long and short labels both render, CSS picks by panel width (≤300px)', async () => {
    await render({ contract: stock, trades: stockTrades, positions: [] });
    const cover = one('flash-tot-cover');
    expect(cover.findAll(x => x.props.className === styles.totCoverLabel).map(text)).toEqual(['待回補']);
    expect(cover.findAll(x => x.props.className === styles.totCoverShort).map(text)).toEqual(['待補']);
    expect(one('flash-tot-buy-working').props.className).toBe(styles.totWorking);
});

it('盤中零股 counts only odd-lot orders, in 股, with no cover cell', async () => {
    await render({ contract: stock, trades: stockTrades, positions: [], lot: 'IntradayOdd', onLotChange: () => {} });
    expect(text(one('flash-tot-buy'))).toBe('買300（100）未200');
    expect(one('flash-tot-buy').props.title).toContain('股');
    expect(text(one('flash-tot-sell'))).toBe('賣0（0）');
    expect(byId('flash-tot-cover')).toHaveLength(0);
    expect(one('flash-totals').props.className).toBe(styles.totRow.plain);
});

it('futures show 口 and never a cover cell', async () => {
    const trades = [trade(futures, F, 'Buy', 3, 2), trade(futures, F, 'Sell', 2, 2, { daytrade_short: true })];
    await render({ contract: futures, trades, positions: [] });
    expect(text(one('flash-tot-buy'))).toBe('買3（2）未1');
    expect(one('flash-tot-sell').props.title).toContain('委託賣出 2 口');
    expect(byId('flash-tot-cover')).toHaveLength(0);
});

it('masks every quantity and hides the progress bars with 遮金額', async () => {
    mocks.priv = true;
    await render({ contract: stock, trades: stockTrades, positions: [] });
    const all = byId('flash-totals').map(text).join('');
    expect(all).not.toMatch(/\d/);
    expect(all).toContain('•••••');
    expect(one('flash-tot-buy').props.title).toBeUndefined();
    expect(one('flash-tot-cover').props.title).toBeUndefined();
    expect(view.root.findAll(x => x.props.className === styles.totProgress.buy)).toHaveLength(0);
});

it('the gear menu toggles 顯示委託合計 (default on); off takes no space and is saved with the panel', async () => {
    let saved: FlashOrderOpts | undefined;
    const props = () => ({ contract: stock, trades: stockTrades, positions: [], orderOpts: saved, onOrderOptsChange: (o: FlashOrderOpts) => { saved = o; } });
    await render(props());
    expect(byId('flash-totals')).toHaveLength(1);
    const gear = view.root.findAll(x => x.type === 'button' && x.props['data-testid'] === 'flash-settings')[0]!;
    await act(async () => { gear.props.onClick(); });
    const item = () => view.root.findAll(x => x.type === 'button' && x.props.role === 'menuitemcheckbox' && text(x).includes('顯示委託合計'))[0]!;
    expect(item().props['aria-checked']).toBe(true);
    await act(async () => { item().props.onClick(); });
    expect(saved?.showTotals).toBe(false);
    await act(async () => view.update(createElement(FlashOrder, props())));
    expect(byId('flash-totals')).toHaveLength(0);
    await act(async () => { gear.props.onClick(); });
    expect(item().props['aria-checked']).toBe(false);
    await act(async () => { item().props.onClick(); });
    expect(saved).not.toHaveProperty('showTotals');
    await act(async () => view.update(createElement(FlashOrder, props())));
    expect(byId('flash-totals')).toHaveLength(1);
});

// PR #400 review P1: 回報投影的委託沒有 daytrade_short，不能猜成現股
it('a sell whose day-trade flag is unknown makes the cover cell 回補待確認 instead of 補齊', async () => {
    const unknownSell = trade(stock, S, 'Sell', 5, 5, { daytrade_short: undefined });
    await render({ contract: stock, trades: [trade(stock, S, 'Sell', 5, 5, { daytrade_short: true }), trade(stock, S, 'Buy', 5, 5), unknownSell], positions: [] });
    const cover = one('flash-tot-cover');
    expect(cover.props['data-state']).toBe('unknown');
    expect(text(cover)).toBe('回補待確認待確認');
    expect(cover.props.title).toContain('另有賣出成交 5 張 無法確認是否為現股當沖先賣');
});

it('uses the conditions this app recorded when it sent the order, matched by broker seqno / ordno', async () => {
    const sell = trade(stock, S, 'Sell', 6, 6, { daytrade_short: undefined, order_cond: undefined, seqno: 'Q1', ordno: 'W001' });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    noteStockOrderConditions(S, { seqno: 'Q1', ordno: 'W001' }, { daytrade_short: true });
    await render({ contract: stock, trades: [sell], positions: [] });
    expect(text(one('flash-tot-cover'))).toBe('待回補待補6');
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
        expect(text(one('flash-tot-buy'))).toBe('買4（4）');
    } finally { vi.useRealTimers(); }
});

// PR #400 review P2
it('leaves out the previous session', async () => {
    const yesterday = now() - 2 * 86400;
    await render({ contract: stock, trades: [trade(stock, S, 'Buy', 9, 9, {}, { ts: yesterday }), trade(stock, S, 'Buy', 2, 1)], positions: [] });
    expect(text(one('flash-tot-buy'))).toBe('買2（1）未1');
});

// PR #400 review P3
it('counts a continuous-month order (MXFR1 → MXFI6) on the MXFI6 panel', async () => {
    const mxfi6 = { ...futures, code: 'MXFI6', target_code: null } as unknown as ContractInfo;
    const r1 = trade(mxfi6, F, 'Buy', 2, 1, {}, { contract: { code: 'MXFR1', target_code: 'MXFI6' } });
    await render({ contract: mxfi6, trades: [r1, trade(mxfi6, F, 'Buy', 1, 0)], positions: [] });
    expect(text(one('flash-tot-buy'))).toBe('買3（1）未2');
});
