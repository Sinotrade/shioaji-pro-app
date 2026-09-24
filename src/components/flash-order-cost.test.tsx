import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { Account, AccountedPosition } from '../lib/types/portfolio';
import type { ContractInfo } from '../lib/types/contract';
import type { Action, Trade } from '../lib/types/order';
const account: Account = { account_type: 'F', broker_id: 'BR', account_id: 'A', signed: true, person_id: '', username: '' };
const stockAccount: Account = { ...account, account_type: 'S', account_id: 'S1' };
vi.mock('../lib/account-store', () => ({ useAccounts: () => ({ accounts: [account, stockAccount], selectedStock: stockAccount, selectedFutures: account }), selectAccount: () => {}, accountFor: (t: string) => (t === 'S' ? stockAccount : account) }));
vi.mock('../hooks/use-stream', () => ({ useTradingLive: () => true }));
vi.mock('../hooks/use-display-book', () => ({ useDisplayBook: () => ({ quote: undefined, snapshot: { close: 45532 }, book: undefined }) }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: vi.fn(), cancelOrders: vi.fn() }));
vi.mock('../lib/trade', () => ({ notify: vi.fn(), placeQuickOrder: vi.fn(), placeStockExitByShares: vi.fn() }));
vi.mock('../lib/stream', () => ({ getAliasFor: (c: string) => (c === 'MXFI6' ? 'MXFR1' : undefined) }));
vi.mock('../lib/tick-bands', () => ({ useTickBandsVersion: () => 0 }));
vi.mock('../lib/utils/ticksize', () => ({ roundToTick: (_c: unknown, p: number) => p, stepPrice: (_c: unknown, p: number, step: number) => p + step }));
import { FlashOrder } from './flash-order';
import { applyPositionFill } from '../lib/portfolio-projection';
import * as styles from './flash-order.css';

const contract = { code: 'MXFR1', target_code: 'MXFI6', security_type: 'FUT', reference: 45592, multiplier: 50 } as unknown as ContractInfo;
const row = (id: number, direction: 'Buy' | 'Sell', quantity: number, price: number, pnl: number): AccountedPosition =>
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
        return { bar: JSON.stringify(view.toJSON()), avgMarks };
    } finally { await act(async () => view?.unmount()); vi.unstubAllGlobals(); }
}

const filled = (id: string, action: Action, price: number, ts: number): Trade => ({
    account, contract: { code: 'MXFR1', target_code: 'MXFI6' },
    order: { id, seqno: id, ordno: id, action, price, quantity: 1, account },
    status: { id, status: 'Filled', status_code: '', order_quantity: 1, deal_quantity: 1, cancel_quantity: 0, modified_price: 0, msg: '',
        deals: [{ seq: '1', price, quantity: 1, ts }] },
}) as unknown as Trade;

// #116: broker returns un-netted Buy and Sell rows for the same contract
// (fills 賣 45546, 賣 45559, 買 45513; last 45532). eLeader (FIFO): 庫 -1 均 45559 損益 1350.
const customerRows = () => [row(0, 'Sell', 2, 45552.5, 2050), row(1, 'Buy', 1, 45513, 950)];
const customerFills = () => [filled('a', 'Sell', 45546, 1), filled('b', 'Sell', 45559, 2), filled('c', 'Buy', 45513, 3)];

it('mixed futures with today\'s fills show the FIFO-matched lot, as eLeader does', async () => {
    const { bar } = await render(customerRows(), contract, customerFills());
    expect(bar).toContain('"空"," ","1"');
    expect(bar).toContain('45,559');
    expect(bar).toContain('+1,350.00');
    expect(bar).toContain('"多空並存"');
    expect(bar).toContain('先進先出');
    expect(bar).not.toContain('估算');
});

it('a missing fill is never shown as a confirmed FIFO cost', async () => {
    // Sell @45559 not loaded: seeding it as a carried lot would give a wrong "FIFO" 45,546.
    const { bar } = await render(customerRows(), contract, [filled('a', 'Sell', 45546, 1), filled('c', 'Buy', 45513, 3)]);
    expect(bar).not.toContain('45,546');
    expect(bar).toContain('45,552.5');
    expect(bar).toContain('多空並存 估算');
});

it('orders or positions awaiting reconciliation keep the marked estimate', async () => {
    const { bar } = await render(customerRows(), contract, customerFills(), true);
    expect(bar).toContain('45,552.5');
    expect(bar).toContain('多空並存 估算');
});

it('replaying the customer\'s fills live (rows netted by the projection) shows the FIFO cost at once', async () => {
    let rows: AccountedPosition[] = [];
    for (const t of customerFills()) {
        const d = t.status.deals[0]!;
        rows = applyPositionFill(rows, { key: `${t.order.id}:${d.seq}`, tradeId: t.order.id, account, code: 'MXFI6',
            action: t.order.action, quantity: d.quantity, price: d.price, ts: d.ts, condition: '', openClose: 'Auto' }, 50)!;
    }
    // The projection nets the buy against the sell row's average: one Sell 1 @ 45552.5 row.
    expect(rows.map(r => [r.direction, r.quantity, r.price])).toEqual([['Sell', 1, 45552.5]]);
    const { bar } = await render(rows.map(r => ({ ...r, last_price: 45532 })), contract, customerFills());
    expect(bar).toContain('"空"," ","1"');
    expect(bar).toContain('45,559');
    expect(bar).toContain('+1,350.00');
    expect(bar).toContain('"FIFO"');
    expect(bar).not.toContain('多空並存');
});

it('the same fill arriving twice (snapshot + live report) is counted once', async () => {
    const { bar } = await render(customerRows(), contract, [...customerFills(), filled('b', 'Sell', 45559, 2)]);
    expect(bar).toContain('+1,350.00');
    expect(bar).not.toContain('估算');
});

it('fills that do not match the rows fall back to the open-side estimate', async () => {
    // Missing fills: without them the rows cannot be explained by FIFO.
    const { bar } = await render(customerRows(), contract, [filled('c', 'Buy', 45513, 3), filled('d', 'Buy', 45520, 4)]);
    expect(bar).toContain('45,552.5');
    expect(bar).toContain('多空並存 估算');
});

it('mixed directions without fills show the open side average and its still-open P&L share, not a gross blend', async () => {
    const { bar } = await render([row(0, 'Sell', 2, 45552.5, 2050), row(1, 'Buy', 1, 45513, 950)]);
    expect(bar).not.toContain('45,539.33'); // old gross blend over 3 lots
    expect(bar).not.toContain('+3,000'); // old P&L summed both directions
    expect(bar).toContain('"空"," ","1"');
    expect(bar).toContain('45,552.5');
    expect(bar).toContain('+1,025.00');
    expect(bar).toContain('多空並存 估算');
});

it('several open-side rows at different prices average only that side and round the P&L share', async () => {
    const { bar } = await render([
        row(0, 'Sell', 1, 45546, 700), row(1, 'Sell', 1, 45559, 1350), row(2, 'Sell', 1, 45600, 3400), row(3, 'Buy', 1, 45513, 950),
    ]);
    expect(bar).toContain('"空"," ","2"');
    expect(bar).toContain('45,568.33');
    expect(bar).toContain('+3,633.00'); // 5450 × 2/3 = 3633.33… rounded to a whole number
    expect(bar).toContain('多空並存');
});

it('stock margin long and short sale on the same stock keep the gross blend and no mixed label', async () => {
    const stock = { code: '2330', security_type: 'STK', reference: 1000 } as unknown as ContractInfo;
    const srow = (id: number, direction: 'Buy' | 'Sell', quantity: number, price: number, pnl: number, cond: string): AccountedPosition =>
        ({ account: stockAccount, id, code: '2330', direction, quantity, price, last_price: 1010, pnl, yd_quantity: quantity, cond });
    const { bar } = await render([srow(0, 'Buy', 3, 1000, 3000, 'MarginTrading'), srow(1, 'Sell', 1, 1030, 1000, 'ShortSelling')], stock);
    // Same as before the fix: net 2, (3×1000 + 1×1030) / 4, P&L 3000 + 1000.
    expect(bar).toContain('"多"," ","2"');
    expect(bar).toContain('1,007.5');
    expect(bar).toContain('+4,000.00');
    expect(bar).not.toContain('多空並存');
});

it('single-direction rows keep the weighted average over all rows and the summed P&L', async () => {
    const { bar } = await render([row(0, 'Buy', 1, 45500, 1600), row(1, 'Buy', 2, 45520, 1200)]);
    expect(bar).toContain('"多"," ","3"');
    expect(bar).toContain('45,513.33');
    expect(bar).toContain('+2,800');
    expect(bar).not.toContain('多空並存');
});

it('ladder cost mark follows the open side average when both directions are present', async () => {
    // Old blend (2×45530 + 1×45540) / 3 = 45533.33 matched no ladder row.
    const { avgMarks } = await render([row(0, 'Buy', 2, 45530, 200), row(1, 'Sell', 1, 45540, 400)]);
    expect(avgMarks).toEqual(['45,530']);
});

it('fully offset mixed rows show no position bar', async () => {
    const { bar } = await render([row(0, 'Sell', 1, 45552, 1000), row(1, 'Buy', 1, 45513, 950)]);
    expect(bar).not.toContain('多空並存');
    expect(bar).not.toContain('平倉');
});
