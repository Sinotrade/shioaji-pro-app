// src/lib/tw-query-window.ts — 台股帳務查詢的券商服務時段閘門。
// 正式環境的 QCredit（交易額度）查詢只在交易日 08:30–15:00 有服務；時段外
// 送出只會拿到 500（StartTime/EndTime 或 no AS400Query Connection），畫面也
// 只能顯示誤導的錯誤，所以時段外不送，等時段開始再自動查。
//
// 時間一律以台北時間（UTC+8、無日光節約）計算，與本機時區無關。
// 交易日只排除週六日：repo 裡沒有台股休市日曆（conditional/session.ts、
// settle-date.ts 同樣只看週末），國定假日當天仍會在時段內送出查詢，
// 券商回的時段／AS400 錯誤由 trading-limits-error.ts 轉成灰字提示。

const TW_OFFSET_MS = 8 * 3600_000;
const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

export interface TwQueryWindow {
    /** 開始（台北時間，當日 00:00 起算的分鐘，含） */
    startMin: number;
    /** 結束（台北時間分鐘，不含）：15:00 整已關閉 */
    endMin: number;
}

/** 交易日 08:30–15:00（QCredit 回的 StartTime=83000, EndTime=150000） */
export const TW_BROKER_DAY_WINDOW: TwQueryWindow = { startMin: 8 * 60 + 30, endMin: 15 * 60 };

/** 交易額度（QCredit）：券商時段錯誤明寫 08:30–15:00 */
export const TRADING_LIMITS_WINDOW: TwQueryWindow = TW_BROKER_DAY_WINDOW;
// 交割行事曆、預收券款／圈存在正式環境沒有服務時段（sw 隨時轉給 TKAP01），不設閘門；
// 它們的暫時性失敗由 trading-limits-error.ts 的 classifyAccountQueryError 處理。

export function windowLabel(w: TwQueryWindow): string {
    const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    return `交易日 ${hm(w.startMin)}–${hm(w.endMin)}`;
}

export interface TwQueryWindowState {
    open: boolean;
    /** 時段內為該交易日的台北日期 YYYY-MM-DD（當快取鍵：每個交易日重查一次），時段外為 null */
    sessionDate: string | null;
    /** 下一次開／關的 epoch ms */
    nextChangeMs: number;
}

const isWeekday = (wd: number) => wd !== 0 && wd !== 6;

export function twQueryWindowState(nowMs: number, w: TwQueryWindow): TwQueryWindowState {
    const wall = nowMs + TW_OFFSET_MS;
    const dayStartWall = Math.floor(wall / DAY_MS) * DAY_MS;
    const dayStartUtc = dayStartWall - TW_OFFSET_MS; // 台北當日 00:00 的 epoch ms
    const weekday = new Date(dayStartWall).getUTCDay();
    const openAt = dayStartUtc + w.startMin * MIN_MS;
    const closeAt = dayStartUtc + w.endMin * MIN_MS;
    if (isWeekday(weekday) && nowMs >= openAt && nowMs < closeAt) {
        return { open: true, sessionDate: new Date(dayStartWall).toISOString().slice(0, 10), nextChangeMs: closeAt };
    }
    // 下一個交易日開盤：今天還沒開就是今天，否則往後找第一個平日
    let next = isWeekday(weekday) && nowMs < openAt ? openAt : openAt + DAY_MS;
    while (!isWeekday(new Date(next + TW_OFFSET_MS).getUTCDay())) next += DAY_MS;
    return { open: false, sessionDate: null, nextChangeMs: next };
}
