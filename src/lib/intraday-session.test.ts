// src/lib/intraday-session.test.ts

import { describe, expect, it } from 'vitest';
import {
    filterDaySession,
    findKbarGap,
    followsSession,
    hasNightSession,
    isDaySessionLabel,
    isDaySessionTick,
    pickIntradayWindow,
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

describe('day-session filter (K 線「僅日盤」)', () => {
    it('only futures/options have a night session to filter', () => {
        expect(hasNightSession('FUT')).toBe(true);
        expect(hasNightSession('OPT')).toBe(true);
        expect(hasNightSession('STK')).toBe(false);
        expect(hasNightSession('IND')).toBe(false);
    });

    it('futures day labels run (08:45, 13:45] plus the close grace', () => {
        const day = (s: string) => isDaySessionLabel('FUT', t(s));
        expect(day('2026-08-07T08:45:00')).toBe(false); // pre-open
        expect(day('2026-08-07T08:46:00')).toBe(true); // first bar
        expect(day('2026-08-07T13:45:00')).toBe(true); // last bar
        expect(day('2026-08-07T13:49:00')).toBe(true); // 定盤 grace
        expect(day('2026-08-07T13:50:00')).toBe(false);
        expect(day('2026-08-07T15:01:00')).toBe(false); // night open
        expect(day('2026-08-08T00:00:00')).toBe(false); // across midnight
        expect(day('2026-08-08T05:00:00')).toBe(false); // night close
    });

    it('stock day labels run (09:00, 13:30]', () => {
        const day = (s: string) => isDaySessionLabel('STK', t(s));
        expect(day('2026-08-07T08:46:00')).toBe(false); // futures-only minute
        expect(day('2026-08-07T09:00:00')).toBe(false);
        expect(day('2026-08-07T09:01:00')).toBe(true);
        expect(day('2026-08-07T13:30:00')).toBe(true);
        expect(day('2026-08-07T14:30:00')).toBe(false); // 盤後定價
    });

    it('filters a mixed futures series down to the day session', () => {
        const bars = [
            '2026-08-06T15:01:00',
            '2026-08-07T04:59:00',
            '2026-08-07T08:46:00',
            '2026-08-07T13:45:00',
            '2026-08-07T15:01:00',
        ].map((s) => ({ time: t(s), close: 1 }));
        expect(filterDaySession('FUT', bars).map((b) => b.time)).toEqual([
            t('2026-08-07T08:46:00'),
            t('2026-08-07T13:45:00'),
        ]);
    });

    it('live ticks use the same minute-end label as the bars', () => {
        const tick = (s: string) => isDaySessionTick('FUT', t(s));
        expect(tick('2026-08-07T08:44:59')).toBe(false); // 試撮
        expect(tick('2026-08-07T08:45:00')).toBe(true); // opening match
        expect(tick('2026-08-07T13:44:59')).toBe(true);
        expect(tick('2026-08-07T13:45:00')).toBe(true); // closing print
        expect(tick('2026-08-07T15:00:00')).toBe(false); // night tick ignored
        expect(tick('2026-08-07T21:30:12')).toBe(false);
        expect(isDaySessionTick('STK', t('2026-08-07T08:59:59'))).toBe(false);
        expect(isDaySessionTick('STK', t('2026-08-07T09:00:00'))).toBe(true);
    });
});

describe('pickIntradayWindow (日盤/夜盤手動切換)', () => {
    // Fri 08-07 day session + that evening's night session (still trading)
    const times = [
        '2026-08-07T08:46:00',
        '2026-08-07T13:45:00',
        '2026-08-07T15:01:00',
        '2026-08-07T20:00:00',
    ].map(t);
    const now = t('2026-08-07T20:00:30');

    it('auto follows the data (evening → night session)', () => {
        const win = pickIntradayWindow('FUT', times, 'auto', now);
        expect(win.night).toBe(true);
        expect(win.start).toBe(t('2026-08-07T15:00:00'));
    });

    it('manual 日盤 in the evening shows today’s day session', () => {
        const win = pickIntradayWindow('FUT', times, 'day', now);
        expect(win.night).toBe(false);
        expect(win.start).toBe(t('2026-08-07T08:45:00'));
        expect(win.end).toBe(t('2026-08-07T13:45:00'));
    });

    it('manual 夜盤 during the day shows last night’s session', () => {
        const dayTimes = [
            '2026-08-06T15:01:00',
            '2026-08-07T04:59:00',
            '2026-08-07T08:46:00',
            '2026-08-07T10:00:00',
        ].map(t);
        const win = pickIntradayWindow(
            'FUT',
            dayTimes,
            'night',
            t('2026-08-07T10:00:30'),
        );
        expect(win.night).toBe(true);
        expect(win.start).toBe(t('2026-08-06T15:00:00'));
    });

    it('manual mode without data of that kind falls back to the latest frame', () => {
        const dayOnly = [t('2026-08-07T08:46:00'), t('2026-08-07T13:45:00')];
        const night = pickIntradayWindow(
            'FUT',
            dayOnly,
            'night',
            t('2026-08-07T11:00:00'),
        );
        expect(night.start).toBe(t('2026-08-06T15:00:00'));
        const day = pickIntradayWindow(
            'FUT',
            [],
            'day',
            t('2026-08-08T02:00:00'),
        );
        expect(day.start).toBe(t('2026-08-07T08:45:00'));
    });

    it('a pending switch only applies when it matches the locked kind', () => {
        // locked 日盤, next-morning 試撮 announces the new day session
        const nextDay = t('2026-08-10T08:45:00');
        expect(
            pickIntradayWindow('FUT', times, 'day', now, nextDay).start,
        ).toBe(nextDay);
        // locked 日盤, a pending night switch is ignored
        const nightPend = t('2026-08-07T15:00:00');
        expect(
            pickIntradayWindow('FUT', times, 'day', now, nightPend).start,
        ).toBe(t('2026-08-07T08:45:00'));
    });

    it('stocks ignore the manual mode', () => {
        const stk = [t('2026-08-07T09:01:00'), t('2026-08-07T13:30:00')];
        const win = pickIntradayWindow('STK', stk, 'night', now);
        expect(win.night).toBe(false);
        expect(win.start).toBe(t('2026-08-07T09:00:00'));
    });

    it('live session switches are followed only for the locked kind', () => {
        const nightWin = pickIntradayWindow('FUT', times, 'auto', now);
        const dayWin = pickIntradayWindow('FUT', times, 'day', now);
        expect(followsSession('auto', nightWin)).toBe(true);
        expect(followsSession('day', nightWin)).toBe(false);
        expect(followsSession('day', dayWin)).toBe(true);
        expect(followsSession('night', dayWin)).toBe(false);
    });
});
