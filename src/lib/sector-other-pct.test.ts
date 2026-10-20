import { describe, expect, it } from 'vitest';
import {
    estimateOtherPct,
    OTHER_PCT_LIMIT,
    type OtherPctEntry,
} from './sector-other-pct';

// 2026-10-20 收盤 index_components 建底快照（IX0001）半導體業：96 檔、
// 群組參考權重 54.7111%、加權漲跌 -0.940698%；成交值前 10 如下。
// 其餘 86 檔實際加權漲跌（由快照全員重算）為 -2.0613%。
const SEMI_WEIGHT = 54.7111;
const SEMI_PCT = -0.940698;
const SEMI_TOP10: OtherPctEntry[] = (
    [
    [-0.62, 410345],
    [-1.31, 44129],
    [-3.21, 8834],
    [-3.42, 10808],
    [-3.77, 3383],
    [-1.09, 6861],
    [-1.49, 19585],
    [-1.93, 4575],
    [-1.84, 2011],
        [-2.02, 2094],
    ] as [number, number][]
).map(([pct, ppm]) => ({ pct_chg: pct, weight_pct: ppm / 10_000 }));

// 修正前的公式（只擋 restWeight ≤ 1e-6、再 clamp ±10）— 示範放大效應
function legacyOtherPct(
    groupWeight: number,
    groupPct: number,
    entries: OtherPctEntry[],
) {
    const topWeight = entries.reduce((s, e) => s + e.weight_pct, 0);
    const restWeight = groupWeight - topWeight;
    if (restWeight <= 1e-6) return null;
    const topWeighted = entries.reduce(
        (s, e) => s + e.weight_pct * e.pct_chg,
        0,
    );
    const estimate = (groupWeight * groupPct - topWeighted) / restWeight;
    return Math.max(-10, Math.min(10, estimate));
}

// 單一前 N 列＋餘量權重 1 的群組：反推值恰為 target（方便測邊界）
function bounded(target: number) {
    // groupWeight=10、top 9（漲跌 0）、rest 1 → estimate = 10 * groupPct
    return estimateOtherPct({
        groupWeight: 10,
        groupPct: target / 10,
        entries: [{ weight_pct: 9, pct_chg: 0 }],
    });
}

describe('estimateOtherPct（#330 其他成員反推）', () => {
    it('同一快照：反推值與實際餘量加權漲跌一致', () => {
        const pct = estimateOtherPct({
            groupWeight: SEMI_WEIGHT,
            groupPct: SEMI_PCT,
            entries: SEMI_TOP10,
        });
        expect(pct).not.toBeNull();
        expect(pct!).toBeCloseTo(-2.0613, 1);
    });

    it('放大效應：群組漲跌偏 0.7 個百分點，舊公式就算出近 +10%', () => {
        // 半導體餘量權重 3.45%，放大約 54.7 / 3.45 ≈ 15.9 倍
        expect(legacyOtherPct(SEMI_WEIGHT, -0.24, SEMI_TOP10)!).toBeGreaterThan(
            9,
        );
        expect(legacyOtherPct(SEMI_WEIGHT, -0.1, SEMI_TOP10)).toBe(10);
        // 新函式不做時間容忍：別刻的群組漲跌由呼叫端擋掉（傳 undefined）
        expect(
            estimateOtherPct({
                groupWeight: SEMI_WEIGHT,
                groupPct: undefined,
                entries: SEMI_TOP10,
            }),
        ).toBeNull();
    });

    it('漲跌停邊界嚴格：恰 ±10% 顯示，超過一點點就不顯示', () => {
        expect(bounded(OTHER_PCT_LIMIT)).toBeCloseTo(10, 10);
        expect(bounded(-OTHER_PCT_LIMIT)).toBeCloseTo(-10, 10);
        expect(bounded(10.0001)).toBeNull();
        expect(bounded(10.04)).toBeNull();
        expect(bounded(-10.0001)).toBeNull();
        expect(bounded(9.99)).toBeCloseTo(9.99, 10);
    });

    it('同一快照但反推值超出漲跌停 → 不顯示（不再 clamp）', () => {
        expect(
            estimateOtherPct({
                groupWeight: SEMI_WEIGHT,
                groupPct: -0.1,
                entries: SEMI_TOP10,
            }),
        ).toBeNull();
    });

    it('餘量權重佔群組 2% 邊界：恰 2% 顯示，低於就不顯示', () => {
        const at = (rest: number) =>
            estimateOtherPct({
                groupWeight: 100,
                groupPct: -1,
                entries: [{ weight_pct: 100 - rest, pct_chg: -1 }],
            });
        expect(at(2)).toBeCloseTo(-1, 6);
        expect(at(1.99)).toBeNull();
        expect(at(0)).toBeNull();
        expect(at(-0.5)).toBeNull(); // 排行權重和超過群組
    });

    it('缺資料（權重、群組漲跌、排行）→ null', () => {
        const base = {
            groupWeight: SEMI_WEIGHT,
            groupPct: SEMI_PCT,
            entries: SEMI_TOP10,
        };
        expect(estimateOtherPct({ ...base, groupWeight: undefined })).toBeNull();
        expect(estimateOtherPct({ ...base, groupWeight: 0 })).toBeNull();
        expect(estimateOtherPct({ ...base, groupPct: Number.NaN })).toBeNull();
        expect(estimateOtherPct({ ...base, entries: [] })).toBeNull();
    });
});
