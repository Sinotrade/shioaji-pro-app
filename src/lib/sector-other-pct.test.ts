import { describe, expect, it } from 'vitest';
import { estimateOtherPct, type OtherPctEntry } from './sector-other-pct';

// 2026-10-20 收盤 index_components 建底快照（IX0001）半導體業：96 檔、
// 群組參考權重 54.7111%、加權漲跌 -0.940698%；成交值前 10 如下。
// 其餘 86 檔實際加權漲跌（由快照全員重算）為 -2.0613%。
const SEMI_WEIGHT = 54.7111;
const SEMI_PCT = -0.940698;
const SEMI_TOP10: OtherPctEntry[] = [
    ['2330', -0.62, 410345],
    ['2454', -1.31, 44129],
    ['2408', -3.21, 8834],
    ['2303', -3.42, 10808],
    ['3189', -3.77, 3383],
    ['3443', -1.09, 6861],
    ['3711', -1.49, 19585],
    ['2344', -1.93, 4575],
    ['6770', -1.84, 2011],
    ['3661', -2.02, 2094],
].map(([, pct, ppm]) => ({
    pct_chg: pct as number,
    weight_pct: (ppm as number) / 10_000,
}));
const CLOSE_AT = '2026-10-20T13:33:00+08:00';

// 修正前的公式（只擋 restWeight ≤ 1e-6、再 clamp ±10）— 用來重現 #330
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

describe('estimateOtherPct（#330 其他成員反推）', () => {
    it('同刻資料：反推值與實際餘量加權漲跌一致', () => {
        const pct = estimateOtherPct({
            groupWeight: SEMI_WEIGHT,
            groupPct: SEMI_PCT,
            groupCalculatedAt: CLOSE_AT,
            entries: SEMI_TOP10,
            entriesCalculatedAt: CLOSE_AT,
        });
        expect(pct).not.toBeNull();
        expect(pct!).toBeCloseTo(-2.0613, 1);
    });

    it('重現 #330：群組漲跌已更新、排行仍是較早的快照 → 舊公式算出近 +10%', () => {
        // 群組漲跌盤中回到 -0.24%，排行仍停在先前那包（前 10 全跌）
        const legacy = legacyOtherPct(SEMI_WEIGHT, -0.24, SEMI_TOP10)!;
        expect(legacy).toBeGreaterThan(9);
        // 差 0.7 個百分點被放大 ~16 倍（54.7 / 3.45）
        expect(legacyOtherPct(SEMI_WEIGHT, -0.1, SEMI_TOP10)).toBe(10);

        expect(
            estimateOtherPct({
                groupWeight: SEMI_WEIGHT,
                groupPct: -0.24,
                groupCalculatedAt: '2026-10-19T13:50:00+08:00',
                entries: SEMI_TOP10,
                entriesCalculatedAt: '2026-10-19T09:05:00+08:00',
            }),
        ).toBeNull();
    });

    it('推送節奏差（10 秒內）仍反推；微秒時間格式可解析', () => {
        expect(
            estimateOtherPct({
                groupWeight: SEMI_WEIGHT,
                groupPct: SEMI_PCT,
                groupCalculatedAt: '2026-10-20T13:32:56.000000+08:00',
                entries: SEMI_TOP10,
                entriesCalculatedAt: '2026-10-20T13:33:01.250000+08:00',
            }),
        ).toBeCloseTo(-2.06, 1);
    });

    it('即使同刻，反推值超出漲跌停也不顯示（不再 clamp 成 ±10%）', () => {
        expect(
            estimateOtherPct({
                groupWeight: SEMI_WEIGHT,
                groupPct: -0.1,
                groupCalculatedAt: CLOSE_AT,
                entries: SEMI_TOP10,
                entriesCalculatedAt: CLOSE_AT,
            }),
        ).toBeNull();
    });

    it('餘量權重佔群組過小 → 不反推', () => {
        expect(
            estimateOtherPct({
                groupWeight: 10,
                groupPct: -1,
                groupCalculatedAt: CLOSE_AT,
                entries: [{ weight_pct: 9.9, pct_chg: -1 }],
                entriesCalculatedAt: CLOSE_AT,
            }),
        ).toBeNull();
        expect(
            estimateOtherPct({
                groupWeight: 10,
                groupPct: -1,
                groupCalculatedAt: CLOSE_AT,
                entries: [{ weight_pct: 10.2, pct_chg: -1 }],
                entriesCalculatedAt: CLOSE_AT,
            }),
        ).toBeNull();
    });

    it('缺資料（權重、群組漲跌、時間、排行）→ null', () => {
        const base = {
            groupWeight: SEMI_WEIGHT,
            groupPct: SEMI_PCT,
            groupCalculatedAt: CLOSE_AT,
            entries: SEMI_TOP10,
            entriesCalculatedAt: CLOSE_AT,
        };
        expect(estimateOtherPct({ ...base, groupWeight: undefined })).toBeNull();
        expect(estimateOtherPct({ ...base, groupPct: undefined })).toBeNull();
        expect(
            estimateOtherPct({ ...base, groupCalculatedAt: undefined }),
        ).toBeNull();
        expect(
            estimateOtherPct({ ...base, entriesCalculatedAt: 'bad' }),
        ).toBeNull();
        expect(estimateOtherPct({ ...base, entries: [] })).toBeNull();
    });
});
