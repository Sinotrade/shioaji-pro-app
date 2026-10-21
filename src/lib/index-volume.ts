// src/lib/index-volume.ts：指數預估成交金額與前一交易日比較（+22%／-17%）

import type { KBars } from './types/market';

// 報價所屬交易日（quote_idx 的 date）正規化成 YYYY-MM-DD；接受 2026/10/16、2026-10-16、20261016。
// 用它（而不是電腦時鐘）當比較基準：App 跨過午夜或整個週末開著時，畫面上的預估量仍是上一個交易日的，
// 拿時鐘日期會變成「週五自己比週五」
export function tradingDate(raw: string | undefined): string | undefined {
    const m = raw ? /^(\d{4})[-/]?(\d{2})[-/]?(\d{2})/.exec(raw.trim()) : null;
    return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}

// 比較的基準交易日：有報價日期就用報價日期，沒有才退回電腦日期（today）
export function sessionDateOf(indexDate: string | undefined, today: string): string {
    return tradingDate(indexDate) ?? today;
}

// YYYY-MM-DD 往前／往後推 days 天（日曆日，用 UTC 計算避免時區與日光節約影響）
export function shiftDate(date: string, days: number): string {
    const [y, m, d] = date.split('-').map(Number);
    const t = new Date(Date.UTC(y!, m! - 1, d! + days));
    return t.toISOString().slice(0, 10);
}

// 抓前一交易日金額往回看的日曆天數：春節封關到開紅盤相隔約 12 到 13 天，7 天會讓開紅盤當天一定抓不到。
// 只加總最近一個有資料的交易日，多抓的天數只是多幾千根 1 分 K，同一個指數每天仍只抓一次
export const PREVIOUS_SESSION_LOOKBACK_DAYS = 21;

// 失敗後的重試間隔（毫秒）。useQuery 只在第一次使用時抓、失敗後不會自己重抓，開盤尖峰或伺服器剛啟動時
// 一次失敗就會整天沒有「較昨日」，所以把有上限的長退避放進抓取本身：失敗後依序等 30、60、120 秒再試，
// 最後一次失敗才丟出錯誤
export const PREVIOUS_AMOUNT_RETRY_MS: readonly number[] = [30_000, 60_000, 120_000];

// 會自己好的錯誤才值得重試：4xx（參數、權限）不會因為等一下就變好；沒有數字 status 的錯誤（逾時、斷線）照樣重試。
// 429 也重試：假設是 sidecar 還在登入（同 cancel-verification 的註解，kbars 端點未驗證）。
// 這點與 index-components 刻意不同，那邊的 429 是日額度用盡、不重試
export function isTransientError(e: unknown): boolean {
    const status = (e as { status?: unknown } | null)?.status;
    return typeof status !== 'number' || status === 429 || status < 400 || status >= 500;
}

export async function retryAfter<T>(
    run: () => Promise<T>,
    delays: readonly number[],
    wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    shouldRetry: (e: unknown) => boolean = () => true,
): Promise<T> {
    for (const delay of delays) {
        try {
            return await run();
        } catch (e) {
            if (!shouldRetry(e)) throw e;
            await wait(delay);
        }
    }
    return run();
}

// 前一個交易日（日期早於 today 的最後一天）全日成交金額：把當天所有 1 分 K 的 Amount 加總。
// 不自己算日曆：週末、補假、颱風假都以「K 棒實際有資料的最近一天」為準。
// 驗證過：加權指數 K 棒 Volume 加總與快照 yesterday_volume 完全相同（含收盤後 13:30 之後的棒）。
export function previousSessionAmount(
    k: Pick<KBars, 'datetime' | 'Amount'>,
    today: string,
): number | undefined {
    let last: string | undefined;
    for (const dt of k.datetime) {
        const day = dt.slice(0, 10);
        if (day < today && (last === undefined || day > last)) last = day;
    }
    if (last === undefined) return undefined;
    let sum = 0;
    for (let i = 0; i < k.datetime.length; i++) {
        if (k.datetime[i]?.slice(0, 10) === last) sum += k.Amount[i] ?? 0;
    }
    return sum > 0 ? sum : undefined;
}

// 指數收盤後的最終報價時間：13:30 收盤集合競價撮合，成交金額要到 13:33 那筆 quote_idx 才算進去
// （2026-10-20 實測加權：13:30 那筆 7113.5 億，13:33 那筆 7586.8 億）
// shortcut: 寫死 13:33，交易時段或揭示時間調整時要改
export const INDEX_CLOSE_TIME = '13:33:00';

// 全日成交金額：有預估量用預估量。收盤後 quote_idx 不再給預估量，這時成交金額就是全日實際量，
// 直接拿它當預估量，較昨日才算得出來（actual 為 true 讓畫面改標「實際量」）。
// 盤前、盤中缺預估量仍回 undefined：那時的成交金額只是累計一半，拿去比昨日會誤導。
// 金額的交易日要等於比較基準日：今天的報價配上前一交易日的快照金額時不算，免得拿昨天比昨天
export function fullDayAmount(
    estimate: number | undefined,
    amount: number | undefined,
    at: { date: string | undefined; time: string | undefined },
    session: string,
): { value: number | undefined; actual: boolean } {
    if (estimate !== undefined && Number.isFinite(estimate) && estimate > 0) return { value: estimate, actual: false };
    const closed = (at.time ?? '').slice(0, 8) >= INDEX_CLOSE_TIME && tradingDate(at.date) === session;
    if (closed && amount !== undefined && Number.isFinite(amount) && amount > 0) return { value: amount, actual: true };
    return { value: undefined, actual: false };
}

// 全日成交金額（預估量，收盤後為實際量）相對前一交易日：+22%／-17%，四捨五入到整數百分比，
// 持平顯示 0%。任一邊缺值或為 0 回傳 undefined（畫面顯示空值符號，不猜）。
export function volumeChangeOf(
    estimate: number | undefined,
    previous: number | undefined,
): string | undefined {
    if (estimate === undefined || previous === undefined) return undefined;
    if (!Number.isFinite(estimate) || !Number.isFinite(previous)) return undefined;
    if (estimate <= 0 || previous <= 0) return undefined;
    const pct = Math.round((estimate / previous - 1) * 100);
    // Math.round 可能算出 -0，字串化是 '0'，持平自然顯示 0%
    return `${pct > 0 ? '+' : ''}${pct}%`;
}
