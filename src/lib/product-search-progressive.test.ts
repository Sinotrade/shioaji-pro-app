import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from './types/contract';

const m = vi.hoisted(() => ({
    base: 'http://search-progressive', day: '2026-10-17', catalog: vi.fn(), resolve: vi.fn(),
    futures: vi.fn(), roots: vi.fn(), options: vi.fn(), optionRoots: vi.fn(), warrants: vi.fn(),
}));
vi.mock('./runtime', () => ({ getApiBase: () => m.base }));
vi.mock('./utils/date', () => ({ todayStr: () => m.day }));
vi.mock('./shioaji', () => ({
    fetchFutures: m.futures, fetchFuturesRoots: m.roots, fetchOptionRoots: m.optionRoots,
    fetchOptions: m.options, fetchWarrants: m.warrants, resolveContract: m.resolve,
    normalizeContractCode: (code: string) => code.trim().toUpperCase(),
}));
vi.mock('./stock-index', async original => ({ ...await original<object>(), loadStockCatalog: m.catalog }));

const stock = { code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', category: '' };
const futures = [
    ['CDFR1', '台積電期貨 近月'], ['QFFR1', '小型台積電期貨 近月'],
    ['CDFR2', '台積電期貨 次月'], ['QFFR2', '小型台積電期貨 次月'],
].map(([code, name]) => ({ ...stock, code, name, security_type: 'FUT', exchange: 'TAIFEX', underlying_code: '2330', target_code: `${code}TARGET` })) as ContractInfo[];
const warrants = [{ ...stock, code: 'TESTW', name: '本機測試權證', security_type: 'WRT', underlying_code: '2330',
    expiry_date: '2027-01-01', last_trading_date: '2027-01-01' }] as ContractInfo[];
const wait = <T,>(ms: number, value: T) => new Promise<T>(resolve => setTimeout(() => resolve(value), ms));
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
const getSearch = async () => (await import('./product-search')).searchProducts;

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T09:00:00+08:00'));
    vi.clearAllMocks();
    m.base = 'http://search-progressive';
    m.catalog.mockResolvedValue([stock]);
    m.resolve.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    m.futures.mockResolvedValue([...futures].reverse());
    m.roots.mockResolvedValue([]);
    m.options.mockResolvedValue([]);
    m.optionRoots.mockResolvedValue([]);
    m.warrants.mockResolvedValue(warrants);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('progressive results preserve the existing product order', () => {
    it('publishes stock at 20 ms and sorted futures at 60 ms without waiting for warrants at 1020 ms', async () => {
        const run = await getSearch();
        const start = Date.now();
        m.catalog.mockImplementation(() => wait(20, [stock]));
        m.futures.mockImplementation(() => wait(40, [...futures].reverse()));
        m.warrants.mockImplementation(() => wait(1000, warrants));
        const updates: { time: number; codes: string[] }[] = [];
        let finished = false;
        const pending = run('台積', 8, { includeWarrants: true, onUpdate: rows => {
            updates.push({ time: Date.now() - start, codes: rows.map(row => row.code) });
        } }).then(rows => { finished = true; return rows; });
        await vi.advanceTimersByTimeAsync(20);
        expect(updates).toEqual([{ time: 20, codes: ['2330'] }]);
        await vi.advanceTimersByTimeAsync(40);
        expect(updates.at(-1)).toEqual({ time: 60, codes: ['2330', 'CDFR1', 'QFFR1', 'CDFR2', 'QFFR2'] });
        expect(finished).toBe(false);
        await vi.advanceTimersByTimeAsync(960);
        const final = await pending;
        expect(final.map(row => row.code)).toEqual(['2330', 'CDFR1', 'QFFR1', 'CDFR2', 'QFFR2', 'TESTW']);
        expect(final[1]?.contract).toBe(futures[0]);
        expect(final[1]?.contract?.target_code).toBe('CDFR1TARGET');
        expect(Date.now() - start).toBe(1020);
    });

    it('does not publish early warrants ahead of still-pending futures', async () => {
        m.futures.mockImplementation(() => wait(400, futures));
        const run = await getSearch();
        const onUpdate = vi.fn();
        const pending = run('台積電', 8, { includeWarrants: true, onUpdate });
        await vi.advanceTimersByTimeAsync(399);
        expect(onUpdate.mock.calls.map(([rows]) => rows.map((row: ContractInfo) => row.code))).toEqual([['2330']]);
        await vi.advanceTimersByTimeAsync(1);
        expect((await pending).map(row => row.code)).toEqual(['2330', 'CDFR1', 'QFFR1', 'CDFR2', 'QFFR2', 'TESTW']);
    });

    it('keeps the six monthly index futures ahead of weekly futures in partial and final results', async () => {
        m.catalog.mockResolvedValue([]);
        const expected = ['TXFR1', 'MXFR1', 'TMFR1', 'TXFR2', 'MXFR2', 'TMFR2'];
        const names = ['台指期貨', '小型台指期貨', '微型台指期貨'];
        m.futures.mockResolvedValue([
            { ...futures[0], code: 'MX4R1', name: '小型台指期貨 W4', underlying_code: 'IX0001' },
            ...expected.map((code, index) => ({ ...futures[0], code, name: names[index % 3], underlying_code: 'IX0001' })).reverse(),
        ]);
        const run = await getSearch();
        const onUpdate = vi.fn();
        const final = await run('台指', 8, { includeWarrants: true, onUpdate });
        expect(final.filter(row => row.security_type === 'FUT').map(row => row.code)).toEqual(expected);
        expect(onUpdate.mock.calls.at(-1)?.[0].map((row: ContractInfo) => row.code)).toEqual(expected);
    });

    it('keeps primary stock and futures if a related source times out, and forwards abort', async () => {
        let sourceSignal!: AbortSignal;
        m.warrants.mockImplementation((_code, _filters, { signal }) => {
            sourceSignal = signal;
            return new Promise(() => undefined);
        });
        const run = await getSearch();
        const onUpdate = vi.fn();
        const pending = run('台積電', 8, { includeWarrants: true, onUpdate });
        await vi.advanceTimersByTimeAsync(0);
        expect(onUpdate.mock.calls.at(-1)?.[0]).toHaveLength(5);
        expect(sourceSignal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1200);
        expect((await pending).map(row => row.code)).toEqual(['2330', 'CDFR1', 'QFFR1', 'CDFR2', 'QFFR2']);
        expect(sourceSignal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('each search owns its cancellation, shared sources do not', () => {
    it('shares simultaneous direct codes but does not cache their completed Info', async () => {
        const direct = deferred<ContractInfo>();
        m.resolve.mockReturnValue(direct.promise);
        const run = await getSearch();
        const pending = Promise.all(Array.from({ length: 3 }, () => run('2330', 8, { includeWarrants: true })));
        await vi.advanceTimersByTimeAsync(0);
        expect(m.resolve).toHaveBeenCalledTimes(1);
        direct.resolve(stock as ContractInfo);
        await pending;
        await run('2330', 8, { includeWarrants: true });
        expect(m.resolve).toHaveBeenCalledTimes(2);
        expect(m.futures).toHaveBeenCalledTimes(1);
    });

    it('cancelling the creator of a direct request does not cancel its other reader or related search', async () => {
        const direct = deferred<ContractInfo>();
        m.resolve.mockReturnValue(direct.promise);
        const run = await getSearch();
        const controller = new AbortController();
        const old = run('2330', 8, { includeWarrants: true, signal: controller.signal });
        const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
        const current = run('2330', 8, { includeWarrants: true });
        await vi.advanceTimersByTimeAsync(0);
        const sharedSignal = m.resolve.mock.calls[0]?.[2].signal as AbortSignal;
        controller.abort();
        await rejected;
        expect(sharedSignal.aborted).toBe(false);
        direct.resolve(stock as ContractInfo);
        expect((await current).map(row => row.code)).toEqual(['2330', 'CDFR1', 'QFFR1', 'CDFR2', 'QFFR2', 'TESTW']);
        expect(m.resolve).toHaveBeenCalledTimes(1);
    });

    it('cancelling the first related-source reader leaves the second reader and cache valid', async () => {
        const late = deferred<ContractInfo[]>();
        m.warrants.mockReturnValue(late.promise);
        const run = await getSearch();
        const controller = new AbortController();
        const onUpdate = vi.fn();
        const old = run('台積', 8, { includeWarrants: true, signal: controller.signal, onUpdate });
        const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
        const current = run('台積電', 8, { includeWarrants: true });
        await vi.advanceTimersByTimeAsync(0);
        const signal = m.warrants.mock.calls[0]?.[2].signal as AbortSignal;
        controller.abort();
        await rejected;
        const priorUpdates = onUpdate.mock.calls.length;
        expect(signal.aborted).toBe(false);
        late.resolve(warrants);
        expect((await current).at(-1)?.code).toBe('TESTW');
        await run('台積電', 8, { includeWarrants: true });
        expect(m.warrants).toHaveBeenCalledTimes(1);
        expect(onUpdate).toHaveBeenCalledTimes(priorUpdates);
    });

    it('cancelled direct miss cannot start catalog or derivative fallback even if it returns late', async () => {
        const late = deferred<ContractInfo>();
        m.resolve.mockReturnValue(late.promise);
        const run = await getSearch();
        const controller = new AbortController();
        const pending = run('2330', 8, { includeWarrants: true, signal: controller.signal });
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        await rejected;
        late.resolve(stock as ContractInfo);
        await vi.advanceTimersByTimeAsync(0);
        expect(m.catalog).not.toHaveBeenCalled();
        expect(m.futures).not.toHaveBeenCalled();
        expect(m.warrants).not.toHaveBeenCalled();
    });

    it('cancels catalog waiting promptly without starting downstream requests', async () => {
        const late = deferred<typeof stock[]>();
        m.catalog.mockReturnValue(late.promise);
        const run = await getSearch();
        const controller = new AbortController();
        const onUpdate = vi.fn();
        const pending = run('台積', 8, { includeWarrants: true, signal: controller.signal, onUpdate });
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await vi.advanceTimersByTimeAsync(0);
        const signal = m.catalog.mock.calls[0]?.[0].signal as AbortSignal;
        controller.abort();
        await rejected;
        expect(signal.aborted).toBe(true);
        late.resolve([stock]);
        await vi.advanceTimersByTimeAsync(0);
        expect(m.futures).not.toHaveBeenCalled();
        expect(m.warrants).not.toHaveBeenCalled();
        expect(onUpdate).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('stops root expansion after cancellation and rejects already aborted calls without work', async () => {
        m.catalog.mockResolvedValue([]);
        const late = deferred<{ root: string; name: string }[]>();
        m.roots.mockReturnValue(late.promise);
        const run = await getSearch();
        const controller = new AbortController();
        const pending = run('測試期貨', 8, { signal: controller.signal });
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        await rejected;
        late.resolve([{ root: 'CDF', name: '測試期貨' }]);
        await vi.advanceTimersByTimeAsync(0);
        expect(m.futures).not.toHaveBeenCalled();
        const before = m.catalog.mock.calls.length;
        await expect(run('台積', 8, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
        expect(m.catalog).toHaveBeenCalledTimes(before);
    });

    it('retries direct 404s and source failures rather than caching them', async () => {
        m.catalog.mockResolvedValue([]);
        const run = await getSearch();
        await run('UNKNOWN');
        await run('UNKNOWN');
        expect(m.resolve).toHaveBeenCalledTimes(2);
        m.resolve.mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce(stock);
        await expect(run('2330')).rejects.toThrow('商品搜尋暫時無法完成');
        expect((await run('2330'))[0]?.code).toBe('2330');
        expect(m.resolve).toHaveBeenCalledTimes(4);
    });
});
