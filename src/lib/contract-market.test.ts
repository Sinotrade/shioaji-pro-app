import { describe, expect, it } from 'vitest';
import { contractMarket, isWarrant } from './contract-market';

describe('contractMarket', () => {
    it.each(['STK', 'WRT'])('%s 走證券帳戶', (type) => {
        expect(contractMarket(type)).toBe('S');
    });

    it.each(['FUT', 'OPT'])('%s 走期貨帳戶', (type) => {
        expect(contractMarket(type)).toBe('F');
    });

    it.each(['IND', null, undefined, ''])('%s 不能下單，也不猜市場', (type) => {
        expect(contractMarket(type)).toBeNull();
    });
});

describe('isWarrant', () => {
    it('只認 WRT；對帳回來標成 STK 的權證仍由 contractMarket 歸到證券', () => {
        expect(isWarrant('WRT')).toBe(true);
        expect(isWarrant('STK')).toBe(false);
    });
});
