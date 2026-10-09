// src/lib/conditional/session.test.ts — trading-session clock (#226).
import { describe, expect, it } from 'vitest';
import { dateEnd, dayEnd, fmtUntil, inSession, sessionEnd, taipeiInstant, tradingDayKey } from './session';

const tpe = (y: number, mo: number, d: number, h: number, mi = 0) => taipeiInstant(y, mo, d, h, mi);

describe('session clock', () => {
    // 2026-10-09 is a Friday
    it('trading day: from 15:00 on it is the next weekday', () => {
        expect(tradingDayKey(tpe(2026, 10, 8, 10))).toBe('2026-10-08');
        expect(tradingDayKey(tpe(2026, 10, 8, 15))).toBe('2026-10-09');
        expect(tradingDayKey(tpe(2026, 10, 9, 2))).toBe('2026-10-09');
        expect(tradingDayKey(tpe(2026, 10, 9, 20))).toBe('2026-10-12'); // Friday night → Monday
        expect(tradingDayKey(tpe(2026, 10, 10, 3))).toBe('2026-10-12'); // Saturday early → Monday
    });

    it('本盤 (futures): day session 13:45, night session 05:00 next day', () => {
        expect(sessionEnd(tpe(2026, 10, 8, 10), 'futures')).toBe(tpe(2026, 10, 8, 13, 45));
        expect(sessionEnd(tpe(2026, 10, 8, 16), 'futures')).toBe(tpe(2026, 10, 9, 5));
        expect(sessionEnd(tpe(2026, 10, 9, 2), 'futures')).toBe(tpe(2026, 10, 9, 5));
        expect(sessionEnd(tpe(2026, 10, 8, 14), 'futures')).toBe(tpe(2026, 10, 9, 5)); // between sessions
        expect(sessionEnd(tpe(2026, 10, 9, 21), 'futures')).toBe(tpe(2026, 10, 10, 5)); // Friday night
        expect(sessionEnd(tpe(2026, 10, 10, 12), 'futures')).toBe(tpe(2026, 10, 12, 13, 45)); // weekend → Monday
    });

    it('本盤 (stocks): 13:30, after the close the next weekday', () => {
        expect(sessionEnd(tpe(2026, 10, 8, 10), 'stock')).toBe(tpe(2026, 10, 8, 13, 30));
        expect(sessionEnd(tpe(2026, 10, 9, 14), 'stock')).toBe(tpe(2026, 10, 12, 13, 30));
    });

    it('今日: the trading day close (a night-session order lasts through the next day session)', () => {
        expect(dayEnd(tpe(2026, 10, 8, 10), 'futures')).toBe(tpe(2026, 10, 8, 13, 45));
        expect(dayEnd(tpe(2026, 10, 8, 20), 'futures')).toBe(tpe(2026, 10, 9, 13, 45));
        expect(dayEnd(tpe(2026, 10, 9, 20), 'futures')).toBe(tpe(2026, 10, 12, 13, 45));
        expect(dayEnd(tpe(2026, 10, 8, 14), 'futures')).toBe(tpe(2026, 10, 9, 13, 45));
        expect(dayEnd(tpe(2026, 10, 8, 9), 'stock')).toBe(tpe(2026, 10, 8, 13, 30));
    });

    it('指定日 and in-session', () => {
        expect(dateEnd('2026-10-15', 'futures')).toBe(tpe(2026, 10, 15, 13, 45));
        expect(dateEnd('bad', 'stock')).toBeNull();
        expect(inSession(tpe(2026, 10, 8, 10), 'futures')).toBe(true);
        expect(inSession(tpe(2026, 10, 8, 14), 'futures')).toBe(false);
        expect(inSession(tpe(2026, 10, 10, 3), 'futures')).toBe(true); // Friday night session
        expect(inSession(tpe(2026, 10, 12, 3), 'futures')).toBe(false); // no Sunday night session
        expect(inSession(tpe(2026, 10, 8, 13, 30), 'stock')).toBe(false);
    });

    it('fmtUntil: time today, date otherwise', () => {
        const now = tpe(2026, 10, 8, 10);
        expect(fmtUntil(tpe(2026, 10, 8, 13, 45), now)).toBe('13:45');
        expect(fmtUntil(tpe(2026, 10, 9, 5), now)).toBe('10/09 05:00');
    });
});
