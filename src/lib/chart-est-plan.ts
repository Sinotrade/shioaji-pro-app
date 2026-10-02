import type { Action } from './types/order';

export type EstSide = 'long' | 'short';
export type EstStageIndex = 1 | 2 | 3;

export interface EstStage {
    index: EstStageIndex;
    enabled: boolean;
    entry: number;
    stop: number;
    target: number;
    quantity: number;
}

export interface EstPlan {
    side: EstSide;
    riskBudget: number;
    pointValue: number;
    roundTripCostPoints: number;
    multiStage: boolean;
    stages: [EstStage, EstStage, EstStage];
}

export function defaultEstPlan(side: EstSide, last: number, tick: number, pointValue = 200): EstPlan {
    const step = Math.max(tick * 20, Math.round(last * 0.002 / tick) * tick);
    const sign = side === 'long' ? 1 : -1;
    const stage = (index: EstStageIndex): EstStage => ({
        index,
        enabled: index === 1,
        entry: last - sign * step * (index - 1),
        stop: last - sign * step * index,
        target: last + sign * step * (4 - index),
        quantity: 1,
    });
    return {
        side,
        riskBudget: 25_000,
        pointValue,
        roundTripCostPoints: 5,
        multiStage: false,
        stages: [stage(1), stage(2), stage(3)],
    };
}

export function activeEstStages(plan: EstPlan): EstStage[] {
    return plan.stages.filter((stage) => stage.index === 1 || (plan.multiStage && stage.enabled));
}

export function estAction(side: EstSide): Action {
    return side === 'long' ? 'Buy' : 'Sell';
}

export function estStageRisk(stage: EstStage, plan: EstPlan): number {
    return (Math.abs(stage.entry - stage.stop) + plan.roundTripCostPoints) * plan.pointValue * stage.quantity;
}

export function estPlanRisk(plan: EstPlan): number {
    return activeEstStages(plan).reduce((sum, stage) => sum + estStageRisk(stage, plan), 0);
}

export function estPlanErrors(plan: EstPlan, last: number): string[] {
    const errors: string[] = [];
    for (const stage of activeEstStages(plan)) {
        if (![stage.entry, stage.stop, stage.target].every((n) => Number.isFinite(n) && n > 0)) {
            errors.push(`第 ${stage.index} 段 E/S/T 必須是正數`);
        }
        if (!Number.isSafeInteger(stage.quantity) || stage.quantity < 1) errors.push(`第 ${stage.index} 段口數必須是正整數`);
        if (plan.side === 'long' && !(stage.stop < stage.entry && stage.entry < stage.target)) {
            errors.push(`第 ${stage.index} 段做多須符合 S < E < T`);
        }
        if (plan.side === 'short' && !(stage.target < stage.entry && stage.entry < stage.stop)) {
            errors.push(`第 ${stage.index} 段做空須符合 T < E < S`);
        }
        // The public trigger engine intentionally has no entry-trigger kind.
        // Until that capability exists, accept only resting limit entries so a
        // breakout line can never be mistaken for an immediately marketable LMT.
        if (plan.side === 'long' && stage.entry > last) errors.push(`第 ${stage.index} 段突破買進尚未支援；E 必須不高於現價`);
        if (plan.side === 'short' && stage.entry < last) errors.push(`第 ${stage.index} 段跌破賣出尚未支援；E 必須不低於現價`);
    }
    if (!Number.isFinite(plan.riskBudget) || plan.riskBudget <= 0) errors.push('風險上限必須大於 0');
    if (!Number.isFinite(plan.pointValue) || plan.pointValue <= 0) errors.push('每點價值必須大於 0');
    const risk = estPlanRisk(plan);
    if (risk > plan.riskBudget) errors.push(`總風險 ${Math.round(risk).toLocaleString()} 超過上限 ${Math.round(plan.riskBudget).toLocaleString()}`);
    return errors;
}
