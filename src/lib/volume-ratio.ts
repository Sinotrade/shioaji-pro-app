// src/lib/volume-ratio.ts — 量比：今日累計成交量 ÷ 昨日全日成交量（個股、期貨看板用）

import { fmtInt } from './utils/format';

// 任一邊缺值、昨日量為 0 或資料不是有限數時回傳 undefined（畫面顯示空值，不猜）
export function volumeRatioOf(today: number | undefined, yesterday: number | undefined): number | undefined {
    if (today === undefined || yesterday === undefined) return undefined;
    if (!Number.isFinite(today) || !Number.isFinite(yesterday) || today < 0 || yesterday <= 0) return undefined;
    return today / yesterday;
}

export function fmtVolumeRatio(ratio: number | undefined): string {
    return ratio === undefined ? '—' : ratio.toFixed(2);
}

// 滑過提示：寫出算法與代入的數字，讓使用者知道量比怎麼來的
export function volumeRatioTitle(today: number | undefined, yesterday: number | undefined): string {
    const formula = '量比 = 今日成交量 ÷ 昨日成交量';
    const ratio = volumeRatioOf(today, yesterday);
    if (ratio === undefined) {
        return yesterday === undefined || yesterday <= 0 ? `${formula}\n昨日成交量尚未取得` : formula;
    }
    return `${formula}\n${fmtInt(today)} ÷ ${fmtInt(yesterday)} = ${fmtVolumeRatio(ratio)}`;
}
