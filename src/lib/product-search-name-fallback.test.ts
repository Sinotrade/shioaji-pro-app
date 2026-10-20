import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from './types/contract';

const source = vi.hoisted(() => ({
    bases: vi.fn(), names: vi.fn(), info: vi.fn(), resolve: vi.fn(), futures: vi.fn(),
    futureRoots: vi.fn(), optionRoots: vi.fn(), options: vi.fn(), warrants: vi.fn(),
    base: 'http://name-fallback', day: '2026-10-17',
}));
vi.mock('./runtime', () => ({ getApiBase: () => source.base }));
vi.mock('./utils/date', () => ({ todayStr: () => source.day }));
vi.mock('./etf-runtime-catalog', () => ({
    etfNameForLive: () => undefined, getEtfNamesVersion: () => 0,
    getEtfNamesStatus: () => ({ usingSnapshot: true }), refreshEtfNames: async () => undefined,
}));
vi.mock('./stock-runtime-catalog', () => ({
    equityNameForLive: () => undefined, getEquityNamesVersion: () => 0, ensureEquityNamesFresh: () => undefined,
}));
vi.mock('./shioaji', () => ({
    fetchContracts: source.bases, fetchWarrantUnderlyings: source.names, fetchContractInfo: source.info,
    resolveContract: source.resolve, fetchFutures: source.futures, fetchFuturesRoots: source.futureRoots,
    fetchOptionRoots: source.optionRoots, fetchOptions: source.options, fetchWarrants: source.warrants,
    normalizeContractCode: (code: string) => code.trim().toUpperCase(),
}));

function contract(code = '2330', fields: Partial<ContractInfo> = {}): ContractInfo {
    return { code, name: '台積電', region: 'TW', security_type: 'STK', exchange: 'TSE', target_code: null,
        currency: 'TWD', reference: 1000, limit_up: 1100, limit_down: 900, day_trade: '', update_date: '',
        category: '', margin_trading_balance: 0, short_selling_balance: 0, ...fields };
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(finish => { resolve = finish; });
    return { promise, resolve };
}
async function api() { return (await import('./product-search')).searchProducts; }
const codes = (rows: { code: string }[]) => rows.map(row => row.code);
const tick = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T00:00:00+08:00'));
    source.base = 'http://name-fallback';
    source.day = '2026-10-17';
    source.bases.mockResolvedValue({ region: 'TW', contracts: [contract()] });
    source.names.mockRejectedValue(new Error('Optional name source unavailable'));
    source.info.mockImplementation(async (code: string) => contract(code));
    source.resolve.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));
    source.futures.mockResolvedValue([]);
    source.futureRoots.mockResolvedValue([]);
    source.warrants.mockResolvedValue([]);
    source.optionRoots.mockResolvedValue([
        { root: 'CDA', name: '台積電選擇權' }, { root: 'CDO', name: '台積電週選擇權' },
    ]);
    source.options.mockImplementation(async (root: string) => [contract(`${root}QA`, {
        name: '台積電選擇權', security_type: 'OPT', exchange: 'TAIFEX', root,
        underlying_code: '2330', delivery_month: '202610', strike_price: 100,
    })]);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('精確股票代碼選擇權的名稱降級', () => {
    it('名稱來源拒絕時，單一 typed Info 名稱仍命中兩個 roots，且不回填 catalog 或價格', async () => {
        const search = await api();
        const rows = await search('2330選擇權', 20);
        expect(codes(rows)).toEqual(['2330', 'CDAQA', 'CDOQA']);
        expect(rows[0]).toMatchObject({ name: '2330', security_type: 'STK' });
        expect(rows[0]).not.toHaveProperty('contract');
        expect(source.info).toHaveBeenCalledExactlyOnceWith('2330', 'STK', { signal: expect.any(AbortSignal) });
        expect(source.resolve).not.toHaveBeenCalled();
        await expect((await import('./stock-index')).loadStockCatalog()).resolves.toEqual([
            expect.objectContaining({ code: '2330', name: '2330' }),
        ]);
    });

    it('健康名稱目錄維持零額外 Info', async () => {
        source.names.mockResolvedValue([{ underlying_code: '2330', name: '台積電' }]);
        expect(codes(await (await api())('2330選擇權', 20))).toEqual(['2330', 'CDAQA', 'CDOQA']);
        expect(source.info).not.toHaveBeenCalled();
    });

    it.each(['23選擇權', '台積電選擇權', '2330期貨', '2330權證'])('%s 不展開名稱 Info', async query => {
        await (await api())(query, 20, { includeWarrants: true });
        expect(source.info).not.toHaveBeenCalled();
    });

    it('相同代碼有兩個 live exchange 時不猜股票身分', async () => {
        source.bases.mockResolvedValue({ region: 'TW', contracts: [contract(), contract('2330', { exchange: 'OTC' })] });
        await (await api())('2330選擇權', 20);
        expect(source.info).not.toHaveBeenCalled();
    });

    it.each([
        ['wrong code', contract('2317')], ['wrong type', contract('2330', { security_type: 'FUT' })],
        ['wrong exchange', contract('2330', { exchange: 'OTC' })],
        ['foreign region', contract('2330', { region: 'US' })],
        ['missing region', contract('2330', { region: undefined })], ['null', null],
        ['empty name', contract('2330', { name: '' })], ['code name', contract('2330', { name: '2330' })],
    ])('%s 不得用來命中 root，失敗不快取', async (_label, response) => {
        source.info.mockResolvedValueOnce(response);
        const search = await api();
        expect(codes(await search('2330選擇權', 20))).toEqual(['2330']);
        expect(source.options).not.toHaveBeenCalled();
        expect(codes(await search('2330選擇權', 20))).toEqual(['2330', 'CDAQA', 'CDOQA']);
        expect(source.info).toHaveBeenCalledTimes(2);
    });

    it('Info 拒絕時保留有效 STK，下次恢復可重試', async () => {
        source.info.mockRejectedValueOnce(new Error('Info unavailable'));
        const search = await api();
        expect(codes(await search('2330選擇權', 20))).toEqual(['2330']);
        expect(codes(await search('2330選擇權', 20))).toEqual(['2330', 'CDAQA', 'CDOQA']);
        expect(source.info).toHaveBeenCalledTimes(2);
    });

    it('roots 與 Info 並行，雙來源不回應只等一段 1200 ms', async () => {
        source.info.mockReturnValue(new Promise(() => undefined));
        source.optionRoots.mockReturnValue(new Promise(() => undefined));
        const pending = (await api())('2330選擇權', 20);
        await tick();
        expect(source.info).toHaveBeenCalledTimes(1);
        expect(source.optionRoots).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1200);
        expect(codes(await pending)).toEqual(['2330']);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('並行讀者共用一個 Info，取消首位不影響另一位', async () => {
        const result = deferred<ContractInfo>();
        source.info.mockReturnValue(result.promise);
        const search = await api();
        const controller = new AbortController();
        const cancelled = search('2330選擇權', 20, { signal: controller.signal });
        const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
        const survivor = search('2330選擇權', 20);
        await tick();
        expect(source.info).toHaveBeenCalledTimes(1);
        const signal = source.info.mock.calls[0]![2].signal as AbortSignal;
        controller.abort();
        await rejected;
        expect(signal.aborted).toBe(false);
        result.resolve(contract());
        expect(codes(await survivor)).toEqual(['2330', 'CDAQA', 'CDOQA']);
    });

    it.each(['epoch', 'day', 'API'])('%s 改變後舊 Info 不得發布或污染新搜尋', async change => {
        const result = deferred<ContractInfo>();
        source.info.mockReturnValueOnce(result.promise);
        const search = await api();
        const updates = vi.fn();
        const pending = search('2330選擇權', 20, { onUpdate: updates });
        const rejected = expect(pending).rejects.toThrow(/伺服器已切換|商品目錄已更新/);
        await tick();
        const before = updates.mock.calls.length;
        if (change === 'epoch') (await import('./product-catalog-version')).invalidateProductCatalog({
            region: 'TW', base_changed: false, info_changed: true,
        });
        if (change === 'day') source.day = '2026-10-18';
        if (change === 'API') source.base = 'http://name-fallback-new';
        result.resolve(contract());
        await rejected;
        expect(updates).toHaveBeenCalledTimes(before);
        expect(codes(await search('2330選擇權', 20))).toEqual(['2330', 'CDAQA', 'CDOQA']);
        expect(source.info).toHaveBeenCalledTimes(2);
    });

    it('成功名稱共用 60 秒，TTL 到期重新取得', async () => {
        const search = await api();
        await search('2330選擇權');
        await vi.advanceTimersByTimeAsync(59_999);
        await search('2330選擇權');
        expect(source.info).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await search('2330選擇權');
        expect(source.info).toHaveBeenCalledTimes(2);
    });

    it('名稱成功快取限 16 筆並依最近讀取保留', async () => {
        const stocks = Array.from({ length: 17 }, (_, i) => contract(String(2300 + i)));
        source.bases.mockResolvedValue({ region: 'TW', contracts: stocks });
        const search = await api();
        for (const stock of stocks.slice(0, 16)) await search(`${stock.code}選擇權`);
        await search('2300選擇權');
        await search('2316選擇權');
        await search('2300選擇權');
        expect(source.info).toHaveBeenCalledTimes(17);
        await search('2301選擇權');
        expect(source.info).toHaveBeenCalledTimes(18);
    });

    it('全讀者取消後中止 Info，晚回不快取', async () => {
        const result = deferred<ContractInfo>();
        source.info.mockReturnValueOnce(result.promise);
        const search = await api();
        const controller = new AbortController();
        const pending = search('2330選擇權', 20, { signal: controller.signal });
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await tick();
        controller.abort();
        await rejected;
        expect(source.info.mock.calls[0]![2].signal.aborted).toBe(true);
        result.resolve(contract());
        await tick();
        await search('2330選擇權');
        expect(source.info).toHaveBeenCalledTimes(2);
    });

    it('缺少有效名稱且 Info 失敗不會以空字串命中所有 roots', async () => {
        source.names.mockResolvedValue([{ underlying_code: '2330', name: '   ' }]);
        source.info.mockRejectedValue(new Error('Info unavailable'));
        expect(codes(await (await api())('2330選擇權', 20))).toEqual(['2330']);
        expect(source.options).not.toHaveBeenCalled();
    });

    it('Info 成功後仍只載入最多四個已匹配 roots，不逐股票或 root 查 Info', async () => {
        source.bases.mockResolvedValue({ region: 'TW', contracts: [contract(), contract('2317'), contract('2454')] });
        source.optionRoots.mockResolvedValue(Array.from({ length: 9 }, (_, i) => ({ root: `CD${i}`, name: `台積電選擇權${i}` })));
        await (await api())('2330選擇權', 30);
        expect(source.info).toHaveBeenCalledTimes(1);
        expect(source.options).toHaveBeenCalledTimes(4);
        expect(source.options.mock.calls.map(call => call[0])).toEqual(['CD0', 'CD1', 'CD2', 'CD3']);
    });

    it('搜尋 queue 飽和時名稱等待含排隊時間，逾時不派出 Info', async () => {
        const search = await api();
        const { SearchRequestCache } = await import('./search-request');
        const blockers = new SearchRequestCache<string>({ ttlMs: 0, limit: 4, deadlineMs: 5000 });
        const blocking = Array.from({ length: 4 }, (_, i) => blockers.read(String(i),
            () => new Promise<string>(() => undefined)).catch(() => undefined));
        const pending = search('2330選擇權', 20);
        await tick();
        expect(source.info).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1200);
        expect(codes(await pending)).toEqual(['2330']);
        blockers.clear();
        await Promise.all(blocking);
        expect(source.info).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('Info 逾時晚回不污染下一次成功的名稱', async () => {
        const stale = deferred<ContractInfo>();
        source.info.mockReturnValueOnce(stale.promise);
        const search = await api();
        const pending = search('2330選擇權', 20);
        await vi.advanceTimersByTimeAsync(1200);
        expect(codes(await pending)).toEqual(['2330']);
        expect(source.info.mock.calls[0]![2].signal.aborted).toBe(true);
        stale.resolve(contract('2330', { name: '錯誤晚回名稱' }));
        await tick();
        expect(codes(await search('2330選擇權', 20))).toEqual(['2330', 'CDAQA', 'CDOQA']);
        expect(source.info).toHaveBeenCalledTimes(2);
    });
});
