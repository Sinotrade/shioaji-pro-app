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

export function isTradingLimitsWindowError(message: string | null | undefined): boolean {
    return !!message
        && QCREDIT_QUERY_FAIL.test(message)
        && START_TIME.test(message)
        && END_TIME.test(message);
}
