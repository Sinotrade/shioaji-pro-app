// src/lib/sector-other-pct.ts — 產業全景下鑽「其他成員」加權漲跌幅反推
//
// 群組加權漲跌（gm:weighted_performance）＝全員參考權重加權平均，扣掉排行
// 前 10 的「權重×漲跌」即得其餘成員的加權漲跌。兩邊權重同為
// reference_weight_ppm（建底參考市值、盤中恆定）；同一快照的資料反推是精確
// 的（2026-10-20 收盤快照：半導體業餘量 3.4% 權重，反推 -2.057%，全員重算
// 實際 -2.061%）。
//
// 但任何輸入誤差都會被放大 groupWeight / restWeight 倍（半導體約 16 倍）。
// #330 的 ≈+10%（clamp 上限）最可能的成因是群組漲跌與排行列不同刻：排行
// 投影可由較早的建底快照或 session cache 先行投出，群組漲跌已是盤中即時
// 值；差 0.7 個百分點乘 16 倍即衝出漲跌停。原案的雙投影 payload 未保留，
// 這是依上述放大效應與元件資料流推得的最可能成因，未經原案資料證實。
//
// 因此本函式只接受「與排行同一個 calculated_at」的群組漲跌（呼叫端以
// getIcGroupWperfAt 取得，取不到就傳 undefined），不做時間容忍；並在餘量
// 權重過小或結果超出台股漲跌停時回 null（畫面顯示「—」），不再 clamp。

export interface OtherPctEntry {
    weight_pct: number;
    pct_chg: number;
}

export interface OtherPctInput {
    /** 群組參考權重（佔指數 %） */
    groupWeight: number | undefined;
    /** 與 entries 同一 calculated_at 的群組加權漲跌幅（%）；沒有就 undefined */
    groupPct: number | undefined;
    /** 排行前 N 成分股（權重同為佔指數 %） */
    entries: readonly OtherPctEntry[];
}

// 餘量權重佔群組 < 2% 時誤差放大逾 50 倍，漲跌幅兩位小數的四捨五入就足以失真
export const OTHER_PCT_MIN_REST_SHARE = 0.02;
// 台股漲跌停幅度；反推值超出代表輸入不自洽，一律不顯示
export const OTHER_PCT_LIMIT = 10;

export function estimateOtherPct(input: OtherPctInput): number | null {
    const { groupWeight, groupPct, entries } = input;
    if (
        groupWeight === undefined ||
        groupPct === undefined ||
        !Number.isFinite(groupWeight) ||
        !Number.isFinite(groupPct) ||
        groupWeight <= 0 ||
        entries.length === 0
    ) {
        return null;
    }
    let topWeight = 0;
    let topWeighted = 0;
    for (const entry of entries) {
        topWeight += entry.weight_pct;
        topWeighted += entry.weight_pct * entry.pct_chg;
    }
    const restWeight = groupWeight - topWeight;
    if (restWeight / groupWeight < OTHER_PCT_MIN_REST_SHARE) return null;
    const estimate = (groupWeight * groupPct - topWeighted) / restWeight;
    if (!Number.isFinite(estimate) || Math.abs(estimate) > OTHER_PCT_LIMIT) {
        return null;
    }
    return estimate;
}
