// src/lib/volume-ratio.test.ts — 量比：今日累計成交量 ÷ 昨日全日成交量

import { describe, expect, it } from 'vitest';
import { fmtVolumeRatio, volumeRatioOf, volumeRatioTitle } from './volume-ratio';

describe('volumeRatioOf', () => {
    it('今日量除以昨日量', () => {
        expect(volumeRatioOf(33389, 48032)).toBeCloseTo(0.6951, 4);
        expect(volumeRatioOf(60000, 48000)).toBe(1.25);
    });

    it('今日還沒成交時是 0', () => {
        expect(volumeRatioOf(0, 48000)).toBe(0);
    });

    it('缺值、昨日量為 0 或不是有限數時回傳 undefined', () => {
        expect(volumeRatioOf(undefined, 48000)).toBeUndefined();
        expect(volumeRatioOf(100, undefined)).toBeUndefined();
        expect(volumeRatioOf(100, 0)).toBeUndefined();
        expect(volumeRatioOf(Number.NaN, 48000)).toBeUndefined();
    });
});

describe('fmtVolumeRatio', () => {
    it('兩位小數；沒有值顯示空值符號', () => {
        expect(fmtVolumeRatio(0.6951)).toBe('0.70');
        expect(fmtVolumeRatio(1.25)).toBe('1.25');
        expect(fmtVolumeRatio(undefined)).toBe('—');
    });
});

describe('volumeRatioTitle', () => {
    it('寫出算法與代入的數字', () => {
        expect(volumeRatioTitle(33389, 48032)).toBe('量比 = 今日成交量 ÷ 昨日成交量\n33,389 ÷ 48,032 = 0.70');
    });

    it('昨日量拿不到時說明原因', () => {
        expect(volumeRatioTitle(33389, undefined)).toBe('量比 = 今日成交量 ÷ 昨日成交量\n昨日成交量尚未取得');
        expect(volumeRatioTitle(33389, 0)).toBe('量比 = 今日成交量 ÷ 昨日成交量\n昨日成交量尚未取得');
    });
});
