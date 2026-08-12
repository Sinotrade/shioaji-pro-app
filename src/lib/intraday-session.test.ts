// src/lib/intraday-session.test.ts

import { describe, expect, it } from 'vitest';
import {
    findKbarGap,
    sessionMinutes,
    sessionWindowFor,
    tickBucket,
} from './intraday-session';
import { wallClockToUtc } from './utils/kbars';

const t = (s: string) => wallClockToUtc(s);

describe('sessionWindowFor', () => {
    it('stock bars map to the 09:00–13:30 window of their day', () => {
        const win = sessionWindowFor('STK', t('2026-08-07T10:31:00'));
        expect(win.start).toBe(t('2026-08-07T09:00:00'));
        expect(win.end).toBe(t('2026-08-07T13:30:00'));
        expect(win.night).toBe(false);
    });

    it('stock closing-auction label 13:30 stays in the same window', () => {
        const win = sessionWindowFor('STK', t('2026-08-07T13:30:00'));
        expect(win.end).toBe(t('2026-08-07T13:30:00'));
    });

    it('futures day-session bar → 08:45–13:45 window', () => {
        const win = sessionWindowFor('FUT', t('2026-08-07T08:46:00'));
        expect(win.start).toBe(t('2026-08-07T08:45:00'));
        expect(win.end).toBe(t('2026-08-07T13:45:00'));
        expect(win.night).toBe(false);
    });

    it('futures pre-open 試撮 time maps to the upcoming day session', () => {
        const win = sessionWindowFor('FUT', t('2026-08-07T08:30:00'));
        expect(win.start).toBe(t('2026-08-07T08:45:00'));
    });

    it('futures evening bar → night session ending 05:00 next day', () => {
        const win = sessionWindowFor('FUT', t('2026-08-07T15:01:00'));
        expect(win.start).toBe(t('2026-08-07T15:00:00'));
        expect(win.end).toBe(t('2026-08-08T05:00:00'));
        expect(win.night).toBe(true);
    });

    it('futures small-hours bar belongs to the previous evening session', () => {
        const win = sessionWindowFor('FUT', t('2026-08-08T01:30:00'));
        expect(win.start).toBe(t('2026-08-07T15:00:00'));
        expect(win.end).toBe(t('2026-08-08T05:00:00'));
        expect(win.night).toBe(true);
    });

    it('night session boundary 05:00 exactly closes the night window', () => {
        const win = sessionWindowFor('FUT', t('2026-08-08T05:00:00'));
        expect(win.start).toBe(t('2026-08-07T15:00:00'));
        expect(win.night).toBe(true);
    });
});

describe('sessionMinutes', () => {
    it('stock session has 270 one-minute labels 09:01…13:30', () => {
        const win = sessionWindowFor('STK', t('2026-08-07T10:00:00'));
        const mins = sessionMinutes(win);
        expect(mins).toHaveLength(270);
        expect(mins[0]).toBe(t('2026-08-07T09:01:00'));
        expect(mins[mins.length - 1]).toBe(t('2026-08-07T13:30:00'));
    });

    it('futures day session has 300 labels', () => {
        const win = sessionWindowFor('FUT', t('2026-08-07T09:00:00'));
        expect(sessionMinutes(win)).toHaveLength(300);
    });

    it('futures night session spans midnight with 840 labels', () => {
        const win = sessionWindowFor('FUT', t('2026-08-07T20:00:00'));
        expect(sessionMinutes(win)).toHaveLength(840);
    });
});

describe('tickBucket', () => {
    const win = sessionWindowFor('STK', t('2026-08-07T10:00:00'));

    it('mid-minute tick rounds up to its minute-end label', () => {
        expect(tickBucket(win, t('2026-08-07T10:00:30'))).toBe(
            t('2026-08-07T10:01:00'),
        );
    });

    it('exact minute boundary keeps its own label', () => {
        expect(tickBucket(win, t('2026-08-07T10:01:00'))).toBe(
            t('2026-08-07T10:01:00'),
        );
    });

    it('opening print 09:00:00 lands on the first label 09:01', () => {
        expect(tickBucket(win, t('2026-08-07T09:00:00'))).toBe(
            t('2026-08-07T09:01:00'),
        );
    });

    it('late prints clamp to the closing label', () => {
        expect(tickBucket(win, t('2026-08-07T13:31:10'))).toBe(
            t('2026-08-07T13:30:00'),
        );
    });
});

describe('findKbarGap', () => {
    // helper: 1-min labels (minute-end) covering (from, to]
    const mins = (from: string, to: string) => {
        const out: number[] = [];
        for (let m = t(from) + 60; m <= t(to); m += 60) out.push(m);
        return out;
    };

    it('non-continuous products (stocks) are never flagged', () => {
        expect(findKbarGap([], 'STK', t('2026-08-12T08:50:00'))).toBeNull();
    });

    it('issue #18: night stops at 23:55, checked pre-open → tail gap', () => {
        // 週一夜盤 15:00 起，跨午夜段 00:00–05:00 上游未發布
        const bars = [
            ...mins('2026-08-11T08:45:00', '2026-08-11T13:45:00'),
            ...mins('2026-08-11T15:00:00', '2026-08-11T23:55:00'),
        ];
        const gap = findKbarGap(bars, 'FUT', t('2026-08-12T08:30:00'));
        expect(gap).toMatch(/^tail/);
    });

    it('complete night session (ends 05:00) → no gap', () => {
        const bars = [
            ...mins('2026-08-11T15:00:00', '2026-08-12T05:00:00'),
        ];
        expect(
            findKbarGap(bars, 'FUT', t('2026-08-12T08:30:00')),
        ).toBeNull();
    });

    it('Monday morning after weekend (no Sunday night) → no gap', () => {
        // 週五夜盤完整結束於週六 05:00；週一早上檢查不能誤判
        const bars = [
            ...mins('2026-08-07T15:00:00', '2026-08-08T05:00:00'),
        ];
        expect(
            findKbarGap(bars, 'FUT', t('2026-08-10T08:30:00')),
        ).toBeNull();
    });

    it('restart mid-morning missing the 08:46-08:50 head → head gap', () => {
        const bars = [
            ...mins('2026-08-11T15:00:00', '2026-08-12T05:00:00'),
            ...mins('2026-08-12T08:50:00', '2026-08-12T08:52:00'),
        ];
        const gap = findKbarGap(bars, 'FUT', t('2026-08-12T08:53:00'));
        expect(gap).toMatch(/^head/);
    });

    it('no day bars at all 5 min after open → head gap', () => {
        const bars = [
            ...mins('2026-08-11T15:00:00', '2026-08-12T05:00:00'),
        ];
        const gap = findKbarGap(bars, 'FUT', t('2026-08-12T08:51:00'));
        expect(gap).toMatch(/^head/);
    });

    it('normal 1-2 min publish lag at the live edge → no gap', () => {
        const bars = [
            ...mins('2026-08-12T08:45:00', '2026-08-12T10:28:00'),
        ];
        expect(
            findKbarGap(bars, 'FUT', t('2026-08-12T10:30:00')),
        ).toBeNull();
    });

    it('interior hole inside one session (sleep/disconnect) → gap', () => {
        const bars = [
            ...mins('2026-08-11T15:00:00', '2026-08-11T20:00:00'),
            ...mins('2026-08-11T23:00:00', '2026-08-12T05:00:00'),
        ];
        const gap = findKbarGap(bars, 'FUT', t('2026-08-12T08:30:00'));
        expect(gap).toMatch(/^interior/);
    });

    it('cross-session gaps (close→open) are not holes', () => {
        const bars = [
            ...mins('2026-08-11T08:45:00', '2026-08-11T13:45:00'),
            ...mins('2026-08-11T15:00:00', '2026-08-12T05:00:00'),
            ...mins('2026-08-12T08:45:00', '2026-08-12T09:30:00'),
        ];
        expect(
            findKbarGap(bars, 'FUT', t('2026-08-12T09:31:00')),
        ).toBeNull();
    });

    it('stale ended-window tail (>6h ago) is ignored', () => {
        // 夜盤缺尾但已是晚上 — 別再為早上的事重抓
        const bars = [
            ...mins('2026-08-11T15:00:00', '2026-08-11T23:55:00'),
            ...mins('2026-08-12T08:45:00', '2026-08-12T13:45:00'),
        ];
        expect(
            findKbarGap(bars, 'FUT', t('2026-08-12T20:00:00')),
        ).toBeNull();
    });
});

describe('findKbarGap density gate', () => {
    // 稀疏商品：遠月個股期/深價外選擇權 — 每 10-40 分鐘才一根
    it('sparse far-month FUT quiet spells are not holes', () => {
        const bars: number[] = [];
        // 日盤 08:46 起每 25 分鐘一根，最後一根 11:00 — 到 13:45 的
        // 「尾端缺口」與內部間隔都不能觸發
        for (
            let m = t('2026-08-12T08:46:00');
            m <= t('2026-08-12T11:00:00');
            m += 25 * 60
        ) {
            bars.push(m);
        }
        expect(
            findKbarGap(bars, 'FUT', t('2026-08-12T13:40:00')),
        ).toBeNull();
    });

    it('dense session with a real interior hole still flags', () => {
        // 密度扣掉最大洞後 ≈1 — 真洞不能被自己豁免
        const dense = (from: string, to: string) => {
            const out: number[] = [];
            for (let m = t(from) + 60; m <= t(to); m += 60) out.push(m);
            return out;
        };
        const bars = [
            ...dense('2026-08-11T15:00:00', '2026-08-11T20:00:00'),
            ...dense('2026-08-11T23:00:00', '2026-08-12T05:00:00'),
        ];
        expect(findKbarGap(bars, 'FUT', t('2026-08-12T08:30:00'))).toMatch(
            /^interior/,
        );
    });

    it('IND with normal 09:01 first bar at 09:06 → no head gap', () => {
        const bars: number[] = [];
        for (
            let m = t('2026-08-12T09:01:00');
            m <= t('2026-08-12T09:04:00');
            m += 60
        ) {
            bars.push(m);
        }
        expect(
            findKbarGap(bars, 'IND', t('2026-08-12T09:06:00')),
        ).toBeNull();
    });
});
