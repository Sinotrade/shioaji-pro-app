import { describe, expect, it } from 'vitest';
import {
    HEAT_NEUTRAL_BAND,
    heatColor,
    heatInk,
    heatIntensity,
    heatPalette,
    heatRgb,
    legendColors,
    LEGEND_STOPS,
} from './heat-scale';

const dark = heatPalette({ mode: 'dark', convention: 'tw' });
const light = heatPalette({ mode: 'light', convention: 'tw' });

const isReddish = (c: number[]) => c[0]! > c[1]! && c[0]! > c[2]!;
const isGreenish = (c: number[]) => c[1]! > c[0]!;

describe('heatIntensity', () => {
    it('null／NaN 為無值', () => {
        expect(heatIntensity(null, 10)).toBeNull();
        expect(heatIntensity(undefined, 10)).toBeNull();
        expect(heatIntensity(Number.NaN, 10)).toBeNull();
    });

    it('中性帶內為 0', () => {
        expect(heatIntensity(0, 10)).toBe(0);
        expect(heatIntensity(HEAT_NEUTRAL_BAND / 2, 10)).toBe(0);
        expect(heatIntensity(-0.049, 10)).toBe(0);
    });

    it('gamma 0.6 把小漲跌拉亮，並在 domain 飽和', () => {
        // 1% / 10% = 0.1 → 0.1^0.6 ≈ 0.251（線性只有 0.1）
        expect(heatIntensity(1, 10)).toBeCloseTo(0.1 ** 0.6, 6);
        expect(heatIntensity(-1, 10)).toBeCloseTo(0.1 ** 0.6, 6);
        expect(heatIntensity(10, 10)).toBe(1);
        expect(heatIntensity(25, 10)).toBe(1);
    });

    it('單調遞增', () => {
        let prev = 0;
        for (const v of [0.1, 0.5, 1, 2, 4, 7, 10]) {
            const k = heatIntensity(v, 10)!;
            expect(k).toBeGreaterThan(prev);
            prev = k;
        }
    });
});

describe('heatRgb', () => {
    it('台股慣例：漲紅跌綠；國際慣例相反', () => {
        expect(isReddish(heatRgb(3, 10, dark))).toBe(true);
        expect(isGreenish(heatRgb(-3, 10, dark))).toBe(true);
        const intl = heatPalette({ mode: 'dark', convention: 'intl' });
        expect(isGreenish(heatRgb(3, 10, intl))).toBe(true);
        expect(isReddish(heatRgb(-3, 10, intl))).toBe(true);
    });

    it('中性與無值顏色不同，也都不是紅綠', () => {
        expect(heatColor(0, 10, dark)).not.toBe(heatColor(null, 10, dark));
        const n = heatRgb(0, 10, dark);
        expect(Math.max(...n) - Math.min(...n)).toBeLessThan(12);
    });

    it('深色：漲幅越大越亮（低飽和起點、收斂的終點）', () => {
        const lum = (c: number[]) => c[0]! + c[1]! + c[2]!;
        expect(lum(heatRgb(8, 10, dark))).toBeGreaterThan(lum(heatRgb(1, 10, dark)));
        // 終點不是純色（降飽和）
        const hi = heatRgb(10, 10, dark);
        expect(hi[0]).toBeLessThan(242);
    });

    it('淺色：漲幅越大越深', () => {
        const lum = (c: number[]) => c[0]! + c[1]! + c[2]!;
        expect(lum(heatRgb(8, 10, light))).toBeLessThan(lum(heatRgb(1, 10, light)));
    });

    it('自訂配色沿用使用者的紅綠', () => {
        const custom = heatPalette({
            mode: 'custom',
            convention: 'tw',
            custom: {
                base: 'dark',
                background: '#000000',
                panel: '#101010',
                foreground: '#eeeeee',
                accent: '#3d8bff',
                red: '#ff0000',
                green: '#00ff00',
            },
        });
        const up = heatRgb(10, 10, custom);
        expect(up[0]).toBeGreaterThan(150);
        expect(up[1]).toBeLessThan(80);
    });
});

describe('heatInk／圖例', () => {
    it('深色 tile 用白字、淺色淡底用深字', () => {
        expect(heatInk(heatRgb(5, 10, dark), dark)).toBe('rgb(255, 255, 255)');
        expect(heatInk(heatRgb(0.3, 10, light), light)).not.toBe(
            'rgb(255, 255, 255)',
        );
    });

    it('圖例 7 格，中間為中性色、兩端為飽和色', () => {
        const colors = legendColors(10, dark);
        expect(colors).toHaveLength(LEGEND_STOPS.length);
        expect(colors[3]).toBe(heatColor(0, 10, dark));
        expect(colors[6]).toBe(heatColor(10, 10, dark));
        expect(colors[0]).toBe(heatColor(-10, 10, dark));
    });
});
