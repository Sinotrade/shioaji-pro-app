import { describe, expect, it } from 'vitest';
import { pickUsReference, usLiveChange } from './use-us-snapshot';

const contract = { us_reference: '351.91', reference_date: '2026-11-17' };

describe('pickUsReference', () => {
    it('uses the same-day snapshot reference, never the tick close', () => {
        expect(pickUsReference({ date: '2026-11-19' }, { tradeDate: '2026-11-19', reference: 352.45 }, contract))
            .toEqual({ price: '352.45', date: null, tradeDate: '2026-11-19' });
    });
    it('uses the snapshot trade date before the first tick', () => {
        expect(pickUsReference(undefined, { tradeDate: '2026-11-19', reference: 352.45 }, contract, '2026-11-19').price).toBe('352.45');
    });
    it('falls back to a contract reference only when it applies to that trade date', () => {
        expect(pickUsReference({ date: '2026-11-18' }, null, contract)).toEqual({ price: '351.91', date: '2026-11-17', tradeDate: '2026-11-18' });
        // 合約檔落後一天（11-17 收盤套到 11-19）：不用
        expect(pickUsReference({ date: '2026-11-19' }, null, contract).price).toBeNull();
        expect(pickUsReference(undefined, null, {}, '2026-11-19').price).toBeNull();
        // 沒有成交、沒有快照：顯示合約檔參考價並標收盤日
        expect(pickUsReference(undefined, null, contract, '2026-11-19')).toMatchObject({ price: '351.91', date: '2026-11-17' });
    });
});

describe('usLiveChange', () => {
    it('computes price minus reference, else keeps the SDK value', () => {
        expect(usLiveChange({ close: '229.08', price_chg: '0', pct_chg: '0' }, '228.53')).toEqual({ priceChg: '0.55', pctChg: '0.24' });
        expect(usLiveChange({ close: '229.08', price_chg: '0.5', pct_chg: '0.2' }, null)).toEqual({ priceChg: '0.5', pctChg: '0.2' });
    });
});
