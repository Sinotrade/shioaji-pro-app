import { describe, expect, it } from 'vitest';
import { estimateTextWidth, fitHeatLabel } from './heat-label';

describe('estimateTextWidth', () => {
    it('CJK 一字 1em、英數 0.62em', () => {
        expect(estimateTextWidth('台積電', 10)).toBe(30);
        expect(estimateTextWidth('2330', 10)).toBeCloseTo(24.8);
        expect(estimateTextWidth('+1.25%', 20)).toBeCloseTo(6 * 0.62 * 20);
    });
});

describe('fitHeatLabel', () => {
    it('大 tile 用最大字級顯示名稱＋漲跌', () => {
        expect(fitHeatLabel(400, 300, '台積電', '+0.62%', '2330')).toEqual({
            mode: 'both',
            fontSize: 28,
        });
    });

    it('字級隨面積遞減', () => {
        const sizes = [
            fitHeatLabel(160, 110, '日月光投控', '+3.64%').fontSize,
            fitHeatLabel(110, 70, '日月光投控', '+3.64%').fontSize,
            fitHeatLabel(90, 56, '日月光投控', '+3.64%').fontSize,
        ];
        expect(sizes[0]).toBeGreaterThan(sizes[1]!);
        expect(sizes[1]).toBeGreaterThan(sizes[2]!);
    });

    it('放不下兩行 → 只放名稱', () => {
        const fit = fitHeatLabel(48, 20, '健策', '+1.00%', '3653');
        expect(fit.mode).toBe('name');
    });

    it('名稱太長 → 代號', () => {
        const fit = fitHeatLabel(34, 18, '台新新光金', '+2.32%', '2887');
        expect(fit).toEqual({ mode: 'code', fontSize: 10 });
    });

    it('太小 → 不放字', () => {
        expect(fitHeatLabel(12, 12, '台積電', '+1%', '2330').mode).toBe('none');
        expect(fitHeatLabel(200, 10, '台積電', '+1%', '2330').mode).toBe('none');
    });

    it('估算寬度不超出 tile', () => {
        for (const [w, h] of [
            [70, 40],
            [120, 60],
            [240, 160],
        ] as const) {
            const fit = fitHeatLabel(w, h, '聯發科', '-0.24%', '2454');
            if (fit.mode === 'both') {
                expect(estimateTextWidth('聯發科', fit.fontSize)).toBeLessThan(w);
                expect(fit.fontSize * 2.3).toBeLessThan(h);
            }
        }
    });
});
