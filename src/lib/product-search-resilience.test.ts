import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from './types/contract';

const mocks = vi.hoisted(() => ({
    catalog: vi.fn(), resolve: vi.fn(), futures: vi.fn(), roots: vi.fn(),
    options: vi.fn(), optionRoots: vi.fn(), warrants: vi.fn(), bases: vi.fn(),
}));
vi.mock('./runtime', () => ({ getApiBase: () => 'http://fixture-search' }));
vi.mock('./utils/date', () => ({ todayStr: () => '2026-10-17' }));
vi.mock('./shioaji', () => ({
    resolveContract: mocks.resolve, fetchFutures: mocks.futures, fetchFuturesRoots: mocks.roots,
    fetchOptions: mocks.options, fetchOptionRoots: mocks.optionRoots, fetchWarrants: mocks.warrants,
    fetchContracts: mocks.bases,
    normalizeContractCode: (code: string) => code === '001' ? 'IX0001' : code.trim().toUpperCase(),
}));
vi.mock('./stock-index', async original => ({ ...await original<object>(), loadStockCatalog: mocks.catalog }));

const stock = { code: '2330', name: '台積電', exchange: 'TSE', category: '' };
function contract(code: string, securityType: 'STK' | 'FUT' | 'WRT', rest: Partial<ContractInfo> = {}): ContractInfo {
    return {
        code, name: code, security_type: securityType, exchange: securityType === 'FUT' ? 'TAIFEX' : 'TSE',
        target_code: null, currency: 'TWD', reference: 0, limit_up: 0, limit_down: 0, day_trade: '',
        update_date: '', category: '', margin_trading_balance: 0, short_selling_balance: 0, ...rest,
    };
}
const future = contract('CDFR1', 'FUT', { root: 'CDF', underlying_code: '2330', target_code: 'CDFJ6' });
const warrant = contract('REVIEWWRT', 'WRT', {
    name: '台積電驗收權證', underlying_code: '2330', expiry_date: '2027-01-01', last_trading_date: '2026-12-28',
});
async function search(query: string) {
    return (await import('./product-search')).searchProducts(query, 8, { includeWarrants: true });
}

beforeEach(() => {
    mocks.bases.mockReset().mockResolvedValue({ region: 'TW', contracts: [
        { code: 'IX0043', security_type: 'IND', exchange: 'OTC' },
        { code: 'TAIWANVIX', security_type: 'IND', exchange: 'TAIFEX' },
    ] });
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T00:00:00+08:00'));
    mocks.catalog.mockReset().mockResolvedValue([stock]);
    mocks.resolve.mockReset().mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));
    mocks.futures.mockReset().mockResolvedValue([future]);
    mocks.roots.mockReset().mockResolvedValue([]);
    mocks.options.mockReset().mockResolvedValue([]);
    mocks.optionRoots.mockReset().mockResolvedValue([]);
    mocks.warrants.mockReset().mockResolvedValue([warrant]);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('商品搜尋來源分流與有界等待', () => {
    it.each(['櫃買指數', '臺指選擇權波動率指數'])('%s 不啟動無關的股票目錄或直接查詢', async query => {
        mocks.catalog.mockReturnValue(new Promise(() => undefined));
        mocks.resolve.mockReturnValue(new Promise(() => undefined));
        const result = await search(query);
        expect(result[0]?.security_type).toBe('IND');
        expect(mocks.catalog).not.toHaveBeenCalled();
        expect(mocks.resolve).not.toHaveBeenCalled();
        expect(mocks.roots).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('指數代碼 IX0043 走直接查詢，不啟動無關的股票目錄', async () => {
        mocks.catalog.mockReturnValue(new Promise(() => undefined));
        mocks.resolve.mockResolvedValue(contract('IX0043', 'STK', { security_type: 'IND', name: '櫃買指數', exchange: 'OTC' }));
        expect(await search('IX0043')).toEqual([expect.objectContaining({ code: 'IX0043', security_type: 'IND', exchange: 'OTC' })]);
        expect(mocks.resolve).toHaveBeenCalledWith('IX0043', undefined, { signal: expect.any(AbortSignal) });
        expect(mocks.catalog).not.toHaveBeenCalled();
        expect(mocks.roots).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('直接期貨代碼不等無關股票目錄與 roots，且保留實際訂閱 target_code', async () => {
        mocks.catalog.mockReturnValue(new Promise(() => undefined));
        mocks.roots.mockReturnValue(new Promise(() => undefined));
        mocks.resolve.mockResolvedValue(future);
        expect((await search('CDFR1'))[0]).toMatchObject({ code: 'CDFR1', contract: { target_code: 'CDFJ6' } });
        expect(mocks.catalog).not.toHaveBeenCalled();
        expect(mocks.roots).not.toHaveBeenCalled();
    });

    it('直接現股代碼在股票目錄無回應時，到期後仍以自身完整名稱找關聯商品', async () => {
        mocks.catalog.mockReturnValue(new Promise(() => undefined));
        mocks.resolve.mockResolvedValue(contract('2330', 'STK', { name: '台積電' }));
        const pending = search('2330');
        await vi.advanceTimersByTimeAsync(1200);
        const rows = await pending;
        expect(rows[0]).toMatchObject({ code: '2330', detail: '直接代碼' });
        expect(rows.some(row => row.code === future.code)).toBe(true);
        expect(rows.some(row => row.code === warrant.code)).toBe(true);
        expect(mocks.catalog).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('直接查詢無回應時，到期後仍使用可用股票目錄及關聯商品', async () => {
        mocks.resolve.mockReturnValue(new Promise(() => undefined));
        const pending = search('2330');
        await vi.advanceTimersByTimeAsync(1200);
        const rows = await pending;
        expect(rows[0]).toMatchObject({ code: '2330', security_type: 'STK' });
        expect(rows.some(row => row.code === future.code)).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('兩個必要來源皆不回應仍在有界時間失敗，而非永久等待或冒稱空清單', async () => {
        mocks.resolve.mockReturnValue(new Promise(() => undefined));
        mocks.catalog.mockReturnValue(new Promise(() => undefined));
        const rejected = expect(search('UNKNOWN123')).rejects.toThrow('商品搜尋暫時無法完成');
        await vi.advanceTimersByTimeAsync(2400);
        await rejected;
        expect(vi.getTimerCount()).toBe(0);
    });

    it('股票名稱目錄無回應時，保留已由獨立 live IND Base 驗證的部分指數結果', async () => {
        mocks.catalog.mockReturnValue(new Promise(() => undefined));
        const pending = search('櫃買');
        await vi.advanceTimersByTimeAsync(1200);
        expect(await pending).toContainEqual(expect.objectContaining({ code: 'IX0043', security_type: 'IND', exchange: 'OTC' }));
        expect(mocks.bases).toHaveBeenCalledWith('IND', undefined, undefined, { signal: expect.any(AbortSignal) });
    });

    it('root 逾時不快取失敗空值，下一次可恢復', async () => {
        mocks.catalog.mockResolvedValue([]);
        mocks.roots.mockReturnValueOnce(new Promise(() => undefined));
        const rejected = expect(search('測試指數期貨')).rejects.toThrow('商品搜尋暫時無法完成');
        await vi.advanceTimersByTimeAsync(1200);
        await rejected;
        mocks.roots.mockResolvedValue([{ root: 'TXF', name: '測試指數期貨' }]);
        mocks.futures.mockResolvedValue([contract('TXFR1', 'FUT', { target_code: 'TXFJ6' })]);
        expect((await search('測試指數期貨'))[0]).toMatchObject({ code: 'TXFR1' });
        expect(mocks.roots).toHaveBeenCalledTimes(2);
    });

    it('台指同標的來源逾時後可重試，不依賴根商品名稱', async () => {
        mocks.catalog.mockResolvedValue([]);
        mocks.futures.mockReturnValueOnce(new Promise(() => undefined));
        const rejected = expect(search('台指期貨')).rejects.toThrow('商品搜尋暫時無法完成');
        await vi.advanceTimersByTimeAsync(1200);
        await rejected;
        mocks.futures.mockResolvedValue([contract('TXFR1', 'FUT', { underlying_code: 'IX0001', target_code: 'TXFJ6' })]);
        expect((await search('台指期貨'))[0]).toMatchObject({ code: 'TXFR1' });
        expect(mocks.futures).toHaveBeenCalledTimes(2);
        expect(mocks.roots).not.toHaveBeenCalled();
    });

    it('相關權證逾時保留現股及期貨，晚回不可污染下一次成功重試的快取', async () => {
        let finishLate!: (rows: ContractInfo[]) => void;
        mocks.warrants.mockReturnValueOnce(new Promise(resolve => { finishLate = resolve; }));
        const pending = search('台積電');
        await vi.advanceTimersByTimeAsync(1200);
        const partial = await pending;
        expect(partial[0]?.code).toBe('2330');
        expect(partial.some(row => row.code === future.code)).toBe(true);
        expect(partial.some(row => row.security_type === 'WRT')).toBe(false);

        finishLate([{ ...warrant, code: 'LATEWRT' }]);
        await Promise.resolve();
        const retried = await search('台積電');
        expect(retried.some(row => row.code === warrant.code)).toBe(true);
        expect(retried.some(row => row.code === 'LATEWRT')).toBe(false);
        expect(mocks.warrants).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('權證日期使用真實日曆驗證', () => {
    it.each([
        ['2027-02-31', '2026-13-99'], ['2027-02-29', '2027-02-28'],
        ['2028-02-30', '2028-02-29'], ['2026-00-10', '2027-01-01'],
    ])('expiry=%s、lastTrading=%s 有不合法日期時標示待確認', async (expiry, lastTrading) => {
        mocks.warrants.mockResolvedValue([{ ...warrant, expiry_date: expiry, last_trading_date: lastTrading }]);
        const rows = await search('台積電權證');
        expect(rows.find(row => row.code === warrant.code)?.detail).toContain('交易日期待確認');
    });

    it('合法閏年 2 月 29 日可確認，不會一律拒絕二月底', async () => {
        mocks.warrants.mockResolvedValue([{ ...warrant, expiry_date: '2028-02-29', last_trading_date: '2028-02-28' }]);
        const rows = await search('台積電權證');
        expect(rows.find(row => row.code === warrant.code)?.detail).not.toContain('交易日期待確認');
    });

    it('無效到期日不能遮蔽有效且已過期的最後交易日', async () => {
        mocks.warrants.mockResolvedValue([{ ...warrant, expiry_date: '2027-02-31', last_trading_date: '2026-10-16' }]);
        expect((await search('台積電權證')).some(row => row.code === warrant.code)).toBe(false);
    });

    it('直接權證代碼也適用真日曆驗證', async () => {
        mocks.resolve.mockResolvedValue({ ...warrant, expiry_date: '2027-02-31', last_trading_date: '2026-13-99' });
        expect((await search(warrant.code))[0]?.detail).toContain('交易日期待確認');
    });
});
