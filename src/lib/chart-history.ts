import { getApiBase } from './runtime';
import { fetchKbars } from './shioaji';
import type { ContractBase } from './types/contract';
import type { Candle, KBars } from './types/market';
import { fetchUsKbars } from './us/us-history';

let revision = 0;
// Shared across mounted charts: a manual refresh must not reuse another
// panel's earlier local counter value and return its old cached history.
export const nextChartHistoryRevision = () => ++revision;

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * 美股 1 分 K（紐約牆鐘當 UTC 的 K 棒結束時間）→ 台股 kbars 的欄位形狀，
 * K 線、走勢面板就能用同一套 kbarsToCandles／wallClockToUtc 畫美股。
 * 美股 kbars 沒有成交金額：用 (高+低+收)/3 × 量 近似（只給走勢均價線用）。
 */
export function usCandlesToKbars(bars: readonly Candle[]): KBars {
    const out: KBars = { datetime: [], Open: [], High: [], Low: [], Close: [], Volume: [], Amount: [] };
    for (const b of bars) {
        const d = new Date(b.time * 1000);
        out.datetime.push(
            `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
        );
        out.Open.push(b.open);
        out.High.push(b.high);
        out.Low.push(b.low);
        out.Close.push(b.close);
        out.Volume.push(b.volume);
        out.Amount.push(((b.high + b.low + b.close) / 3) * b.volume);
    }
    return out;
}

/** 依 region 取 1 分 K：台股 /data/kbars；美股走 us-history（一次最多 30 天，自動分段） */
function fetchMinuteKbars(contract: ContractBase, start: string, end: string, opts?: { timeoutMs?: number }): Promise<KBars> {
    if (contract.region === 'US') return fetchUsKbars(contract, start, end, opts).then(usCandlesToKbars);
    return fetchKbars(contract, start, end, opts);
}

/** 範圍含近兩天（可能還在長的當日資料）的快取只用這麼久 */
export const LIVE_HISTORY_TTL_MS = 60_000;

const requests = new Map<string, { at: number; live: boolean; promise: Promise<KBars> }>();
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Presentation rebuilds reuse history, including failures. A manual revision
 * or a new date range explicitly permits another bounded fetchKbars attempt.
 * 範圍碰到今天的查詢只快取 LIVE_HISTORY_TTL_MS：同一面板 A→B→A 隔了一段時間
 * 再切回來時要重抓，否則歷史停在第一次查的時間點，中間的成交變成缺口。
 * 純過去的範圍不會再變，照舊一直沿用。 */
export function fetchChartHistory(contract: ContractBase, start: string, end: string, opts?: { timeoutMs?: number; revision?: number }, nowMs = Date.now()) {
    const key = JSON.stringify([getApiBase(), contract, start, end, opts?.revision ?? 0]);
    const hit = requests.get(key);
    if (hit && !(hit.live && nowMs - hit.at > LIVE_HISTORY_TTL_MS)) return hit.promise;
    const promise = fetchMinuteKbars(contract, start, end, opts);
    // 台北／紐約日期和 UTC 最多差一天：end 在 UTC 兩天前以後都當成「含當日」
    requests.delete(key);
    requests.set(key, { at: nowMs, live: end >= isoDay(nowMs - 2 * 86_400_000), promise });
    if (requests.size > 100) requests.delete(requests.keys().next().value!);
    return promise;
}

export function resetChartHistoryCacheForTest() {
    requests.clear();
}
