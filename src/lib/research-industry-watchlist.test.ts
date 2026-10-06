import { describe, expect, it } from 'vitest';
import { filterResearchIndustryGroups, RESEARCH_INDUSTRY_GROUPS, RESEARCH_INDUSTRY_STOCK_COUNT, researchObservedPrice } from './research-industry-watchlist';
import { BLOCK_META, isPanelAvailable, V9_RESEARCH_WORKSPACE } from './workspace';
import type { QuoteState } from './stream';
import type { ContractInfo } from './types/contract';
import type { Snapshot } from './types/market';

const contract = { code: '2330', name: '台積電', security_type: 'STK', region: 'TW', exchange: 'TSE', reference: 100 } as ContractInfo;
const quote = (close: string, price_chg?: string): QuoteState => ({ tick: { code: '2330', date: '2026-10-02', time: '13:29:59', close, price_chg }, seq: 1, flashSeq: 1, lastDir: 1 } as QuoteState);
const snapshot = { code: '2330', exchange: 'TSE', close: 101, change_price: 1, change_rate: 1, datetime: '2026-10-02T13:30:00' } as Snapshot;

describe('screenshot industry observation pool', () => {
    it('preserves all 17 groups and 49 unique screenshot stock codes in order', () => {
        expect(RESEARCH_INDUSTRY_GROUPS).toHaveLength(17);
        expect(RESEARCH_INDUSTRY_STOCK_COUNT).toBe(49);
        const codes = RESEARCH_INDUSTRY_GROUPS.flatMap(group => group.stocks.map(stock => stock.code));
        expect(new Set(codes).size).toBe(49);
        expect(codes).toEqual(['6488','5483','3532','2330','2303','5347','3711','3034','3545','4961','3443','3035','2454','2313','4958','3037','8046','3189','8069','6143','2327','2492','2002','6505','1303','1301','1326','2603','2615','2609','2637','2606','2605','1519','1503','1513','1514','4588','2371','3017','3324','3653','8996','3163','3363','4977','9958','6806','3708']);
        expect(RESEARCH_INDUSTRY_GROUPS.find(group => group.industry === '重電')?.stocks.find(stock => stock.code === '4588')?.name).toBe('玖鼎電力');
    });
    it('filters industry and case-insensitive stock name/code without mutating the source', () => {
        expect(filterResearchIndustryGroups('散熱', '')[0]?.stocks).toHaveLength(4);
        expect(filterResearchIndustryGroups('', '  2330 ')).toEqual([{ industry: '晶圓代工', stocks: [{ code: '2330', name: '台積電' }] }]);
        expect(filterResearchIndustryGroups('', '台塑').flatMap(group => group.stocks.map(stock => stock.code))).toEqual(['6505', '1301']);
        expect(filterResearchIndustryGroups('貨櫃航運', '台積')).toEqual([]);
        expect(filterResearchIndustryGroups('', 'ky').flatMap(group => group.stocks)).toHaveLength(3);
        expect(RESEARCH_INDUSTRY_STOCK_COUNT).toBe(49);
    });
    it('offers an optional research-only panel without replacing the saved/default watchlist', () => {
        expect(BLOCK_META.industrywatch.researchOnly).toBe(true);
        expect(isPanelAvailable('industrywatch', false)).toBe(false);
        expect(isPanelAvailable('industrywatch', true)).toBe(true);
        expect(isPanelAvailable('watchlist', false)).toBe(true);
        expect(V9_RESEARCH_WORKSPACE.blocks.some(block => block.type === 'watchlist')).toBe(true);
        expect(V9_RESEARCH_WORKSPACE.blocks.some(block => block.type === 'industrywatch')).toBe(false);
    });
});

describe('already loaded observation prices', () => {
    it('never synthesizes missing contracts, prices or percentage as zero', () => {
        expect(researchObservedPrice('2330')).toEqual({ source: '合約未載入' });
        expect(researchObservedPrice('2330', contract)).toEqual({ source: '未載入' });
        expect(researchObservedPrice('2330', contract, quote('0'))).toEqual({ source: '未載入' });
        expect(researchObservedPrice('2330', contract, quote('Infinity'))).toEqual({ source: '未載入' });
        expect(researchObservedPrice('2330', { ...contract, security_type: 'FUT' }, quote('105'))).toEqual({ source: '合約未載入' });
        expect(researchObservedPrice('2330', { ...contract, region: 'US' }, quote('105'))).toEqual({ source: '合約未載入' });
        expect(researchObservedPrice('2330', { ...contract, exchange: 'TAIFEX' }, quote('105'))).toEqual({ source: '合約未載入' });
        expect(researchObservedPrice('2330', contract, undefined, { ...snapshot, code: '2303' })).toEqual({ source: '未載入' });
        expect(researchObservedPrice('2330', contract, undefined, { ...snapshot, exchange: 'OTC' })).toEqual({ source: '未載入' });
    });
    it('derives stock change percentages rather than trusting incompatible tick pct_chg units', () => {
        const tick = quote('105', '5');
        tick.tick!.pct_chg = '500';
        expect(researchObservedPrice('2330', contract, tick)).toEqual({ price: 105, change: 5, pct: 5, stamp: '2026-10-02 13:29:59', source: '已載入逐筆' });
        expect(researchObservedPrice('2330', contract, quote('100', '0')).pct).toBe(0);
        expect(researchObservedPrice('2330', { ...contract, reference: 90 }, tick).pct).toBe(5);
    });
    it('uses loaded snapshots when tick data is missing and explicitly marks trial trades', () => {
        expect(researchObservedPrice('2330', contract, undefined, snapshot)).toEqual({ price: 101, change: 1, pct: 1, stamp: snapshot.datetime, source: '已載入快照' });
        const trial = quote('105', '5'); trial.tick!.simtrade = true;
        expect(researchObservedPrice('2330', contract, trial).source).toBe('試撮');
        expect(researchObservedPrice('2330', { ...contract, reference: 0 }, quote('105')).pct).toBeUndefined();
    });
    it('selects the newer timestamp and treats invalid time or contradictory tick identity conservatively', () => {
        expect(researchObservedPrice('2330', contract, quote('105', '5'), snapshot).source).toBe('已載入快照');
        const newer = quote('105', '5'); newer.tick!.time = '13:30:01';
        expect(researchObservedPrice('2330', contract, newer, snapshot).source).toBe('已載入逐筆');
        newer.tick!.date = 'invalid';
        expect(researchObservedPrice('2330', contract, newer).source).toBe('未載入');
        expect(researchObservedPrice('2330', contract, newer, snapshot).source).toBe('已載入快照');
        expect(researchObservedPrice('2330', contract, undefined, { ...snapshot, datetime: '' }).source).toBe('未載入');
        for (const metadata of [{ security_type: 'FUT' }, { exchange: 'OTC' }, { region: 'US' }]) {
            const wrong = quote('105', '5'); Object.assign(wrong.tick!, metadata);
            expect(researchObservedPrice('2330', contract, wrong).source).toBe('未載入');
        }
    });
});
