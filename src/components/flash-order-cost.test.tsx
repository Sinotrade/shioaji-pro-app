import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { Account, AccountedPosition } from '../lib/types/portfolio';
import type { ContractInfo } from '../lib/types/contract';
const account: Account = { account_type: 'F', broker_id: 'BR', account_id: 'A', signed: true, person_id: '', username: '' };
vi.mock('../lib/account-store', () => ({ useAccounts: () => ({ accounts: [account], selectedStock: account, selectedFutures: account }), selectAccount: () => {}, accountFor: () => account }));
vi.mock('../hooks/use-stream', () => ({ useTradingLive: () => true }));
vi.mock('../hooks/use-display-book', () => ({ useDisplayBook: () => ({ quote: undefined, snapshot: { close: 45532 }, book: undefined }) }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: vi.fn(), cancelOrders: vi.fn() }));
vi.mock('../lib/trade', () => ({ notify: vi.fn(), placeQuickOrder: vi.fn(), placeStockExitByShares: vi.fn() }));
vi.mock('../lib/stream', () => ({ getAliasFor: (c: string) => (c === 'MXFI6' ? 'MXFR1' : undefined) }));
vi.mock('../lib/tick-bands', () => ({ useTickBandsVersion: () => 0 }));
vi.mock('../lib/utils/ticksize', () => ({ roundToTick: (_c: unknown, p: number) => p, stepPrice: (_c: unknown, p: number, step: number) => p + step }));
import { FlashOrder } from './flash-order';
import * as styles from './flash-order.css';

const contract = { code: 'MXFR1', target_code: 'MXFI6', security_type: 'FUT', reference: 45592, multiplier: 50 } as unknown as ContractInfo;
const row = (id: number, direction: 'Buy' | 'Sell', quantity: number, price: number, pnl: number): AccountedPosition =>
    ({ account, id, code: 'MXFI6', direction, quantity, price, last_price: 45532, pnl });

async function render(positions: AccountedPosition[]) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    let view!: ReactTestRenderer;
    try {
        await act(async () => { view = create(createElement(FlashOrder, { contract, trades: [], positions })); });
        const avgMarks = view.root.findAll(n => typeof n.type === 'string' && String(n.props.className ?? '').split(' ').includes(styles.avgMark))
            .map(n => n.children.filter(c => typeof c === 'string').join(''));
        return { bar: JSON.stringify(view.toJSON()), avgMarks };
    } finally { await act(async () => view?.unmount()); vi.unstubAllGlobals(); }
}

// #116: broker returns un-netted Buy and Sell rows for the same contract
// (fills 賣 45546, 賣 45559, 買 45513; last 45532). eLeader (FIFO): 庫 -1 均 45559 損益 1350.
it('mixed directions show the open side average and its still-open P&L share, not a gross blend', async () => {
    const { bar } = await render([row(0, 'Sell', 2, 45552.5, 2050), row(1, 'Buy', 1, 45513, 950)]);
    expect(bar).not.toContain('45,539.33'); // old gross blend over 3 lots
    expect(bar).not.toContain('+3,000'); // old P&L summed both directions
    expect(bar).toContain('"空"," ","1"');
    expect(bar).toContain('45,552.5');
    expect(bar).toContain('+1,025');
    expect(bar).toContain('多空並存');
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
