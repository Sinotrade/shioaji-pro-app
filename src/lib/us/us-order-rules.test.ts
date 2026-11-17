import { describe, expect, it } from 'vitest';
import { buildUsOrderReq, isUsCancelTooEarly, US_TIME_IN_FORCE_ENABLED, usOrderProblem, usPriceTypeAllowed, type UsOrderDraft } from './us-order-rules';

const draft = (over: Partial<UsOrderDraft> = {}): UsOrderDraft => ({
    action: 'Buy', quantity: '10', priceType: 'LMT', timeInForce: 'DAY', price: '173.97', ...over,
});

describe('US order rules (closed beta)', () => {
    it('offers DAY and ATC only; OPG stays behind the constant', () => {
        expect(US_TIME_IN_FORCE_ENABLED).toEqual(['DAY', 'ATC']);
        expect(usOrderProblem(draft({ timeInForce: 'OPG' }))).toContain('OPG');
    });

    it('rejects ATC with a market price', () => {
        expect(usPriceTypeAllowed('ATC', 'MKT')).toBe(false);
        expect(usOrderProblem(draft({ timeInForce: 'ATC', priceType: 'MKT', price: '' }))).toBe('ATC 只能限價，不能用市價');
        expect(usOrderProblem(draft({ timeInForce: 'ATC' }))).toBeNull();
    });

    it('requires whole shares and at most 4 decimals', () => {
        expect(usOrderProblem(draft({ quantity: '1.5' }))).toContain('整股');
        expect(usOrderProblem(draft({ quantity: '0' }))).toContain('整股');
        expect(usOrderProblem(draft({ price: '1.23456' }))).toContain('4 位小數');
        expect(usOrderProblem(draft({ price: '0' }))).toContain('大於 0');
        expect(usOrderProblem(draft({ price: '1.2345' }))).toBeNull();
    });

    it('builds a request with string price, MKT as "0", and no TW-only fields', () => {
        const lmt = buildUsOrderReq(draft({ price: '173.9700' }));
        expect(lmt).toEqual({ action: 'Buy', price: '173.97', quantity: 10, price_type: 'LMT', time_in_force: 'DAY' });
        const mkt = buildUsOrderReq(draft({ priceType: 'MKT', price: '999' }));
        expect(mkt.price).toBe('0');
        for (const key of ['order_lot', 'order_cond', 'daytrade_short', 'custom_field', 'order_type']) expect(mkt).not.toHaveProperty(key);
    });

    it('recognizes the -2054 cancel-too-early rejection', () => {
        expect(isUsCancelTooEarly('400 此委託不存在 (-2054)')).toBe(true);
        expect(isUsCancelTooEarly('400 other')).toBe(false);
    });
});
