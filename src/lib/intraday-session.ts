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

// 收盤定盤可能印在收盤後幾分鐘（指數定盤 13:31–33）— 這段內的
// kbar/tick 都併進該時段最後一根 label
export const CLOSE_GRACE = 240;

// 有夜盤的商品（期貨/選擇權）才有「日盤/夜盤」與「全盤/僅日盤」之分
export function hasNightSession(secType: SecurityType): boolean {
    return secType === 'FUT' || secType === 'OPT';
}

// 日盤 08:45–16:15 的期/選（匯率、黃金、原油等）— 用 underlying_kind
// （E=匯率、C=商品）判斷，舊合約快取沒帶時退回商品代碼
const LONG_DAY_ROOTS = new Set([
    'RHF', 'RTF', 'XJF', 'XEF', 'XAF', 'XBF', // 匯率期貨
    'RHO', 'RTO', // 匯率選擇權
    'GDF', 'TGF', 'TGO', // 黃金期貨/選擇權
    'BRF', // 布蘭特原油期貨
]);

export interface SessionContractLike {
    security_type: SecurityType;
    underlying_kind?: string;
    root?: string;
    category?: string;
}

// 「日盤/夜盤」手動切換與 K 線「僅日盤」只開給日盤 08:45–13:45 的
// 期/選（指數、個股類）— 日盤較長的商品用 13:45 截斷會丟掉下午的
// K 棒，寧可不給切換
export function supportsSessionSplit(c: SessionContractLike): boolean {
    if (!hasNightSession(c.security_type)) return false;
    const kind = c.underlying_kind?.toUpperCase();
    if (kind === 'E' || kind === 'C') return false;
    const root = (c.root || c.category || '').toUpperCase();
    return !LONG_DAY_ROOTS.has(root);
}

// 1 分 K label（minute-end）是否屬於日盤：期/選 08:45–13:45、其他
// 09:00–13:30，label 區間 (start, end + CLOSE_GRACE]（收盤定盤併入）
export function isDaySessionLabel(secType: SecurityType, label: number): boolean {
    const w = sessionWindowFor(secType, label);
    if (!w.night && label > w.start && label <= w.end) return true;
    // 期貨 13:45 後的 label 在 sessionWindowFor 已歸夜盤框架 — 退回
    // grace 前的時點判斷是否仍屬剛收的日盤
    const p = sessionWindowFor(secType, label - CLOSE_GRACE);
    return !p.night && label > p.end && label <= p.end + CLOSE_GRACE;
}

// 即時成交時間 τ 是否屬於日盤 — 先換成 close-label-right 的 1 分 K
// label（08:45:00 的開盤撮合 → 08:46），再用 K 棒同一套判斷，
// 歷史與 live 才不會一邊收、一邊丟
export function isDaySessionTick(secType: SecurityType, t: number): boolean {
    return isDaySessionLabel(secType, Math.floor(t / 60) * 60 + 60);
}

// K 線「僅日盤」：aggregate 前把夜盤與盤外的 1 分 K 濾掉
export function filterDaySession<T extends { time: number }>(
    secType: SecurityType,
    bars: T[],
): T[] {
    return bars.filter((b) => isDaySessionLabel(secType, b.time));
}

// 當日走勢的時段選擇：auto = 依資料所在（原行為）；day/night =
// 使用者手動鎖定，取「有資料的最近一段」該種時段（晚上複盤今天日盤）
export type IntradaySessionMode = 'auto' | 'day' | 'night';
export type ChartSessionMode = 'all' | 'day';

// 存檔讀回的時段值只接受已知值，其餘（舊版/手改/壞檔）退回預設
export function parseIntradaySessionMode(
    v: unknown,
): IntradaySessionMode | undefined {
    return v === 'auto' || v === 'day' || v === 'night' ? v : undefined;
}

export function parseChartSessionMode(v: unknown): ChartSessionMode | undefined {
    return v === 'all' || v === 'day' ? v : undefined;
}

// 商品日盤時間字串（按鈕說明用，不寫死）
export function daySessionLabel(secType: SecurityType): string {
    // 取任一交易日 10:00 的日盤框架
    const w = sessionWindowFor(secType, 10 * H);
    const hm = (t: number) => {
        const tod = ((t % DAY) + DAY) % DAY;
        return `${String(Math.floor(tod / H)).padStart(2, '0')}:${String(
            Math.floor((tod % H) / 60),
        ).padStart(2, '0')}`;
    };
    return `${hm(w.start)}–${hm(w.end)}`;
}

// 最近一段（含進行中/即將開始）指定種類的時段框架 — 手動模式下
// 完全沒有該種時段資料時，用它開空框架
function latestWindowOfKind(
    secType: SecurityType,
    night: boolean,
    now: number,
): SessionWindow {
    const cur = sessionWindowFor(secType, now);
    const d0 = Math.floor(now / DAY) * DAY;
    const tod = now - d0;
    let win =
        cur.night === night
            ? cur
            : night
              ? // 日盤時段 → 前一晚開始的夜盤（凌晨已收的那段）
                sessionWindowFor(secType, d0 + H)
              : // 夜盤時段：15:00 後 → 今天日盤；凌晨 → 昨天日盤
                sessionWindowFor(
                    secType,
                    (tod <= 5 * H ? d0 - DAY : d0) + 9 * H,
                );
    // 週六、週日開始的時段不存在（週六日盤、週六/週日夜盤）— 往前退到
    // 週五那段。國定假日無從得知，由呼叫端標日期提示
    for (let i = 0; i < 3 && isWeekendStart(win); i++) {
        win = sessionWindowFor(secType, win.start - DAY + 60);
    }
    return win;
}

function isWeekendStart(win: SessionWindow): boolean {
    const wd = new Date(win.start * 1000).getUTCDay(); // 牆鐘編碼 → 台灣星期
    return wd === 0 || wd === 6;
}

// 依模式挑出要畫的時段。times = 已排序的 1 分 K label；pendStart =
// 換時段重載帶來的目標時段起點（試搓/開盤，新時段 kbar 還沒出，0 = 無）
export function pickIntradayWindow(
    secType: SecurityType,
    times: number[],
    mode: IntradaySessionMode,
    now: number,
    pendStart = 0,
): SessionWindow {
    const last = times[times.length - 1];
    if (mode === 'auto' || !hasNightSession(secType)) {
        let win = sessionWindowFor(
            secType,
            last !== undefined ? last : pendStart > 0 ? pendStart + 60 : now,
        );
        if (pendStart > win.start) {
            win = sessionWindowFor(secType, pendStart + 60);
        }
        return win;
    }
    const night = mode === 'night';
    let win: SessionWindow | null = null;
    for (let i = times.length - 1; i >= 0; i--) {
        const t = times[i]!;
        const w = sessionWindowFor(secType, t);
        if (w.night === night && t > w.start && t <= w.end + CLOSE_GRACE) {
            win = w;
            break;
        }
    }
    // 換到同種新時段（例如鎖日盤、隔天 08:30 試搓）才跟上；目標是
    // 另一種時段就不理
    if (pendStart > 0) {
        const p = sessionWindowFor(secType, pendStart + 60);
        if (p.night === night && (!win || p.start > win.start)) win = p;
    }
    return win ?? latestWindowOfKind(secType, night, now);
}

// live 進到另一段時段時要不要跟過去重載：自動一律跟；手動鎖定只跟
// 同種時段（鎖日盤看複盤時，夜盤 tick 不能把圖切走）
export function followsSession(
    mode: IntradaySessionMode,
    next: SessionWindow,
): boolean {
    return mode === 'auto' || next.night === (mode === 'night');
}

// 回顧已結束的時段時（晚上鎖日盤），合約快取的參考價/漲跌停屬於
// 現在的時段，不能拿來畫。期/選日盤與夜盤的參考價都是「前一個日盤
// 的結算價」— 以已抓歷史中 win.start 之前最後一根日盤 K 的收盤近似；
// 找不到回 null（呼叫端退回合約參考價）
export function pastSessionReference(
    secType: SecurityType,
    bars: { time: number; close: number }[],
    win: SessionWindow,
): number | null {
    for (let i = bars.length - 1; i >= 0; i--) {
        const b = bars[i]!;
        if (b.time > win.start) continue;
        if (isDaySessionLabel(secType, b.time) && b.close > 0) return b.close;
    }
    return null;
}

// 顯示的時段是否不是「現在（或即將開始）的時段」
export function isPastSession(
    secType: SecurityType,
    win: SessionWindow,
    now: number,
): boolean {
    const cur = sessionWindowFor(secType, now);
    if (win.start === cur.start) return false;
    // 13:45 收盤到 15:00 夜盤開盤之間，剛收的日盤仍是「今天的時段」
    // （合約參考價/漲跌停仍屬於它）
    if (
        !win.night &&
        cur.night &&
        now > win.end &&
        now <= cur.start &&
        cur.start - win.end < 2 * H
    ) {
        return false;
    }
    return true;
}

// 手動鎖定的時段是否要當「回顧」處理（參考價近似、不畫停板）。
// 與「自動」會選的時段相同時（例如假日：自動與鎖夜盤都顯示昨晚那段）
// 合約參考價/停板就是屬於它的 — 照自動用官方值，不改近似
export function isReviewingPastSession(
    secType: SecurityType,
    mode: IntradaySessionMode,
    win: SessionWindow,
    times: number[],
    now: number,
    pendStart = 0,
): boolean {
    if (mode === 'auto') return false;
    const autoWin = pickIntradayWindow(secType, times, 'auto', now, pendStart);
    if (autoWin.start === win.start) return false;
    return isPastSession(secType, win, now);
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
