import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from './types/contract';

const m = vi.hoisted(() => ({
    equityVersion: 0, etfVersion: 0, snapshot: true,
    equity: new Map<string, { name: string; aliases: readonly string[] }>(),
    etfs: new Map<string, { name: string; aliases: string[] }>(),
    ensure: vi.fn(), refreshEtf: vi.fn(), bases: vi.fn(), names: vi.fn(), info: vi.fn(), resolve: vi.fn(),
    futures: vi.fn(), futureRoots: vi.fn(), roots: vi.fn(), options: vi.fn(), warrants: vi.fn(),
}));
vi.mock('./runtime', () => ({ getApiBase: () => 'http://names-integration' }));
vi.mock('./utils/date', () => ({ todayStr: () => '2026-10-17' }));
vi.mock('./stock-runtime-catalog', () => ({
    equityNameForLive: (exchange: string, code: string) => m.equity.get(`${exchange}:${code}`),
    getEquityNamesVersion: () => m.equityVersion, ensureEquityNamesFresh: m.ensure,
}));
vi.mock('./etf-runtime-catalog', () => ({
    etfNameForLive: (code: string, exchange: string) => m.etfs.get(`${exchange}:${code}`),
    getEtfNamesVersion: () => m.etfVersion, getEtfNamesStatus: () => ({ usingSnapshot: m.snapshot }), refreshEtfNames: m.refreshEtf,
}));
vi.mock('./shioaji', () => ({
    fetchContracts: m.bases, fetchWarrantUnderlyings: m.names, fetchContractInfo: m.info, resolveContract: m.resolve,
    fetchFutures: m.futures, fetchFuturesRoots: m.futureRoots, fetchOptionRoots: m.roots,
    fetchOptions: m.options, fetchWarrants: m.warrants, normalizeContractCode: (code: string) => code.trim().toUpperCase(),
}));
function info(fields: Partial<ContractInfo> = {}): ContractInfo {
    return { code: '2330', name: '券商舊名稱', security_type: 'STK', exchange: 'TSE', region: 'TW', target_code: null,
        currency: 'TWD', reference: 1000, limit_up: 1100, limit_down: 900, day_trade: '', update_date: '', category: '',
        margin_trading_balance: 0, short_selling_balance: 0, ...fields };
}
beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks();
    m.equityVersion = 0; m.etfVersion = 0; m.snapshot = true;
    m.equity.clear(); m.etfs.clear();
    m.bases.mockResolvedValue({ contracts: [info()] });
    m.names.mockResolvedValue([{ underlying_code: '2330', name: '券商舊名稱' }]);
    m.info.mockResolvedValue(info());
    m.resolve.mockResolvedValue(info());
    m.futures.mockResolvedValue([]); m.futureRoots.mockResolvedValue([]); m.warrants.mockResolvedValue([]);
    m.roots.mockResolvedValue([{ root: 'CDA', name: '台積電選擇權' }, { root: 'CDO', name: '台積電週選擇權' }]);
    m.options.mockImplementation(async root => [info({ code: `${root}QA`, name: '台積電選擇權', security_type: 'OPT',
        exchange: 'TAIFEX', root, underlying_code: '2330', delivery_month: '202610' })]);
});

describe('shared official ordinary stock display policy', () => {
    it('uses official short name and full/broker aliases, intersects exchange/code with live Base only', async () => {
        m.equity.set('TSE:2330', { name: '台積電', aliases: ['台灣積體電路製造股份有限公司'] });
        m.equity.set('TSE:9999', { name: '不存在於 Base', aliases: [] });
        m.equity.set('OTC:2330', { name: '合成另一市場', aliases: [] });
        const { loadStockCatalog, searchStocks } = await import('./stock-index');
        const catalog = await loadStockCatalog();
        expect(catalog).toEqual([{ code: '2330', name: '台積電', exchange: 'TSE', category: '',
            aliases: ['台灣積體電路製造股份有限公司', '券商舊名稱'] }]);
        expect(searchStocks(catalog, '券商舊名稱')[0]?.code).toBe('2330');
        expect(searchStocks(catalog, '台灣積體電路製造股份有限公司')[0]?.code).toBe('2330');
        expect(m.info).not.toHaveBeenCalled();
    });

    it('equity version invalidates assembled names without refetching Base or mutating prior rows', async () => {
        const { loadStockCatalog } = await import('./stock-index');
        const before = await loadStockCatalog();
        expect(await loadStockCatalog()).toBe(before);
        m.equity.set('TSE:2330', { name: '台積電', aliases: ['台灣積體電路製造股份有限公司'] });
        m.equityVersion++;
        const after = await loadStockCatalog();
        expect(after).not.toBe(before);
        expect(after[0]?.name).toBe('台積電');
        expect(before[0]?.name).toBe('券商舊名稱');
        expect(await loadStockCatalog()).toBe(after);
        expect(m.bases).toHaveBeenCalledTimes(1);
        expect(m.names).toHaveBeenCalledTimes(1);
    });

    it('direct code shares display policy while preserving the broker ContractInfo and prices', async () => {
        m.equity.set('TSE:2330', { name: '台積電', aliases: ['台灣積體電路製造股份有限公司'] });
        const result = await (await import('./product-search')).searchProducts('2330');
        expect(result[0]).toMatchObject({ code: '2330', name: '台積電', contract: { name: '券商舊名稱', reference: 1000 } });
        expect(m.info).not.toHaveBeenCalled();
    });

    it('official catalog names avoid F6 Info and resolve both option roots', async () => {
        m.names.mockRejectedValue(new Error('No broker names'));
        m.equity.set('TSE:2330', { name: '台積電', aliases: [] });
        const result = await (await import('./product-search')).searchProducts('2330選擇權', 20);
        expect(result.map(row => row.code)).toEqual(['2330', 'CDAQA', 'CDOQA']);
        expect(m.info).not.toHaveBeenCalled();
    });

    it('display priority preserves ETF authority and rejects unsupported ordinary identity classes', async () => {
        const { stockDisplayMeta } = await import('./stock-index');
        m.equity.set('TSE:2330', { name: '一般股名稱', aliases: [] });
        m.etfs.set('TSE:2330', { name: '合成 ETF 官方名', aliases: ['合成基金別名'] });
        expect(stockDisplayMeta('2330', 'TSE', '券商基金名')).toMatchObject({ name: '券商基金名', kind: 'ETF' });
        m.snapshot = false;
        expect(stockDisplayMeta('2330', 'TSE', '券商基金名')).toMatchObject({ name: '合成 ETF 官方名', kind: 'ETF' });
        for (const code of ['0050', '2330A', '123456', 'IX0001']) {
            m.equity.set(`TSE:${code}`, { name: '不得使用的一般股名稱', aliases: [] });
            expect(stockDisplayMeta(code, 'TSE', '券商名稱')).toEqual({ name: '券商名稱' });
        }
        expect(stockDisplayMeta('2330', 'TAIFEX', '券商名稱')).toEqual({ name: '券商名稱' });
    });

    it('ordinary official absent falls back to broker then code, without manufactured aliases', async () => {
        const { stockDisplayMeta } = await import('./stock-index');
        expect(stockDisplayMeta('2330', 'TSE', '券商名稱')).toEqual({ name: '券商名稱' });
        expect(stockDisplayMeta('2330', 'TSE', '2330')).toEqual({ name: '2330' });
    });

    it('full-name alias matches retain the existing exact-code/short-name priority', async () => {
        m.bases.mockResolvedValue({ contracts: [info(), info({ code: '3456' })] });
        m.equity.set('TSE:2330', { name: '台積電', aliases: ['合成股份有限公司'] });
        m.equity.set('TSE:3456', { name: '股份有限公司', aliases: ['合成完整公司名稱'] });
        const { loadStockCatalog, searchStocks } = await import('./stock-index');
        const catalog = await loadStockCatalog();
        expect(searchStocks(catalog, '股份有限公司').map(row => row.code)).toEqual(['3456', '2330']);
        expect(searchStocks(catalog, '2330')[0]?.code).toBe('2330');
    });
});
