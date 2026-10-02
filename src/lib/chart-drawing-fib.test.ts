import { describe, expect, it } from 'vitest';
import {
    defaultFibOptions,
    FIB_TOKEN_COLORS,
    fibLabel,
    fibLabelPlacement,
    fibLevelColor,
    fibLevelPrice,
    sanitizeFibOptions,
    tokenForValue,
} from './chart-drawing-fib';

describe('斐波那契預設（TradingView 式）', () => {
    it('七個比例，顏色依序灰、紅、橘、綠、青、藍、灰；標籤預設左側、線上方，顯示層級與價格', () => {
        const d = defaultFibOptions();
        expect(d.levels.map((l) => l.value)).toEqual([0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);
        expect(d.levels.map((l) => l.token)).toEqual(['grey', 'red', 'orange', 'green', 'teal', 'blue', 'grey']);
        expect(d).toMatchObject({ labelH: 'left', labelV: 'top', showLevel: true, showPrice: true, levelFormat: 'value' });
        expect(d.bandOpacity).toBeGreaterThan(0);
    });

    it('顏色是主題 token：深淺主題各一組，使用者挑的色碼優先，單一顏色用線色', () => {
        const lvl = defaultFibOptions().levels[1]!;
        expect(fibLevelColor(lvl, { singleColor: false }, '#123456', 'dark')).toBe(FIB_TOKEN_COLORS.dark.red);
        expect(fibLevelColor(lvl, { singleColor: false }, '#123456', 'light')).toBe(FIB_TOKEN_COLORS.light.red);
        expect(FIB_TOKEN_COLORS.dark.red).not.toBe(FIB_TOKEN_COLORS.light.red);
        expect(fibLevelColor({ ...lvl, color: '#abcdef' }, { singleColor: false }, '#123456', 'dark')).toBe('#abcdef');
        expect(fibLevelColor({ ...lvl, color: '#abcdef' }, { singleColor: true }, '#123456', 'dark')).toBe('#123456');
    });

    it('新增的比例：預設值沿用原本顏色，其他輪色盤', () => {
        expect(tokenForValue(0.618, 9)).toBe('teal');
        expect(tokenForValue(1.618, 0)).toBe('grey');
        expect(tokenForValue(1.618, 1)).toBe('red');
    });
});

describe('驗證', () => {
    it('壞值退回預設、數值夾在範圍內；舊版數字陣列轉成比例清單', () => {
        const o = sanitizeFibOptions({
            bandOpacity: 9,
            fontSize: 'big',
            labelH: 'up',
            labelV: 'middle',
            levelFormat: 'percent',
            reverse: 1,
            levels: [{ value: 0.5, visible: false, color: 'red', token: 'pink' }, { value: 'x' }, { value: 0.5 }],
        });
        expect(o.bandOpacity).toBe(0.5);
        expect(o.fontSize).toBe(11);
        expect(o.labelH).toBe('left');
        expect(o.labelV).toBe('middle');
        expect(o.levelFormat).toBe('percent');
        expect(o.reverse).toBe(false);
        expect(o.levels).toEqual([{ value: 0.5, visible: false, token: 'green' }]);
        expect(sanitizeFibOptions(undefined, [1, 0, 2]).levels.map((l) => l.value)).toEqual([0, 1, 2]);
        expect(sanitizeFibOptions(null).levels).toHaveLength(7);
    });
});

describe('價格與標籤', () => {
    it('終點＝0、起點＝1；反轉相反', () => {
        expect(fibLevelPrice(48000, 48600, 0, false)).toBe(48600);
        expect(fibLevelPrice(48000, 48600, 1, false)).toBe(48000);
        expect(fibLevelPrice(48000, 48600, 0.5, false)).toBe(48300);
        expect(fibLevelPrice(48000, 48600, 0, true)).toBe(48000);
        expect(fibLevelPrice(48000, 48600, 0.25, true)).toBe(48150);
    });

    it('標籤文字：層級（數值／百分比）與價格各自可開關', () => {
        const fmt = (p: number) => p.toLocaleString('en-US');
        const base = { showLevel: true, levelFormat: 'value' as const, showPrice: true };
        expect(fibLabel(0.618, 48488, base, fmt)).toBe('0.618 (48,488)');
        expect(fibLabel(0.618, 48488, { ...base, levelFormat: 'percent' }, fmt)).toBe('61.8% (48,488)');
        expect(fibLabel(0.618, 48488, { ...base, showPrice: false }, fmt)).toBe('0.618');
        expect(fibLabel(0.618, 48488, { ...base, showLevel: false }, fmt)).toBe('48,488');
    });

    it('標籤位置：預設在回撤範圍左外側、線的上方；右側放在右錨點外；延伸時貼畫面內緣', () => {
        const o = defaultFibOptions();
        const x = { min: 300, max: 600 };
        expect(fibLabelPlacement(x, o, 800, 200, 11)).toEqual({ x: 296, y: 198, align: 'right', baseline: 'bottom' });
        expect(fibLabelPlacement(x, { ...o, labelH: 'right', labelV: 'bottom' }, 800, 200, 11)).toEqual({
            x: 604,
            y: 202,
            align: 'left',
            baseline: 'top',
        });
        expect(fibLabelPlacement(x, { ...o, labelV: 'middle' }, 800, 200, 11).baseline).toBe('middle');
        expect(fibLabelPlacement(x, { ...o, extendLeft: true }, 800, 200, 11)).toMatchObject({ x: 4, align: 'left' });
        expect(fibLabelPlacement(x, { ...o, labelH: 'right', extendRight: true }, 800, 200, 11)).toMatchObject({ x: 796, align: 'right' });
        // 左錨點貼近畫面左緣，外側放不下：改放範圍內側
        expect(fibLabelPlacement({ min: 5, max: 600 }, o, 800, 200, 11)).toMatchObject({ x: 9, align: 'left' });
    });
});
