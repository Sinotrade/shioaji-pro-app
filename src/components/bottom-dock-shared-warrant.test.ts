import { describe, expect, it, vi } from 'vitest';
vi.mock('../lib/trade', () => ({ notify: vi.fn() }));
import { tradeMarket } from './bottom-dock-shared';
import type { Trade } from '../lib/types/order';

const trade = (securityType: string) => ({
    contract: { code: '030392', security_type: securityType, exchange: 'TSE', target_code: null },
    order: {},
}) as unknown as Trade;

describe('tradeMarket', () => {
    // 對帳後的權證委託是 STK、place 回應是 WRT；同一筆委託不能因此換市場
    it.each(['WRT', 'STK'])('沒有帳戶資料時 %s 歸證券', (securityType) => {
        expect(tradeMarket(trade(securityType))).toBe('S');
    });

    it.each(['FUT', 'OPT'])('%s 歸期貨', (securityType) => {
        expect(tradeMarket(trade(securityType))).toBe('F');
    });
});
