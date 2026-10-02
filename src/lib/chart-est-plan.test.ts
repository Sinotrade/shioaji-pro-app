import { describe, expect, it } from 'vitest';
import { activeEstStages, defaultEstPlan, estPlanErrors, estPlanRisk } from './chart-est-plan';

describe('圖形 E/S/T 多段計畫', () => {
    it('建立多單預設幾何並含 5 點成本', () => {
        const p = defaultEstPlan('long', 48000, 1);
        expect(p.stages[0]).toMatchObject({ entry: 48000, stop: 47904, target: 48288, quantity: 1 });
        expect(estPlanRisk(p)).toBe((96 + 5) * 200);
        expect(estPlanErrors(p, 48000)).toEqual([]);
    });

    it('多段只計算啟用列並合計風險', () => {
        const p = defaultEstPlan('short', 48000, 1);
        p.multiStage = true;
        p.stages[1].enabled = true;
        p.stages[2].enabled = false;
        expect(activeEstStages(p).map((s) => s.index)).toEqual([1, 2]);
        expect(estPlanRisk(p)).toBeGreaterThan(0);
    });

    it('拒絕方向錯誤、超額與會立即成交的突破 E', () => {
        const p = defaultEstPlan('long', 48000, 1);
        p.stages[0].entry = 48100;
        p.stages[0].stop = 48200;
        p.riskBudget = 1;
        expect(estPlanErrors(p, 48000).join('；')).toMatch(/S < E < T/);
        expect(estPlanErrors(p, 48000).join('；')).toMatch(/突破買進尚未支援/);
        expect(estPlanErrors(p, 48000).join('；')).toMatch(/超過上限/);
    });
});
