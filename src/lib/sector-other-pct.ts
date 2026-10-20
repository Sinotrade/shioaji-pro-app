// src/lib/sector-other-pct.ts — 產業全景下鑽「其他成員」加權漲跌幅反推
//
// 群組加權漲跌（gm:weighted_performance）＝全員參考權重加權平均，扣掉排行
// 前 10 的「權重×漲跌」即得其餘成員的加權漲跌。兩邊權重同為
// reference_weight_ppm（建底參考市值、盤中恆定），資料同刻時反推是精確的
// （2026-10-20 收盤快照：半導體業餘量 3.4% 權重，反推 -2.057% vs 實際 -2.061%）。
//
// 但誤差會被放大 groupWeight / restWeight 倍（半導體約 16 倍）。#330 的
// ≈+10% 來自兩串流不同刻：排行投影由較早的建底快照或 session cache 先行
// 投出（早盤價格），群組漲跌已是盤中即時值 — 兩者相減的差額再乘 16 倍
// 就衝出漲跌停，被 clamp 成 +10%。因此：
// - 兩份資料的 calculated_at 相差超過容忍度 → 不反推；
// - 餘量權重佔群組比例過小 → 不反推（誤差放大過大）；
// - 反推值超出台股漲跌停 ±10% → 資料必然不自洽，不顯示（不再 clamp）。

export interface OtherPctEntry {
    weight_pct: number;
    pct_chg: number;
}

export interface OtherPctInput {
    /** 群組參考權重（佔指數 %） */
    groupWeight: number | undefined;
    /** 群組加權漲跌幅（%） */
    groupPct: number | undefined;
    /** 群組漲跌投影的 calculated_at */
    groupCalculatedAt: string | undefined;
    /** 排行前 N 成分股（權重同為佔指數 %） */
    entries: readonly OtherPctEntry[];
    /** 排行投影的 calculated_at */
    entriesCalculatedAt: string | undefined;
}

// 群組 1s、排行 5s 的推送節奏差在容忍內；超過即視為不同刻
export const OTHER_PCT_MAX_SKEW_MS = 10_000;
// 餘量權重佔群組 < 2% 時誤差放大逾 50 倍，價格四捨五入就足以失真
export const OTHER_PCT_MIN_REST_SHARE = 0.02;
// 台股漲跌停幅度；反推值超出（留 0.05 給四捨五入）代表輸入不自洽
export const OTHER_PCT_LIMIT = 10;

function parseTime(value: string | undefined): number | null {
    if (!value) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
}

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
    const groupAt = parseTime(input.groupCalculatedAt);
    const entriesAt = parseTime(input.entriesCalculatedAt);
    if (
        groupAt === null ||
        entriesAt === null ||
        Math.abs(groupAt - entriesAt) > OTHER_PCT_MAX_SKEW_MS
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
    if (
        !Number.isFinite(estimate) ||
        Math.abs(estimate) > OTHER_PCT_LIMIT + 0.05
    ) {
        return null;
    }
    return estimate;
}
