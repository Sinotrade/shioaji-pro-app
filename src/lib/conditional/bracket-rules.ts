// src/lib/conditional/bracket-rules.ts — 括號單 rules of the 條件單管理面板
// (#226): the per-tier specs one entry order gets and the checks done before
// anything is sent. Pure.

import type { BracketSpec } from '../bracket';
import type { BracketEntryPlan } from '../trigger-engine';

/** #226: the per-tier specs of one panel bracket (entry order accepted). */
export function tierSpecs(base: Omit<BracketSpec, 'quantity' | 'stopPrice' | 'takePrice' | 'tier' | 'rules'>, plan: BracketEntryPlan): BracketSpec[] {
    const entryQuantity = plan.tiers.reduce((s, t) => s + t.quantity, 0);
    const trailAll = !!plan.trail && plan.tiers.every(t => t.takeTicks !== null);
    let offset = 0;
    return plan.tiers.map((t, index) => {
        const spec: BracketSpec = { ...base, quantity: t.quantity, stopPrice: null, takePrice: null,
            tier: { index, count: plan.tiers.length, offset, entryQuantity },
            rules: { stopTicks: plan.stopTicks, takeTicks: t.takeTicks,
                trail: plan.trail && (t.takeTicks === null || trailAll) ? plan.trail : null, breakeven: plan.breakeven } };
        offset += t.quantity;
        return spec;
    });
}

/** #226: problems of a panel bracket's rules (null: fine). */
export function bracketPlanProblem(plan: BracketEntryPlan): string | null {
    if (!plan.tiers.length || plan.tiers.length > 3) return '停利最多 3 層';
    if (!Number.isSafeInteger(plan.stopTicks) || plan.stopTicks <= 0) return '停損檔數必須是正整數';
    for (const t of plan.tiers) {
        if (!Number.isSafeInteger(t.quantity) || t.quantity <= 0) return '每層數量必須是正整數';
        if (t.takeTicks !== null && (!Number.isSafeInteger(t.takeTicks) || t.takeTicks <= 0)) return '停利檔數必須是正整數';
    }
    if (plan.tiers.some(t => t.takeTicks === null) && !plan.trail) return '沒有停利價的那一層需要開啟移動停損';
    if (plan.trail) {
        const { activateTicks, distanceTicks, stepTicks } = plan.trail;
        if (![activateTicks, distanceTicks, stepTicks].every(n => Number.isSafeInteger(n) && n >= 0) || distanceTicks <= 0 || stepTicks <= 0) {
            return '移動停損的啟動、距離與移動檔數要填正整數';
        }
    }
    if (plan.breakeven && (!Number.isSafeInteger(plan.breakeven.offsetTicks) || plan.breakeven.offsetTicks < 0
        || plan.breakeven.afterTier < 1 || plan.breakeven.afterTier > plan.tiers.length || plan.tiers[plan.breakeven.afterTier - 1]!.takeTicks === null)) {
        return '保本要選有停利價的一層';
    }
    return null;
}

