import type { QuoteState } from './stream';
import type { ContractInfo } from './types/contract';
import type { Snapshot } from './types/market';
import { marketTime } from './display-book';

export interface ResearchIndustryStock { code: string; name: string }
export interface ResearchIndustryGroup { industry: string; stocks: readonly ResearchIndustryStock[] }

// Transcribed from the user's supplied book table, not a current leader ranking.
// Keep the original industry order, names and codes; never auto-expand the pool.
export const RESEARCH_INDUSTRY_GROUPS: readonly ResearchIndustryGroup[] = [
    { industry: '矽晶圓', stocks: [{ code: '6488', name: '環球晶' }, { code: '5483', name: '中美晶' }, { code: '3532', name: '台勝科' }] },
    { industry: '晶圓代工', stocks: [{ code: '2330', name: '台積電' }, { code: '2303', name: '聯電' }, { code: '5347', name: '世界' }] },
    { industry: '半導體封測', stocks: [{ code: '3711', name: '日月光投控' }] },
    { industry: '驅動IC', stocks: [{ code: '3034', name: '聯詠' }, { code: '3545', name: '敦泰' }, { code: '4961', name: '天鈺' }] },
    { industry: 'IP矽智財', stocks: [{ code: '3443', name: '創意' }, { code: '3035', name: '智原' }] },
    { industry: '手機IC', stocks: [{ code: '2454', name: '聯發科' }] },
    { industry: 'PCB', stocks: [{ code: '2313', name: '華通' }, { code: '4958', name: '臻鼎-KY' }] },
    { industry: 'IC載板', stocks: [{ code: '3037', name: '欣興' }, { code: '8046', name: '南電' }, { code: '3189', name: '景碩' }] },
    { industry: '電子書', stocks: [{ code: '8069', name: '元太' }, { code: '6143', name: '振曜' }] },
    { industry: '被動元件', stocks: [{ code: '2327', name: '國巨' }, { code: '2492', name: '華新科' }] },
    { industry: '原物料', stocks: [{ code: '2002', name: '中鋼' }, { code: '6505', name: '台塑化' }, { code: '1303', name: '南亞' }, { code: '1301', name: '台塑' }, { code: '1326', name: '台化' }] },
    { industry: '貨櫃航運', stocks: [{ code: '2603', name: '長榮' }, { code: '2615', name: '萬海' }, { code: '2609', name: '陽明' }] },
    { industry: '散裝航運', stocks: [{ code: '2637', name: '慧洋-KY' }, { code: '2606', name: '裕民' }, { code: '2605', name: '新興' }] },
    { industry: '重電', stocks: [{ code: '1519', name: '華城' }, { code: '1503', name: '士電' }, { code: '1513', name: '中興電' }, { code: '1514', name: '亞力' }, { code: '4588', name: '玖鼎電力' }, { code: '2371', name: '大同' }] },
    { industry: '散熱', stocks: [{ code: '3017', name: '奇鋐' }, { code: '3324', name: '雙鴻' }, { code: '3653', name: '健策' }, { code: '8996', name: '高力' }] },
    { industry: '光通訊', stocks: [{ code: '3163', name: '波若威' }, { code: '3363', name: '上詮' }, { code: '4977', name: '眾達-KY' }] },
    { industry: '風電', stocks: [{ code: '9958', name: '世紀鋼' }, { code: '6806', name: '森崴能源' }, { code: '3708', name: '上緯投控' }] },
];
export const RESEARCH_INDUSTRY_STOCK_COUNT = RESEARCH_INDUSTRY_GROUPS.reduce((sum, group) => sum + group.stocks.length, 0);

export function filterResearchIndustryGroups(industry: string, query: string): ResearchIndustryGroup[] {
    const search = query.trim().toLocaleLowerCase();
    return RESEARCH_INDUSTRY_GROUPS
        .filter(group => !industry || group.industry === industry)
        .map(group => ({ ...group, stocks: group.stocks.filter(stock => !search || `${stock.code} ${stock.name} ${group.industry}`.toLocaleLowerCase().includes(search)) }))
        .filter(group => group.stocks.length > 0);
}

export interface ResearchObservedPrice {
    price?: number;
    change?: number;
    pct?: number;
    stamp?: string;
    source: '未載入' | '合約未載入' | '已載入逐筆' | '已載入快照' | '試撮';
}
const positive = (value: unknown): number | undefined => {
    if (value === null || value === undefined || value === '') return undefined;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
};
const finite = (value: unknown): number | undefined => {
    if (value === null || value === undefined || value === '') return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
};

/** Pure read of data already loaded by other panels. It owns no network/quotes. */
export function researchObservedPrice(code: string, contract?: ContractInfo, quote?: QuoteState, snapshot?: Snapshot): ResearchObservedPrice {
    if (!contract || contract.code !== code || contract.security_type !== 'STK' || (contract.region && contract.region !== 'TW') || (contract.exchange !== 'TSE' && contract.exchange !== 'OTC')) return { source: '合約未載入' };
    // Current SSE wire has only code, not security/exchange/API identity. Do not
    // invent those fields; reject contradictory provider metadata if supplied.
    const candidate = quote?.tick as (NonNullable<QuoteState['tick']> & { security_type?: string; exchange?: string; region?: string }) | undefined;
    const tick = candidate?.code === code && (!candidate.security_type || candidate.security_type === 'STK') && (!candidate.exchange || candidate.exchange === contract.exchange) && (!candidate.region || candidate.region === 'TW') ? candidate : undefined;
    const tickPrice = positive(tick?.close);
    const tickTime = marketTime(tick?.date, tick?.time);
    const snapTime = marketTime(snapshot?.datetime);
    const snapPrice = snapshot?.code === code && snapshot.exchange === contract.exchange && Number.isFinite(snapTime) ? positive(snapshot.close) : undefined;
    if (tick && tickPrice !== undefined && Number.isFinite(tickTime) && (snapPrice === undefined || tickTime >= snapTime)) {
        const change = finite(tick.price_chg) ?? (positive(contract.reference) ? tickPrice - contract.reference : undefined);
        const reference = (change !== undefined ? positive(tickPrice - change) : undefined) ?? positive(contract.reference);
        return { price: tickPrice, change, pct: change !== undefined && reference !== undefined ? change / reference * 100 : undefined,
            stamp: `${tick.date} ${tick.time}`, source: tick.simtrade ? '試撮' : '已載入逐筆' };
    }
    if (snapshot && snapPrice !== undefined) return { price: snapPrice, change: finite(snapshot.change_price), pct: finite(snapshot.change_rate), stamp: snapshot.datetime, source: '已載入快照' };
    return { source: '未載入' };
}
