// src/lib/conditional/session.ts — trading-session clock for conditional
// orders (#226): which trading day a moment belongs to and when 本盤／今日／
// 指定日 validity ends. Asia/Taipei wall clock, independent of the machine's
// time zone. Exchange holidays are not known here: a validity that ends on a
// holiday simply ends then (nothing is sent outside a session anyway).
//
// Futures / options: day session 08:45–13:45, night session 15:00–05:00 (the
// night session belongs to the NEXT trading day). Stocks: 09:00–13:30.

export type SessionMarket = 'stock' | 'futures';

const TPE_OFFSET_MS = 8 * 3600_000;
const DAY_MS = 24 * 3600_000;

/** Taipei wall-clock fields of an instant. */
export function taipeiParts(ms: number): { y: number; mo: number; d: number; h: number; mi: number; dow: number } {
    const t = new Date(ms + TPE_OFFSET_MS);
    return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), dow: t.getUTCDay() };
}

/** The instant of Taipei `y-mo-d hh:mm`. */
export function taipeiInstant(y: number, mo: number, d: number, h: number, mi: number): number {
    return Date.UTC(y, mo - 1, d, h, mi) - TPE_OFFSET_MS;
}

const pad = (n: number) => String(n).padStart(2, '0');

function dateKey(ms: number): string {
    const p = taipeiParts(ms);
    return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

/** Midnight (Taipei) of the calendar day of `ms`, moved forward to a weekday. */
function weekdayStart(ms: number): number {
    let p = taipeiParts(ms);
    let start = taipeiInstant(p.y, p.mo, p.d, 0, 0);
    while (p.dow === 0 || p.dow === 6) {
        start += DAY_MS;
        p = taipeiParts(start);
    }
    return start;
}

/** Trading day (YYYY-MM-DD) of an instant: from 15:00 on it is the next
 * weekday's (futures night session); weekends roll to Monday. */
export function tradingDayKey(ms: number): string {
    const p = taipeiParts(ms);
    const base = p.h >= 15 ? taipeiInstant(p.y, p.mo, p.d, 0, 0) + DAY_MS : taipeiInstant(p.y, p.mo, p.d, 0, 0);
    return dateKey(weekdayStart(base));
}

export function sameTradingDay(a: number, b: number): boolean {
    return tradingDayKey(a) === tradingDayKey(b);
}

const minutes = (p: { h: number; mi: number }) => p.h * 60 + p.mi;
const DAY_CLOSE_FUT = 13 * 60 + 45;
const DAY_OPEN_FUT = 8 * 60 + 45;
const NIGHT_OPEN = 15 * 60;
const NIGHT_CLOSE = 5 * 60;
const STOCK_CLOSE = 13 * 60 + 30;

function at(dayStart: number, minute: number): number {
    return dayStart + minute * 60_000;
}

/** Close of the trading day `key` (YYYY-MM-DD). */
function closeOfDay(key: string, market: SessionMarket): number {
    const [y, mo, d] = key.split('-').map(Number) as [number, number, number];
    return at(taipeiInstant(y, mo, d, 0, 0), market === 'futures' ? DAY_CLOSE_FUT : STOCK_CLOSE);
}

/** 本盤: end of the session `ms` is in, or of the next one when between
 * sessions. */
export function sessionEnd(ms: number, market: SessionMarket): number {
    const p = taipeiParts(ms);
    const today = taipeiInstant(p.y, p.mo, p.d, 0, 0);
    const m = minutes(p);
    if (market === 'stock') {
        if (m < STOCK_CLOSE && p.dow !== 0 && p.dow !== 6) return at(today, STOCK_CLOSE);
        return closeOfDay(dateKey(weekdayStart(today + DAY_MS)), 'stock');
    }
    if (m < NIGHT_CLOSE) return at(today, NIGHT_CLOSE); // night session after midnight
    if (m < DAY_CLOSE_FUT && p.dow !== 0 && p.dow !== 6) return at(today, DAY_CLOSE_FUT);
    // 13:45 onwards (or a weekend): the coming night session ends 05:00 next day
    if (p.dow === 6 || p.dow === 0) return closeOfDay(dateKey(weekdayStart(today)), 'futures');
    return at(today + DAY_MS, NIGHT_CLOSE);
}

/** 今日: close of the trading day `ms` belongs to (futures: 13:45 of that
 * day, so a night-session order stays valid through the next day session). */
export function dayEnd(ms: number, market: SessionMarket): number {
    if (market === 'stock') {
        const p = taipeiParts(ms);
        const today = taipeiInstant(p.y, p.mo, p.d, 0, 0);
        if (minutes(p) < STOCK_CLOSE && p.dow !== 0 && p.dow !== 6) return at(today, STOCK_CLOSE);
        return closeOfDay(dateKey(weekdayStart(today + DAY_MS)), 'stock');
    }
    const key = tradingDayKey(ms);
    const close = closeOfDay(key, 'futures');
    return close > ms ? close : closeOfDay(tradingDayKey(close + 2 * 3600_000), 'futures');
}

/** 指定日: close of that calendar day (YYYY-MM-DD). */
export function dateEnd(date: string, market: SessionMarket): number | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!m) return null;
    return closeOfDay(`${m[1]}-${m[2]}-${m[3]}`, market);
}

/** Whether `ms` is inside a regular trading session (no holiday calendar). */
export function inSession(ms: number, market: SessionMarket): boolean {
    const p = taipeiParts(ms);
    const m = minutes(p);
    const weekday = p.dow !== 0 && p.dow !== 6;
    if (market === 'stock') return weekday && m >= 9 * 60 && m < STOCK_CLOSE;
    if (weekday && m >= DAY_OPEN_FUT && m < DAY_CLOSE_FUT) return true;
    if (weekday && m >= NIGHT_OPEN) return true;
    // after midnight: the night session that started the previous weekday
    return m < NIGHT_CLOSE && p.dow !== 0 && p.dow !== 1;
}

/** `13:45`, or `10/03 13:45` when not on the trading day of `now`. */
export function fmtUntil(until: number, now = Date.now()): string {
    const p = taipeiParts(until);
    const time = `${pad(p.h)}:${pad(p.mi)}`;
    return dateKey(until) === dateKey(now) ? time : `${pad(p.mo)}/${pad(p.d)} ${time}`;
}

/** `09:01:12` (Taipei). */
export function fmtClock(ms: number): string {
    const p = taipeiParts(ms);
    const s = new Date(ms + TPE_OFFSET_MS).getUTCSeconds();
    return `${pad(p.h)}:${pad(p.mi)}:${pad(s)}`;
}

/** `47,900` / `203.5` — a price or distance without padded decimals. */
export function fmtNum(v: number): string {
    return Number.isFinite(v) ? v.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '—';
}
