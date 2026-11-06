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
    bases: vi.fn(),
    equityVersion: 0,
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
    fetchContracts: mocks.bases,
    normalizeContractCode: (code: string) => code === '001' ? 'IX0001' : code === '020' ? 'IX0018' : code.trim().toUpperCase(),
}));
vi.mock('./stock-index', async (original) => ({
    ...await original<object>(),
    loadStockCatalog: mocks.catalog,
}));
vi.mock('./stock-runtime-catalog', async (original) => ({
    ...await original<object>(),
    getEquityNamesVersion: () => mocks.equityVersion,
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
    mocks.bases.mockReset().mockResolvedValue({ region: 'TW', contracts: [
        { code: 'IX0043', security_type: 'IND', exchange: 'OTC' },
        { code: 'TAIWANVIX', security_type: 'IND', exchange: 'TAIFEX' },
        { code: 'IX0001', security_type: 'IND', exchange: 'TSE' },
    ] });
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T01:00:00+08:00'));
    mocks.base = 'http://127.0.0.1:21323';
    mocks.day = '2026-10-17';
    mocks.equityVersion = 0;
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

    it('resolves a unique 台積 prefix and groups its stock, continuous futures, then warrants', async () => {
        mocks.futures.mockResolvedValue([...futures].reverse());
        const rows = await search('台積');
        expect(rows.slice(0, 5).map(row => row.code)).toEqual(['2330', 'CDFR1', 'QFFR1', 'CDFR2', 'QFFR2']);
        expect(rows.slice(5).every(row => row.security_type === 'WRT')).toBe(true);
        expect(mocks.futures).toHaveBeenCalledWith({ underlyingCode: '2330' }, { signal: expect.any(AbortSignal) });
        expect(mocks.warrants).toHaveBeenCalledWith('2330', { expiryFrom: mocks.day }, { signal: expect.any(AbortSignal) });
    });

    it.each(['台指', '台指期貨', '臺股期貨'])('finds the same index underlying and groups all sizes for %s', async query => {
        const codes = ['TXFR1', 'MXFR1', 'TMFR1', 'TXFR2', 'MXFR2', 'TMFR2'];
        const rows = codes.map((code, i) => contract(code, 'FUT', {
            root: code.slice(0, 3), name: `${i % 3 === 0 ? '臺股' : i % 3 === 1 ? '小型臺指' : '微型臺指'}期貨`,
            underlying_code: 'IX0001', delivery_month: i < 3 ? '202610' : '202611', target_code: `${code.slice(0, 3)}${i < 3 ? 'J6' : 'K6'}`,
        }));
        mocks.futures.mockResolvedValue([...rows].reverse());
        expect((await search(query, false)).filter(row => row.security_type === 'FUT').map(row => row.code)).toEqual(codes);
        expect(mocks.futures).toHaveBeenCalledWith({ underlyingCode: 'IX0001' }, { signal: expect.any(AbortSignal) });
        expect(mocks.futureRoots).not.toHaveBeenCalled();
        expect(mocks.warrants).not.toHaveBeenCalled();
    });

    it('keeps a same-prefix stock after the exact stock futures and ahead of its warrants', async () => {
        mocks.catalog.mockResolvedValue([
            { code: '1303', name: '南亞', exchange: 'TSE', category: '' },
            { code: '2408', name: '南亞科', exchange: 'TSE', category: '' },
        ]);
        mocks.futures.mockResolvedValue(['R2', 'R1'].map(suffix => contract(`NYF${suffix}`, 'FUT', {
            root: 'NYF', name: `南亞期貨 ${suffix === 'R1' ? '近月' : '次月'}`, underlying_code: '1303',
            delivery_month: suffix === 'R1' ? '202610' : '202611', target_code: `NYF${suffix === 'R1' ? 'J6' : 'K6'}`,
        })));
        mocks.warrants.mockResolvedValue(Array.from({ length: 8 }, (_, i) => contract(`NYW${i}`, 'WRT', {
            name: `南亞購 ${i}`, underlying_code: '1303', expiry_date: '2027-04-07', last_trading_date: '2027-04-01',
        })));
        // The same-prefix stock sits between futures and warrants; every partial update is still a prefix.
        const updates: string[][] = [];
        const rows = (await (await import('./product-search')).searchProducts('南亞', 8, {
            includeWarrants: true, onUpdate: partial => updates.push(partial.map(row => row.code)),
        })).map(row => row.code);
        expect(rows).toEqual(['1303', 'NYFR1', 'NYFR2', '2408', 'NYW0', 'NYW1', 'NYW2', 'NYW3']);
        expect(updates.length).toBeGreaterThan(0);
        for (const prefix of updates) expect(rows.slice(0, prefix.length)).toEqual(prefix);
    });
});

describe('only the near and next month of each futures specification', () => {
    const far = ['202612', '202703'];
    const months = [['J6', '202610'], ['K6', '202611'], ['L6', '202612'], ['H7', '202703']] as const;
    // Continuous R1/R2 identities plus every actual month, including far ones.
    const family = (root: string, name: string, underlying: string, continuous: string[] = ['R1', 'R2'],
        fields: Partial<ContractInfo> = {}) => [
        ...continuous.map(suffix => contract(`${root}${suffix}`, 'FUT', {
            root, name: `${name} ${suffix === 'R1' ? '近月' : '次月'}`, underlying_code: underlying,
            delivery_month: suffix === 'R1' ? '202610' : '202611', target_code: `${root}${suffix === 'R1' ? 'J6' : 'K6'}`,
            ...fields,
        })),
        ...months.map(([suffix, month]) => contract(`${root}${suffix}`, 'FUT', {
            root, name: `${name} ${month}`, underlying_code: underlying, delivery_month: month,
        })),
    ];
    const stockFamily = (fields: Partial<ContractInfo> = {}) =>
        [...family('CDF', '台積電期貨', '2330', ['R1', 'R2'], fields), ...family('QFF', '小型台積電期貨', '2330')];
    const indexFamily = (txf: string[], mxf: string[], tmf: string[], tmfFields: Partial<ContractInfo> = {}) => [
        ...family('TXF', '臺股期貨', 'IX0001', txf), ...family('MXF', '小型臺指期貨', 'IX0001', mxf),
        ...family('TMF', '微型臺指期貨', 'IX0001', tmf, tmfFields),
    ];
    const R = ['R1', 'R2'];

    it.each([
        { label: '沒有權證', query: '台積電', includeWarrants: false, limit: 8, rows: stockFamily(),
            expected: ['CDFR1', 'QFFR1', 'CDFR2', 'QFFR2'] },
        { label: 'limit 30', query: '台積電', includeWarrants: true, limit: 30, rows: stockFamily(),
            expected: ['CDFR1', 'QFFR1', 'CDFR2', 'QFFR2'] },
        { label: '部分 R 列缺 target_code', query: '台積電', includeWarrants: true, limit: 30,
            rows: stockFamily({ target_code: null }), expected: ['CDFR1', 'QFFR1', 'CDFR2', 'QFFR2'] },
        // Without target_code, its own actual near month is not covered and
        // must still not be listed again as the next month.
        { label: '某規格只有 R1', query: '台指期貨', includeWarrants: false, limit: 30,
            rows: indexFamily(R, R, ['R1'], { target_code: null }),
            expected: ['TXFR1', 'MXFR1', 'TMFR1', 'TXFR2', 'MXFR2', 'TMFK6'] },
        { label: '某規格只有 R1 且缺 delivery_month', query: '台指期貨', includeWarrants: false, limit: 30,
            rows: indexFamily(R, R, ['R1'], { delivery_month: undefined }),
            expected: ['TXFR1', 'MXFR1', 'TMFR1', 'TXFR2', 'MXFR2', 'TMFK6'] },
        { label: '某規格只有 R2', query: '台指期貨', includeWarrants: false, limit: 30, rows: indexFamily(R, R, ['R2']),
            expected: ['TXFR1', 'MXFR1', 'TMFJ6', 'TXFR2', 'MXFR2', 'TMFR2'] },
        { label: '某規格沒有任何 R', query: '台指期貨', includeWarrants: false, limit: 30, rows: indexFamily(R, [], R),
            expected: ['TXFR1', 'MXFJ6', 'TMFR1', 'TXFR2', 'MXFK6', 'TMFR2'] },
        { label: '列缺 delivery_month', query: '台指期貨', includeWarrants: false, limit: 30,
            rows: [contract('MXFA6', 'FUT', { root: 'MXF', name: '小型臺指期貨', underlying_code: 'IX0001' }), ...indexFamily(R, [], R)],
            expected: ['TXFR1', 'MXFJ6', 'TMFR1', 'TXFR2', 'MXFK6', 'TMFR2'] },
    ])('$label', async ({ query, includeWarrants, limit, rows, expected }) => {
        mocks.futures.mockResolvedValue([...rows].reverse());
        const result = await search(query, includeWarrants, limit);
        expect(result.filter(row => row.security_type === 'FUT').map(row => row.code)).toEqual(expected);
        expect(result.some(row => far.includes(row.contract?.delivery_month ?? ''))).toBe(false);
    });
});

describe('product search sources and related products', () => {
    it('labels a supported ETF name and keeps its actual underlying-related products', async () => {
        mocks.catalog.mockResolvedValue([{ code: '00679B', name: '元大美債20年', exchange: 'OTC', category: '', kind: 'ETF' }]);
        mocks.futures.mockResolvedValue([contract('RZFR1', 'FUT', { name: '元大美債20年ETF期貨 近月', underlying_code: '00679B' })]);
        const rows = await search('元大美債20年');
        expect(rows[0]).toMatchObject({ code: '00679B', exchange: 'OTC', security_type: 'STK', kind: 'ETF', detail: 'ETF' });
        expect(rows.some(row => row.code === 'RZFR1')).toBe(true);
        expect(mocks.futures).toHaveBeenCalledWith({ underlyingCode: '00679B' }, { signal: expect.any(AbortSignal) });
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
        expect(mocks.futures).toHaveBeenCalledWith({ underlyingCode: fund.code }, { signal: expect.any(AbortSignal) });
    });

    it('labels a direct ETF code and still reads the stock catalog for same-prefix products', async () => {
        mocks.resolve.mockResolvedValue(contract('00679B', 'STK', { name: '元大美債20年', exchange: 'OTC' }));
        mocks.futures.mockResolvedValue([]);
        mocks.warrants.mockResolvedValue([]);
        expect((await search('00679B'))[0]).toMatchObject({ code: '00679B', detail: 'ETF · 直接代碼', exchange: 'OTC', security_type: 'STK', kind: 'ETF' });
        expect(mocks.catalog).toHaveBeenCalledOnce();
    });

    it('keeps same-code preferred shares for a direct stock code, and the direct row if the catalog fails', async () => {
        mocks.catalog.mockResolvedValue([
            { code: '2881', name: '富邦金', exchange: 'TSE', category: '' },
            { code: '2881A', name: '富邦特', exchange: 'TSE', category: '' },
            { code: '2881B', name: '富邦金乙特', exchange: 'TSE', category: '' },
        ]);
        mocks.resolve.mockResolvedValue(contract('2881', 'STK', { name: '富邦金' }));
        mocks.futures.mockResolvedValue([]);
        mocks.warrants.mockResolvedValue([]);
        expect((await search('2881')).map(row => row.code)).toEqual(['2881', '2881A', '2881B']);
        mocks.catalog.mockRejectedValue(new Error('503 stock'));
        expect(await search('2881')).toEqual([expect.objectContaining({ code: '2881', detail: '直接代碼', security_type: 'STK' })]);
    });

    it('direct and name ETF suggestions share typed kind without mutating ContractInfo or extra catalog reads', async () => {
        const fund = etfSnapshot.entries.find(row => row.code === '0050')!;
        const resolved = contract('0050', 'STK', { name: fund.name });
        mocks.resolve.mockResolvedValue(resolved);
        mocks.futures.mockResolvedValue([]);
        mocks.warrants.mockResolvedValue([]);
        const direct = (await search('0050'))[0]!;
        expect(direct).toMatchObject({ code: '0050', name: fund.name, security_type: 'STK', kind: 'ETF', contract: resolved });
        expect(direct.contract).toBe(resolved);
        expect(resolved).not.toHaveProperty('kind');
        expect(mocks.catalog).toHaveBeenCalledOnce();
        mocks.catalog.mockResolvedValue([{ ...fund, kind: 'ETF', category: '' }]);
        expect((await search(fund.name))[0]).toMatchObject({ code: direct.code, name: direct.name, security_type: 'STK', kind: 'ETF' });
        mocks.resolve.mockResolvedValue(contract('2330', 'STK', { name: '台積電' }));
        expect((await search('2330'))[0]).not.toHaveProperty('kind');
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
        expect(mocks.futures).toHaveBeenCalledWith({ underlyingCode: '2330' }, { signal: expect.any(AbortSignal) });
        expect(mocks.warrants).toHaveBeenCalledWith('2330', { expiryFrom: '2026-10-17' }, { signal: expect.any(AbortSignal) });
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

    // 台指 would otherwise show only the VIX index; 台積電期貨 only the stock.
    it.each(['台指', '台積電期貨'])('reports a timed-out primary futures source for %s instead of a partial list', async query => {
        mocks.futures.mockReturnValue(new Promise(() => undefined));
        const rejected = expect(search(query)).rejects.toThrow('商品搜尋暫時無法完成');
        await vi.advanceTimersByTimeAsync(1200);
        await rejected;
        expect(mocks.futures).toHaveBeenCalledOnce();
    });

    it('finds an exact index code by direct lookup when the IND batch catalog fails', async () => {
        mocks.bases.mockRejectedValue(Object.assign(new Error('503 IND'), { status: 503 }));
        mocks.resolve.mockResolvedValue(contract('IX0001', 'STK', { security_type: 'IND', name: '發行量加權股價指數' }));
        expect(await search('IX0001')).toEqual([expect.objectContaining({ code: 'IX0001', security_type: 'IND', exchange: 'TSE' })]);
        expect(mocks.bases).toHaveBeenCalledOnce();
    });

    it('lists both the legacy index alias 020 and the 020xxx products it prefixes', async () => {
        mocks.catalog.mockResolvedValue([{ code: '020001', name: '測試 ETN', exchange: 'TSE', category: '' }]);
        mocks.bases.mockResolvedValue({ region: 'TW', contracts: [{ code: 'IX0018', security_type: 'IND', exchange: 'TSE' }] });
        mocks.resolve.mockResolvedValue(contract('IX0018', 'STK', { security_type: 'IND', name: '電器電纜類指數' }));
        expect((await search('020')).map(row => `${row.security_type}:${row.code}`)).toEqual(['IND:IX0018', 'STK:020001']);
        expect(mocks.resolve).toHaveBeenCalledWith('IX0018', 'IND', { signal: expect.any(AbortSignal) });
    });

    it('rejects an old search when only the equity name version changes', async () => {
        let finish!: (rows: ContractInfo[]) => void;
        mocks.futures.mockReturnValue(new Promise<ContractInfo[]>(resolve => { finish = resolve; }));
        const rejected = expect(search('台積電')).rejects.toThrow('名稱目錄已更新');
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.futures).toHaveBeenCalledOnce();
        mocks.equityVersion++;
        finish(futures);
        await rejected;
    });

    it('returns an ordinary empty list for a successful no-match search and direct 404', async () => {
        mocks.catalog.mockResolvedValue([]);
        mocks.futureRoots.mockResolvedValue([]);
        expect(await search('ZZZNOTFOUND')).toEqual([]);
    });
});

describe('related product request cache', () => {
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

    it('bounds cached underlying requests instead of retaining every visited stock', async () => {
        mocks.catalog.mockResolvedValue(Array.from({ length: 40 }, (_, i) => ({ ...stock, code: `S${i}`, name: `測試${i}` })));
        for (let i = 0; i < 40; i++) await search(`測試${i}`);
        const before = mocks.warrants.mock.calls.length;
        await search('測試0');
        expect(mocks.warrants.mock.calls.length).toBe(before + 1);
    });
});
