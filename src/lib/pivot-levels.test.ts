import { describe, expect, it } from 'vitest';
import { pivotLevels, pivotSignal, pivotZone } from './pivot-levels';

describe('pivotLevels', () => {
    it('收盤偏弱（M>=C）：強 1.382、弱 1.618', () => {
        const lv = pivotLevels(100, 90, 95);
        expect(lv.mid).toBe(95);
        expect(lv.strong).toBeCloseTo(103.82, 6);
        expect(lv.weak).toBeCloseTo(83.82, 6);
    });

    it('收盤偏強（M<C）：強 1.618、弱 1.382', () => {
        const lv = pivotLevels(100, 90, 99);
        expect(lv.strong).toBeCloseTo(106.18, 6);
        expect(lv.weak).toBeCloseTo(86.18, 6);
    });
});

describe('pivotZone', () => {
    const lv = pivotLevels(100, 90, 95);
    it('開盤價六分區邊界', () => {
        expect(pivotZone(105, lv, 100, 90)).toBe(1);
        expect(pivotZone(102, lv, 100, 90)).toBe(2);
        expect(pivotZone(96, lv, 100, 90)).toBe(3);
        expect(pivotZone(93, lv, 100, 90)).toBe(4);
        expect(pivotZone(86, lv, 100, 90)).toBe(5);
        expect(pivotZone(80, lv, 100, 90)).toBe(6);
    });
});

describe('pivotSignal', () => {
    it('只有一區做多、六區做空，其餘中性不操作', () => {
        expect(pivotSignal(1).tone).toBe('long');
        expect(pivotSignal(6).tone).toBe('short');
        for (const z of [2, 3, 4, 5] as const) {
            expect(pivotSignal(z).tone).toBe('neutral');
        }
    });
});
