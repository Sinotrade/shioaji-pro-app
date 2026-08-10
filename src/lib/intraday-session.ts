// src/lib/intraday-session.ts — trading-session windows for the 當日走勢
// (intraday) chart. All times are Taiwan wall-clock encoded as UTC seconds
// (see utils/kbars.wallClockToUtc). 1-minute kbar labels mark minute END,
// so a session's bar labels run (start, end] — e.g. TXF day session
// 08:45–13:45 yields labels 08:46 … 13:45.

import type { SecurityType } from './types/contract';

export interface SessionWindow {
    start: number; // session open — exclusive in bar-label space
    end: number; // session close — the last bar label, inclusive
    night: boolean;
}

const H = 3600;
const DAY = 86400;

// The window containing (or, for pre-open 試撮 times, about to contain) a
// bar/tick timestamp. Futures & options: day 08:45–13:45, night 15:00 to
// next-day 05:00. Everything else (stocks, warrants, indices): 09:00–13:30.
export function sessionWindowFor(
    secType: SecurityType,
    t: number,
): SessionWindow {
    const d0 = Math.floor(t / DAY) * DAY;
    const tod = t - d0;
    if (secType === 'FUT' || secType === 'OPT') {
        if (tod <= 5 * H) {
            return { start: d0 - DAY + 15 * H, end: d0 + 5 * H, night: true };
        }
        // 05:00–13:45 → that day's day session (incl. 08:30 試撮 window)
        if (tod <= 13.75 * H) {
            return { start: d0 + 8.75 * H, end: d0 + 13.75 * H, night: false };
        }
        return { start: d0 + 15 * H, end: d0 + DAY + 5 * H, night: true };
    }
    return { start: d0 + 9 * H, end: d0 + 13.5 * H, night: false };
}

// every 1-minute bar-label time of a session, for whitespace axis fill
export function sessionMinutes(win: SessionWindow): number[] {
    const out: number[] = [];
    for (let m = win.start + 60; m <= win.end; m += 60) out.push(m);
    return out;
}

// minute-end label bucket for a tick timestamp, clamped into the window
// (opening-auction prints land on the first label, closing prints on the
// last instead of spilling past the session edge)
export function tickBucket(win: SessionWindow, t: number): number {
    const label = Math.ceil(t / 60) * 60;
    return Math.min(Math.max(label, win.start + 60), win.end);
}
