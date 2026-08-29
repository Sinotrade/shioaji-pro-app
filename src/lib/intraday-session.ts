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

// K 線歷史缺口偵測（issue #18）— 上游 kbars 晚發布時，載入的歷史會缺
//  a) 已結束夜盤的跨午夜尾段：00:00–05:00 掛在新日曆日，開盤前抓不到
//  b) 進行中時段的頭部：開盤頭幾根 K 晚出（重啟後缺 08:45）
//  c) 同時段內部的大洞（睡醒/斷線期間上游缺段）
// 回傳缺口描述（null = 完整，呼叫端據此排程重抓）。只看連續成交的
// 商品（期/選/指數）— 冷門股沒成交就沒 kbar，gap 天生正常不能當洞。
// 假日/週末「整段夜盤不存在」與正常收盤間隔都是跨時段 gap，不誤判。
export function findKbarGap(
    times: number[],
    secType: SecurityType,
    now: number,
): string | null {
    if (secType !== 'FUT' && secType !== 'OPT' && secType !== 'IND') {
        return null;
    }
    const HEAD_TOL = 240; // 開盤頭部容忍（發布延遲 1–2 分鐘屬正常）
    const INNER_TOL = 1800; // 內部/尾端洞門檻
    const DENSITY_MIN = 0.8; // 稀疏時段（遠月/深價外）不信任 gap
    const lookback = now - 36 * 3600;

    // 依時段分組，記每段的首尾/根數/最大內部 gap
    interface Grp {
        win: SessionWindow;
        first: number;
        last: number;
        count: number;
        maxGap: number;
        gapAt: number;
    }
    const groups: Grp[] = [];
    let cur: Grp | null = null;
    for (const t of times) {
        if (t < lookback) continue;
        const w = sessionWindowFor(secType, t);
        if (!cur || cur.win.start !== w.start) {
            if (cur) groups.push(cur);
            cur = { win: w, first: t, last: t, count: 1, maxGap: 0, gapAt: 0 };
        } else {
            if (t - cur.last > cur.maxGap) {
                cur.maxGap = t - cur.last;
                cur.gapAt = cur.last;
            }
            cur.count++;
            cur.last = t;
        }
    }
    if (cur) groups.push(cur);

    // 密度 = 根數 /（首尾跨距扣掉最大洞的分鐘數）— 連續成交的商品
    // ≈1；洞本身不拉低密度（否則真洞會自我豁免），稀疏商品到處是
    // gap、扣一個洞仍遠低於門檻 → 不誤判
    const density = (g: Grp) => {
        const spanMin =
            (g.last - g.first) / 60 +
            1 -
            (g.maxGap > 60 ? g.maxGap / 60 - 1 : 0);
        return spanMin <= 0 ? 1 : g.count / spanMin;
    };

    for (const g of groups) {
        if (density(g) < DENSITY_MIN) continue;
        // c) 同時段內部大洞（睡醒/斷線期間上游缺段）
        if (g.maxGap > INNER_TOL) {
            return `interior ${g.gapAt}->${g.gapAt + g.maxGap}`;
        }
        // a) 已結束時段的尾端缺口（夜盤停在 23:55，00:00–05:00 未發布）
        if (
            g.win.end < now - 120 &&
            now - g.win.end < 6 * 3600 &&
            g.win.end - g.last > INNER_TOL
        ) {
            return `tail ${g.last}<${g.win.end}`;
        }
    }

    // b) 進行中時段的頭部：開盤已過 HEAD_TOL 卻沒有頭幾根
    const curWin = sessionWindowFor(secType, now);
    if (
        now > curWin.start + 60 + HEAD_TOL &&
        now < curWin.start + 3 * 3600
    ) {
        const first = times.find((t) => t > curWin.start);
        const expectedFirst = curWin.start + 60;
        if (first === undefined || first - expectedFirst > HEAD_TOL) {
            return `head ${first ?? 'none'}>${expectedFirst}`;
        }
    }
    return null;
}
