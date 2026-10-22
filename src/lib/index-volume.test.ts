// src/lib/index-volume.test.ts：指數預估金額相對前一交易日（+22%／-17%）

import { describe, expect, it } from 'vitest';
import {
    PREVIOUS_SESSION_LOOKBACK_DAYS,
    fullDayAmount,
    isTransientError,
    previousSessionAmount,
    retryAfter,
    sessionDateOf,
    shiftDate,
    tradingDate,
    volumeChangeOf,
} from './index-volume';

// 形狀取自 /api/v1/data/kbars 加權指數實際回應：datetime 為台灣牆鐘 YYYY-MM-DDTHH:MM:SS，
// Amount 單位為元；收盤後 13:31 起仍有棒
const kbars = {
    datetime: [
        '2026-10-14T09:01:00',
        '2026-10-14T09:02:00',
        '2026-10-15T09:01:00',
        '2026-10-15T09:02:00',
        '2026-10-15T13:34:00',
        '2026-10-16T09:01:00',
    ],
    Amount: [100, 200, 79_746_644_240, 20_239_448_670, 5, 999],
};

describe('previousSessionAmount', () => {
    it('取早於今天的最近一個交易日，只加總那一天（含收盤後的棒），不含今天與更早的日子', () => {
        expect(previousSessionAmount(kbars, '2026-10-16')).toBe(
            79_746_644_240 + 20_239_448_670 + 5,
        );
    });

    it('週末、補假讓前一交易日隔了好幾天（今天是週一），取最近有資料的那天', () => {
        expect(previousSessionAmount(kbars, '2026-10-19')).toBe(999);
    });

    it('沒有早於今天的資料時回傳 undefined', () => {
        expect(previousSessionAmount(kbars, '2026-10-14')).toBeUndefined();
        expect(previousSessionAmount({ datetime: [], Amount: [] }, '2026-10-16')).toBeUndefined();
    });

    it('前一交易日金額全是 0 或缺值時回傳 undefined', () => {
        expect(
            previousSessionAmount(
                { datetime: ['2026-10-15T09:01:00'], Amount: [0] },
                '2026-10-16',
            ),
        ).toBeUndefined();
    });
});

describe('volumeChangeOf', () => {
    it('預估高於前一交易日顯示 +%', () => {
        expect(volumeChangeOf(1220, 1000)).toBe('+22%');
    });

    it('預估低於前一交易日顯示 -%', () => {
        expect(volumeChangeOf(830, 1000)).toBe('-17%');
    });

    it('四捨五入後為 0% 顯示 0%，略低於持平（四捨五入出 -0）也不會顯示 -0%', () => {
        expect(volumeChangeOf(1004, 1000)).toBe('0%');
        expect(volumeChangeOf(996, 1000)).toBe('0%');
    });

    it('任一邊缺值、為 0 或不是有限數時回傳 undefined', () => {
        expect(volumeChangeOf(undefined, 1000)).toBeUndefined();
        expect(volumeChangeOf(1000, undefined)).toBeUndefined();
        expect(volumeChangeOf(0, 1000)).toBeUndefined();
        expect(volumeChangeOf(1000, 0)).toBeUndefined();
        expect(volumeChangeOf(Number.NaN, 1000)).toBeUndefined();
    });
});

describe('fullDayAmount：收盤後用實際量補預估量', () => {
    const at = (time: string | undefined, date = '2026-10-19') => ({ date, time });

    it('有預估量就用預估量，不是實際量', () => {
        expect(fullDayAmount(9_292e8, 6_441e8, at('11:36:10'), '2026-10-19')).toEqual({ value: 9_292e8, actual: false });
        expect(fullDayAmount(9_292e8, 8_251e8, at('13:33:00'), '2026-10-19')).toEqual({ value: 9_292e8, actual: false });
    });

    it('收盤後（13:33 最終那筆起）沒有預估量，拿全日成交金額當實際量', () => {
        for (const estimate of [undefined, 0, Number.NaN]) {
            expect(fullDayAmount(estimate, 8_251e8, at('13:33:00'), '2026-10-19')).toEqual({ value: 8_251e8, actual: true });
        }
        expect(fullDayAmount(undefined, 8_251e8, at('13:33:00.000000'), '2026-10-19').actual).toBe(true);
    });

    it('13:25 到 13:33 之間不算：收盤集合競價的成交要到 13:33 那筆才含進金額（實測 13:30 那筆少約 470 億）', () => {
        expect(fullDayAmount(undefined, 7_113e8, at('13:30:00'), '2026-10-19').value).toBeUndefined();
        expect(fullDayAmount(undefined, 7_113e8, at('13:32:59'), '2026-10-19').value).toBeUndefined();
        expect(fullDayAmount(undefined, 7_587e8, at('13:33:00'), '2026-10-19').actual).toBe(true);
    });

    it('盤前與盤中沒有預估量不補，累計一半的金額不拿去比昨日', () => {
        expect(fullDayAmount(undefined, 6_441e8, at('11:36:10'), '2026-10-19')).toEqual({ value: undefined, actual: false });
        expect(fullDayAmount(undefined, 6_441e8, at('13:29:59'), '2026-10-19').value).toBeUndefined();
        expect(fullDayAmount(undefined, 6_441e8, at(undefined), '2026-10-19').value).toBeUndefined();
    });

    it('金額的交易日等於基準日才算：週五收盤那筆配週五基準（週末開著或重開）算收盤', () => {
        expect(fullDayAmount(undefined, 8_251e8, at('13:33:00', '2026-10-16'), '2026-10-16').actual).toBe(true);
        expect(fullDayAmount(undefined, 8_251e8, at('13:33:00', '2026-10-16T13:33:00'), '2026-10-16').actual).toBe(true);
    });

    it('今天的報價配上前一交易日的快照金額不算，免得拿昨天比昨天；盤中的快照也不算', () => {
        expect(fullDayAmount(undefined, 8_251e8, at('13:33:00', '2026-10-16T13:33:00'), '2026-10-19').value).toBeUndefined();
        expect(fullDayAmount(undefined, 6_441e8, at('11:00:00', '2026-10-19T11:00:00'), '2026-10-19').value).toBeUndefined();
    });

    it('金額缺值、0、NaN 時不補', () => {
        for (const amount of [undefined, 0, Number.NaN]) {
            expect(fullDayAmount(undefined, amount, at('13:33:00'), '2026-10-19').value).toBeUndefined();
        }
    });
});

describe('tradingDate', () => {
    it('各種日期格式正規化成 YYYY-MM-DD', () => {
        expect(tradingDate('2026/10/16')).toBe('2026-10-16');
        expect(tradingDate('2026-10-16')).toBe('2026-10-16');
        expect(tradingDate('20261016')).toBe('2026-10-16');
        expect(tradingDate('2026-10-16T13:30:00')).toBe('2026-10-16');
    });

    it('缺值或看不懂時回傳 undefined（呼叫端退回電腦日期）', () => {
        expect(tradingDate(undefined)).toBeUndefined();
        expect(tradingDate('')).toBeUndefined();
        expect(tradingDate('n/a')).toBeUndefined();
    });
});

describe('shiftDate', () => {
    it('跨月、跨年、閏年都正確', () => {
        expect(shiftDate('2026-10-16', -1)).toBe('2026-10-15');
        expect(shiftDate('2026-10-01', -1)).toBe('2026-09-30');
        expect(shiftDate('2026-01-03', -7)).toBe('2025-12-27');
        expect(shiftDate('2028-03-01', -1)).toBe('2028-02-29');
    });
});

describe('sessionDateOf：比較的基準交易日', () => {
    it('報價日期落後電腦時鐘（App 跨午夜或整個週末開著）時以報價日期為準', () => {
        expect(sessionDateOf('2026-10-16', '2026-10-17')).toBe('2026-10-16');
        expect(sessionDateOf('2026/10/16', '2026-10-19')).toBe('2026-10-16');
    });

    it('兩者相同時就是當天', () => {
        expect(sessionDateOf('2026-10-16', '2026-10-16')).toBe('2026-10-16');
    });

    it('沒有報價日期（尚未收到 quote_idx）時退回電腦日期', () => {
        expect(sessionDateOf(undefined, '2026-10-16')).toBe('2026-10-16');
        expect(sessionDateOf('', '2026-10-16')).toBe('2026-10-16');
    });
});

describe('前一交易日挑選：以基準交易日往前找', () => {
    it('基準是週五時挑週四（週六還開著 App 也不會變成週五自己比週五）', () => {
        const k = {
            datetime: ['2026-10-15T09:01:00', '2026-10-16T09:01:00'],
            Amount: [1000, 1300],
        };
        // 報價日期是週五 10-16，電腦時鐘已是週六 10-17
        const session = sessionDateOf('2026-10-16', '2026-10-17');
        expect(previousSessionAmount(k, session)).toBe(1000);
    });
});

describe('PREVIOUS_SESSION_LOOKBACK_DAYS', () => {
    it('涵蓋春節封關到開紅盤的最長間隔（約 13 天），開紅盤當天仍抓得到前一交易日', () => {
        // 2025 年封關 1/22、開紅盤 2/3，相隔 12 天
        const reopen = '2025-02-03';
        const from = shiftDate(reopen, -PREVIOUS_SESSION_LOOKBACK_DAYS);
        expect(from <= '2025-01-22').toBe(true);
        const bars = { datetime: ['2025-01-22T09:01:00', '2025-01-22T13:30:00'], Amount: [10, 20] };
        expect(previousSessionAmount(bars, reopen)).toBe(30);
    });
});

describe('retryAfter', () => {
    const noWait = async () => {};

    it('第一次就成功時不等待、只執行一次', async () => {
        const waits: number[] = [];
        let calls = 0;
        const value = await retryAfter(
            async () => ++calls,
            [30, 60],
            async (ms) => {
                waits.push(ms);
            },
        );
        expect(value).toBe(1);
        expect(waits).toEqual([]);
    });

    it('失敗後依序等 delays 再試，成功就回傳結果', async () => {
        const waits: number[] = [];
        let calls = 0;
        const value = await retryAfter(
            async () => {
                if (++calls < 3) throw new Error('boom');
                return 'ok';
            },
            [30, 60, 120],
            async (ms) => {
                waits.push(ms);
            },
        );
        expect(value).toBe('ok');
        expect(calls).toBe(3);
        expect(waits).toEqual([30, 60]);
    });

    it('全部重試都失敗時，最後一次的錯誤丟給呼叫端（共 delays 長度加 1 次嘗試）', async () => {
        let calls = 0;
        await expect(
            retryAfter(
                async () => {
                    throw new Error(`fail ${++calls}`);
                },
                [1, 2, 3],
                noWait,
            ),
        ).rejects.toThrow('fail 4');
        expect(calls).toBe(4);
    });

    it('shouldRetry 回傳 false 的錯誤立刻丟出，不等待也不再試', async () => {
        const waits: number[] = [];
        let calls = 0;
        await expect(
            retryAfter(
                async () => {
                    calls++;
                    throw Object.assign(new Error('422 bad range'), { status: 422 });
                },
                [1, 2, 3],
                async (ms) => {
                    waits.push(ms);
                },
                isTransientError,
            ),
        ).rejects.toThrow('422 bad range');
        expect(calls).toBe(1);
        expect(waits).toEqual([]);
    });
});

describe('isTransientError', () => {
    it('逾時、斷線（沒有數字 status）與 5xx、429 會重試，其他 4xx 不重試', () => {
        expect(isTransientError(new Error('timeout'))).toBe(true);
        expect(isTransientError(null)).toBe(true);
        expect(isTransientError(Object.assign(new Error('503'), { status: 503 }))).toBe(true);
        expect(isTransientError(Object.assign(new Error('429'), { status: 429 }))).toBe(true);
        for (const status of [400, 401, 403, 404, 422]) {
            expect(isTransientError(Object.assign(new Error(String(status)), { status }))).toBe(false);
        }
    });
});
