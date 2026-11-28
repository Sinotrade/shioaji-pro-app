// 商品搜尋併入美股代碼命中：只在美股清單已載入時；建議帶 region 與連動 key
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { UsContractRecord } from './types/us';

const mocks = vi.hoisted(() => ({
    base: 'http://fixture.test',
    day: '2026-11-18',
    catalog: vi.fn(),
    futures: vi.fn(),
    futureRoots: vi.fn(),
    resolve: vi.fn(),
    bases: vi.fn(),
    usInfo: vi.fn(),
    usList: vi.fn(),
}));
vi.mock('./runtime', () => ({ getApiBase: () => mocks.base }));
vi.mock('./utils/date', () => ({ todayStr: () => mocks.day }));
vi.mock('./shioaji', () => ({
    fetchFutures: mocks.futures,
    fetchFuturesRoots: mocks.futureRoots,
    fetchOptions: vi.fn().mockResolvedValue([]),
    fetchOptionRoots: vi.fn().mockResolvedValue([]),
    fetchWarrants: vi.fn().mockResolvedValue([]),
    resolveContract: mocks.resolve,
    fetchContracts: mocks.bases,
    normalizeContractCode: (code: string) => code.trim().toUpperCase(),
}));
vi.mock('./stock-index', async (original) => ({
    ...await original<object>(),
    loadStockCatalog: mocks.catalog,
}));
vi.mock('./us/us-api', () => ({
    fetchUsContractInfo: mocks.usInfo,
    fetchUsContractList: mocks.usList,
}));

const usRows: UsContractRecord[] = [
    { code: 'AAPL', exchange: 'NASDAQ', region: 'US', security_type: 'STK' },
    { code: 'AAP', exchange: 'NYSE', region: 'US', security_type: 'STK' },
    { code: 'T', exchange: 'NYSE', region: 'US', security_type: 'STK' },
    { code: 'TSLA', exchange: 'NASDAQ', region: 'US', security_type: 'STK' },
];

async function load() {
    const us = await import('./us/us-contracts');
    const search = await import('./product-search');
    return { us, search };
}

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.bases.mockResolvedValue({ region: 'TW', contracts: [] });
    mocks.catalog.mockResolvedValue([]);
    mocks.futures.mockResolvedValue([]);
    mocks.futureRoots.mockResolvedValue([]);
    mocks.resolve.mockRejectedValue(Object.assign(new Error('Contract not found'), { status: 404 }));
    mocks.usInfo.mockImplementation(async (code: string) => ({
        code, exchange: usRows.find(r => r.code === code)?.exchange ?? 'NYSE', name: `${code} Inc.`,
        short_name: code === 'AAPL' ? 'Apple' : null, reference: '187.5', reference_date: '2026-11-17', currency: 'USD',
    }));
});
afterEach(() => vi.useRealTimers());

describe('US hits in product search', () => {
    it('adds nothing while the US catalog is not loaded (and never loads it itself)', async () => {
        const { search } = await load();
        const rows = await search.searchProducts('AAPL', 8).catch(() => []);
        expect(rows.every(row => row.region !== 'US')).toBe(true);
        expect(mocks.usList).not.toHaveBeenCalled();
    });

    it('merges US code hits with region, link key, name and a 美股 detail', async () => {
        const { us, search } = await load();
        us.setUsContractsForTest(usRows);
        const rows = await search.searchProducts('AAP', 8);
        expect(rows.map(row => row.key)).toEqual(['US:AAP', 'US:AAPL']);
        expect(rows[0]).toMatchObject({ code: 'AAP', region: 'US', exchange: 'NYSE', security_type: 'STK', detail: '美股 · NYSE', name: 'AAP Inc.' });
        expect(rows[1]).toMatchObject({ code: 'AAPL', name: 'Apple', exchange: 'NASDAQ' });
        expect(rows[1]!.contract).toMatchObject({ region: 'US', exchange: 'NASDAQ', currency: 'USD', us_reference: '187.5' });
        expect(search.suggestionLinkKey(rows[1]!)).toBe('US:AAPL');
        // 名稱逐筆查 info，不打台股 region=TW 的合約查詢給美股
        expect(mocks.usInfo).toHaveBeenCalledWith('AAPL');
    });

    it('keeps a TW T and a US T as two suggestions with different keys', async () => {
        const { us, search } = await load();
        us.setUsContractsForTest(usRows);
        mocks.catalog.mockResolvedValue([{ code: 'T', name: '台測', exchange: 'TSE', category: '' }]);
        const rows = await search.searchProducts('T', 8);
        const tw = rows.find(row => row.code === 'T' && row.region !== 'US');
        const usT = rows.find(row => row.code === 'T' && row.region === 'US');
        expect(tw).toBeDefined();
        expect(usT?.key).toBe('US:T');
        expect(search.suggestionLinkKey(tw!)).toBe('T');
        // TW 完全相同的代碼排前面
        expect(rows.indexOf(tw!)).toBeLessThan(rows.indexOf(usT!));
    });

    it('finds a US stock by English or Chinese company name once the catalog is loaded', async () => {
        const { us, search } = await load();
        us.setUsContractsForTest(usRows);
        for (const query of ['apple', 'Apple Inc', '蘋果']) {
            const rows = await search.searchProducts(query, 8);
            const us0 = rows.filter(row => row.region === 'US');
            expect(us0.map(row => row.key), query).toEqual(['US:AAPL']);
            expect(us0[0]).toMatchObject({ exchange: 'NASDAQ', security_type: 'STK', detail: '美股 · NASDAQ' });
        }
    });

    it('does not suggest a name hit whose code is not in the US catalog', async () => {
        const { us, search } = await load();
        us.setUsContractsForTest(usRows);
        // 名稱表有 Microsoft，但這份美股清單沒有 MSFT
        const rows = await search.searchProducts('microsoft', 8);
        expect(rows.some(row => row.region === 'US')).toBe(false);
    });

    it('still shows the name hits that are in the catalog when others are missing from it', async () => {
        const { us, search } = await load();
        // 名稱表裡 micro 開頭的 MU、MCHP、MSFT、MSTR 都不在這份清單，只剩單字開頭的 AMD
        us.setUsContractsForTest([...usRows, { code: 'AMD', exchange: 'NASDAQ', region: 'US', security_type: 'STK' }]);
        const rows = await search.searchProducts('micro', 8);
        expect(rows.filter(row => row.region === 'US').map(row => row.key)).toEqual(['US:AMD']);
    });

    it('adds nothing for a name while the US catalog is not loaded (and never loads it itself)', async () => {
        const { search } = await load();
        const rows = await search.searchProducts('apple', 8);
        expect(rows.some(row => row.region === 'US')).toBe(false);
        expect(mocks.usList).not.toHaveBeenCalled();
    });

    it('lists a code once when it matches by both code and name', async () => {
        const { us, search } = await load();
        us.setUsContractsForTest([...usRows, { code: 'ON', exchange: 'NASDAQ', region: 'US', security_type: 'STK' }]);
        const rows = await search.searchProducts('on', 8);
        expect(rows.filter(row => row.key === 'US:ON')).toHaveLength(1);
    });

    it('keeps TW first and adds the US ADR below when a Chinese name matches both', async () => {
        const { us, search } = await load();
        us.setUsContractsForTest([...usRows, { code: 'TSM', exchange: 'NYSE', region: 'US', security_type: 'STK' }]);
        mocks.catalog.mockResolvedValue([{ code: '2330', name: '台積電', exchange: 'TSE', category: '' }]);
        const keys = (await search.searchProducts('台積電', 8)).map(row => row.key ?? row.code);
        expect(keys).toContain('US:TSM');
        expect(keys.indexOf('2330')).toBeGreaterThanOrEqual(0);
        expect(keys.indexOf('2330')).toBeLessThan(keys.indexOf('US:TSM'));
    });

    it('keeps Taiwan futures for a generic two-character word that is also a US name prefix', async () => {
        const { us, search } = await load();
        // 美國電力（AEP）、美國銀行（BAC）、美國運通（AXP）的名稱開頭都是「美國」
        us.setUsContractsForTest(['AEP', 'BAC', 'AXP', 'AIG'].map(code => ({ code, exchange: 'NYSE', region: 'US', security_type: 'STK' }) as UsContractRecord));
        const roots = [['UNF', '美國那斯達克100期貨'], ['SPF', '美國標普500期貨'], ['UDF', '美國道瓊期貨'], ['SXF', '美國費城半導體期貨']];
        mocks.futureRoots.mockResolvedValue(roots.map(([root, name]) => ({ root, name: `${name} 202612` })));
        mocks.futures.mockImplementation(async ({ root }: { root: string }) => [{
            code: `${root}L6`, name: `${roots.find(([r]) => r === root)![1]} 202612`, security_type: 'FUT', exchange: 'TAIFEX',
            root, delivery_month: '202612', region: 'TW',
        }]);
        const rows = await search.searchProducts('美國', 8);
        expect(rows.map(row => row.code)).toEqual(expect.arrayContaining(['UNFL6', 'SPFL6', 'UDFL6', 'SXFL6']));
        expect(rows.some(row => row.region === 'US')).toBe(false);
        expect(mocks.usInfo).not.toHaveBeenCalled();
    });

    it('does not look up US codes for Chinese names or numeric TW codes', async () => {
        const { us, search } = await load();
        us.setUsContractsForTest(usRows);
        mocks.catalog.mockResolvedValue([{ code: '2330', name: '台積電', exchange: 'TSE', category: '' }]);
        const rows = await search.searchProducts('2330', 8);
        expect(rows.some(row => row.region === 'US')).toBe(false);
        expect(search.looksLikeUsCode('台積電')).toBe(false);
        expect(search.looksLikeUsCode('BRK.B')).toBe(true);
    });
});

describe('mergeUsSuggestions', () => {
    const row = (code: string, region?: 'US') => ({ code, name: code, security_type: 'STK' as const, exchange: region ? 'NYSE' : 'TSE', detail: '',
        ...(region ? { region, key: `US:${code}` } : {}) });
    it('leads with an exact US code when TW has no such code, and reserves slots for US', async () => {
        const { search } = await load();
        const tw = Array.from({ length: 10 }, (_, i) => row(`AA${i}`));
        const merged = search.mergeUsSuggestions(tw, [row('AA', 'US'), row('AAL', 'US'), row('AAP', 'US'), row('AAPL', 'US')], 'aa', 8);
        expect(merged.map(r => r.key ?? r.code)).toEqual(['US:AA', 'AA0', 'AA1', 'AA2', 'AA3', 'US:AAL', 'US:AAP', 'US:AAPL']);
    });
    it('returns TW rows untouched when there are no US hits', async () => {
        const { search } = await load();
        const tw = [row('2330'), row('2317')];
        expect(search.mergeUsSuggestions(tw, [], '23', 8)).toEqual(tw);
    });
});
