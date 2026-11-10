import { expect, it } from 'vitest';
import { flashOrderTotals } from './flash-order-totals';
import type { Trade } from './types/order';

const t = (action: 'Buy' | 'Sell', quantity: number, deal: number, cancel: number, status: string, extra: Record<string, unknown> = {}) =>
    ({ contract: { code: '2317' }, order: { action, price: 100, quantity, order_cond: 'Cash', ...extra },
        status: { status, deal_quantity: deal, cancel_quantity: cancel, deals: [] } }) as unknown as Trade;
const all = () => true;

it('counts ordered net of cancels, filled and working per side (customer case 32(20) / 40(20))', () => {
    const trades = [
        t('Buy', 12, 12, 0, 'Filled'), t('Buy', 8, 8, 0, 'Filled'), t('Buy', 12, 0, 0, 'Submitted'),
        t('Sell', 20, 20, 0, 'Filled', { daytrade_short: true }), t('Sell', 20, 0, 0, 'Submitted', { daytrade_short: true }),
        t('Sell', 5, 0, 5, 'Cancelled', { daytrade_short: true }), t('Sell', 3, 0, 0, 'Failed'),
    ];
    const r = flashOrderTotals(trades, all, true);
    expect(r.buy).toEqual({ ordered: 32, filled: 20, working: 12, cancelled: 0 });
    expect(r.sell).toEqual({ ordered: 40, filled: 20, working: 20, cancelled: 5 });
    expect(r.dayShort).toEqual({ sold: 20, covered: 20, open: 0 });
});

it('a partly filled then cancelled order counts only what filled; a part-filled one keeps its rest working', () => {
    const r = flashOrderTotals([t('Buy', 10, 4, 6, 'Cancelled'), t('Sell', 10, 3, 2, 'PartFilled')], all, false);
    expect(r.buy).toEqual({ ordered: 4, filled: 4, working: 0, cancelled: 6 });
    expect(r.sell).toEqual({ ordered: 8, filled: 3, working: 5, cancelled: 2 });
});

it('only cash buys cover day-trade short sells; a plain sell is not a short', () => {
    const r = flashOrderTotals([
        t('Sell', 30, 30, 0, 'Filled', { daytrade_short: true }),
        t('Sell', 5, 5, 0, 'Filled'),
        t('Buy', 20, 20, 0, 'Filled'),
        t('Buy', 5, 5, 0, 'Filled', { order_cond: 'MarginTrading' }),
    ], all, true);
    expect(r.dayShort).toEqual({ sold: 30, covered: 20, open: 10 });
});

it('futures (stock=false) never report a day-trade short', () => {
    expect(flashOrderTotals([t('Sell', 2, 2, 0, 'Filled', { daytrade_short: true })], all, false).dayShort).toBeNull();
});

it('skips rows outside the panel and malformed quantities', () => {
    const r = flashOrderTotals([t('Buy', 5, 5, 0, 'Filled'), t('Buy', Number.NaN, 0, 0, 'Submitted')], tr => tr.order.quantity !== 5, false);
    expect(r.buy.ordered).toBe(0);
});

it('the 顯示委託合計 setting survives saving: only an explicit false is kept (absent = on)', async () => {
    const { normalizeFlashOrderOpts } = await import('./flash-account');
    expect(normalizeFlashOrderOpts({ orderType: 'ROD', showTotals: false })?.showTotals).toBe(false);
    expect(normalizeFlashOrderOpts({ orderType: 'ROD', showTotals: true })).not.toHaveProperty('showTotals');
    expect(normalizeFlashOrderOpts({ orderType: 'ROD' })).not.toHaveProperty('showTotals');
});
