import { describe, expect, it } from 'vitest';
import { normalizeOrderEvent } from './order-report';
import { applyPositionFill, markPosition, positionFill, type PositionFill } from './portfolio-projection';
import type { Account, AccountedPosition } from './types/portfolio';

const account: Account = { account_type: 'S', broker_id: 'test', account_id: 'a', person_id: '', signed: true, username: '' };
const base: AccountedPosition = { id: 1, code: '2330', direction: 'Buy', quantity: 1000, price: 100, last_price: 110, pnl: 9900, yd_quantity: 1000, cond: 'Cash', account };
const fill: PositionFill = { key: 'fill', tradeId: 'order', account, code: '2330', action: 'Buy', quantity: 100, price: 120, ts: 1789000000, condition: 'Cash', openClose: '' };

describe('position projection', () => {
    it('marks current value without discarding broker baseline adjustments', () => {
        expect(markPosition(base, 112, 1)).toMatchObject({ last_price: 112, pnl: 11900 });
        expect(markPosition({ ...base, direction: 'Sell' }, 112, 1).pnl).toBe(7900);
    });
    it('uses explicit futures multiplier and ignores invalid quotes', () => {
        expect(markPosition({ ...base, quantity: 2 }, 111, 200).pnl).toBe(10300);
        expect(markPosition(base, NaN, 1)).toBe(base);
        expect(markPosition(base, 0, 1)).toBe(base);
        expect(markPosition(base, 112, 0)).toBe(base);
    });
    it('adds shares at weighted cost and retains existing mark-to-market', () => {
        const p = applyPositionFill([base], fill, 1)![0]!;
        expect(p.quantity).toBe(1100);
        expect(p.price).toBeCloseTo(101.8181818);
        expect(p.pnl).toBe(19900);
        expect(p.last_price).toBe(120);
        expect('yd_quantity' in p && p.yd_quantity).toBe(1000);
    });
    it('reduces or removes only the matching account holding', () => {
        const other = { ...base, account: { ...account, account_id: 'b' } };
        expect(applyPositionFill([base, other], { ...fill, action: 'Sell', quantity: 1000 }, 1)).toEqual([other]);
        expect(applyPositionFill([base], { ...fill, action: 'Sell', quantity: 100 }, 1)![0]!.quantity).toBe(900);
    });
    it('does not invent short cash holdings or choose among ambiguous lots', () => {
        expect(applyPositionFill([base], { ...fill, action: 'Sell', quantity: 1001 }, 1)).toBeNull();
        expect(applyPositionFill([base, { ...base, id: 2 }], fill, 1)).toBeNull();
    });
    it('handles explicit new/cover and net auto futures without guessing hedged auto', () => {
        const a = { ...account, account_type: 'F' };
        const p = { ...base, account: a, quantity: 2 };
        const f = { ...fill, account: a, action: 'Sell' as const, quantity: 3, openClose: 'Auto' };
        expect(applyPositionFill([p], f, 200)).toEqual([expect.objectContaining({ direction: 'Sell', quantity: 1, price: 120 })]);
        expect(applyPositionFill([p], { ...f, openClose: 'Cover' }, 200)).toBeNull();
        expect(applyPositionFill([p], { ...f, openClose: 'New' }, 200)).toHaveLength(2);
        expect(applyPositionFill([p, { ...p, direction: 'Sell' }], f, 200)).toBeNull();
    });
    it('requires account and fill identity; normalizes lots to shares', () => {
        const body = { trade_id: 'order', exchange_seq: 'fill-1', broker_id: 'test', account_id: 'a', code: '2330', action: 'Buy', price: 120, quantity: 1, order_lot: 'Common', order_cond: 'Cash', ts: fill.ts };
        const parse = (b: object) => positionFill(normalizeOrderEvent({ state: 'StockDeal', data: { StockDeal: b } })!, [account], []);
        expect(parse(body)?.quantity).toBe(1000);
        expect(parse({ ...body, order_lot: 'IntradayOdd' })?.quantity).toBe(1);
        expect(parse({ ...body, account_id: '' })).toBeNull();
        expect(parse({ ...body, exchange_seq: '' })).toBeNull();
        expect(parse({ ...body, order_cond: 'MarginTrading' })).toBeNull();
        expect(parse({ ...body, order_cond: 'Netting' })).toBeNull();
        expect(parse({ ...body, quantity: 0 })).toBeNull();
    });
});
