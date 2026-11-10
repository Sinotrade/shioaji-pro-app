// A warrant panel bracket (自動停損停利 on a warrant) in the background
// engine (private engine #217): a stock-market WRT program, whole lots in cash.
import { expect, it } from 'vitest';
import { panelBracketRequest } from './background-bracket';
import { warrantTickTable } from '../warrant-rules';

const base = {
    env: 'http://sim.invalid|simulation',
    account: { account_type: 'S' as const, broker_id: 'B', account_id: '1' },
    quoteCode: '051231', orderCode: '051231', action: 'Buy' as const,
    plan: { tiers: [{ quantity: 2, takeTicks: 5 }], stopTicks: 3, trail: null, breakeven: null },
    tickTable: warrantTickTable(),
};

it('a 觸價 warrant bracket: WRT on the stock market, the entry in cash whole lots', () => {
    const r = panelBracketRequest({ ...base, securityType: 'WRT',
        entry: { trigger: { condition: 'above', price: 12, send: { type: 'LMT', ticks: 1 } } } }, 'bkt-w');
    expect(r).toMatchObject({ id: 'bkt-w', qty: 2,
        binding: { account: { accountType: 'S' }, contract: { market: 'stock', securityType: 'WRT', orderCode: '051231' } },
        trigger: { condition: 'above', price: 12, limitTicks: 1, order: { priceType: 'LMT', timeInForce: 'ROD', stockCond: 'Cash', stockLot: 'Common' } } });
    expect(r!.trigger!.order.octype).toBeUndefined();
});

it('a warrant at market after the trigger stays a cash whole-lot market order (domestic underlying)', () => {
    const r = panelBracketRequest({ ...base, securityType: 'WRT',
        entry: { trigger: { condition: 'below', price: 12, send: { type: 'MKT' } } } }, 'bkt-m');
    expect(r!.trigger!.order).toEqual({ priceType: 'MKT', timeInForce: 'IOC', stockCond: 'Cash', stockLot: 'Common' });
});
