// src/lib/utils/date.test.ts — todayStr 必須是台灣日期，不隨本機時區

import { afterEach, describe, expect, it, vi } from 'vitest';
import { todayStr } from './date';
import { dateStrOffset } from './kbars';

describe('todayStr', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('is the Taiwan date while the machine is still on the previous day', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        // 台北 09-25 09:30 ＝ 洛杉磯 09-24 18:30 ＝ UTC 09-25 01:30
        vi.setSystemTime(new Date('2026-09-25T01:30:00Z'));
        expect(todayStr()).toBe('2026-09-25');
        // 台北 09-25 01:30 ＝ UTC 09-24 17:30（UTC 機器仍是 09-24）
        vi.setSystemTime(new Date('2026-09-24T17:30:00Z'));
        expect(todayStr()).toBe('2026-09-25');
    });

    it('agrees with dateStrOffset(0) used for the chart/tick ranges', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-25T15:59:59Z')); // 台北 23:59:59
        expect(todayStr()).toBe(dateStrOffset(0));
        expect(todayStr()).toBe('2026-09-25');
        vi.setSystemTime(new Date('2026-09-25T16:00:00Z')); // 台北隔天 00:00
        expect(todayStr()).toBe('2026-09-26');
    });
});
