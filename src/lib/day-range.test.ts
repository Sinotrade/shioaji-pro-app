// src/lib/day-range.test.ts：個股看板的日內區間軌，尺度、位置、刻度、提示文字

import { describe, expect, it } from 'vitest';
import {
    dayRangeOf,
    dirVsOpen,
    INDEX_FUTURE_SCALES,
    railCellsRem,
    railChars,
    railEndPcts,
    railPos,
    railScale,
    railTicks,
    railTitle,
    type DayRange,
} from './day-range';

// 台指期近月（2026-10-16 夜盤實際數字）：今天只在 ±0.2% 內，漲跌停 ±10%
const TXF: DayRange = {
    reference: 47284,
    limitUp: 52012,
    limitDown: 42556,
    open: 47269,
    high: 47380,
    low: 47214,
    close: 47289,
};
const STK = { reference: 2440, limitUp: 2680, limitDown: 2200 };

describe('dayRangeOf', () => {
    it('數值齊全且合理時組出區間', () => {
        expect(dayRangeOf(TXF)).toEqual(TXF);
    });

    it('任一值缺席、不是有限數或 <= 0 時回傳 undefined（不畫軌，維持數字欄）', () => {
        expect(dayRangeOf({ ...TXF, open: undefined })).toBeUndefined();
        expect(dayRangeOf({ ...TXF, high: Number.NaN })).toBeUndefined();
        expect(dayRangeOf({ ...TXF, low: 0 })).toBeUndefined();
        expect(dayRangeOf({ ...TXF, reference: undefined })).toBeUndefined();
    });

    it('漲跌停不合理（跌停 >= 參考價、漲停 <= 參考價）或最低高於最高時回傳 undefined', () => {
        expect(dayRangeOf({ ...TXF, limitDown: 47284 })).toBeUndefined();
        expect(dayRangeOf({ ...TXF, limitUp: 47000 })).toBeUndefined();
        expect(dayRangeOf({ ...TXF, low: 47400, high: 47380 })).toBeUndefined();
    });
});

describe('railScale', () => {
    it('平常日用最小的 ±1%（台指期只動 0.2%，尺畫到漲跌停的話軌道幾乎是空的）', () => {
        expect(railScale(TXF)).toBe(1);
    });

    it('今天最大偏離要落在尺的 92% 以內，超過就換下一級', () => {
        expect(railScale({ ...STK, open: 2440, high: 2440 * 1.0091, low: 2440, close: 2440 })).toBe(1);
        expect(railScale({ ...STK, open: 2440, high: 2440 * 1.0093, low: 2440, close: 2440 })).toBe(2);
        expect(railScale({ ...STK, open: 2440, high: 2440 * 1.025, low: 2440, close: 2440 })).toBe(3);
        // 大跌 -4.4%（最低偏離最大）→ ±5%
        expect(railScale({ ...STK, open: 2400, high: 2410, low: 2333, close: 2350 })).toBe(5);
        expect(railScale({ ...STK, open: 2440, high: 2440, low: 2440 * 0.94, close: 2440 })).toBe(7);
        expect(railScale({ ...STK, open: 2440, high: 2440, low: 2440 * 0.935, close: 2440 })).toBeNull();
    });

    it('接近停板幅度（大漲 8%）或碰到漲跌停時用到漲跌停（回傳 null）', () => {
        expect(railScale({ ...STK, open: 2490, high: 2645, low: 2475, close: 2610 })).toBeNull();
        expect(railScale({ ...STK, open: 2500, high: 2680, low: 2490, close: 2680 })).toBeNull();
    });

    it('尺不能比停板幅度寬：停板只有 ±1.5% 時只試 ±1%', () => {
        const narrow = { reference: 1000, limitUp: 1015, limitDown: 985 };
        expect(railScale({ ...narrow, open: 1000, high: 1005, low: 998, close: 1003 })).toBe(1);
        expect(railScale({ ...narrow, open: 1000, high: 1012, low: 998, close: 1010 })).toBeNull();
    });
});

describe('railPos', () => {
    it('參考價在正中間；有尺時線性，超出尺就貼在兩端', () => {
        expect(railPos(2440, { ...STK, open: 0, high: 0, low: 0, close: 0 }, 1)).toBe(0.5);
        const r = { ...STK, open: 0, high: 0, low: 0, close: 0 };
        expect(railPos(2440 * 1.01, r, 1)).toBeCloseTo(1, 10);
        expect(railPos(2440 * 0.995, r, 1)).toBeCloseTo(0.25, 10);
        expect(railPos(2440 * 1.05, r, 1)).toBe(1);
        expect(railPos(2440 * 0.9, r, 2)).toBe(0);
    });

    it('沒有尺（用到漲跌停）時兩側各自線性對到漲跌停', () => {
        const r = { reference: 100, limitUp: 110, limitDown: 95, open: 0, high: 0, low: 0, close: 0 };
        expect(railPos(110, r, null)).toBe(1);
        expect(railPos(95, r, null)).toBe(0);
        expect(railPos(105, r, null)).toBe(0.75);
        expect(railPos(97.5, r, null)).toBe(0.25);
    });
});

describe('railTicks', () => {
    it('±1% 的尺每 0.5% 一格，其餘每 1% 一格，不畫參考價本身', () => {
        expect(railTicks(TXF, 1).map((p) => +(((p / TXF.reference) - 1) * 100).toFixed(4))).toEqual([-0.5, 0.5]);
        expect(railTicks(TXF, 3).map((p) => +(((p / TXF.reference) - 1) * 100).toFixed(4))).toEqual([-2, -1, 1, 2]);
    });

    it('用到漲跌停時標 ±1%、±5%（停板幅度內的才畫）', () => {
        const pcts = (r: DayRange) => railTicks(r, null).map((p) => +(((p / r.reference) - 1) * 100).toFixed(4));
        expect(pcts(TXF)).toEqual([-5, -1, 1, 5]);
        expect(pcts({ ...TXF, limitUp: 47284 * 1.03, limitDown: 47284 * 0.97 })).toEqual([-1, 1]);
    });
});

describe('指數期的尺（使用者指定：平常振幅約 ±1%，從 ±2.5% 起跳，大行情才放大）', () => {
    it('台指期平常日用 ±2.5%；最大偏離超過 2.3% 換 ±5%，再超過換 ±7.5%', () => {
        expect(railScale(TXF, INDEX_FUTURE_SCALES)).toBe(2.5);
        expect(railScale({ ...TXF, low: 47284 * 0.976 }, INDEX_FUTURE_SCALES)).toBe(5);
        expect(railScale({ ...TXF, low: 47284 * 0.95 }, INDEX_FUTURE_SCALES)).toBe(7.5);
        expect(railScale({ ...TXF, low: 47284 * 0.93 }, INDEX_FUTURE_SCALES)).toBeNull();
    });

    it('±2.5% 的刻度落在格線上（±1、±2），不會出現 ±1.5', () => {
        const pcts = railTicks(TXF, 2.5).map((p) => +(((p / TXF.reference) - 1) * 100).toFixed(4));
        expect(pcts).toEqual([-2, -1, 1, 2]);
    });
});

describe('railEndPcts', () => {
    it('有尺時兩端是尺的半寬，用到漲跌停時是兩側停板幅度（整數）', () => {
        expect(railEndPcts(TXF, 1)).toEqual([1, 1]);
        expect(railEndPcts(TXF, 2.5)).toEqual([2.5, 2.5]);
        expect(railEndPcts(TXF, null)).toEqual([10, 10]);
        expect(railEndPcts({ ...TXF, reference: 100, limitUp: 110, limitDown: 95 }, null)).toEqual([5, 10]);
    });
});

describe('dirVsOpen', () => {
    it('高、低跟開盤價比：高於開盤是漲、低於是跌、相等或缺值不上色', () => {
        expect(dirVsOpen(47380, 47269)).toBe('up');
        expect(dirVsOpen(47214, 47269)).toBe('down');
        expect(dirVsOpen(59.9, 59.9)).toBeNull();
        expect(dirVsOpen(undefined, 59.9)).toBeNull();
        expect(dirVsOpen(60, Number.NaN)).toBeNull();
    });
});

describe('railTitle', () => {
    const fmt = (v: number) => v.toLocaleString('en-US');

    it('第一行開高低與平盤價（數字列收起時的退路），第二行看板上沒有的資訊與尺度，第三行說明粗細兩段', () => {
        expect(railTitle(TXF, 1, fmt)).toBe(
            '開 47,269｜高 47,380（+0.20%）｜低 47,214（-0.15%）｜平盤 47,284（幅度對平盤）\n' +
                '較開盤 +0.04%（陽線）｜距漲停 +9.99%｜距跌停 -10.01%｜刻度 ±1%，每格 0.5%\n' +
                '粗：開到現價｜細：最低到最高',
        );
    });

    it('尺度：±2% 以上每格 1%，用到漲跌停時註明', () => {
        expect(railTitle(TXF, 5, fmt)).toContain('｜刻度 ±5%，每格 1%');
        expect(railTitle(TXF, null, fmt)).toContain('｜刻度到漲跌停');
    });

    it('現價低於開盤是陰線，等於開盤是十字線', () => {
        expect(railTitle({ ...TXF, close: 47200 }, 1, fmt)).toContain('（陰線）');
        expect(railTitle({ ...TXF, close: 47269 }, 1, fmt)).toContain('較開盤 0.00%（十字線）');
    });

    it('指數期提示補足窄版收起的距低、距高點數；刻度到停板時維持停板幅度', () => {
        const title = railTitle(TXF, 2.5, fmt, 'distance', value => value.toFixed(1));
        expect(title).toContain('距低 75.0 點｜距高 91.0 點');
        expect(title).not.toContain('距漲停');
        expect(railTitle(TXF, null, fmt, 'distance')).toContain('距漲停');
        expect(railTitle(TXF, null, fmt, 'distance')).toContain('距低');
    });
});

describe('railMid、railLow 數字列的寬度門檻', () => {
    it('字數取低、開、高最長的那個，限制在 3 到 10 字', () => {
        expect(railChars(['2,420', '2,430', '2,445'])).toBe(5);
        expect(railChars(['99.95', '100.00', '99.80'])).toBe(6);
        // 500 到 999 元的個股跳動 1 元，價格只有 3 字
        expect(railChars(['650', '655', '648'])).toBe(3);
        expect(railChars(['55', '56', '55'])).toBe(3);
        expect(railChars(['123,456,789.5', '1', '1'])).toBe(10);
    });

    it('門檻＝格寬加格距再留 0.25rem；格寬與實測相同（5 字 3.08rem、6 字 3.512rem）', () => {
        expect(railCellsRem(1, 5) - 0.25).toBeCloseTo(3.08, 6);
        expect(railCellsRem(1, 6) - 0.25).toBeCloseTo(3.512, 6);
        expect(railCellsRem(3, 5)).toBeCloseTo(3 * 3.08 + 2 * 0.9 + 0.25, 6);
        expect(railCellsRem(2, 8)).toBeCloseTo(2 * 4.376 + 0.9 + 0.25, 6);
    });

    it('字數越少門檻越低：短價格在放得下時不會被收掉', () => {
        expect(railCellsRem(3, 5)).toBeLessThan(railCellsRem(3, 8));
        expect(railCellsRem(2, 5)).toBeLessThan(railCellsRem(2, 8));
    });
});
