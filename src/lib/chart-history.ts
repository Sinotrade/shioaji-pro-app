import { getApiBase } from './runtime';
import { fetchKbars } from './shioaji';
import type { ContractBase } from './types/contract';
import type { Candle, KBars } from './types/market';
import { fetchUsKbars, type UsKbars } from './us/us-history';

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
export function usCandlesToKbars(bars: readonly Candle[] | UsKbars): ChartKBars {
    const out: ChartKBars = { datetime: [], Open: [], High: [], Low: [], Close: [], Volume: [], Amount: [] };
    if ((bars as UsKbars).extendedHistory !== undefined) out.usExtendedHistory = (bars as UsKbars).extendedHistory;
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

/**
 * 圖表歷史。美股要了含盤前盤後（usExtended）時，usExtendedHistory 表示
 * sidecar 有沒有真的給延長時段（舊 sidecar 忽略 sessions，只回一般盤 —
 * 這時圖表退回用記憶體裡 App 開著時收到的盤前盤後 K 棒）。
 */
export type ChartKBars = KBars & { usExtendedHistory?: boolean };

export interface ChartHistoryOpts {
    timeoutMs?: number;
    revision?: number;
    /** 美股含盤前盤後（kbars 帶 sessions）；台股忽略 */
    usExtended?: boolean;
}

/** 依 region 取 1 分 K：台股 /data/kbars；美股走 us-history（一次最多 30 天，自動分段） */
function fetchMinuteKbars(contract: ContractBase, start: string, end: string, opts?: ChartHistoryOpts): Promise<ChartKBars> {
    if (contract.region === 'US') return fetchUsKbars(contract, start, end, { timeoutMs: opts?.timeoutMs, extended: opts?.usExtended === true }).then(usCandlesToKbars);
    return fetchKbars(contract, start, end, { timeoutMs: opts?.timeoutMs });
}

/** 範圍含近兩天（可能還在長的當日資料）的快取只用這麼久 */
export const LIVE_HISTORY_TTL_MS = 60_000;

interface CachedHistory {
    at: number;
    live: boolean;
    /** 成功且有資料才會變 true；失敗、空結果維持 false */
    hasData: boolean;
    promise: Promise<ChartKBars>;
}
const requests = new Map<string, CachedHistory>();
const TODAY_FMT = {
    TW: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }),
    US: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }),
};
/** 商品所在市場的「今天」（台股台北、美股紐約），YYYY-MM-DD */
function marketToday(contract: ContractBase, nowMs: number): string {
    return TODAY_FMT[contract.region === 'US' ? 'US' : 'TW'].format(nowMs);
}
/** Presentation rebuilds reuse history, including failures and empty results
 * (ADR 0002). A manual revision or a new date range explicitly permits another
 * bounded fetchKbars attempt.
 * 例外只有一個：成功、有資料、範圍碰到今天的結果只快取 LIVE_HISTORY_TTL_MS —
 * 同一面板 A→B→A 隔了一段時間再切回來時要重抓，否則歷史停在第一次查的時間
 * 點，中間的成交變成缺口。失敗（403 等）與空結果照舊一直沿用，不因重建重打。
 * 純過去的範圍不會再變，也一直沿用。 */
export function fetchChartHistory(contract: ContractBase, start: string, end: string, opts?: ChartHistoryOpts, nowMs = Date.now()) {
    const usExtended = contract.region === 'US' && opts?.usExtended === true;
    const key = JSON.stringify([getApiBase(), contract, start, end, opts?.revision ?? 0, usExtended]);
    const hit = requests.get(key);
    if (hit && !(hit.live && hit.hasData && nowMs - hit.at > LIVE_HISTORY_TTL_MS)) return hit.promise;
    const promise = fetchMinuteKbars(contract, start, end, { ...opts, usExtended });
    // 範圍的結束日到了商品所在市場的今天，才算「含當日」
    const entry: CachedHistory = { at: nowMs, live: end >= marketToday(contract, nowMs), hasData: false, promise };
    promise.then(
        (k) => {
            if ((k?.datetime?.length ?? 0) > 0) entry.hasData = true;
        },
        () => {},
    );
    requests.delete(key);
    requests.set(key, entry);
    if (requests.size > 100) requests.delete(requests.keys().next().value!);
    return promise;
}

export function resetChartHistoryCacheForTest() {
    requests.clear();
}
