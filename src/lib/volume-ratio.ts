// src/lib/volume-ratio.ts：量比，今日累計成交量 ÷ 昨日全日成交量（個股看板用）

import { tradingDate } from './index-volume';
import { fmtInt } from './utils/format';

// 重抓快照的重試間隔（毫秒）：當天第一筆真成交時伺服器的快照可能還沒翻日、開盤壅塞也可能逾時，
// useQuery 失敗後不會自己重抓，所以把有上限的退避放進抓取本身，每檔每天最多抓 5 次，且只在快照已過期時才會抓
export const RATIO_SNAPSHOT_RETRY_MS: readonly number[] = [3_000, 10_000, 30_000, 60_000];

// 任一邊缺值、昨日量為 0 或資料不是有限數時回傳 undefined（畫面顯示空值，不猜）
export function volumeRatioOf(today: number | undefined, yesterday: number | undefined): number | undefined {
    if (today === undefined || yesterday === undefined) return undefined;
    if (!Number.isFinite(today) || !Number.isFinite(yesterday) || today < 0 || yesterday <= 0) return undefined;
    return today / yesterday;
}

export function fmtVolumeRatio(ratio: number | undefined): string {
    return ratio === undefined ? '—' : ratio.toFixed(2);
}

// 分母是快照裡的「昨日成交量」，指的是快照所屬交易日的前一天。快照是 App 開著期間抓的、不會自己更新：
// 跨日、或週末後盤前才打開 App 時，快照還是上一個交易日的，拿它的昨日量會除到前前一天。
// 即時成交的日期和快照的日期對不上就視為過期，量比不算（兩邊有任一邊沒有日期時無從比較，照常算）
export function ratioSnapshotStale(tickDate: string | undefined, snapshotDatetime: string | undefined): boolean {
    const tickDay = tradingDate(tickDate);
    const snapshotDay = tradingDate(snapshotDatetime);
    return tickDay !== undefined && snapshotDay !== undefined && tickDay !== snapshotDay;
}

// 滑過提示：寫出算法與代入的數字，讓使用者知道量比怎麼來的；算不出來時寫明原因
export function volumeRatioTitle(
    today: number | undefined,
    yesterday: number | undefined,
    stale = false,
): string {
    const formula = '量比 = 今日成交量 ÷ 昨日成交量';
    if (stale) return `${formula}
昨日成交量待更新`;
    if (yesterday === undefined) return `${formula}
昨日成交量尚未取得`;
    // 0 可能是新上市第一天、停牌後復牌，也可能是伺服器沒資料的預設值，只寫數值不推論原因
    if (yesterday <= 0) return `${formula}
昨日成交量為 0，無法計算`;
    const ratio = volumeRatioOf(today, yesterday);
    if (ratio === undefined) return formula;
    return `${formula}
${fmtInt(today)} ÷ ${fmtInt(yesterday)} = ${fmtVolumeRatio(ratio)}`;
}
