// src/lib/trading-limits-error.ts — tell the broker's "QCredit is only open
// inside its window" answer from a real failure (#381). Outside 08:30–15:00
// POST /portfolio/trading_limits is an HTTP 500 whose message names the window:
//   500 Query error: QCredit:Query fail{StartTime=83000, EndTime=150000}
// The window's numbers and the prefix may change, so neither is compared
// verbatim. All three parts are required: a bare "Query fail", or any QCredit
// failure without a window (session lost, timeout), must stay a real error.

const QCREDIT_QUERY_FAIL = /\bQCredit\s*:?\s*Query\s*fail\b/i;
const START_TIME = /\bStartTime\s*[=:]\s*\d+/i;
const END_TIME = /\bEndTime\s*[=:]\s*\d+/i;

// App 自己在送出當下發現已出時段、沒有送出查詢時用的訊息；視同時段錯誤
export const TRADING_LIMITS_NOT_SENT = '非交易時段，交易額度查詢未送出';

export function isTradingLimitsWindowError(message: string | null | undefined): boolean {
    if (message === TRADING_LIMITS_NOT_SENT) return true;
    return !!message
        && QCREDIT_QUERY_FAIL.test(message)
        && START_TIME.test(message)
        && END_TIME.test(message);
}

// 夜間／非服務時段券商主機（AS400）沒接上時，QCredit 與其他帳務查詢回：
//   500 Query error: QCredit:Query fail{no AS400Query Connection (RouteID=M|N, WebID=094, MachineID=H05)}
// 這是「券商服務目前未開放」，不是查詢真的失敗；只認 AS400 連線這個關鍵片段，
// 其他 QCredit 失敗（timeout、session 斷線）仍是真錯誤。
const NO_AS400_CONNECTION = /\bno\s+AS400\s*Query\s+Connection\b/i;

export function isBrokerServiceUnavailableError(message: string | null | undefined): boolean {
    return !!message && NO_AS400_CONNECTION.test(message);
}

/**
 * 券商帳務查詢錯誤分類：
 * - 'window'：明寫服務時段（StartTime/EndTime）→ 顯示「非交易時段」提示
 * - 'unavailable'：AS400 未連線 → 顯示「券商服務目前未開放」灰字
 * - null：真正的失敗，照常顯示錯誤與重試
 */
export type BrokerQueryErrorKind = 'window' | 'unavailable' | null;

export function classifyBrokerQueryError(message: string | null | undefined): BrokerQueryErrorKind {
    if (isTradingLimitsWindowError(message)) return 'window';
    if (isBrokerServiceUnavailableError(message)) return 'unavailable';
    return null;
}

// 交割行事曆、預收券款／圈存（不設時段閘門）的暫時性失敗：
// - HTTP 503（sw 之後可能把 TKAP01 暫時錯誤改成 503 並帶原訊息）
// - TKAP01 6044「無法取得交易狀態」（帶原訊息時）
// - 目前 6044 只以 HTTP 500、內容只有 "Internal Server Error" 送回 — 只認這個
//   「整段就是 500 Internal Server Error」的情形；帶其他訊息的 500 仍是真錯誤。
// 只給這幾個帳務查詢用：其他地方的裸 500 不能當成暫時性。
const HTTP_503 = /^503\b/;
// 裸 "500"：HTTP/2 或 Tauri 的回應可能沒有 statusText，throwApiError 只剩狀態碼
const BARE_500 = /^500(\s+Internal\s+Server\s+Error)?$/i;
// 6044 必須跟 TKAP01／錯誤碼欄位相鄰，避免帳號、數量等其他數字誤判
const TKAP01_NO_TRADE_STATUS = /無法取得交易狀態|\bTKAP01\D{0,8}6044\b|\berror_?code\W{0,4}6044\b/i;

export type AccountQueryErrorKind = BrokerQueryErrorKind | 'temporary';

export function classifyAccountQueryError(message: string | null | undefined): AccountQueryErrorKind {
    const broker = classifyBrokerQueryError(message);
    if (broker || !message) return broker;
    const m = message.trim();
    if (HTTP_503.test(m) || BARE_500.test(m) || TKAP01_NO_TRADE_STATUS.test(m)) return 'temporary';
    return null;
}
