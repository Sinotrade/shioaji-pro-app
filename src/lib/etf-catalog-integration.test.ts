import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import snapshot from './data/etf-catalog.json';
import { ETF_SOURCE_ROUTES } from './public-metadata-routes';
import type { ContractInfo } from './types/contract';

// Synthetic metadata changes, never market quotes or trading calls.
const source = vi.hoisted(() => ({ bases: vi.fn(), names: vi.fn(), info: vi.fn(), futures: vi.fn(),
    warrants: vi.fn(), publicFetch: vi.fn() }));
vi.mock('./runtime', () => ({ getApiBase: () => 'http://fixture-etf-integration', isTauri: false }));
vi.mock('./utils/date', () => ({ todayStr: () => '2026-10-17' }));
vi.mock('./shioaji', () => ({
    fetchContracts: source.bases, fetchWarrantUnderlyings: source.names, fetchContractInfo: source.info,
    resolveContract: source.info, fetchFutures: source.futures, fetchWarrants: source.warrants,
    fetchFuturesRoots: async () => [], fetchOptionRoots: async () => [], fetchOptions: async () => [],
    normalizeContractCode: (code: string) => code.toUpperCase(),
}));

const urls = snapshot.sources.map(row => row.url);
const routes = [ETF_SOURCE_ROUTES.tseFunds, ETF_SOURCE_ROUTES.otcFunds, ETF_SOURCE_ROUTES.tseNames];
const officialName = snapshot.entries.find(row => row.code === '0053' && row.exchange === 'TSE')!.name;
const stock = (code = '0053', name = '服務端名稱', exchange: ContractInfo['exchange'] = 'TSE'): ContractInfo => ({
    code, name, security_type: 'STK', exchange, region: 'TW', target_code: null,
    currency: 'TWD', reference: 10, limit_up: 11, limit_down: 9, day_trade: '', update_date: '',
    category: '', margin_trading_balance: 0, short_selling_balance: 0,
});
const future = (code: string): ContractInfo => ({ ...stock(code), security_type: 'FUT', exchange: 'TAIFEX',
    name: '驗收 ETF 期貨', underlying_code: '0053', target_code: `${code}:target` });
function payloads() {
    const tse = snapshot.entries.filter(row => row.exchange === 'TSE').map(row => ({
        基金代號: row.code, 基金簡稱: row.aliases?.[0] ?? row.name,
        基金中文名稱: row.aliases?.[1] ?? '', 出表日期: '1151016',
    }));
    const otc = { status: 'success', data: snapshot.entries.filter(row => row.exchange === 'OTC')
        .map(row => ({ stockNo: row.code, stockName: row.name })) };
    const daily = snapshot.entries.filter(row => row.exchange === 'TSE')
        .map(row => ({ Code: row.code, Name: row.name, Date: '1151016' }));
    const count = snapshot.sources.find(row => row.url === urls[2])!.count;
    for (let i = daily.length; i < count; i++) daily.push({ Code: `X${String(i).padStart(5, '0')}`, Name: `合成非 ETF ${i}`, Date: '1151016' });
    return { tse, otc, daily };
}
function respond(data = payloads()) {
    source.publicFetch.mockImplementation(async (url: string) => new Response(JSON.stringify(
        url === routes[0] ? data.tse : url === routes[1] ? data.otc : data.daily,
    ), { headers: { 'Content-Type': 'application/json' } }));
}
const codes = (rows: { code: string }[]) => rows.map(row => row.code);
function renamed(name: string) {
    const data = payloads();
    data.daily.find(row => row.Code === '0053')!.Name = name;
    return data;
}

beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T06:00:00Z'));
    vi.stubEnv('DEV', false);
    vi.stubGlobal('fetch', source.publicFetch);
    source.bases.mockResolvedValue({ region: 'TW', contracts: [stock()] });
    source.names.mockResolvedValue([{ underlying_code: '0053', name: '服務端名稱' }]);
    source.info.mockResolvedValue(stock());
    source.futures.mockResolvedValue([future('NKFR2'), future('NKFR1')]);
    source.warrants.mockResolvedValue([]);
    respond();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('ETF source authority and search integration', () => {
    it('a changed official name joins the aliases under the broker display name, rebuilding rows without refetching Base/underlyings', async () => {
        respond(renamed('合成官方新名'));
        const runtime = await import('./etf-runtime-catalog');
        const { loadStockCatalog } = await import('./stock-index');
        const before = await loadStockCatalog();
        expect(before[0]?.name).toBe('服務端名稱');
        const changed = vi.fn();
        const unsubscribe = runtime.subscribeEtfNames(changed);
        await runtime.refreshEtfNames();
        expect(runtime.getEtfNamesVersion()).toBe(1);
        expect(changed).toHaveBeenCalledOnce();
        const after = await loadStockCatalog();
        expect(after[0]?.name).toBe('服務端名稱');
        expect(after[0]?.aliases).toEqual(expect.arrayContaining(['合成官方新名', officialName]));
        expect(after).not.toBe(before);
        expect(await loadStockCatalog()).toBe(after);
        expect(source.bases).toHaveBeenCalledOnce();
        expect(source.names).toHaveBeenCalledOnce();
        expect(source.publicFetch).toHaveBeenCalledTimes(3);
        unsubscribe();
    });

    it('code, official name and broker name share the broker display name and related ordering without mutating Info', async () => {
        const runtime = await import('./etf-runtime-catalog');
        await runtime.refreshEtfNames();
        const { searchProducts } = await import('./product-search');
        const byCode = await searchProducts('0053', 8, { includeWarrants: true });
        const byName = await searchProducts(officialName, 8, { includeWarrants: true });
        const byAlias = await searchProducts('服務端名稱', 8, { includeWarrants: true });
        for (const rows of [byCode, byName, byAlias]) {
            expect(rows[0]?.name).toBe('服務端名稱');
            expect(codes(rows)).toEqual(['0053', 'NKFR1', 'NKFR2']);
        }
        expect(byCode[0]?.contract?.name).toBe('服務端名稱');
        expect(byCode[0]?.contract?.reference).toBe(10);
        expect(source.futures).toHaveBeenCalledOnce();
        expect(source.bases).toHaveBeenCalledOnce();
        expect(source.names).toHaveBeenCalledOnce();
    });

    it('does not put the slow public source on the sidecar search critical path', async () => {
        const runtime = await import('./etf-runtime-catalog');
        source.publicFetch.mockImplementation(() => new Promise(() => undefined));
        const refresh = runtime.refreshEtfNames();
        const { loadStockCatalog } = await import('./stock-index');
        expect((await loadStockCatalog())[0]?.name).toBe('服務端名稱');
        const { searchProducts } = await import('./product-search');
        expect(codes(await searchProducts('0053', 8, { includeWarrants: true }))).toEqual(['0053', 'NKFR1', 'NKFR2']);
        expect(runtime.getEtfNamesStatus().phase).toBe('refreshing');
        await vi.advanceTimersByTimeAsync(5000);
        await refresh;
        expect(runtime.getEtfNamesStatus()).toMatchObject({ phase: 'error', usingSnapshot: true });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('cannot manufacture a new supported ETF from the official name catalog or borrow its name across exchanges', async () => {
        const data = payloads();
        expect(snapshot.entries.some(row => row.code === '00999Z')).toBe(false);
        data.tse.push({ 基金代號: '00999Z', 基金簡稱: '驗收新 ETF', 基金中文名稱: '驗收新 ETF 完整名稱', 出表日期: '1151016' });
        data.daily.push({ Code: '00999Z', Name: '驗收新 ETF', Date: '1151016' });
        respond(data);
        const runtime = await import('./etf-runtime-catalog');
        await runtime.refreshEtfNames();
        expect(runtime.etfNameForLive('00999Z', 'TSE')?.name).toBe('驗收新 ETF');
        const { loadStockCatalog } = await import('./stock-index');
        expect(codes(await loadStockCatalog())).not.toContain('00999Z');
        const { searchProducts } = await import('./product-search');
        expect(await searchProducts('驗收新 ETF')).toEqual([]);
        source.bases.mockResolvedValue({ region: 'TW', contracts: [stock('0053', '', 'OTC')] });
        const { invalidateProductCatalog } = await import('./product-catalog-version');
        invalidateProductCatalog({ region: 'TW', base_changed: true, info_changed: false });
        const differentExchange = await loadStockCatalog();
        expect(differentExchange[0]).toMatchObject({ name: '服務端名稱', exchange: 'OTC' });
        expect(differentExchange[0]?.kind).toBeUndefined();
        expect(differentExchange[0]?.aliases).toBeUndefined();
    });

    it('rejects an old name-generation publication but reuses valid shared derivative data in the new search', async () => {
        let finish!: (rows: ContractInfo[]) => void;
        source.futures.mockReturnValue(new Promise<ContractInfo[]>(resolve => { finish = resolve; }));
        const { searchProducts } = await import('./product-search');
        const pending = searchProducts('0053', 8, { includeWarrants: true });
        const rejected = expect(pending).rejects.toThrow('名稱目錄已更新');
        await vi.advanceTimersByTimeAsync(0);
        respond(renamed('合成官方新名'));
        const runtime = await import('./etf-runtime-catalog');
        await runtime.refreshEtfNames();
        finish([future('NKFR1'), future('NKFR2')]);
        await rejected;
        const current = await searchProducts('0053', 8, { includeWarrants: true });
        expect(current[0]?.name).toBe('服務端名稱');
        expect(codes(current)).toEqual(['0053', 'NKFR1', 'NKFR2']);
        expect(source.futures).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });
});
