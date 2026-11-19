import { describe, expect, it } from 'vitest';
import { pickUsReference } from './use-us-snapshot';

const contract = { us_reference: '351.91', reference_date: '2026-11-17' };

describe('pickUsReference', () => {
    it('uses the live change base once a tick has price_chg', () => {
        expect(pickUsReference({ close: '353.65', price_chg: '1.2' }, { reference: 352.45 }, contract)).toEqual({ price: '352.45', date: null });
    });
    it('uses the snapshot reference before the first tick (the contract file can be a day behind)', () => {
        expect(pickUsReference(undefined, { reference: 352.45 }, contract)).toEqual({ price: '352.45', date: null });
    });
    it('falls back to the contract reference with its close date', () => {
        expect(pickUsReference(undefined, null, contract)).toEqual({ price: '351.91', date: '2026-11-17' });
        expect(pickUsReference(undefined, { reference: 0 }, contract).price).toBe('351.91');
        expect(pickUsReference(undefined, null, {})).toEqual({ price: null, date: null });
    });
});
