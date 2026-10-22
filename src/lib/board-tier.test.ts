// src/lib/board-tier.test.ts：報價看板階梯，標題加看板不超過面板 1/5，strip 保底

import { describe, expect, it, vi } from 'vitest';
import {
    BOARD_TIERS,
    boardBudget,
    effectiveTier,
    isRichTier,
    nextBoardMode,
    parseBoardMode,
    pickBoardTier,
    pickExpandedTier,
    RAIL_TIERS,
    STOCK_TIERS,
    UPGRADE_SLACK_PX,
    type BoardTier,
} from './board-tier';

// 各階梯排版後的看板高度（px），取自 dev 實測：寬 69、mid 67、單行階梯 45、strip 29；
// 個股軌道各級的高度（實機約 60 與 45，和上面指數的實測值不同源）
const HEIGHT: Record<BoardTier, number> = {
    rail: 60,
    railMid: 60,
    railLow: 45,
    wide: 69,
    mid: 67,
    inline: 45,
    lean: 45,
    compact: 45,
    tight: 45,
    strip: 29,
};
const measure = (tier: BoardTier) => HEIGHT[tier];

describe('pickExpandedTier', () => {
    it('沒有軌道時不量測，直接用 wide', () => {
        const measure = vi.fn(() => 50);
        expect(pickExpandedTier(measure, BOARD_TIERS)).toBe('wide');
        expect(measure).not.toHaveBeenCalled();
    });
    it('完整 rail 放得下時保留軌道', () => {
        expect(pickExpandedTier(() => 50, RAIL_TIERS)).toBe('rail');
    });
    it('只有從 wide 升回 rail 時要求升級緩衝', () => {
        for (const current of [undefined, 'wide', 'rail', 'railMid'] as const) {
            const measure = vi.fn(() => 50);
            pickExpandedTier(measure, RAIL_TIERS, current);
            expect(measure).toHaveBeenCalledWith('rail', current === 'wide');
        }
    });
    it('rail 放不下時回 wide，永遠不以 railMid 取代完整統計', () => {
        expect(pickExpandedTier(() => Infinity, RAIL_TIERS)).toBe('wide');
    });
});

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

    it('個股收起順序：漲跌停價 → 開 → 高低 → 量比 → 量（使用者指定）', () => {
        expect(STOCK_TIERS).toEqual(['wide', 'mid', 'inline', 'lean', 'compact', 'tight', 'strip']);
        // 有軌道時：軌道兩級之後直接接 mid，不會再回到帶漲跌停價的 wide
        expect(RAIL_TIERS).toEqual(['rail', 'railMid', 'mid', 'railLow', 'inline', 'lean', 'compact', 'tight', 'strip']);
        const need = { wide: 600, mid: 500, inline: 460, lean: 420, compact: 330, tight: 260 };
        const pick = (width: number) => pickBoardTier(measureWithin(width, need), 81, undefined, STOCK_TIERS);
        expect(pick(340)).toBe('compact');
        expect(pick(300)).toBe('tight');
        expect(pick(250)).toBe('strip');
    });

    it('有軌道的個股先試 rail、railMid，放不下時接原本的 mid 起，切換點不變', () => {
        const need = { rail: 700, railMid: 620, railLow: 600, wide: 600, mid: 500, inline: 460, lean: 420, compact: 330, tight: 260 };
        const pick = (width: number) => pickBoardTier(measureWithin(width, need), 81, undefined, RAIL_TIERS);
        expect(pick(1000)).toBe('rail');
        expect(pick(650)).toBe('railMid');
        // wide 放得下但 railMid 放不下：不回到帶漲跌停價的 wide，直接用 mid
        expect(pick(610)).toBe('mid');
        for (const width of [510, 470, 430, 340, 300, 250]) {
            expect(pick(width)).toBe(pickBoardTier(measureWithin(width, need), 81, undefined, STOCK_TIERS));
        }
    });

    it('面板矮、mid 的高度放不下時改用 railLow（單行高度的軌道），不會直接掉到沒有軌道的 inline', () => {
        const need = { rail: 700, railMid: 620, railLow: 600, mid: 500, inline: 460 };
        // 預算 50：rail、railMid、mid（60 到 67）都太高，railLow（45）放得下
        expect(pickBoardTier(measureWithin(1000, need), 50, undefined, RAIL_TIERS)).toBe('railLow');
        // 寬度不夠放軌道時照舊用 inline
        expect(pickBoardTier(measureWithin(550, need), 50, undefined, RAIL_TIERS)).toBe('inline');
        // railLow 不算豐富階梯：按鈕標示「展開」
        expect(isRichTier('railLow')).toBe(false);
    });

    it('軌道階梯也有升級緩衝：從 railMid 回 rail 要多留一個字寬', () => {
        const need = { rail: 600, railMid: 520 };
        let tier = pickBoardTier(measureWithin(600, need), 81, undefined, RAIL_TIERS);
        expect(tier).toBe('rail');
        tier = pickBoardTier(measureWithin(599, need), 81, tier, RAIL_TIERS);
        expect(tier).toBe('railMid');
        tier = pickBoardTier(measureWithin(600, need), 81, tier, RAIL_TIERS);
        expect(tier).toBe('railMid');
        tier = pickBoardTier(measureWithin(600 + DIGIT_PX, need), 81, tier, RAIL_TIERS);
        expect(tier).toBe('rail');
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
        // 所有階梯（指數、個股、個股有軌道）各試一遍
        const tiers = [...new Set<BoardTier>([...BOARD_TIERS, ...STOCK_TIERS, ...RAIL_TIERS])];
        for (const mode of ['auto', 'collapsed', 'expanded'] as const) {
            for (const auto of tiers) {
                const before = isRichTier(effectiveTier(mode, auto));
                const after = isRichTier(effectiveTier(nextBoardMode(mode, auto), auto));
                expect(after).toBe(!before);
            }
        }
    });

    it('豐富階梯是 rail、railMid、wide 與 mid；railLow（面板矮的軌道）、tight 等單行階梯都是精簡的', () => {
        for (const t of ['rail', 'railMid', 'wide', 'mid'] as const) expect(isRichTier(t)).toBe(true);
        for (const t of ['railLow', 'inline', 'lean', 'compact', 'tight', 'strip'] as const) {
            expect(isRichTier(t)).toBe(false);
        }
    });

    it('展開用量測端挑的階梯（軌道放得下就是 rail，否則 wide），不看自動結果；按鈕一樣每按一下翻轉', () => {
        // 矮面板自動是 railLow，展開仍保留軌道（不變成沒有軌道的數字欄）
        expect(effectiveTier('expanded', 'railLow', 'rail')).toBe('rail');
        expect(effectiveTier('expanded', 'railMid', 'rail')).toBe('rail');
        expect(effectiveTier('expanded', 'compact')).toBe('wide');
        expect(effectiveTier('collapsed', 'rail', 'rail')).toBe('strip');
        expect(effectiveTier('auto', 'railLow', 'rail')).toBe('railLow');
        for (const mode of ['auto', 'collapsed', 'expanded'] as const) {
            for (const auto of RAIL_TIERS) {
                const before = isRichTier(effectiveTier(mode, auto));
                const after = isRichTier(effectiveTier(nextBoardMode(mode, auto), auto));
                expect(after).toBe(!before);
            }
        }
    });

    it('讀回瀏覽器存的值：不認得的一律當 auto', () => {
        expect(parseBoardMode('collapsed')).toBe('collapsed');
        expect(parseBoardMode('expanded')).toBe('expanded');
        expect(parseBoardMode('whatever')).toBe('auto');
        expect(parseBoardMode(null)).toBe('auto');
    });
});
