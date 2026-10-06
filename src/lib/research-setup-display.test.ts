import { describe, expect, it } from 'vitest';
import { researchSetupDisplay, type ResearchSetupEvaluation, type ResearchVwapEvaluation } from './research-setup-display';

const confirmed: ResearchSetupEvaluation = {
    state: 'confirmed', label: '順勢回踩研究確認', detail: '最新已收5分K確認',
    side: 'long', setup: 'pullback', confirmedAt: 100, patternTime: 90,
};
const ready: ResearchVwapEvaluation = { status: 'ready', reason: '完整開盤起算', points: [] };

describe('independent research setup display gate', () => {
    it('only displays confirmation with fresh data and proven VWAP coverage', () => {
        expect(researchSetupDisplay(confirmed, ready, { state: 'fresh' }).label).toBe(confirmed.label);
        expect(researchSetupDisplay(confirmed, ready, { state: 'fresh' }).tone).toBe('long');
        for (const state of ['stale', 'unknown', 'closed', 'loading'] as const) {
            expect(researchSetupDisplay(confirmed, ready, { state }).label).not.toContain('研究確認');
        }
        expect(researchSetupDisplay(confirmed, ready).label).not.toContain('研究確認');
        expect(researchSetupDisplay(confirmed, ready, { state: 'fresh' }, true).label).toContain('載入');
    });
    it('explains partial opening/gap evidence and zero data without inventing a value', () => {
        const partial = { ...ready, status: 'partial' as const, reason: '缺開盤第一分鐘' };
        expect(researchSetupDisplay(confirmed, partial, { state: 'fresh' })).toMatchObject({
            label: '等待型態資料', detail: '缺開盤第一分鐘', tone: 'insufficient',
        });
        expect(researchSetupDisplay({ ...confirmed, state: 'waiting-data' }, ready, { state: 'fresh' }).label).toBe('等待型態資料');
    });
});
