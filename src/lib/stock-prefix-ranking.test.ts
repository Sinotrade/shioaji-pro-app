import { describe, expect, it, vi } from 'vitest';
import { searchStocks, type StockMeta } from './stock-index';
import type { ContractInfo } from './types/contract';

const source = vi.hoisted(() => ({ bases: vi.fn(), resolve: vi.fn() }));
vi.mock('./runtime', () => ({ getApiBase: () => 'http://prefix-regression', isTauri: false }));
vi.mock('./shioaji', () => ({
    fetchContracts: source.bases, resolveContract: source.resolve,
    fetchWarrantUnderlyings: async () => [], fetchContractInfo: vi.fn(),
    fetchFutures: async () => [], fetchFuturesRoots: async () => [],
    fetchOptionRoots: async () => [], fetchOptions: async () => [], fetchWarrants: async () => [],
    normalizeContractCode: (code: string) => code.trim().toUpperCase(),
}));

// Synthetic catalog fixtures test ranking only, not current listing status.
const stock = (code: string, name: string, rest: Partial<StockMeta> = {}): StockMeta => ({
    code, name, exchange: 'TSE', category: '', ...rest,
});
const codes = (rows: StockMeta[]) => rows.map(row => row.code);

describe('已知 ETF 的數字代碼前綴排序', () => {
    it('00981 系列 A/B 依代碼排序，排在不相關名稱及 exact alias 之前', () => {
        const catalog = [
            stock('00888', '短名', { kind: 'ETF', aliases: ['00981'] }),
            stock('00981B', '合成系列債券', { kind: 'ETF', exchange: 'OTC' }),
            stock('7777', '00981'),
            stock('00981A', '合成系列股票基金名稱長於債券基金', { kind: 'ETF' }),
        ];
        expect(codes(searchStocks(catalog, '00981'))).toEqual(['00981A', '00981B', '7777', '00888']);
        expect(codes(searchStocks(catalog, '００９８１', 2))).toEqual(['00981A', '00981B']);
    });

    it('完整代碼優先於同系列及同名 alias，即使名稱較長', () => {
        const catalog = [
            stock('00981B', '短', { kind: 'ETF', aliases: ['00981A'] }),
            stock('00981A', '合成完整代碼的較長名稱'.repeat(15), { kind: 'ETF' }),
            stock('00888', '00981A', { kind: 'ETF' }),
        ];
        expect(searchStocks(catalog, '00981a')[0]?.code).toBe('00981A');
    });

    it('完整數字代碼仍先於後綴系列，且只有現有 catalog 身分會出現', () => {
        const catalog = [
            stock('00981B', '合成債券系列', { kind: 'ETF' }),
            stock('00981', '合成完整代碼名稱'.repeat(15), { kind: 'ETF' }),
        ];
        expect(codes(searchStocks(catalog, '00981'))).toEqual(['00981', '00981B']);
        expect(codes(searchStocks(catalog, '00981A'))).toEqual([]);
    });

    it('字母後綴不自動歸類 ETF，亦不改原物件名稱或類型', () => {
        const ordinary = stock('00981X', 'X');
        const bond = stock('00981B', '合成債券名稱很長'.repeat(15), { kind: 'ETF', exchange: 'OTC' });
        const catalog = [ordinary, bond];
        expect(searchStocks(catalog, '00981')).toEqual([bond, ordinary]);
        expect(ordinary).not.toHaveProperty('kind');
        expect(bond).toMatchObject({ name: '合成債券名稱很長'.repeat(15), kind: 'ETF', exchange: 'OTC' });
    });

    it('非 ETF 的同分結果保留 catalog 原順序', () => {
        const catalog = [stock('2339', '測試乙'), stock('2331', '測試甲'), stock('2332', '測試丙')];
        expect(codes(searchStocks(catalog, '233'))).toEqual(['2339', '2331', '2332']);
        expect(codes(searchStocks(catalog, '測試'))).toEqual(['2339', '2331', '2332']);
    });

    it('非數字 query 的 ETF 同分結果也沿用原順序', () => {
        const catalog = [stock('00982A', '合成乙', { kind: 'ETF' }), stock('00981A', '合成甲', { kind: 'ETF' })];
        expect(codes(searchStocks(catalog, '合成'))).toEqual(['00982A', '00981A']);
    });

    it('ETF 前綴系列代碼相同時以 exchange 為次排序鍵', () => {
        const catalog = [
            stock('00981A', '甲', { kind: 'ETF', exchange: 'TSE' }),
            stock('00981A', '合成較長名稱', { kind: 'ETF', exchange: 'OTC' }),
        ];
        expect(searchStocks(catalog, '00981').map(row => row.exchange)).toEqual(['OTC', 'TSE']);
    });

    it('searchProducts 真正入口將已知字母系列排在數字延伸前，完整數字代碼仍第一', async () => {
        // Synthetic live Base subset backed by reviewed ETF metadata; no current availability claim.
        const liveCodes = ['009810', '009811', '009812', '009813', '009814', '009815', '009816', '009817', '009818', '009819', '00981T', '00981D', '00981B', '00981A'];
        source.bases.mockResolvedValue({ contracts: liveCodes.map(code => ({ code,
            exchange: code === '00981B' || code === '00981D' ? 'OTC' : 'TSE', security_type: 'STK', target_code: null })) });
        const exact: ContractInfo = { code: '009810', name: '玉山全球藍籌100', exchange: 'TSE', security_type: 'STK', region: 'TW', target_code: null,
            currency: 'TWD', reference: 0, limit_up: 0, limit_down: 0, day_trade: '', update_date: '', category: '',
            margin_trading_balance: 0, short_selling_balance: 0 };
        source.resolve.mockImplementation(async code => {
            if (code === exact.code) return exact;
            throw Object.assign(new Error('Not found'), { status: 404 });
        });
        const { searchProducts } = await import('./product-search');
        const result = await searchProducts('00981', 10);
        expect(result.slice(0, 4).map(row => row.code)).toEqual(['00981A', '00981B', '00981D', '00981T']);
        expect(result[4]?.code).toBe('009810');
        expect(result.every(row => row.kind === 'ETF')).toBe(true);
        expect((await searchProducts('009810', 10))[0]?.code).toBe('009810');
    });
});
