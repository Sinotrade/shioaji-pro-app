// src/lib/index-breadth.test.ts：指數漲跌家數比例

import { describe, expect, it } from 'vitest';
import { amountProgress, breadthOf, breadthTitle } from './index-breadth';

describe('breadthOf', () => {
    it('加總三類家數', () => {
        expect(breadthOf(803, 90, 161)).toEqual({ up: 803, flat: 90, down: 161, total: 1054 });
    });

    it('缺值、NaN、負數視為 0', () => {
        expect(breadthOf(undefined, Number.NaN, -3)).toEqual({ up: 0, flat: 0, down: 0, total: 0 });
    });
});

describe('breadthTitle', () => {
    it('列出各類家數與占比', () => {
        expect(breadthTitle(breadthOf(803, 90, 161))).toBe(
            '上漲 803（76.2%）　平盤 90（8.5%）　下跌 161（15.3%）',
        );
    });

    it('沒有家數資料時回傳空字串，不顯示 tooltip', () => {
        expect(breadthTitle(breadthOf(undefined, undefined, undefined))).toBe('');
    });
});

describe('amountProgress', () => {
    it('成交金額除以預估金額', () => {
        expect(amountProgress(5668.1, 8965.7)).toBeCloseTo(0.632, 3);
    });

    it('超過預估時上限為 1，負值下限為 0', () => {
        expect(amountProgress(9000, 8000)).toBe(1);
        expect(amountProgress(-1, 8000)).toBe(0);
    });

    it('預估缺值、為 0 或資料不是有限數時回傳 undefined', () => {
        expect(amountProgress(100, undefined)).toBeUndefined();
        expect(amountProgress(100, 0)).toBeUndefined();
        expect(amountProgress(undefined, 100)).toBeUndefined();
        expect(amountProgress(Number.NaN, 100)).toBeUndefined();
    });
});
