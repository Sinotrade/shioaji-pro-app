// src/lib/index-close-quote.ts：收盤後的最後一筆指數報價，存在本機給重新整理、重開的 App 用。
// 漲跌家數只在即時 quote_idx 裡（快照沒有這些欄位），而伺服器不一定會補發已推過的報價，
// 收盤後才開的頁面就只剩「—」，所以把收盤那筆留下來

import { INDEX_CLOSE_TIME, tradingDate } from './index-volume';
import type { SseIndexQuote } from './types/market';

const KEY_PREFIX = 'sj-index-close:';

// 只存收盤後（13:33 最終那筆起）而且帶家數的報價：盤中的若留下來，盤中斷線重開時會把舊家數當成即時；
// 沒帶家數的那筆不能蓋掉先前存好的
export function rememberIndexClose(index: SseIndexQuote): void {
    if (index.time.slice(0, 8) < INDEX_CLOSE_TIME || index.raise_count === undefined) return;
    try {
        localStorage.setItem(KEY_PREFIX + index.code, JSON.stringify(index));
    } catch {
        // 儲存空間滿或被停用：只是少了盤後備援，不影響即時行情
    }
}

// 讀回和快照同一個交易日的收盤報價：價格看快照、家數看這筆，兩者要是同一天才放在一起
export function recalledIndexClose(code: string, snapshotDatetime: string | undefined): SseIndexQuote | undefined {
    const day = tradingDate(snapshotDatetime);
    if (!day) return undefined;
    try {
        const raw = localStorage.getItem(KEY_PREFIX + code);
        const saved = raw ? (JSON.parse(raw) as SseIndexQuote) : undefined;
        // 存檔是跨版本留下的本機資料，缺 time 的不用（看板會拿它切字串）
        return saved && typeof saved.time === 'string' && tradingDate(saved.date) === day ? saved : undefined;
    } catch {
        return undefined;
    }
}
