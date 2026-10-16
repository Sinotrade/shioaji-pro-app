// src/lib/volume-ratio.test.ts：量比，今日累計成交量 ÷ 昨日全日成交量

import { describe, expect, it } from 'vitest';
import { fmtVolumeRatio, ratioSnapshotStale, volumeRatioOf, volumeRatioTitle } from './volume-ratio';

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

describe('ratioSnapshotStale', () => {
    it('即時成交的日期和快照的日期不同天就是過期（跨日開著、週末後盤前才開 App）', () => {
        expect(ratioSnapshotStale('2026/10/19', '2026-10-16T14:30:00')).toBe(true);
        expect(ratioSnapshotStale('2026-10-19', '2026-10-16T14:30:00')).toBe(true);
    });

    it('同一天不算過期，不管快照是幾點抓的', () => {
        expect(ratioSnapshotStale('2026/10/16', '2026-10-16T09:00:02')).toBe(false);
        expect(ratioSnapshotStale('2026-10-16', '2026-10-16T14:30:00')).toBe(false);
    });

    it('任一邊沒有日期（還沒有即時成交、快照缺時間）無從比較，不算過期', () => {
        expect(ratioSnapshotStale(undefined, '2026-10-16T14:30:00')).toBe(false);
        expect(ratioSnapshotStale('2026/10/19', undefined)).toBe(false);
        expect(ratioSnapshotStale('', 'not a date')).toBe(false);
    });
});

describe('volumeRatioTitle', () => {
    const formula = '量比 = 今日累計成交量 ÷ 前一交易日全日成交量';

    it('寫出算法與代入的數字', () => {
        expect(volumeRatioTitle(33389, 48032)).toBe(`${formula}
33,389 ÷ 48,032 = 0.70
1.00 代表已達前一交易日全日量`);
    });

    it('昨日量拿不到時說明原因', () => {
        expect(volumeRatioTitle(33389, undefined)).toBe(`${formula}
前一交易日成交量尚未取得`);
    });

    it('昨日量是 0 時寫「為 0，無法計算」，不寫成還沒取得（資料其實到了）', () => {
        expect(volumeRatioTitle(33389, 0)).toBe(`${formula}
前一交易日成交量為 0，無法計算`);
    });

    it('快照過期時寫「待更新」，不代入過期的數字', () => {
        expect(volumeRatioTitle(33389, 48032, true)).toBe(`${formula}
前一交易日成交量待更新`);
    });
});
