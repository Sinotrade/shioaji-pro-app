// chain-detail 鏈內卡片走勢圖：x 軸至少涵蓋 15 分鐘，線從左邊長出來
import { describe, expect, it } from 'vitest';
import { TIER_SPAN, tierDomain } from './chain-detail';

describe('tierDomain', () => {
    it('covers at least the 15-minute window from the first bar, then the observed span', () => {
        expect(TIER_SPAN).toBe(15);
        expect(tierDomain(100, 100)).toEqual({ start: 100, slots: 15 });
        expect(tierDomain(100, 104)).toEqual({ start: 100, slots: 15 });
        expect(tierDomain(100, 114)).toEqual({ start: 100, slots: 15 });
        expect(tierDomain(100, 160)).toEqual({ start: 100, slots: 61 });
    });
});
