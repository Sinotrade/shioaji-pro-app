import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from './types/contract';
import etfSnapshot from './data/etf-catalog.json';

const mocks = vi.hoisted(() => ({
    base: 'http://127.0.0.1:21323',
    day: '2026-10-17',
    catalog: vi.fn(),
    futures: vi.fn(),
    futureRoots: vi.fn(),
    options: vi.fn(),
    optionRoots: vi.fn(),
    warrants: vi.fn(),
    resolve: vi.fn(),
}));
vi.mock('./runtime', () => ({ getApiBase: () => mocks.base }));
vi.mock('./utils/date', () => ({ todayStr: () => mocks.day }));
vi.mock('./shioaji', () => ({
    fetchFutures: mocks.futures,
    fetchFuturesRoots: mocks.futureRoots,
    fetchOptions: mocks.options,
    fetchOptionRoots: mocks.optionRoots,
    fetchWarrants: mocks.warrants,
    resolveContract: mocks.resolve,
    normalizeContractCode: (code: string) => code === '001' ? 'IX0001' : code.trim().toUpperCase(),
}));
vi.mock('./stock-index', async (original) => ({
    ...await original<object>(),
    loadStockCatalog: mocks.catalog,
}));

function contract(code: string, type: 'STK' | 'FUT' | 'OPT' | 'WRT', rest: Partial<ContractInfo> = {}): ContractInfo {
    return {
        code, name: code, security_type: type,
        exchange: type === 'FUT' || type === 'OPT' ? 'TAIFEX' : 'TSE',
        target_code: null, currency: 'TWD', limit_up: 0, limit_down: 0,
        reference: 0, day_trade: '', update_date: '', category: '',
        margin_trading_balance: 0, short_selling_balance: 0,
        ...rest,
    };
}

const stock = { code: '2330', name: '台積電', exchange: 'TSE', category: '' };
const futures = [
    contract('CDFJ6', 'FUT', { name: '台積電期貨 202610', root: 'CDF', underlying_code: '2330', delivery_month: '202610' }),
    contract('CDFR1', 'FUT', { name: '台積電期貨 近月', root: 'CDF', underlying_code: '2330', delivery_month: '202610', target_code: 'CDFJ6' }),
    contract('CDFR2', 'FUT', { root: 'CDF', underlying_code: '2330', delivery_month: '202611', target_code: 'CDFK6' }),
    contract('QFFR1', 'FUT', { name: '小型台積電期貨 近月', root: 'QFF', underlying_code: '2330', delivery_month: '202610', target_code: 'QFFJ6' }),
    contract('QFFR2', 'FUT', { root: 'QFF', underlying_code: '2330', delivery_month: '202611', target_code: 'QFFK6' }),
];
const warrants = Array.from({ length: 12 }, (_, i) => contract(`W${i}`, 'WRT', {
    name: `台積電認購 ${i}`, underlying_code: '2330', call_put: 'C',
    expiry_date: '2027-04-07', last_trading_date: '2027-04-01',
}));

async function search(query: string, includeWarrants = true, limit = 8) {
    return (await import('./product-search')).searchProducts(query, limit, { includeWarrants });
}

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T01:00:00+08:00'));
    mocks.base = 'http://127.0.0.1:21323';
    mocks.day = '2026-10-17';
    mocks.catalog.mockResolvedValue([stock]);
    mocks.futures.mockResolvedValue(futures);
    mocks.futureRoots.mockResolvedValue([{ root: 'CDF', name: '台積電期貨' }, { root: 'QFF', name: '小型台積電期貨' }]);
    mocks.options.mockResolvedValue([]);
    mocks.optionRoots.mockResolvedValue([]);
    mocks.warrants.mockResolvedValue(warrants);
    mocks.resolve.mockRejectedValue(Object.assign(new Error('Contract not found'), { status: 404 }));
});
afterEach(() => vi.useRealTimers());

describe('futures month and size priority', () => {
    // Synthetic names/codes deliberately make the small root sort first by
    // code and root-name length, so passing cannot rely on CDF/QFF letters.
    const ordered = [
        contract('ZZZR1', 'FUT', { root: 'ZZZ', name: '測試一般期貨 近月', underlying_code: '2330', delivery_month: '202610', target_code: 'ZZZJ6' }),
        contract('AAAR1', 'FUT', { root: 'AAA', name: '小型測試期貨 近月', underlying_code: '2330', delivery_month: '202610', target_code: 'AAAJ6' }),
        contract('ZZZR2', 'FUT', { root: 'ZZZ', name: '測試一般期貨 次月', underlying_code: '2330', delivery_month: '202611', target_code: 'ZZZK6' }),
        contract('AAAR2', 'FUT', { root: 'AAA', name: '小型測試期貨 次月', underlying_code: '2330', delivery_month: '202611', target_code: 'AAAK6' }),
    ];

    it.each(['台積電', '台積電期貨'])('orders regular near, small near, regular next, small next for %s', async query => {
        mocks.futures.mockResolvedValue([ordered[3], ordered[1], ordered[2], ordered[0]]);
        const rows = (await search(query, false)).filter(row => row.security_type === 'FUT');
        expect(rows.map(row => row.code)).toEqual(ordered.map(row => row.code));
        expect(rows.map(row => row.contract)).toEqual(ordered);
    });

    it('globally sorts multiple roots instead of inheriting the first matching root', async () => {
        mocks.catalog.mockResolvedValue([]);
        mocks.futureRoots.mockResolvedValue([
            { root: 'AAA', name: '小型測試期貨' },
            { root: 'ZZZ', name: '測試一般期貨' },
        ]);
        mocks.futures.mockImplementation(async ({ root }) => ordered.filter(row => row.root === root).reverse());
        const rows = (await search('測試期貨', false)).filter(row => row.security_type === 'FUT');
        expect(rows.map(row => row.code)).toEqual(ordered.map(row => row.code));
        expect(mocks.futures).toHaveBeenCalledTimes(2);
    });

    it('uses R1/R2 identities even when delivery-month metadata is missing', async () => {
        mocks.futures.mockResolvedValue([...ordered].reverse().map(row => ({ ...row, delivery_month: undefined })));
        expect((await search('台積電', false)).filter(row => row.security_type === 'FUT').map(row => row.code))
            .toEqual(ordered.map(row => row.code));
    });

    it.each(['ZZZ', 'AAA'])('keeps near before next when only root %s is available', async root => {
        mocks.futures.mockResolvedValue(ordered.filter(row => row.root === root).reverse());
        expect((await search('台積電', false)).filter(row => row.security_type === 'FUT').map(row => row.code))
            .toEqual([`${root}R1`, `${root}R2`]);
    });

    it('keeps dated and micro contracts behind the four requested priorities without mutating identities', async () => {
        const dated = contract('ZZZJ6', 'FUT', { name: '測試一般期貨 202610', underlying_code: '2330', delivery_month: '202610' });
        const micro = contract('MMMR1', 'FUT', { name: '微型測試期貨 近月', underlying_code: '2330', delivery_month: '202610', target_code: 'MMMJ6' });
        const source = [dated, micro, ...ordered].reverse();
        const before = structuredClone(source);
        mocks.futures.mockResolvedValue(source);
        const rows = (await search('台積電', false, 10)).filter(row => row.security_type === 'FUT');
        expect(rows.slice(0, 4).map(row => row.code)).toEqual(ordered.map(row => row.code));
        expect(source).toEqual(before);
        expect(rows.find(row => row.code === 'MMMR1')?.contract?.target_code).toBe('MMMJ6');
    });

    it('preserves the relative futures order when mixed with stocks and warrants at a limited size', async () => {
        mocks.futures.mockResolvedValue([...ordered].reverse());
        const rows = await search('台積電', true, 8);
        expect(rows[0]?.code).toBe('2330');
        const futureCodes = rows.filter(row => row.security_type === 'FUT').map(row => row.code);
        expect(futureCodes).toEqual(ordered.slice(0, futureCodes.length).map(row => row.code));
        expect(rows.some(row => row.security_type === 'WRT')).toBe(true);
        expect(rows).toHaveLength(8);
    });
});

describe('product search sources and related products', () => {
    it('labels a supported ETF name and keeps its actual underlying-related products', async () => {
        mocks.catalog.mockResolvedValue([{ code: '00679B', name: '元大美債20年', exchange: 'OTC', category: '', kind: 'ETF' }]);
        mocks.futures.mockResolvedValue([contract('RZFR1', 'FUT', { name: '元大美債20年ETF期貨 近月', underlying_code: '00679B' })]);
        const rows = await search('元大美債20年');
        expect(rows[0]).toMatchObject({ code: '00679B', exchange: 'OTC', security_type: 'STK', detail: 'ETF' });
        expect(rows.some(row => row.code === 'RZFR1')).toBe(true);
        expect(mocks.futures).toHaveBeenCalledWith({ underlyingCode: '00679B' });
        expect(rows.some(row => row.code.startsWith('W'))).toBe(false);
    });

    it('does not strip 期貨 out of an exact official ETF full name', async () => {
        const fund = etfSnapshot.entries.find(row => row.aliases?.some(alias => alias.includes('期貨')))!;
        const officialName = fund.aliases!.find(alias => alias.includes('期貨'))!;
        mocks.catalog.mockResolvedValue([{ ...fund, category: '', kind: 'ETF' }]);
        mocks.futures.mockResolvedValue([]);
        mocks.warrants.mockResolvedValue([]);
        expect((await search(officialName))[0]).toMatchObject({ code: fund.code, detail: 'ETF', security_type: 'STK' });
        expect(mocks.futureRoots).not.toHaveBeenCalled();
        expect(mocks.futures).toHaveBeenCalledWith({ underlyingCode: fund.code });
    });

    it('labels a direct ETF code without requiring the stock catalog', async () => {
        mocks.resolve.mockResolvedValue(contract('00679B', 'STK', { name: '元大美債20年', exchange: 'OTC' }));
        mocks.futures.mockResolvedValue([]);
        mocks.warrants.mockResolvedValue([]);
        expect((await search('00679B'))[0]).toMatchObject({ code: '00679B', detail: 'ETF · 直接代碼', exchange: 'OTC' });
        expect(mocks.catalog).not.toHaveBeenCalled();
    });

    it('finds the OTC index even if stock and derivative catalogs fail', async () => {
        mocks.catalog.mockRejectedValue(new Error('503 stock'));
        mocks.futureRoots.mockRejectedValue(new Error('503 futures'));
        mocks.optionRoots.mockRejectedValue(new Error('503 options'));
        expect(await search('櫃買')).toContainEqual(expect.objectContaining({ code: 'IX0043', exchange: 'OTC', security_type: 'IND' }));
    });

    it.each(['臺指選擇權波動率指數', '台指選擇權波動率指數'])('does not parse the index name %s as an options query', async (query) => {
        expect((await search(query))[0]).toMatchObject({ code: 'TAIWANVIX', exchange: 'TAIFEX', security_type: 'IND' });
        expect(mocks.options).not.toHaveBeenCalled();
        expect(mocks.optionRoots).not.toHaveBeenCalled();
    });

    it('keeps direct lookup available when catalogs fail', async () => {
        mocks.catalog.mockRejectedValue(new Error('503 stock'));
        mocks.futureRoots.mockRejectedValue(new Error('503 roots'));
        mocks.resolve.mockResolvedValue(contract('CDFR1', 'FUT', { target_code: 'CDFJ6' }));
        expect((await search('CDFR1'))[0]).toMatchObject({ code: 'CDFR1', contract: { target_code: 'CDFJ6' } });
    });

    it.each(['台積電', '臺積電', '2330'])('mixes exact stock, regular/small futures and warrants for %s', async (query) => {
        const result = await search(query);
        expect(result).toHaveLength(8);
        expect(result[0]?.code).toBe('2330');
        expect(result).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'CDFR1', contract: { ...futures[1] } }),
            expect.objectContaining({ code: 'QFFR1' }),
            expect.objectContaining({ security_type: 'WRT' }),
        ]));
        expect(mocks.futures).toHaveBeenCalledWith({ underlyingCode: '2330' });
        expect(mocks.warrants).toHaveBeenCalledWith('2330', { expiryFrom: '2026-10-17' });
        expect(mocks.options).not.toHaveBeenCalled();
    });

    it('does not choose the first fuzzy stock as a related underlying', async () => {
        mocks.catalog.mockResolvedValue([stock, { ...stock, code: '1301', name: '台塑' }]);
        await search('台');
        expect(mocks.futures.mock.calls.some(([filters]) => filters.underlyingCode)).toBe(false);
        expect(mocks.warrants).not.toHaveBeenCalled();
    });

    it('keeps explicit futures search and continuous-month metadata', async () => {
        const result = await search('台積電期貨');
        expect(result.some((row) => row.code === 'CDFR1' && row.contract?.target_code === 'CDFJ6')).toBe(true);
        expect(result.some((row) => row.code === 'QFFR1')).toBe(true);
    });

    it('does not use target_code as a stock association', async () => {
        mocks.futures.mockResolvedValue([...futures, contract('OTHER', 'FUT', { underlying_code: '2317', target_code: '2330' })]);
        mocks.warrants.mockResolvedValue([...warrants, contract('OTHERW', 'WRT', { name: '其他標的', underlying_code: '2317', target_code: '2330' })]);
        const result = await search('台積電', true, 30);
        expect(result.map((row) => row.code)).not.toContain('OTHER');
        expect(result.map((row) => row.code)).not.toContain('OTHERW');
    });

    it('preserves a direct stock hit ahead of related derivatives', async () => {
        mocks.resolve.mockResolvedValue(contract('2330', 'STK', { name: '台積電' }));
        const result = await search('2330');
        expect(result[0]).toMatchObject({ code: '2330', detail: '直接代碼' });
        expect(result.filter((row) => row.code === '2330')).toHaveLength(1);
        expect(result.some((row) => row.security_type === 'WRT')).toBe(true);
    });

    it.each(['台積電選擇權', '2330選擇權'])('finds both identically named option roots for %s with bounded results', async (query) => {
        mocks.optionRoots.mockResolvedValue([{ root: 'CDA', name: '台積電選擇權' }, { root: 'CDO', name: '台積電選擇權' }]);
        mocks.options.mockImplementation(async (root: string) => Array.from({ length: 40 }, (_, i) => contract(`${root}${i}`, 'OPT', {
            root, underlying_code: '2330', delivery_month: i === 39 ? '202611' : '202610', strike_price: 2000 + i,
        })));
        const result = await search(query);
        expect(result.length).toBeLessThanOrEqual(8);
        expect(result.some((row) => row.contract?.root === 'CDA')).toBe(true);
        expect(result.some((row) => row.contract?.root === 'CDO')).toBe(true);
        expect(mocks.options).toHaveBeenCalledTimes(2);
    });

    it('keeps another option root if one matching root fails', async () => {
        mocks.optionRoots.mockResolvedValue([{ root: 'CDA', name: '台積電選擇權' }, { root: 'CDO', name: '台積電選擇權' }]);
        mocks.options.mockImplementation(async (root: string) => {
            if (root === 'CDA') throw new Error('503 weekly');
            return [contract('CDO1', 'OPT', { root, underlying_code: '2330', delivery_month: '202610' })];
        });
        expect((await search('台積電選擇權')).some((row) => row.code === 'CDO1')).toBe(true);
    });

    it('bounds generic matching-root expansion', async () => {
        mocks.optionRoots.mockResolvedValue(Array.from({ length: 20 }, (_, i) => ({ root: `R${i}`, name: '台指選擇權' })));
        await search('台指選擇權');
        expect(mocks.options).toHaveBeenCalledTimes(4);
    });

    it('excludes expired or already stopped warrants without calling missing dates tradable', async () => {
        mocks.warrants.mockResolvedValue([
            warrants[0],
            contract('STOPPED', 'WRT', { name: '已停止交易', underlying_code: '2330', expiry_date: '2026-10-20', last_trading_date: '2026-10-16' }),
            contract('EXPIRED', 'WRT', { name: '已到期', underlying_code: '2330', expiry_date: '2026-10-16', last_trading_date: '2026-10-20' }),
            contract('UNKNOWN', 'WRT', { name: '缺最後交易日', underlying_code: '2330', expiry_date: '2027-01-01' }),
        ]);
        const result = await search('台積電權證');
        expect(result.map((row) => row.code)).not.toContain('STOPPED');
        expect(result.map((row) => row.code)).not.toContain('EXPIRED');
        expect(result.find((row) => row.code === 'UNKNOWN')?.detail).toContain('交易日期待確認');
    });

    it('marks a direct warrant without trading dates as unconfirmed', async () => {
        mocks.catalog.mockResolvedValue([]);
        mocks.resolve.mockResolvedValue(contract('030156', 'WRT'));
        expect((await search('030156'))[0]?.detail).toContain('交易日期待確認');
    });

    it('also filters direct warrants when stop-trading metadata is available', async () => {
        mocks.catalog.mockResolvedValue([]);
        mocks.resolve.mockResolvedValue(contract('040991', 'WRT', { expiry_date: '2026-10-20', last_trading_date: '2026-10-16' }));
        expect(await search('040991')).toEqual([]);
    });

    it('requires the warrant opt-in for both related and explicit warrant queries', async () => {
        expect((await search('台積電', false)).some((row) => row.security_type === 'WRT')).toBe(false);
        expect(await search('台積電權證', false)).toEqual([]);
        expect(mocks.warrants).not.toHaveBeenCalled();
    });

    it('throws on an empty result caused by failed sources, rather than claiming no products', async () => {
        mocks.catalog.mockRejectedValue(new Error('503 stock'));
        mocks.futureRoots.mockRejectedValue(new Error('503 roots'));
        await expect(search('不存在商品')).rejects.toThrow('搜尋');
    });

    it('returns an ordinary empty list for a successful no-match search and direct 404', async () => {
        mocks.catalog.mockResolvedValue([]);
        mocks.futureRoots.mockResolvedValue([]);
        expect(await search('ZZZNOTFOUND')).toEqual([]);
    });
});

describe('related product request cache', () => {
    it('shares simultaneous requests and caches successful warrant results', async () => {
        let resolve!: (rows: ContractInfo[]) => void;
        mocks.warrants.mockReturnValue(new Promise<ContractInfo[]>((done) => { resolve = done; }));
        const pending = Promise.all([search('台積電'), search('2330')]);
        await vi.waitFor(() => expect(mocks.warrants).toHaveBeenCalledTimes(1));
        resolve(warrants);
        await pending;
        await search('臺積電');
        expect(mocks.warrants).toHaveBeenCalledTimes(1);
    });

    it('retries a failed request without poisoning other product types', async () => {
        mocks.warrants.mockRejectedValueOnce(new Error('503 warrants'));
        expect((await search('台積電'))[0]?.code).toBe('2330');
        expect((await search('台積電')).some((row) => row.security_type === 'WRT')).toBe(true);
        expect(mocks.warrants).toHaveBeenCalledTimes(2);
    });

    it('expires successful results and separates API bases and Taiwan dates', async () => {
        await search('台積電');
        vi.advanceTimersByTime(5 * 60_000);
        await search('台積電');
        expect(mocks.warrants).toHaveBeenCalledTimes(2);
        mocks.base = 'http://127.0.0.1:21324';
        await search('台積電');
        mocks.day = '2026-10-18';
        await search('台積電');
        expect(mocks.warrants).toHaveBeenCalledTimes(4);
    });

    it('rejects a mid-request API switch and does not cache that response under the old server', async () => {
        let resolve!: (rows: ContractInfo[]) => void;
        mocks.warrants.mockReturnValueOnce(new Promise<ContractInfo[]>((done) => { resolve = done; }));
        const pending = search('台積電');
        const rejected = expect(pending).rejects.toThrow('伺服器已切換');
        await vi.waitFor(() => expect(mocks.warrants).toHaveBeenCalledTimes(1));
        mocks.base = 'http://127.0.0.1:21324';
        resolve(warrants);
        await rejected;
        mocks.base = 'http://127.0.0.1:21323';
        await search('台積電');
        expect(mocks.warrants).toHaveBeenCalledTimes(2);
    });

    it('bounds cached underlying requests instead of retaining every visited stock', async () => {
        mocks.catalog.mockResolvedValue(Array.from({ length: 40 }, (_, i) => ({ ...stock, code: `S${i}`, name: `測試${i}` })));
        for (let i = 0; i < 40; i++) await search(`測試${i}`);
        const before = mocks.warrants.mock.calls.length;
        await search('測試0');
        expect(mocks.warrants.mock.calls.length).toBe(before + 1);
    });
});
