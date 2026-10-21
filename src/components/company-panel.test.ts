import { describe, expect, it, vi } from 'vitest';

// The panel module pulls in app modules that touch window/localStorage at load.
vi.hoisted(() => {
    const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
    Object.assign(globalThis, {
        window: Object.assign(globalThis, { addEventListener: () => undefined, removeEventListener: () => undefined }),
        localStorage: storage,
    });
});
import type { ContractInfo } from '../lib/types/contract';
import { companyTarget, fmtTwd } from './company-panel';

const c = (fields: Partial<ContractInfo>) => fields as ContractInfo;

describe('company panel helpers (#337)', () => {
    it('follows stocks and stock-future underlyings, not indices', () => {
        expect(companyTarget(c({ security_type: 'STK', code: '2330' }))).toEqual({ code: '2330', viaUnderlying: false });
        expect(companyTarget(c({ security_type: 'FUT', code: 'CDFR1', underlying_code: '2330' }))).toEqual({ code: '2330', viaUnderlying: true });
        expect(companyTarget(c({ security_type: 'FUT', code: 'TXFR1', underlying_kind: 'I', underlying_code: '#001' }))).toBeNull();
        expect(companyTarget(c({ security_type: 'IND', code: '001' }))).toBeNull();
    });

    it('formats TWD amounts in 兆 / 億 / 萬', () => {
        expect(fmtTwd(62.37e12)).toBe('62.37 兆');
        expect(fmtTwd(5.119e11)).toBe('5,119 億');
        expect(fmtTwd(3.5e8)).toBe('3.5 億');
        expect(fmtTwd(null)).toBe('—');
    });
});
