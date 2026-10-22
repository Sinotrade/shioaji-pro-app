import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractBase, ContractInfo } from './types/contract';
import type { ContractChangeEvent } from './stream';

// Independent QA fixtures model metadata changes, not market quotes. Network
// access and watchlist/order mutations are intentionally unavailable here.
const source = vi.hoisted(() => ({
    base: 'http://fixture-product-catalog',
    day: '2026-10-17',
    stocks: [] as ContractBase[],
    indices: [] as ContractBase[],
    names: [] as { underlying_code: string; name: string }[],
    detailName: '驗收原名稱',
    bases: vi.fn(), namesRequest: vi.fn(), info: vi.fn(), resolve: vi.fn(),
    futures: vi.fn(), futureRoots: vi.fn(), options: vi.fn(), optionRoots: vi.fn(), warrants: vi.fn(),
}));

vi.mock('./runtime', () => ({ getApiBase: () => source.base }));
vi.mock('./utils/date', () => ({ todayStr: () => source.day }));
vi.mock('./shioaji', () => ({
    fetchContracts: source.bases,
    fetchWarrantUnderlyings: source.namesRequest,
    fetchContractInfo: source.info,
    resolveContract: source.resolve,
    fetchFutures: source.futures,
    fetchFuturesRoots: source.futureRoots,
    fetchOptions: source.options,
    fetchOptionRoots: source.optionRoots,
    fetchWarrants: source.warrants,
    normalizeContractCode: (code: string) => code.trim().toUpperCase(),
}));

const base = (code: string, exchange: ContractBase['exchange'] = 'TSE'): ContractBase => ({
    code, exchange, security_type: 'STK', target_code: null,
});
function contract(code: string, type: 'STK' | 'FUT' | 'WRT', fields: Partial<ContractInfo> = {}): ContractInfo {
    return {
        ...base(code, type === 'FUT' ? 'TAIFEX' : 'TSE'), security_type: type, name: code,
        currency: 'TWD', reference: 0, limit_up: 0, limit_down: 0, day_trade: '',
        update_date: '', category: '', margin_trading_balance: 0, short_selling_balance: 0,
        ...fields,
    };
}
async function emit(fields: Partial<ContractChangeEvent> = {}): Promise<void> {
    const event: ContractChangeEvent = {
        event_id: `qa:${source.day}`, action: 'UPDATE', region: 'TW', security_type: 'STK',
        published_at: `${source.day}T06:00:00Z`, base_changed: true, info_changed: false,
        info_scope: null, info_shards: [], ...fields,
    };
    const { invalidateProductCatalog } = await import('./product-catalog-version');
    invalidateProductCatalog(event);
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
const codes = (rows: { code: string }[]) => rows.map(row => row.code);

beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T06:00:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('QA prohibits external network access')));
    source.base = 'http://fixture-product-catalog';
    source.day = '2026-10-17';
    source.detailName = '驗收原名稱';
    source.stocks = [base('2330')];
    source.indices = [];
    source.names = [{ underlying_code: '2330', name: '台積電' }];
    source.bases.mockImplementation(async (type: string) => ({
        contracts: [...(type === 'STK' ? source.stocks : type === 'IND' ? source.indices : [])], security_type: type,
        region: 'TW', total: type === 'STK' ? source.stocks.length : type === 'IND' ? source.indices.length : 0,
    }));
    source.namesRequest.mockImplementation(async () => [...source.names]);
    source.info.mockImplementation(async (code: string) => contract(code, 'STK', { name: source.detailName }));
    source.resolve.mockRejectedValue(Object.assign(new Error('fixture: not found'), { status: 404 }));
    source.futures.mockResolvedValue([]);
    source.futureRoots.mockResolvedValue([]);
    source.options.mockResolvedValue([]);
    source.optionRoots.mockResolvedValue([]);
    source.warrants.mockResolvedValue([]);
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('商品目錄異動的獨立驗收', () => {
    it('短暫快取內不輪詢，60 秒後下一次讀取加入新商品並移除原商品', async () => {
        const { loadStockCatalog, searchStocks } = await import('./stock-index');
        expect(codes(await loadStockCatalog())).toEqual(['2330']);
        source.stocks = [base('9999')];
        source.names = [{ underlying_code: '9999', name: '驗收新掛牌' }];
        expect(codes(await loadStockCatalog())).toEqual(['2330']);
        expect(source.bases).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(60_001);
        const fresh = await loadStockCatalog();
        expect(codes(fresh)).toEqual(['9999']);
        expect(searchStocks(fresh, '驗收新掛牌')[0]?.code).toBe('9999');
        expect(searchStocks(fresh, '台積電')).toEqual([]);
        expect(source.bases).toHaveBeenCalledTimes(2);
    });

    it('保留商品身分，60 秒後更新 live 名稱且不繼續命中非 ETF 舊名', async () => {
        source.names = [{ underlying_code: '2330', name: '驗收更名前' }];
        const { loadStockCatalog, searchStocks } = await import('./stock-index');
        expect((await loadStockCatalog())[0]?.name).toBe('驗收更名前');
        source.names = [{ underlying_code: '2330', name: '驗收更名後' }];
        await vi.advanceTimersByTimeAsync(60_001);
        const fresh = await loadStockCatalog();
        expect(searchStocks(fresh, '驗收更名後')[0]?.code).toBe('2330');
        expect(searchStocks(fresh, '驗收更名前')).toEqual([]);
    });

    it('官方 ETF 補名不得增加 live Base 不存在的商品，也不得跨交易所借名', async () => {
        source.stocks = [base('0051', 'OTC'), base('2330')];
        source.names = [];
        const { loadStockCatalog, searchStocks } = await import('./stock-index');
        const catalog = await loadStockCatalog();
        expect(codes(catalog)).toEqual(['0051', '2330']);
        expect(catalog[0]).toMatchObject({ code: '0051', exchange: 'OTC', name: '0051' });
        expect(catalog[0]?.kind).toBeUndefined();
        expect(searchStocks(catalog, '元大中型100')).toEqual([]);
        expect(searchStocks(catalog, '元大美債20年')).toEqual([]);
    });

    it('live ETF 更名優先於隨 App 快照，舊官方名稱仍只作同身分別名', async () => {
        source.stocks = [base('0051')];
        source.names = [{ underlying_code: '0051', name: '驗收 ETF 即時更名' }];
        const { loadStockCatalog, searchStocks } = await import('./stock-index');
        const catalog = await loadStockCatalog();
        expect(catalog[0]).toMatchObject({ code: '0051', name: '驗收 ETF 即時更名', kind: 'ETF' });
        expect(searchStocks(catalog, '驗收 ETF 即時更名')[0]?.code).toBe('0051');
        expect(searchStocks(catalog, '元大中型100')[0]?.code).toBe('0051');
    });

    it('ETF 從 live Base 移除後，即使補名快照仍存在也不可再搜尋到', async () => {
        source.stocks = [base('0051')];
        source.names = [];
        const { loadStockCatalog, searchStocks } = await import('./stock-index');
        expect(searchStocks(await loadStockCatalog(), '元大中型100')[0]?.code).toBe('0051');
        source.stocks = [];
        await vi.advanceTimersByTimeAsync(60_001);
        expect(searchStocks(await loadStockCatalog(), '元大中型100')).toEqual([]);
    });

    it('同 URL 的 Base 變更事件立即使成功快取失效，不必等 60 秒', async () => {
        const { loadStockCatalog } = await import('./stock-index');
        await loadStockCatalog();
        source.stocks = [base('9999')];
        source.names = [{ underlying_code: '9999', name: '驗收新掛牌' }];
        await emit();
        expect(codes(await loadStockCatalog())).toEqual(['9999']);
        expect(source.bases).toHaveBeenCalledTimes(2);
        expect(source.namesRequest).toHaveBeenCalledTimes(2);
    });

    it.each(['RECONNECT', 'MAINTENANCE'])('同 URL 的 %s 重新讀取目錄，不沿用前一程序快取', async action => {
        const { loadStockCatalog } = await import('./stock-index');
        await loadStockCatalog();
        source.stocks = [base('9999')];
        await emit({ action, security_type: null, base_changed: true, info_changed: true, info_scope: 'ALL' });
        expect(codes(await loadStockCatalog())).toEqual(['9999']);
        expect(source.bases).toHaveBeenCalledTimes(2);
    });

    it('無變更事件或其他區域事件不使台灣商品目錄重抓', async () => {
        const { loadStockCatalog } = await import('./stock-index');
        await loadStockCatalog();
        await emit({ base_changed: false, info_changed: false });
        await emit({ region: 'US', base_changed: true, info_changed: true });
        await loadStockCatalog();
        expect(source.bases).toHaveBeenCalledTimes(1);
        expect(source.namesRequest).toHaveBeenCalledTimes(1);
    });

    it('同 URL 的 Info 變更同時更新名稱來源與已快取的完整 metadata', async () => {
        const { loadStockCatalog, loadStockDetails } = await import('./stock-index');
        await loadStockCatalog();
        expect((await loadStockDetails(['2330']))[0]?.name).toBe('驗收原名稱');
        source.detailName = '驗收更新 metadata';
        source.names = [{ underlying_code: '2330', name: '驗收更新名稱' }];
        await emit({ base_changed: false, info_changed: true, info_scope: 'SHARDS', info_shards: ['STK'] });
        expect((await loadStockCatalog())[0]?.name).toBe('驗收更新名稱');
        expect((await loadStockDetails(['2330']))[0]?.name).toBe('驗收更新 metadata');
        expect(source.info).toHaveBeenCalledTimes(2);
    });

    it('事件前的目錄來源即使忽略 AbortSignal 晚回，也不能覆蓋新一代目錄', async () => {
        const old = deferred<{ contracts: ContractBase[] }>();
        source.bases.mockReturnValueOnce(old.promise);
        const { loadStockCatalog } = await import('./stock-index');
        const pending = loadStockCatalog();
        const rejected = expect(pending).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(0);
        source.stocks = [base('9999')];
        source.names = [{ underlying_code: '9999', name: '驗收事件後' }];
        await emit();
        expect(codes(await loadStockCatalog())).toEqual(['9999']);
        old.resolve({ contracts: [base('2330')] });
        await rejected;
        expect(codes(await loadStockCatalog())).toEqual(['9999']);
    });

    it('事件前的完整 metadata 晚回，不可污染同 URL 新一代 detail cache', async () => {
        const old = deferred<ContractInfo>();
        source.info.mockReturnValueOnce(old.promise);
        const { loadStockDetails } = await import('./stock-index');
        const pending = loadStockDetails(['2330']);
        source.detailName = '驗收事件後 metadata';
        await emit({ base_changed: false, info_changed: true, info_scope: 'ALL' });
        expect((await loadStockDetails(['2330']))[0]?.name).toBe('驗收事件後 metadata');
        old.resolve(contract('2330', 'STK', { name: '驗收過期 metadata' }));
        expect(await pending).toEqual([]);
        expect((await loadStockDetails(['2330']))[0]?.name).toBe('驗收事件後 metadata');
    });
});

describe('關聯商品更新不改變既有排序', () => {
    const family = (target: string) => ['CDFR1', 'QFFR1', 'CDFR2', 'QFFR2'].map((code, index) => contract(code, 'FUT', {
        name: `${index % 2 ? '小型' : ''}台積電期貨`, underlying_code: '2330',
        delivery_month: index < 2 ? '202610' : '202611', target_code: `${target}:${code}`,
    }));
    const warrant = (code: string) => contract(code, 'WRT', {
        name: '台積電驗收權證', underlying_code: '2330', expiry_date: '2026-12-31', last_trading_date: '2026-12-29',
    });

    it('同 URL 期貨／權證事件更新 target 與商品身分，仍為現股、近月大小、次月大小、權證', async () => {
        source.futures.mockResolvedValue(family('before').reverse());
        source.warrants.mockResolvedValue([warrant('OLDWRT')]);
        const { searchProducts } = await import('./product-search');
        expect(codes(await searchProducts('台積電', 8, { includeWarrants: true })))
            .toEqual(['2330', 'CDFR1', 'QFFR1', 'CDFR2', 'QFFR2', 'OLDWRT']);
        source.futures.mockResolvedValue(family('after').reverse());
        source.warrants.mockResolvedValue([warrant('NEWWRT')]);
        await emit({ security_type: 'FUT', info_changed: true, info_scope: 'ALL' });
        const rows = await searchProducts('台積電', 8, { includeWarrants: true });
        expect(codes(rows)).toEqual(['2330', 'CDFR1', 'QFFR1', 'CDFR2', 'QFFR2', 'NEWWRT']);
        expect(rows[1]?.contract?.target_code).toBe('after:CDFR1');
        expect(source.futures).toHaveBeenCalledTimes(2);
        expect(source.warrants).toHaveBeenCalledTimes(2);
    });

    it('台灣日期切換會重查相關商品，舊日期可用的權證不延用到新日期', async () => {
        source.futures.mockResolvedValue(family('before'));
        source.warrants.mockResolvedValue([warrant('LASTDAY')].map(row => ({ ...row, last_trading_date: '2026-10-17' })));
        const { searchProducts } = await import('./product-search');
        expect(codes(await searchProducts('台積電', 8, { includeWarrants: true }))).toContain('LASTDAY');
        source.day = '2026-10-18';
        source.futures.mockResolvedValue(family('after'));
        const rows = await searchProducts('台積電', 8, { includeWarrants: true });
        expect(codes(rows)).not.toContain('LASTDAY');
        expect(rows[1]?.contract?.target_code).toBe('after:CDFR1');
        expect(source.futures).toHaveBeenCalledTimes(2);
        expect(source.warrants).toHaveBeenCalledTimes(2);
        expect(source.warrants).toHaveBeenLastCalledWith('2330', { expiryFrom: '2026-10-18' }, expect.any(Object));
    });
});

describe('指數名稱只是別名，商品身分必須存在於 live IND Base', () => {
    it('精確名稱也不能讓不支援的櫃買指數繞過 live Base', async () => {
        const { searchProducts } = await import('./product-search');
        expect(await searchProducts('櫃買指數')).toEqual([]);
        expect(source.bases.mock.calls.some(([type]) => type === 'IND')).toBe(true);
        expect(source.info).not.toHaveBeenCalled();
    });

    it('live Base 支援同 code 與 exchange 才保留指數名稱，不逐筆讀取 Info', async () => {
        source.indices = [{ ...base('IX0043', 'OTC'), security_type: 'IND' }];
        const { searchProducts } = await import('./product-search');
        expect((await searchProducts('櫃買指數'))[0])
            .toMatchObject({ code: 'IX0043', name: '櫃買指數', exchange: 'OTC', security_type: 'IND' });
        expect(source.info).not.toHaveBeenCalled();
        expect(source.resolve).not.toHaveBeenCalled();
    });

    it('相同指數代碼出現在錯誤交易所時，不套用另一市場的靜態名稱', async () => {
        source.indices = [{ ...base('IX0043', 'TSE'), security_type: 'IND' }];
        const { searchProducts } = await import('./product-search');
        expect(await searchProducts('櫃買指數')).toEqual([]);
    });

    it('同 URL 商品更新移除指數後，舊別名不會讓已移除身分重新出現', async () => {
        source.indices = [{ ...base('IX0043', 'OTC'), security_type: 'IND' }];
        const { searchProducts } = await import('./product-search');
        expect(codes(await searchProducts('櫃買指數'))).toEqual(['IX0043']);
        source.indices = [];
        await emit({ security_type: 'IND' });
        expect(await searchProducts('櫃買指數')).toEqual([]);
        expect(source.bases.mock.calls.filter(([type]) => type === 'IND')).toHaveLength(2);
    });

    it('不在名稱快照的新指數，仍可透過直接代碼取得 sidecar 身分', async () => {
        source.resolve.mockResolvedValue({ ...contract('NEWINDEX', 'STK'), security_type: 'IND', name: '驗收新指數', exchange: 'OTC' });
        const { searchProducts } = await import('./product-search');
        expect((await searchProducts('NEWINDEX'))[0])
            .toMatchObject({ code: 'NEWINDEX', name: '驗收新指數', exchange: 'OTC', security_type: 'IND' });
    });
});
