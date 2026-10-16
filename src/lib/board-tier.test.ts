// src/lib/board-tier.test.ts：指數看板階梯，標題加看板不超過面板 1/5，strip 保底

import { describe, expect, it } from 'vitest';
import {
    boardBudget,
    effectiveTier,
    isRichTier,
    nextBoardMode,
    parseBoardMode,
    pickBoardTier,
    UPGRADE_SLACK_PX,
    type BoardTier,
} from './board-tier';

// 各階梯排版後的看板高度（px），取自 dev 實測：寬 69、mid 67、單行階梯 45、strip 29
const HEIGHT: Record<BoardTier, number> = { wide: 69, mid: 67, inline: 45, lean: 45, compact: 45, strip: 29 };
const measure = (tier: BoardTier) => HEIGHT[tier];

// 模擬寬度：各階梯需要的寬度（px），超過可用寬度就算放不下；升級時要多留一個數字寬
// （1.5rem 等寬字約 17px，對應量測端依字級換算的寬度緩衝）
const DIGIT_PX = 17;
function measureWithin(width: number, need: Partial<Record<BoardTier, number>>) {
    return (tier: BoardTier, upgrading: boolean) =>
        (need[tier] ?? 0) + (upgrading ? DIGIT_PX : 0) > width ? Infinity : HEIGHT[tier];
}

describe('boardBudget', () => {
    it('面板高度的 1/5 減掉看板上方已占的高度', () => {
        expect(boardBudget(570, 33)).toBeCloseTo(81, 5);
        expect(boardBudget(400, 33)).toBeCloseTo(47, 5);
    });
});

describe('pickBoardTier', () => {
    it('預算夠就用最豐富的階梯', () => {
        expect(pickBoardTier(measure, 81)).toBe('wide');
    });

    it('依預算逐級降級', () => {
        expect(pickBoardTier(measure, 67)).toBe('mid');
        expect(pickBoardTier(measure, 60)).toBe('inline');
        expect(pickBoardTier(measure, 40)).toBe('strip');
    });

    it('面板再矮也保底 strip，不隱藏看板（價格永遠看得到）', () => {
        expect(pickBoardTier(measure, 20)).toBe('strip');
        expect(pickBoardTier(measure, -5)).toBe('strip');
    });

    it('依寬度逐級跳過放不下的單行階梯：inline → lean → compact', () => {
        const need = { wide: 900, mid: 800, inline: 600, lean: 450, compact: 330 };
        expect(pickBoardTier(measureWithin(620, need), 60)).toBe('inline');
        expect(pickBoardTier(measureWithin(500, need), 60)).toBe('lean');
        expect(pickBoardTier(measureWithin(400, need), 60)).toBe('compact');
        expect(pickBoardTier(measureWithin(300, need), 60)).toBe('strip');
    });

    it('寬度也有升級緩衝：內容寬度在門檻附近差一整個字來回時不會兩級之間閃爍', () => {
        // inline 需要 600px：可用寬度 600 時第一次量放得下
        let tier = pickBoardTier(measureWithin(600, { inline: 600 }), 60);
        expect(tier).toBe('inline');
        // 內容多一個字（漲跌跨過 +100、家數跨過百位）溢出 → 立即降級
        tier = pickBoardTier(measureWithin(600, { inline: 600 + DIGIT_PX }), 60, tier);
        expect(tier).toBe('lean');
        // 內容縮回剛好放得下 → 要多留一個字寬才升級，所以維持 lean（不會每跳一次就閃）
        tier = pickBoardTier(measureWithin(600, { inline: 600 }), 60, tier);
        expect(tier).toBe('lean');
        // 寬度多出一個字以上才升回 inline
        tier = pickBoardTier(measureWithin(600, { inline: 600 - DIGIT_PX }), 60, tier);
        expect(tier).toBe('inline');
    });

    it('豐富的階梯因為換行變高時自動跳過，只看實際高度', () => {
        const wrapped = (tier: BoardTier) => (tier === 'wide' || tier === 'mid' ? 126 : HEIGHT[tier]);
        expect(pickBoardTier(wrapped, 81)).toBe('inline');
        expect(pickBoardTier(wrapped, 127)).toBe('wide');
    });

    it('降級立即生效', () => {
        expect(pickBoardTier(measure, 60, 'wide')).toBe('inline');
    });

    it('高度升級要多留緩衝：預算剛好等於高度時維持原階梯', () => {
        expect(pickBoardTier(measure, 67, 'inline')).toBe('inline');
        expect(pickBoardTier(measure, 67 + UPGRADE_SLACK_PX, 'inline')).toBe('mid');
    });

    it('同一階梯內預算小幅上下抖動不會切換', () => {
        let tier = pickBoardTier(measure, 50);
        const seen = new Set<BoardTier>();
        for (const budget of [50, 52, 49, 51, 50, 49, 48]) {
            tier = pickBoardTier(measure, budget, tier);
            seen.add(tier);
        }
        expect([...seen]).toEqual(['inline']);
    });
});

describe('手動模式', () => {
    it('collapsed 固定一行、expanded 固定全部，auto 照自動結果', () => {
        expect(effectiveTier('collapsed', 'wide')).toBe('strip');
        expect(effectiveTier('expanded', 'compact')).toBe('wide');
        expect(effectiveTier('auto', 'mid')).toBe('mid');
    });

    it('自動時：豐富 → 收合；精簡 → 展開', () => {
        expect(nextBoardMode('auto', 'wide')).toBe('collapsed');
        expect(nextBoardMode('auto', 'mid')).toBe('collapsed');
        expect(nextBoardMode('auto', 'inline')).toBe('expanded');
        expect(nextBoardMode('auto', 'lean')).toBe('expanded');
        expect(nextBoardMode('auto', 'compact')).toBe('expanded');
        expect(nextBoardMode('auto', 'strip')).toBe('expanded');
    });

    it('手動時自動結果剛好符合按鈕意圖就回自動', () => {
        // 標示「展開」，自動是完整 → 回自動
        expect(nextBoardMode('collapsed', 'wide')).toBe('auto');
        // 標示「收合」，自動是精簡 → 回自動
        expect(nextBoardMode('expanded', 'compact')).toBe('auto');
    });

    it('手動時自動結果不符合按鈕意圖，就切到相反的手動狀態（按一下完整／精簡一定翻轉）', () => {
        // 標示「收合」，自動也是完整（展開後面板拉高）→ 手動收合
        expect(nextBoardMode('expanded', 'wide')).toBe('collapsed');
        expect(nextBoardMode('expanded', 'mid')).toBe('collapsed');
        // 標示「展開」，自動也是精簡（大面板收合後，小面板看到的是一行）→ 手動展開
        expect(nextBoardMode('collapsed', 'strip')).toBe('expanded');
        expect(nextBoardMode('collapsed', 'compact')).toBe('expanded');
    });

    it('任何狀態下按一下，完整／精簡都會翻轉', () => {
        const tiers: BoardTier[] = ['wide', 'mid', 'inline', 'lean', 'compact', 'strip'];
        for (const mode of ['auto', 'collapsed', 'expanded'] as const) {
            for (const auto of tiers) {
                const before = isRichTier(effectiveTier(mode, auto));
                const after = isRichTier(effectiveTier(nextBoardMode(mode, auto), auto));
                expect(after).toBe(!before);
            }
        }
    });

    it('豐富階梯只有 wide 與 mid', () => {
        expect(isRichTier('wide')).toBe(true);
        expect(isRichTier('mid')).toBe(true);
        for (const t of ['inline', 'lean', 'compact', 'strip'] as const) expect(isRichTier(t)).toBe(false);
    });

    it('讀回瀏覽器存的值：不認得的一律當 auto', () => {
        expect(parseBoardMode('collapsed')).toBe('collapsed');
        expect(parseBoardMode('expanded')).toBe('expanded');
        expect(parseBoardMode('whatever')).toBe('auto');
        expect(parseBoardMode(null)).toBe('auto');
    });
});
