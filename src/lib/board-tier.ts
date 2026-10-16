// src/lib/board-tier.ts：報價看板（指數、個股共用）依面板大小自動降級，目標是標題列加看板不超過面板高度的 1/5，
// 讓 K 線區拿到其餘空間。階梯由豐富到精簡；實際高度與寬度由畫面量測（見 hooks/use-board-tier），
// 這裡只放不依賴 DOM 的判斷，方便測試。

export type BoardTier =
    | 'rail'
    | 'railMid'
    | 'railLow'
    | 'wide'
    | 'mid'
    | 'inline'
    | 'lean'
    | 'compact'
    | 'tight'
    | 'strip';

// auto：照面板大小自動選；collapsed：使用者手動收成一行；expanded：使用者手動展開全部統計
export type BoardMode = 'auto' | 'collapsed' | 'expanded';

// 由豐富到精簡。strip（現價與漲跌一行）是保底：面板再矮也不隱藏，價格永遠看得到
export const BOARD_TIERS: readonly BoardTier[] = ['wide', 'mid', 'inline', 'lean', 'compact', 'strip'];

// 個股、期貨看板縮窄時依序收起：漲跌停價 → 開 → 最高最低 → 量比 → 成交量（使用者指定）。
// mid 收漲跌停、lean 收開、compact 收高低（留量與量比）、tight 再收量比（只留量）
export const STOCK_TIERS: readonly BoardTier[] = ['wide', 'mid', 'inline', 'lean', 'compact', 'tight', 'strip'];

// 有日內區間軌的個股（軌道取代右側的高低開停板數字）：
// rail 軌道兩端寫漲跌停價並顯示產業分類，railMid 不寫漲跌停價（軌道變窄時數字再依序收起，見 quote-board.css），
// 放不下時接 mid 起的階梯，不再回到帶漲跌停價的 wide。
// railLow 是面板矮、mid 的高度放不下時的軌道：價格縮小成單行階梯的大小，軌道照樣留著（和 inline 差不多高）
export const RAIL_TIERS: readonly BoardTier[] = [
    'rail',
    'railMid',
    'mid',
    'railLow',
    'inline',
    'lean',
    'compact',
    'tight',
    'strip',
];

// 標題列加看板最多占面板高度的比例（strip 保底時可能略超過）
export const BOARD_HEIGHT_SHARE = 0.2;

// 要升級到比目前更豐富的階梯時，高度多留的緩衝（px）。寬度的緩衝由量測端依字級換算
// （約一個數字寬），避免報價跳動（漲跌跨過 +100、家數跨過百位）時在兩級之間來回閃爍
export const UPGRADE_SLACK_PX = 6;

// 看板可用高度 = 面板高度的 1/5 減掉看板上方已占的高度（標題列）
export function boardBudget(panelHeight: number, aboveBoardHeight: number): number {
    return panelHeight * BOARD_HEIGHT_SHARE - aboveBoardHeight;
}

// measure(tier, upgrading) 回傳該階梯實際排版後的看板高度（px）；橫向放不下（被裁切、擠出）
// 回傳 Infinity，upgrading 時量測端要求橫向多留緩衝。從最豐富的開始試，第一個放得下的就用；
// 升級（比 current 豐富）時高度多留 UPGRADE_SLACK_PX，降級立即生效。都放不下就用 strip。
export function pickBoardTier(
    measure: (tier: BoardTier, upgrading: boolean) => number,
    budget: number,
    current?: BoardTier,
    tiers: readonly BoardTier[] = BOARD_TIERS,
): BoardTier {
    const currentIdx = current === undefined ? 0 : tiers.indexOf(current);
    for (const [i, tier] of tiers.entries()) {
        if (tier === 'strip') return tier;
        const upgrading = i < currentIdx;
        if (measure(tier, upgrading) + (upgrading ? UPGRADE_SLACK_PX : 0) <= budget) return tier;
    }
    return 'strip';
}

export function isRichTier(tier: BoardTier): boolean {
    return tier === 'rail' || tier === 'railMid' || tier === 'wide' || tier === 'mid';
}

// 手動模式優先於自動結果。展開要看到最完整的版面：expandedTier 由量測端依「橫向放不放得下」挑
// （有軌道的個股，rail 放得下就用，否則用 wide；不看高度預算，因為使用者明確要求展開）
export function effectiveTier(mode: BoardMode, auto: BoardTier, expandedTier: BoardTier = 'wide'): BoardTier {
    if (mode === 'collapsed') return 'strip';
    if (mode === 'expanded') return expandedTier;
    return auto;
}

// 按鈕依標示的意圖切換，每按一下「完整（rail、railMid、wide、mid）／精簡」一定翻轉：
// 標示「收合」時結果必須是精簡，自動結果剛好精簡就回自動，否則手動收合；
// 標示「展開」時結果必須是完整，自動結果剛好完整就回自動，否則手動展開
export function nextBoardMode(mode: BoardMode, auto: BoardTier): BoardMode {
    const autoRich = isRichTier(auto);
    if (isRichTier(effectiveTier(mode, auto))) return mode !== 'auto' && !autoRich ? 'auto' : 'collapsed';
    return mode !== 'auto' && autoRich ? 'auto' : 'expanded';
}

export function parseBoardMode(raw: string | null): BoardMode {
    return raw === 'collapsed' || raw === 'expanded' ? raw : 'auto';
}
