import { afterEach, describe, expect, it, vi } from 'vitest';
import { researchDecision } from './research-decision';
import * as entry from './research-entry';
import type { V9Resonance, V9ResonanceSide } from './utils/research-chart';

function resonance(sides: V9ResonanceSide[]): V9Resonance {
    return {
        summary: 'test', asOf: 123,
        frames: sides.map((side, index) => ({
            minutes: [1, 5, 60, 1440][index] as 1 | 5 | 60 | 1440,
            label: ['1分', '5分', '60分', '日K'][index] as '1分' | '5分' | '60分' | '日K',
            side, bars: side === 'insufficient' ? 10 : 117, requiredBars: 117,
        })),
    };
}
afterEach(() => vi.restoreAllMocks());

describe('researchDecision', () => {
    it('separates higher-timeframe background from short-term direction', () => {
        const decision = researchDecision(resonance(['short', 'short', 'long', 'long']), { state: 'fresh' });
        expect(decision.background).toMatchObject({ tone: 'long', label: '背景偏多' });
        expect(decision.shortTerm).toMatchObject({ tone: 'short', label: '短線偏空' });
        expect(decision.entryLabel).toBe('方向分歧');
        expect(decision.reasons.join()).toContain('高週期背景與短線方向分歧');
    });
    it('never treats four matching direction votes as entry authorization', () => {
        for (const side of ['long', 'short'] as const) {
            const decision = researchDecision(resonance([side, side, side, side]), { state: 'fresh' });
            expect(decision.entryLabel).toBe('等待資料');
            expect(decision.reasons.join()).toContain('固定已收5分K');
            expect(decision.reasons.join()).toContain('不是已驗證進場條件');
        }
    });
    it('does not infer the daily background from available lower timeframes', () => {
        const decision = researchDecision(resonance(['long', 'long', 'long', 'insufficient']), { state: 'fresh' });
        expect(decision.background.tone).toBe('insufficient');
        expect(decision.background.label).toBe('背景：60分多／日K不足');
        expect(decision.shortTerm.tone).toBe('long');
        expect(decision.reasons.join()).toContain('日K 10/117');
        expect(decision.entryLabel).toBe('等待資料');
    });
    it('gates stale, unknown and loading state instead of displaying old direction', () => {
        const allLong = resonance(['long', 'long', 'long', 'long']);
        for (const state of ['stale', 'unknown', 'loading'] as const) {
            const decision = researchDecision(allLong, { state });
            expect(decision.background.tone).toBe('insufficient');
            expect(decision.shortTerm.tone).toBe('insufficient');
            expect(decision.entryLabel).not.toBe('等待確認');
        }
        expect(researchDecision(allLong, { state: 'fresh' }, true).entryLabel).toBe('等待資料');
        expect(researchDecision(allLong).entryLabel).toBe('不可確認');
    });
    it('shows a closed session as review rather than disconnection or stale', () => {
        const decision = researchDecision(resonance(['short', 'short', 'short', 'short']), { state: 'closed', reason: '夜盤已收盤' });
        expect(decision.entryLabel).toBe('休市回顧');
        expect(decision.shortTerm.tone).toBe('short');
        expect(decision.reasons.join()).toContain('不是行情斷線');
        expect(decision.reasons).toContain('夜盤已收盤');
    });
    it('handles no bars and mixed neutral directions conservatively', () => {
        expect(researchDecision(null, { state: 'fresh' }).entryLabel).toBe('等待資料');
        const decision = researchDecision(resonance(['long', 'short', 'neutral', 'neutral']), { state: 'fresh' });
        expect(decision.shortTerm.label).toBe('短線分歧');
        expect(decision.background.label).toBe('背景未同向');
    });
    it('preserves known direction in a partial pair while keeping insufficient tone', () => {
        const short = researchDecision(resonance(['short', 'insufficient', 'insufficient', 'neutral']), { state: 'fresh' });
        expect(short.shortTerm).toMatchObject({ tone: 'insufficient', label: '短線：1分空／5分不足' });
        expect(short.background).toMatchObject({ tone: 'insufficient', label: '背景：60分不足／日K中性' });
        expect(short.entryLabel).toBe('等待資料');
    });
    it('keeps the concise waiting label when both role frames are missing', () => {
        const decision = researchDecision(resonance(['insufficient', 'insufficient', 'insufficient', 'insufficient']), { state: 'fresh' });
        expect(decision.shortTerm).toMatchObject({ tone: 'insufficient', label: '短線待資料' });
        expect(decision.background).toMatchObject({ tone: 'insufficient', label: '背景待資料' });
        expect(decision.entryLabel).toBe('等待資料');
    });
    it('explicitly labels conflicts inside either pair and any neutral direction', () => {
        expect(researchDecision(resonance(['long', 'short', 'long', 'long']), { state: 'fresh' }).entryLabel).toBe('方向分歧');
        expect(researchDecision(resonance(['long', 'long', 'short', 'long']), { state: 'fresh' }).entryLabel).toBe('方向分歧');
        expect(researchDecision(resonance(['neutral', 'neutral', 'neutral', 'neutral']), { state: 'fresh' }).entryLabel).toBe('方向未同向');
        expect(researchDecision(resonance(['long', 'neutral', 'long', 'long']), { state: 'fresh' }).entryLabel).toBe('方向未同向');
    });
    it('evaluates fixed-5-minute inspection only after fresh and truly same-side directions', () => {
        const ctx: entry.ResearchEntryContext = { closedFiveMinuteBars: [], securityType: 'STK', now: 123 };
        const inspect = vi.spyOn(entry, 'researchEntry').mockReturnValue({ side: 'long', label: '研究觸發多', checks: [
            { id: 'trigger', label: 'SuperTrend', state: 'pass', detail: '最新已收5分K新觸發' },
        ] });
        const same = resonance(['long', 'long', 'long', 'long']);
        for (const state of ['stale', 'unknown', 'loading', 'closed'] as const)
            researchDecision(same, { state }, false, ctx);
        researchDecision(resonance(['long', 'short', 'long', 'long']), { state: 'fresh' }, false, ctx);
        researchDecision(resonance(['long', 'long', 'neutral', 'long']), { state: 'fresh' }, false, ctx);
        researchDecision(resonance(['long', 'long', 'long', 'insufficient']), { state: 'fresh' }, false, ctx);
        expect(inspect).not.toHaveBeenCalled();
        const result = researchDecision(same, { state: 'fresh' }, false, ctx);
        expect(inspect).toHaveBeenCalledExactlyOnceWith(ctx, 'long');
        expect(result.entryLabel).toBe('研究觸發多');
        expect(result.entrySide).toBe('long');
        expect(result.entryChecks.map(check => check.id)).toEqual(['direction', 'trigger']);
        expect(result.reasons.join()).toContain('非正式進場策略');
    });
    it('returns missing fixed-data and checklist reasons rather than vague waiting', () => {
        const ctx: entry.ResearchEntryContext = { closedFiveMinuteBars: [], securityType: 'STK', now: 123 };
        const result = researchDecision(resonance(['short', 'short', 'short', 'short']), { state: 'fresh' }, false, ctx);
        expect(result.entryLabel).toBe('等待資料');
        expect(result.entryChecks.map(check => check.id)).toEqual(['direction', 'data', 'ema', 'atr', 'trigger']);
        expect(result.reasons.join()).toContain('尚無本時段最新已收5分K');
    });
    it('prioritizes loading even if a previous symbol status still says fresh', () => {
        const inspect = vi.spyOn(entry, 'researchEntry');
        const result = researchDecision(resonance(['long', 'long', 'long', 'long']), { state: 'fresh' }, true,
            { closedFiveMinuteBars: [], securityType: 'STK', now: 123 });
        expect(result.entryLabel).toBe('等待資料');
        expect(result.entryChecks).toEqual([]);
        expect(inspect).not.toHaveBeenCalled();
    });
});
