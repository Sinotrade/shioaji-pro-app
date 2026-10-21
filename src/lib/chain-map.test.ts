import { describe, expect, it } from 'vitest';
import { fmtSignedPct, fmtTwd, isKbarCode, memberCodes, orderedStages, stageMembers, stockContract, themeCodes } from './chain-map';
import type { Theme } from './company-data/types';

const member = (id: string, stage: string) => ({
    id,
    stage,
    tier: 'midstream' as const,
    detail: null,
    as_of: null,
    confidence: 'high' as Theme['members'][number]['confidence'],
});

const theme: Theme = {
    id: 'theme.test',
    kind: 'theme',
    name: '測試',
    aliases: [],
    related: [],
    stages: [
        { id: 'down', name: '下游', tier: 'downstream' },
        { id: 'mid', name: '中游', tier: 'midstream' },
        { id: 'up', name: '上游', tier: 'upstream' },
    ],
    members: [member('tw.2330', 'mid'), member('tw.2330', 'mid'), member('tw.3008', 'up'), member('us.NVDA', 'down'), member('tw.00878', 'down')],
    as_of: null,
};

describe('chain structure', () => {
    it('orders stages upstream → midstream → downstream', () => {
        expect(orderedStages(theme).map((s) => s.id)).toEqual(['up', 'mid', 'down']);
    });

    it('collects Taiwan members once, per theme and per stage', () => {
        expect(memberCodes([theme, theme])).toEqual(['2330', '3008', '00878']);
        expect(themeCodes(theme)).toEqual(['2330', '3008', '00878']);
        expect(Object.fromEntries(stageMembers(theme))).toEqual({ down: ['00878'], mid: ['2330'], up: ['3008'] });
    });

    it('builds stock contracts by market and filters K-bar codes', () => {
        expect(stockContract('6488', 'tpex')).toEqual({ security_type: 'STK', exchange: 'OTC', code: '6488', target_code: null });
        expect(stockContract('2330', 'twse').exchange).toBe('TSE');
        expect(isKbarCode('2330')).toBe(true);
        expect(isKbarCode('00878')).toBe(false);
        expect(isKbarCode('910861')).toBe(false);
    });
});

describe('formatting', () => {
    it('formats TWD amounts in 兆 / 億 / 萬 with an optional sign', () => {
        expect(fmtTwd(1.234e12)).toBe('1.23 兆');
        expect(fmtTwd(5.1e10)).toBe('510 億');
        expect(fmtTwd(2.34e9, true)).toBe('+23.4 億');
        expect(fmtTwd(-1.5e8)).toBe('−1.50 億');
        expect(fmtTwd(-56_000_000)).toBe('−5,600 萬');
        expect(fmtTwd(0)).toBe('0');
        expect(fmtTwd(null)).toBe('--');
        expect(fmtSignedPct(1.234)).toBe('+1.23%');
        expect(fmtSignedPct(-0.5, 1)).toBe('-0.5%');
        expect(fmtSignedPct(Number.NaN)).toBe('--');
    });
});
