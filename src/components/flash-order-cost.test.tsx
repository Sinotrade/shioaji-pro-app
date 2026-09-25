import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account, AccountedPosition } from '../lib/types/portfolio';
import type { ContractInfo } from '../lib/types/contract';
import type { Action, Trade } from '../lib/types/order';
const account: Account = { account_type: 'F', broker_id: 'BR', account_id: 'A', signed: true, person_id: '', username: '' };
const stockAccount: Account = { ...account, account_type: 'S', account_id: 'S1' };
const book = vi.hoisted(() => ({ close: 45532 }));
vi.mock('../lib/account-store', () => ({ useAccounts: () => ({ accounts: [account, stockAccount], selectedStock: stockAccount, selectedFutures: account }), selectAccount: () => {}, accountFor: (t: string) => (t === 'S' ? stockAccount : account) }));
vi.mock('../hooks/use-stream', () => ({ useTradingLive: () => true }));
vi.mock('../hooks/use-display-book', () => ({ useDisplayBook: () => ({ quote: undefined, snapshot: { close: book.close }, book: undefined }) }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: vi.fn(), cancelOrders: vi.fn() }));
vi.mock('../lib/trade', () => ({ notify: vi.fn(), placeQuickOrder: vi.fn(), placeStockExitByShares: vi.fn() }));
vi.mock('../lib/stream', () => ({ getAliasFor: (c: string) => (c === 'MXFI6' ? 'MXFR1' : undefined) }));
vi.mock('../lib/tick-bands', () => ({ useTickBandsVersion: () => 0 }));
vi.mock('../lib/utils/ticksize', () => ({ roundToTick: (_c: unknown, p: number) => p, stepPrice: (_c: unknown, p: number, step: number) => p + step }));
import { FlashOrder } from './flash-order';
import { applyPositionFill } from '../lib/portfolio-projection';
import * as styles from './flash-order.css';

// Wednesday 2026-09-23 10:00 Taipei (day session; the trading day began Tue 15:00).
const NOW = Date.parse('2026-09-23T10:00:00+08:00') / 1000;
const at = (n: number) => NOW - 3600 + n;
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW * 1000); book.close = 45532; });
afterEach(() => { vi.useRealTimers(); });

const contract = { code: 'MXFR1', target_code: 'MXFI6', security_type: 'FUT', reference: 45592, multiplier: 50 } as unknown as ContractInfo;
const row = (id: number, direction: Action, quantity: number, price: number, pnl: number): AccountedPosition =>
    ({ account, id, code: 'MXFI6', direction, quantity, price, last_price: 45532, pnl });

async function render(positions: AccountedPosition[], c: ContractInfo = contract, trades: Trade[] = [], reconcilePending = false) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    let view!: ReactTestRenderer;
    try {
        await act(async () => { view = create(createElement(FlashOrder, { contract: c, trades, positions, reconcilePending })); });
        const avgMarks = view.root.findAll(n => typeof n.type === 'string' && String(n.props.className ?? '').split(' ').includes(styles.avgMark))
            .map(n => n.children.filter(c => typeof c === 'string').join(''));
        const label = view.root.findAll(n => typeof n.type === 'string' && n.props.className === styles.posMixed)
            .map(n => n.children.join(''));
        return { bar: JSON.stringify(view.toJSON()), avgMarks, label: label[0] ?? null };
    } finally { await act(async () => view?.unmount()); vi.unstubAllGlobals(); }
}

const filled = (id: string, action: Action, price: number, ts: number, code = 'MXFI6', target: string | null = 'MXFI6'): Trade => ({
    account, contract: { code: code === 'MXFI6' ? 'MXFR1' : code, target_code: code === 'MXFI6' ? target : null },
    order: { id, seqno: id, ordno: id, action, price, quantity: 1, account },
    status: { id, status: 'Filled', status_code: '', order_quantity: 1, deal_quantity: 1, cancel_quantity: 0, modified_price: 0, msg: '',
        deals: [{ seq: '000001', price, quantity: 1, ts }] },
}) as unknown as Trade;

// #116: broker returns un-netted Buy and Sell rows for the same contract
// (fills 賣 45546, 賣 45559, 買 45513; last 45532). eLeader (FIFO): 庫 -1 均 45559 損益 1350.
// main blends both rows: 空 1 @ 45,539.33 +3,000.00.
const customerRows = () => [row(0, 'Sell', 2, 45552.5, 2050), row(1, 'Buy', 1, 45513, 950)];
const customerFills = () => [filled('a', 'Sell', 45546, at(1)), filled('b', 'Sell', 45559, at(2)), filled('c', 'Buy', 45513, at(3))];
const expectMain = (bar: string) => { expect(bar).toContain('45,539.33'); expect(bar).toContain('+3,000.00'); };

it('mixed futures with this trading day\'s fills show the FIFO-matched lot, as eLeader does', async () => {
    const { bar, label } = await render(customerRows(), contract, customerFills());
    expect(bar).toContain('"空"," ","1"');
    expect(bar).toContain('45,559');
    expect(bar).toContain('+1,350.00');
    expect(label).toBe('多空並存');
    expect(bar).toContain('先進先出');
});

it('fills from the previous session in /order/trades are ignored, not seen as negative carry', async () => {
    const yesterday = Date.parse('2026-09-22T10:00:00+08:00') / 1000;
    const { bar, label } = await render(customerRows(), contract, [filled('y1', 'Buy', 45000, yesterday), filled('y2', 'Sell', 45100, yesterday + 1), ...customerFills()]);
    expect(bar).toContain('+1,350.00');
    expect(label).toBe('多空並存');
});

it('a missing fill is never shown as a confirmed FIFO cost; the rows\' figures stay exactly as main', async () => {
    // Sell @45559 not loaded: seeding it as a carried lot would give a wrong "FIFO" 45,546.
    const { bar, label } = await render(customerRows(), contract, [filled('a', 'Sell', 45546, at(1)), filled('c', 'Buy', 45513, at(3))]);
    expect(bar).not.toContain('45,546');
    expectMain(bar);
    expect(label).toBe('多空並存 估算');
});

it('mixed rows without fills keep main\'s figures, marked 估算 (never worse than main)', async () => {
    const { bar, label } = await render(customerRows());
    expectMain(bar);
    expect(label).toBe('多空並存 估算');
});

it('orders or positions awaiting reconciliation show main\'s figures marked 待更新', async () => {
    const { bar, label } = await render(customerRows(), contract, customerFills(), true);
    expectMain(bar);
    expect(label).toBe('多空並存 待更新');
});

it('a fill from another client not yet applied to positions marks a single-direction row 待更新', async () => {
    // 「成交回報缺少委託資料，持倉暫未套用」 raises the positions reconcile flag; rows are stale.
    const { bar, label } = await render([row(0, 'Buy', 1, 45500, 1600)], contract, [], true);
    expect(bar).toContain('45,500');
    expect(label).toBe('待更新');
    expect(bar).toContain('請更新持倉');
});

it('replaying the customer\'s fills live (rows netted by the projection) shows the FIFO cost at once', async () => {
    let rows: AccountedPosition[] = [];
    for (const t of customerFills()) {
        const d = t.status.deals[0]!;
        rows = applyPositionFill(rows, { key: `${t.order.id}:${d.seq}`, tradeId: t.order.id, account, code: 'MXFI6',
            action: t.order.action, quantity: d.quantity, price: d.price, ts: d.ts, condition: '', openClose: 'Auto' }, 50)!;
    }
    // The projection nets the Auto buy against the sell row's average: one Sell 1 @ 45552.5 row.
    expect(rows.map(r => [r.direction, r.quantity, r.price])).toEqual([['Sell', 1, 45552.5]]);
    const { bar, label } = await render(rows.map(r => ({ ...r, last_price: 45532 })), contract, customerFills());
    expect(bar).toContain('"空"," ","1"');
    expect(bar).toContain('45,559');
    expect(bar).toContain('+1,350.00');
    expect(label).toBe('FIFO');
});

it('replaying New fills live (projection keeps opposite rows) also reaches the FIFO cost', async () => {
    let rows: AccountedPosition[] = [];
    for (const t of customerFills()) {
        const d = t.status.deals[0]!;
        rows = applyPositionFill(rows, { key: `${t.order.id}:${d.seq}`, tradeId: t.order.id, account, code: 'MXFI6',
            action: t.order.action, quantity: d.quantity, price: d.price, ts: d.ts, condition: '', openClose: 'New' }, 50)!;
    }
    expect(rows.map(r => [r.direction, r.quantity, r.price])).toEqual([['Sell', 2, 45552.5], ['Buy', 1, 45513]]);
    const { bar, label } = await render(rows, contract, customerFills());
    expect(bar).toContain('45,559');
    expect(bar).toContain('+1,350.00');
    expect(label).toBe('多空並存');
});

it('a hidden buy/sell pair on a single-direction row keeps the row figures marked 估算', async () => {
    // Visible fills Buy 100, Buy 101, Sell 110; hidden Buy 105 / Sell 106 moved the netted row to 102.75.
    const c = { ...contract, reference: 101 } as ContractInfo;
    book.close = 104;
    const { bar, label } = await render([{ account, id: 0, code: 'MXFI6', direction: 'Buy', quantity: 1, price: 102.75, last_price: 104, pnl: 62.5 }], c,
        [filled('a', 'Buy', 100, at(1)), filled('b', 'Buy', 101, at(2)), filled('c', 'Sell', 110, at(3))]);
    expect(bar).toContain('102.75');
    expect(label).toBe('估算');
});

it('the same fill arriving twice (snapshot + live report) is counted once', async () => {
    const { bar, label } = await render(customerRows(), contract, [...customerFills(), filled('b', 'Sell', 45559, at(2))]);
    expect(bar).toContain('+1,350.00');
    expect(label).toBe('多空並存');
});

it('ladder cost mark follows the FIFO average', async () => {
    // Buy 45530, Buy 45540, Sell 45545 → FIFO long 1 @ 45540; main's blend 45,538.33 matches no row.
    const { avgMarks, label } = await render([row(0, 'Buy', 2, 45535, 0), row(1, 'Sell', 1, 45545, 0)], contract,
        [filled('a', 'Buy', 45530, at(1)), filled('b', 'Buy', 45540, at(2)), filled('c', 'Sell', 45545, at(3))]);
    expect(label).toBe('多空並存');
    expect(avgMarks).toEqual(['45,540']);
});

it('options (market F) use the same FIFO with the option multiplier and live last price', async () => {
    const opt = { code: 'TXO45500I6', target_code: null, security_type: 'OPT', reference: 115, multiplier: 50 } as unknown as ContractInfo;
    book.close = 115;
    const orow = (id: number, direction: Action, quantity: number, price: number): AccountedPosition =>
        ({ account, id, code: 'TXO45500I6', direction, quantity, price, last_price: 115, pnl: 0 });
    const { bar, label } = await render([orow(0, 'Sell', 2, 120), orow(1, 'Buy', 1, 100)], opt,
        [filled('a', 'Sell', 110, at(1), 'TXO45500I6'), filled('b', 'Sell', 130, at(2), 'TXO45500I6'), filled('c', 'Buy', 100, at(3), 'TXO45500I6')]);
    // Open: Sell 1 @ 130; (115 − 130) × −1 × 50 = +750.
    expect(bar).toContain('"空"," ","1"');
    expect(bar).toContain('@ ","130');
    expect(bar).toContain('+750.00');
    expect(label).toBe('多空並存');
});

it('stock margin long and short sale on the same stock keep main\'s gross blend and no label', async () => {
    const stock = { code: '2330', security_type: 'STK', reference: 1000 } as unknown as ContractInfo;
    const srow = (id: number, direction: Action, quantity: number, price: number, pnl: number, cond: string): AccountedPosition =>
        ({ account: stockAccount, id, code: '2330', direction, quantity, price, last_price: 1010, pnl, yd_quantity: quantity, cond });
    const { bar, label } = await render([srow(0, 'Buy', 3, 1000, 3000, 'MarginTrading'), srow(1, 'Sell', 1, 1030, 1000, 'ShortSelling')], stock, [], true);
    // Same as main: net 2, (3×1000 + 1×1030) / 4, P&L 3000 + 1000; no label even while reconciling.
    expect(bar).toContain('"多"," ","2"');
    expect(bar).toContain('1,007.5');
    expect(bar).toContain('+4,000.00');
    expect(label).toBeNull();
});

it('single-direction futures without two-way fills keep the weighted average and summed P&L, no label', async () => {
    const { bar, label } = await render([row(0, 'Buy', 1, 45500, 1600), row(1, 'Buy', 2, 45520, 1200)], contract,
        [filled('a', 'Buy', 45500, at(1))]);
    expect(bar).toContain('"多"," ","3"');
    expect(bar).toContain('45,513.33');
    expect(bar).toContain('+2,800.00');
    expect(label).toBeNull();
});

it('fully offset mixed rows show no position bar', async () => {
    const { bar } = await render([row(0, 'Sell', 1, 45552, 1000), row(1, 'Buy', 1, 45513, 950)]);
    expect(bar).not.toContain('多空並存');
    expect(bar).not.toContain('平倉');
});
