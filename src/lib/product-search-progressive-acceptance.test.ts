import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from './types/contract';

// Independent acceptance fixtures model the inspected 1.7.8 identity fields.
// They are synthetic responses, not market-price or live-connection evidence.
const source = vi.hoisted(() => ({
    base: 'http://127.0.0.1:21323',
    bases: vi.fn(),
    names: vi.fn(),
    resolve: vi.fn(),
    futures: vi.fn(),
    futureRoots: vi.fn(),
    options: vi.fn(),
    optionRoots: vi.fn(),
    warrants: vi.fn(),
}));

vi.mock('./runtime', () => ({ getApiBase: () => source.base }));
vi.mock('./utils/date', () => ({ todayStr: () => '2026-10-17' }));
vi.mock('./shioaji', () => ({
    fetchContracts: source.bases,
    fetchWarrantUnderlyings: source.names,
    fetchContractInfo: vi.fn(),
    resolveContract: source.resolve,
    fetchFutures: source.futures,
    fetchFuturesRoots: source.futureRoots,
    fetchOptions: source.options,
    fetchOptionRoots: source.optionRoots,
    fetchWarrants: source.warrants,
    normalizeContractCode: (code: string) => code.trim().toUpperCase(),
}));

function row(code: string, security_type: 'STK' | 'FUT' | 'WRT', fields: Partial<ContractInfo> = {}): ContractInfo {
    return {
        code, security_type, exchange: security_type === 'FUT' ? 'TAIFEX' : 'TSE', name: code,
        target_code: null, currency: 'TWD', reference: 0, limit_up: 0, limit_down: 0,
        day_trade: '', update_date: '', category: '', margin_trading_balance: 0, short_selling_balance: 0,
        ...fields,
    };
}

const stock = row('2330', 'STK', { name: '台積電' });
const etf = row('00679B', 'STK', { name: '元大美債20年', exchange: 'OTC' });
const expectedFutures = ['CDFR1', 'QFFR1', 'CDFR2', 'QFFR2'];
const futures = expectedFutures.map((code, i) => row(code, 'FUT', {
    name: `${i % 2 ? '小型' : ''}台積電期貨 ${i < 2 ? '近月' : '次月'}`,
    underlying_code: '2330', root: code.slice(0, 3), delivery_month: i < 2 ? '202610' : '202611',
    target_code: `${code.slice(0, 3)}${i < 2 ? 'J6' : 'K6'}`,
}));
const warrants = ['W001', 'W002', 'W003'].map(code => row(code, 'WRT', {
    name: `台積電測試認購 ${code}`, underlying_code: '2330', call_put: 'C',
    expiry_date: '2027-01-20', last_trading_date: '2027-01-18',
}));

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const codes = (rows: { code: string }[]) => rows.map(item => item.code);
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T08:00:00+08:00'));
    source.base = 'http://127.0.0.1:21323';
    source.bases.mockResolvedValue({ contracts: [stock, etf] });
    source.names.mockResolvedValue([stock, etf].map(item => ({ underlying_code: item.code, name: item.name })));
    source.resolve.mockImplementation(async (code: string) => {
        if (code === stock.code) return stock;
        if (code === etf.code) return etf;
        throw Object.assign(new Error('not found'), { status: 404 });
    });
    source.futures.mockResolvedValue([...futures].reverse());
    source.futureRoots.mockResolvedValue([]);
    source.optionRoots.mockResolvedValue([]);
    source.options.mockResolvedValue([]);
    source.warrants.mockResolvedValue(warrants);
});

afterEach(() => vi.useRealTimers());

describe('progressive product-search acceptance', () => {
    it.each(['台積', '台積電', '2330'])('publishes a stable stock and monthly futures prefix before slow warrants for %s', async query => {
        const delayedFutures = deferred<ContractInfo[]>();
        const delayedWarrants = deferred<ContractInfo[]>();
        source.futures.mockReturnValue(delayedFutures.promise);
        source.warrants.mockReturnValue(delayedWarrants.promise);
        const { searchProducts } = await import('./product-search');
        const updates: string[][] = [];
        let finished = false;
        const pending = searchProducts(query, 8, { includeWarrants: true, onUpdate: rows => updates.push(codes(rows)) })
            .then(result => { finished = true; return result; });
        await flush();
        expect(updates).toEqual([['2330']]);
        expect(finished).toBe(false);
        delayedFutures.resolve([...futures].reverse());
        await flush();
        expect(updates.at(-1)).toEqual(['2330', ...expectedFutures]);
        expect(finished).toBe(false);
        delayedWarrants.resolve(warrants);
        expect(codes(await pending)).toEqual(['2330', ...expectedFutures, 'W001', 'W002', 'W003']);
        expect(source.futures.mock.calls[0]?.[0]).toEqual({ underlyingCode: '2330' });
        expect(source.warrants.mock.calls[0]?.[0]).toBe('2330');
        if (query === '2330') {
            expect(source.bases).not.toHaveBeenCalled();
            expect(source.names).not.toHaveBeenCalled();
        }
    });

    it('never publishes fast warrants ahead of still-pending monthly futures', async () => {
        const delayed = deferred<ContractInfo[]>();
        source.futures.mockReturnValue(delayed.promise);
        const { searchProducts } = await import('./product-search');
        const updates: string[][] = [];
        const pending = searchProducts('2330', 8, { includeWarrants: true, onUpdate: rows => updates.push(codes(rows)) });
        await flush();
        expect(source.warrants).toHaveBeenCalledTimes(1);
        expect(updates).toEqual([['2330']]);
        delayed.resolve([...futures].reverse());
        const result = await pending;
        expect(codes(result)).toEqual(['2330', ...expectedFutures, 'W001', 'W002', 'W003']);
        expect(updates.every(update => update.every(code => !code.startsWith('W')))).toBe(true);
        expect(result.find(item => item.code === 'CDFR1')?.contract?.target_code).toBe('CDFJ6');
    });

    it.each(['00679B', '元大美債20年'])('associates the same ETF underlying for code and name: %s', async query => {
        const delayed = deferred<ContractInfo[]>();
        source.warrants.mockReturnValue(delayed.promise);
        const related = ['RZFR2', 'RZFR1'].map(code => row(code, 'FUT', {
            name: '元大美債20年ETF期貨', underlying_code: '00679B', target_code: `${code.slice(0, 3)}J6`,
        }));
        source.futures.mockResolvedValue(related);
        const { searchProducts } = await import('./product-search');
        const updates: string[][] = [];
        const pending = searchProducts(query, 8, { includeWarrants: true, onUpdate: rows => updates.push(codes(rows)) });
        await flush();
        expect(updates.at(-1)).toEqual(['00679B', 'RZFR1', 'RZFR2']);
        expect(source.futures.mock.calls[0]?.[0]).toEqual({ underlyingCode: '00679B' });
        expect(source.warrants.mock.calls[0]?.[0]).toBe('00679B');
        delayed.resolve([]);
        expect((await pending)[0]).toMatchObject({ code: '00679B', exchange: 'OTC', security_type: 'STK' });
    });

    it('keeps monthly regular, small, micro ordering for index-family progressive results', async () => {
        const expected = ['TXFR1', 'MXFR1', 'TMFR1', 'TXFR2', 'MXFR2', 'TMFR2'];
        source.futures.mockResolvedValue([...expected].reverse().map(code => row(code, 'FUT', {
            name: `${code.startsWith('MX') ? '小型' : code.startsWith('TM') ? '微型' : ''}台指期貨`, underlying_code: 'IX0001',
        })));
        const { searchProducts } = await import('./product-search');
        const updates: string[][] = [];
        const result = await searchProducts('台指', 8, { includeWarrants: true, onUpdate: rows => updates.push(codes(rows)) });
        expect(codes(result.filter(item => item.security_type === 'FUT'))).toEqual(expected);
        expect(updates.at(-1)).toEqual(expected);
        expect(source.warrants).not.toHaveBeenCalled();
    });

    it('does not mutate frozen shared contract rows while publishing multiple phases', async () => {
        const immutable = Object.freeze([...futures].reverse().map(item => Object.freeze({ ...item })));
        source.futures.mockResolvedValue(immutable);
        const { searchProducts } = await import('./product-search');
        expect(codes(await searchProducts('2330', 8, { includeWarrants: true })))
            .toEqual(['2330', ...expectedFutures, 'W001', 'W002', 'W003']);
        expect(codes([...immutable])).toEqual([...expectedFutures].reverse());
    });
});

describe('search-source sharing and independent cancellation acceptance', () => {
    it('does not start any source for an already-aborted search', async () => {
        const controller = new AbortController();
        controller.abort();
        const { searchProducts } = await import('./product-search');
        await expect(searchProducts('2330', 8, { includeWarrants: true, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
        for (const mock of [source.resolve, source.bases, source.names, source.futureRoots, source.futures, source.warrants]) {
            expect(mock).not.toHaveBeenCalled();
        }
    });

    it('aborts the last direct-lookup reader and never starts downstream sources after a late answer', async () => {
        const old = deferred<ContractInfo>();
        source.resolve.mockReturnValueOnce(old.promise);
        const controller = new AbortController();
        const { searchProducts } = await import('./product-search');
        const pending = searchProducts('2330', 8, { includeWarrants: true, signal: controller.signal });
        const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await flush();
        const transportSignal = source.resolve.mock.calls[0]?.[2]?.signal as AbortSignal;
        controller.abort();
        await rejection;
        expect(transportSignal.aborted).toBe(true);
        old.resolve(stock);
        await flush();
        expect(source.bases).not.toHaveBeenCalled();
        expect(source.names).not.toHaveBeenCalled();
        expect(source.futures).not.toHaveBeenCalled();
        expect(source.warrants).not.toHaveBeenCalled();
        expect((await searchProducts('2330', 8, { includeWarrants: true }))[0]?.code).toBe('2330');
        expect(source.resolve).toHaveBeenCalledTimes(2);
    });

    it('shares duplicate direct lookups while one reader leaving does not abort the remaining reader', async () => {
        const delayed = deferred<ContractInfo>();
        source.resolve.mockReturnValue(delayed.promise);
        const first = new AbortController();
        const second = new AbortController();
        const { searchProducts } = await import('./product-search');
        const left = searchProducts('2330', 8, { includeWarrants: true, signal: first.signal });
        const leftRejected = expect(left).rejects.toMatchObject({ name: 'AbortError' });
        const right = searchProducts('2330', 8, { includeWarrants: true, signal: second.signal });
        await flush();
        expect(source.resolve).toHaveBeenCalledTimes(1);
        const transportSignal = source.resolve.mock.calls[0]?.[2]?.signal as AbortSignal;
        first.abort();
        await leftRejected;
        expect(transportSignal.aborted).toBe(false);
        delayed.resolve(stock);
        expect(codes(await right)).toEqual(['2330', ...expectedFutures, 'W001', 'W002', 'W003']);
        expect(source.futures).toHaveBeenCalledTimes(1);
        expect(source.warrants).toHaveBeenCalledTimes(1);
    });

    it('shares actual catalog sources between two name searches without coupling their cancellation', async () => {
        const bases = deferred<{ contracts: ContractInfo[] }>();
        const names = deferred<{ underlying_code: string; name: string }[]>();
        source.bases.mockReturnValue(bases.promise);
        source.names.mockReturnValue(names.promise);
        const controller = new AbortController();
        const { searchProducts } = await import('./product-search');
        const first = searchProducts('台積', 8, { includeWarrants: true, signal: controller.signal });
        const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
        const second = searchProducts('台積電', 8, { includeWarrants: true });
        await flush();
        expect(source.bases).toHaveBeenCalledTimes(1);
        expect(source.names).toHaveBeenCalledTimes(1);
        controller.abort();
        await rejected;
        expect(source.bases.mock.calls[0]?.[3]?.signal.aborted).toBe(false);
        expect(source.names.mock.calls[0]?.[0]?.signal.aborted).toBe(false);
        bases.resolve({ contracts: [stock] });
        names.resolve([{ underlying_code: '2330', name: '台積電' }]);
        expect(codes(await second)).toEqual(['2330', ...expectedFutures, 'W001', 'W002', 'W003']);
    });

    it('aborts both catalog transports and does not expand roots or derivatives after cancellation', async () => {
        const bases = deferred<{ contracts: ContractInfo[] }>();
        const names = deferred<{ underlying_code: string; name: string }[]>();
        source.bases.mockReturnValue(bases.promise);
        source.names.mockReturnValue(names.promise);
        const controller = new AbortController();
        const { searchProducts } = await import('./product-search');
        const pending = searchProducts('台積', 8, { includeWarrants: true, signal: controller.signal });
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await flush();
        controller.abort();
        await rejected;
        expect(source.bases.mock.calls[0]?.[3]?.signal.aborted).toBe(true);
        expect(source.names.mock.calls[0]?.[0]?.signal.aborted).toBe(true);
        bases.resolve({ contracts: [stock] });
        names.resolve([{ underlying_code: '2330', name: '台積電' }]);
        await flush();
        for (const mock of [source.futureRoots, source.optionRoots, source.futures, source.warrants]) expect(mock).not.toHaveBeenCalled();
    });

    it('does not fan out a late root response after its only reader has left', async () => {
        const roots = deferred<{ root: string; name: string }[]>();
        source.futureRoots.mockReturnValue(roots.promise);
        const controller = new AbortController();
        const { searchProducts } = await import('./product-search');
        const pending = searchProducts('金融期貨', 8, { signal: controller.signal });
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await flush();
        expect(source.futureRoots).toHaveBeenCalledTimes(1);
        controller.abort();
        await rejected;
        expect(source.futureRoots.mock.calls[0]?.[0]?.signal.aborted).toBe(true);
        roots.resolve([{ root: 'TXF', name: '金融期貨' }]);
        await flush();
        expect(source.futures).not.toHaveBeenCalled();
        expect(source.warrants).not.toHaveBeenCalled();
    });

    it('shares underlying requests across code and name searches and preserves remaining readers', async () => {
        const delayedFutures = deferred<ContractInfo[]>();
        const delayedWarrants = deferred<ContractInfo[]>();
        source.futures.mockReturnValue(delayedFutures.promise);
        source.warrants.mockReturnValue(delayedWarrants.promise);
        const controller = new AbortController();
        const { searchProducts } = await import('./product-search');
        const first = searchProducts('2330', 8, { includeWarrants: true, signal: controller.signal });
        const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
        const second = searchProducts('台積電', 8, { includeWarrants: true });
        await flush();
        expect(source.futures).toHaveBeenCalledTimes(1);
        expect(source.warrants).toHaveBeenCalledTimes(1);
        controller.abort();
        await rejected;
        expect(source.futures.mock.calls[0]?.[1]?.signal.aborted).toBe(false);
        expect(source.warrants.mock.calls[0]?.[2]?.signal.aborted).toBe(false);
        delayedFutures.resolve([...futures].reverse());
        delayedWarrants.resolve(warrants);
        expect(codes(await second)).toEqual(['2330', ...expectedFutures, 'W001', 'W002', 'W003']);
    });
});

describe('partial-source recovery and stale-response acceptance', () => {
    it('retries failed optional names without refetching the successful Base catalog', async () => {
        source.names.mockRejectedValueOnce(new Error('503 optional names'));
        const { searchProducts } = await import('./product-search');
        expect(await searchProducts('台積', 8, { includeWarrants: true })).toEqual([]);
        const recovered = await searchProducts('台積', 8, { includeWarrants: true });
        expect(codes(recovered)).toEqual(['2330', ...expectedFutures, 'W001', 'W002', 'W003']);
        expect(source.bases).toHaveBeenCalledTimes(1);
        expect(source.names).toHaveBeenCalledTimes(2);
    });

    it('rejects a changed server and does not cache its late futures response', async () => {
        const delayed = deferred<ContractInfo[]>();
        source.futures.mockReturnValueOnce(delayed.promise);
        const { searchProducts } = await import('./product-search');
        const updates: string[][] = [];
        const pending = searchProducts('2330', 8, { includeWarrants: true, onUpdate: rows => updates.push(codes(rows)) });
        const rejected = expect(pending).rejects.toThrow('伺服器已切換');
        await flush();
        source.base = 'http://127.0.0.1:21324';
        delayed.resolve([...futures].reverse());
        await rejected;
        expect(updates).toEqual([['2330']]);
        source.base = 'http://127.0.0.1:21323';
        expect((await searchProducts('2330', 8, { includeWarrants: true })).some(item => item.code === 'CDFR1')).toBe(true);
        expect(source.futures).toHaveBeenCalledTimes(2);
    });

    it('aborts a timed-out transport, preserves valid results, and does not cache its late answer', async () => {
        const delayed = deferred<ContractInfo[]>();
        source.futures.mockReturnValueOnce(delayed.promise);
        const { searchProducts } = await import('./product-search');
        const pending = searchProducts('2330', 8, { includeWarrants: true });
        await flush();
        const transportSignal = source.futures.mock.calls[0]?.[1]?.signal as AbortSignal;
        await vi.advanceTimersByTimeAsync(1200);
        expect(codes(await pending)).toEqual(['2330', 'W001', 'W002', 'W003']);
        expect(transportSignal.aborted).toBe(true);
        delayed.resolve([row('STALE', 'FUT', { underlying_code: '2330' })]);
        await flush();
        const retry = await searchProducts('2330', 8, { includeWarrants: true });
        expect(codes(retry)).toEqual(['2330', ...expectedFutures, 'W001', 'W002', 'W003']);
        expect(source.futures).toHaveBeenCalledTimes(2);
        expect(source.warrants).toHaveBeenCalledTimes(1);
    });

    it('does not cache direct Info beyond concurrent readers while caching successful related sources', async () => {
        const { searchProducts } = await import('./product-search');
        await searchProducts('2330', 8, { includeWarrants: true });
        await searchProducts('2330', 8, { includeWarrants: true });
        expect(source.resolve).toHaveBeenCalledTimes(2);
        expect(source.futures).toHaveBeenCalledTimes(1);
        expect(source.warrants).toHaveBeenCalledTimes(1);
    });
});
