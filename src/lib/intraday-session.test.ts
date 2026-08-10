// src/lib/intraday-session.test.ts

import { describe, expect, it } from 'vitest';
import {
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
