import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import snapshot from './data/etf-catalog.json';

const m = vi.hoisted(() => ({ base: 'fixture-a', day: '2026-10-17', baseRows: vi.fn(), names: vi.fn(), info: vi.fn() }));
vi.mock('./runtime', () => ({ getApiBase: () => m.base }));
vi.mock('./utils/date', () => ({ todayStr: () => m.day }));
vi.mock('./shioaji', () => ({ fetchContracts: m.baseRows, fetchWarrantUnderlyings: m.names, fetchContractInfo: m.info }));

const base = (code: string, exchange = 'TSE') => ({ code, exchange, security_type: 'STK' });
const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
};

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T06:00:00Z'));
    m.base = 'fixture-a';
    m.day = '2026-10-17';
    m.baseRows.mockReset().mockResolvedValue({ contracts: [base('2330')] });
    m.names.mockReset().mockResolvedValue([{ underlying_code: '2330', name: '台積電' }]);
    m.info.mockReset().mockImplementation(async code => ({ code, name: code, exchange: 'TSE', category: '24' }));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('stock catalog identity, source recovery and scope', () => {
    it('shares concurrent source reads and briefly caches successes', async () => {
        const { loadStockCatalog } = await import('./stock-index');
        const [a, b] = await Promise.all([loadStockCatalog(), loadStockCatalog()]);
        expect(a).toBe(b);
        expect(a[0]?.name).toBe('台積電');
        expect(await loadStockCatalog()).toBe(a);
        expect(m.baseRows).toHaveBeenCalledTimes(1);
        expect(m.names).toHaveBeenCalledTimes(1);
    });
    it('retries failed optional names without refetching successful Base', async () => {
        m.names.mockRejectedValueOnce(new Error('Synthetic 503'));
        const { loadStockCatalog } = await import('./stock-index');
        expect((await loadStockCatalog())[0]?.name).toBe('2330');
        expect((await loadStockCatalog())[0]?.name).toBe('台積電');
        expect(m.baseRows).toHaveBeenCalledTimes(1);
        expect(m.names).toHaveBeenCalledTimes(2);
    });
    it('retries failed Base rather than caching a missing catalog', async () => {
        m.baseRows.mockRejectedValueOnce(new Error('Synthetic 503'));
        const { loadStockCatalog } = await import('./stock-index');
        await expect(loadStockCatalog()).rejects.toThrow('Synthetic 503');
        expect((await loadStockCatalog())[0]?.name).toBe('台積電');
        expect(m.baseRows).toHaveBeenCalledTimes(2);
    });
    it('isolates different services and Taiwan calendar days', async () => {
        const { loadStockCatalog } = await import('./stock-index');
        await loadStockCatalog();
        m.base = 'fixture-b';
        m.baseRows.mockResolvedValue({ contracts: [base('3481')] });
        expect((await loadStockCatalog())[0]?.code).toBe('3481');
        m.day = '2026-10-18';
        await loadStockCatalog();
        expect(m.baseRows).toHaveBeenCalledTimes(3);
    });
    it('refreshes source data after the short TTL', async () => {
        const { loadStockCatalog } = await import('./stock-index');
        await loadStockCatalog();
        await vi.advanceTimersByTimeAsync(60_001);
        await loadStockCatalog();
        expect(m.baseRows).toHaveBeenCalledTimes(2);
        expect(m.names).toHaveBeenCalledTimes(2);
    });
    it('rejects an old in-flight catalog after a server switch', async () => {
        const old = deferred<{ contracts: ReturnType<typeof base>[] }>();
        m.baseRows.mockReturnValueOnce(old.promise);
        const { loadStockCatalog } = await import('./stock-index');
        const pending = loadStockCatalog();
        const rejected = expect(pending).rejects.toThrow('伺服器已切換');
        await vi.advanceTimersByTimeAsync(0);
        m.base = 'fixture-b';
        old.resolve({ contracts: [base('2330')] });
        await rejected;
        m.baseRows.mockResolvedValue({ contracts: [base('3481')] });
        expect((await loadStockCatalog())[0]?.code).toBe('3481');
    });
    it('bounds a stuck name source and retries without accepting its late completion', async () => {
        const old = deferred<{ underlying_code: string; name: string }[]>();
        m.names.mockReturnValueOnce(old.promise);
        const { loadStockCatalog } = await import('./stock-index');
        const pending = loadStockCatalog();
        await vi.advanceTimersByTimeAsync(1000);
        expect((await pending)[0]?.name).toBe('2330');
        expect((await loadStockCatalog())[0]?.name).toBe('台積電');
        old.resolve([{ underlying_code: '2330', name: 'Synthetic stale' }]);
        await vi.advanceTimersByTimeAsync(0);
        expect((await loadStockCatalog())[0]?.name).toBe('台積電');
    });
    it('bounds a stuck Base source, then allows a successful retry', async () => {
        m.baseRows.mockReturnValueOnce(new Promise(() => undefined));
        const { loadStockCatalog } = await import('./stock-index');
        const pending = expect(loadStockCatalog()).rejects.toThrow('逾時');
        await vi.advanceTimersByTimeAsync(1000);
        await pending;
        expect((await loadStockCatalog())[0]?.name).toBe('台積電');
    });
    it('does not reuse or overwrite detailed metadata across service switches', async () => {
        const old = deferred<{ code: string; name: string; category: string; exchange: string }>();
        m.info.mockReturnValueOnce(old.promise);
        const { loadStockDetails } = await import('./stock-index');
        const a = loadStockDetails(['2330']);
        m.base = 'fixture-b';
        m.info.mockResolvedValue({ code: '2330', name: 'Synthetic B', category: '24', exchange: 'TSE' });
        expect((await loadStockDetails(['2330']))[0]?.name).toBe('Synthetic B');
        old.resolve({ code: '2330', name: 'Synthetic A', category: '24', exchange: 'TSE' });
        expect(await a).toEqual([]);
        expect((await loadStockDetails(['2330']))[0]?.name).toBe('Synthetic B');
    });
    it('rejects the first A detail even after A→B→A returns to the same service URL', async () => {
        const old = deferred<{ code: string; name: string; category: string; exchange: string }>();
        m.info.mockReturnValueOnce(old.promise);
        const { loadStockDetails } = await import('./stock-index');
        const firstA = loadStockDetails(['2330']);
        m.base = 'fixture-b';
        await loadStockDetails(['2330']);
        m.base = 'fixture-a';
        m.info.mockResolvedValue({ code: '2330', name: 'Synthetic new A', category: '24', exchange: 'TSE' });
        await loadStockDetails(['2330']);
        old.resolve({ code: '2330', name: 'Synthetic stale A', category: '24', exchange: 'TSE' });
        expect(await firstA).toEqual([]);
        expect((await loadStockDetails(['2330']))[0]?.name).toBe('Synthetic new A');
    });
    it('does not reuse or accept old pending catalog sources after A→B→A', async () => {
        const old = deferred<{ contracts: ReturnType<typeof base>[] }>();
        m.baseRows.mockReturnValueOnce(old.promise);
        const { loadStockCatalog } = await import('./stock-index');
        const firstA = loadStockCatalog();
        const rejected = expect(firstA).rejects.toThrow('伺服器已切換');
        await vi.advanceTimersByTimeAsync(0);
        m.base = 'fixture-b';
        await loadStockCatalog();
        m.base = 'fixture-a';
        m.baseRows.mockResolvedValue({ contracts: [base('3481')] });
        expect((await loadStockCatalog())[0]?.code).toBe('3481');
        old.resolve({ contracts: [base('2330')] });
        await rejected;
        expect((await loadStockCatalog())[0]?.code).toBe('3481');
    });
    it.each([
        { action: 'ADD', base_changed: true, info_changed: false },
        { action: 'UPDATE', base_changed: false, info_changed: true },
        { action: 'RECONNECT', base_changed: true, info_changed: true },
        { action: 'MAINTENANCE', base_changed: true, info_changed: true },
    ])('refreshes Base, names and typed details after a same-service $action event', async change => {
        const { loadStockCatalog, loadStockDetails } = await import('./stock-index');
        const { invalidateProductCatalog } = await import('./product-catalog-version');
        const before = await loadStockCatalog();
        await loadStockDetails(['2330']);
        m.baseRows.mockResolvedValue({ contracts: [base('3481')] });
        m.names.mockResolvedValue([{ underlying_code: '3481', name: '群創' }]);
        m.info.mockResolvedValue({ code: '2330', name: 'Synthetic fresh Info', category: '24', exchange: 'TSE' });

        invalidateProductCatalog({ region: 'TW', ...change });

        const after = await loadStockCatalog();
        expect(after).not.toBe(before);
        expect(after[0]).toMatchObject({ code: '3481', name: '群創' });
        expect((await loadStockDetails(['2330']))[0]?.name).toBe('Synthetic fresh Info');
        expect(m.baseRows).toHaveBeenCalledTimes(2);
        expect(m.names).toHaveBeenCalledTimes(2);
        expect(m.info).toHaveBeenCalledTimes(2);
    });
    it('keeps the catalog and details cached after foreign or unchanged events', async () => {
        const { loadStockCatalog, loadStockDetails } = await import('./stock-index');
        const { invalidateProductCatalog } = await import('./product-catalog-version');
        const before = await loadStockCatalog();
        await loadStockDetails(['2330']);
        invalidateProductCatalog({ region: 'US', base_changed: true, info_changed: true });
        invalidateProductCatalog({ region: 'TW', base_changed: false, info_changed: false });
        expect(await loadStockCatalog()).toBe(before);
        await loadStockDetails(['2330']);
        expect(m.baseRows).toHaveBeenCalledTimes(1);
        expect(m.names).toHaveBeenCalledTimes(1);
        expect(m.info).toHaveBeenCalledTimes(1);
    });
    it('rejects old pending sources and ignores old Info after a same-service refresh', async () => {
        const oldBase = deferred<{ contracts: ReturnType<typeof base>[] }>();
        const oldInfo = deferred<{ code: string; name: string; category: string; exchange: string }>();
        m.baseRows.mockReturnValueOnce(oldBase.promise);
        m.info.mockReturnValueOnce(oldInfo.promise);
        const { loadStockCatalog, loadStockDetails } = await import('./stock-index');
        const { invalidateProductCatalog } = await import('./product-catalog-version');
        const oldCatalog = loadStockCatalog();
        const rejected = expect(oldCatalog).rejects.toThrow('伺服器已切換');
        const oldDetails = loadStockDetails(['2330']);
        invalidateProductCatalog({ region: 'TW', base_changed: true, info_changed: true });
        await rejected;
        m.baseRows.mockResolvedValue({ contracts: [base('3481')] });
        m.info.mockResolvedValue({ code: '2330', name: 'Synthetic current', category: '24', exchange: 'TSE' });
        expect((await loadStockCatalog())[0]?.code).toBe('3481');
        expect((await loadStockDetails(['2330']))[0]?.name).toBe('Synthetic current');
        oldBase.resolve({ contracts: [base('2330')] });
        oldInfo.resolve({ code: '2330', name: 'Synthetic stale', category: '24', exchange: 'TSE' });
        expect(await oldDetails).toEqual([]);
        expect((await loadStockCatalog())[0]?.code).toBe('3481');
        expect((await loadStockDetails(['2330']))[0]?.name).toBe('Synthetic current');
    });
    it('refreshes individual typed details and the assembled full index after the short TTL', async () => {
        const { loadStockDetails, loadStockIndex } = await import('./stock-index');
        expect((await loadStockDetails(['2330']))[0]?.name).toBe('2330');
        await loadStockIndex();
        expect(m.info).toHaveBeenCalledTimes(1);
        m.info.mockResolvedValue({ code: '2330', name: 'Synthetic new name', category: '24', exchange: 'TSE' });
        await vi.advanceTimersByTimeAsync(60_000);
        expect((await loadStockIndex())[0]?.name).toBe('Synthetic new name');
        expect((await loadStockDetails(['2330']))[0]?.name).toBe('Synthetic new name');
        expect(m.info).toHaveBeenCalledTimes(2);
        expect(m.baseRows).toHaveBeenCalledTimes(2);
    });
    it('retries failed typed details instead of caching a permanent missing name', async () => {
        m.info.mockRejectedValueOnce(new Error('Synthetic Info outage'));
        const { loadStockDetails } = await import('./stock-index');
        expect(await loadStockDetails(['2330'])).toEqual([]);
        expect((await loadStockDetails(['2330']))[0]?.code).toBe('2330');
        expect(m.info).toHaveBeenCalledTimes(2);
    });
    it('does not extend an older Info TTL when the complete index is assembled later', async () => {
        const { loadStockDetails, loadStockIndex } = await import('./stock-index');
        await loadStockDetails(['2330']);
        await vi.advanceTimersByTimeAsync(59_000);
        await loadStockIndex();
        m.info.mockResolvedValue({ code: '2330', name: 'Synthetic after expiry', category: '24', exchange: 'TSE' });
        await vi.advanceTimersByTimeAsync(1000);
        expect((await loadStockIndex())[0]?.name).toBe('Synthetic after expiry');
        expect(m.info).toHaveBeenCalledTimes(2);
    });
    it('does not extend an older Base TTL when complete Info is loaded later', async () => {
        const { loadStockCatalog, loadStockIndex } = await import('./stock-index');
        await loadStockCatalog();
        await vi.advanceTimersByTimeAsync(59_000);
        await loadStockIndex();
        m.baseRows.mockResolvedValue({ contracts: [base('3481')] });
        m.names.mockResolvedValue([{ underlying_code: '3481', name: '群創' }]);
        await vi.advanceTimersByTimeAsync(1000);
        expect((await loadStockIndex())[0]?.code).toBe('3481');
        expect(m.baseRows).toHaveBeenCalledTimes(2);
    });
});

describe('official ETF name snapshot joined only to supported contracts', () => {
    it('names all snapshot entries only when the same exchange+code exists in Base', async () => {
        m.baseRows.mockResolvedValue({ contracts: snapshot.entries.map(row => base(row.code, row.exchange)) });
        m.names.mockResolvedValue([]);
        const { loadStockCatalog, searchStocks } = await import('./stock-index');
        const catalog = await loadStockCatalog();
        expect(catalog).toHaveLength(snapshot.entries.length);
        for (const row of snapshot.entries) {
            expect(catalog.find(item => item.code === row.code && item.exchange === row.exchange))
                .toMatchObject({ name: row.name, kind: 'ETF' });
            expect(searchStocks(catalog, row.code, catalog.length).some(item => item.code === row.code)).toBe(true);
            expect(searchStocks(catalog, row.name, catalog.length).some(item => item.code === row.code)).toBe(true);
        }
    });
    it('does not invent unsupported ETF identities or borrow another market name', async () => {
        m.baseRows.mockResolvedValue({ contracts: [base('0051', 'OTC'), base('NOTETF')] });
        m.names.mockResolvedValue([]);
        const { loadStockCatalog } = await import('./stock-index');
        const catalog = await loadStockCatalog();
        expect(catalog).toEqual([
            { code: '0051', name: '0051', category: '', exchange: 'OTC' },
            { code: 'NOTETF', name: 'NOTETF', category: '', exchange: 'TSE' },
        ]);
    });
    it('preserves the fresh broker name while allowing official full-name aliases', async () => {
        m.baseRows.mockResolvedValue({ contracts: [base('0051')] });
        m.names.mockResolvedValue([{ underlying_code: '0051', name: 'Synthetic live name' }]);
        const { loadStockCatalog, searchStocks } = await import('./stock-index');
        const catalog = await loadStockCatalog();
        const official = snapshot.entries.find(row => row.code === '0051' && row.exchange === 'TSE')!;
        expect(catalog[0]?.name).toBe('Synthetic live name');
        expect(searchStocks(catalog, official.name)[0]?.code).toBe('0051');
        expect(searchStocks(catalog, official.aliases![0]!)[0]?.code).toBe('0051');
    });
    it('keeps ETF names usable when the optional warrant-underlying service fails', async () => {
        m.baseRows.mockResolvedValue({ contracts: [base('0051'), base('00679B', 'OTC'), base('00981A')] });
        m.names.mockRejectedValue(new Error('Synthetic name outage'));
        const { loadStockCatalog, searchStocks } = await import('./stock-index');
        const catalog = await loadStockCatalog();
        expect(searchStocks(catalog, '元大中型100')[0]).toMatchObject({ code: '0051', kind: 'ETF', exchange: 'TSE' });
        expect(searchStocks(catalog, '元大美債20年')[0]).toMatchObject({ code: '00679B', kind: 'ETF', exchange: 'OTC' });
        expect(catalog.find(row => row.code === '00981A')?.name).not.toBe('00981A');
    });
    it('normalizes 台/臺 and English case without changing the official display', async () => {
        m.baseRows.mockResolvedValue({ contracts: [base('0050'), base('00679B', 'OTC')] });
        m.names.mockResolvedValue([]);
        const { loadStockCatalog, searchStocks } = await import('./stock-index');
        const catalog = await loadStockCatalog();
        const fund = snapshot.entries.find(row => row.code === '0050' && row.exchange === 'TSE')!;
        expect(searchStocks(catalog, '元大臺灣50')[0]?.name).toBe(fund.name);
        expect(searchStocks(catalog, '00679b')[0]?.exchange).toBe('OTC');
    });
    it('matches decoded S&P names even when broker names are unavailable', async () => {
        m.baseRows.mockResolvedValue({ contracts: [base('00646')] });
        m.names.mockRejectedValue(new Error('Synthetic name outage'));
        const { loadStockCatalog, searchStocks } = await import('./stock-index');
        const catalog = await loadStockCatalog();
        expect(searchStocks(catalog, 'S&P500')[0]).toMatchObject({ code: '00646', name: '元大S&P500' });
        expect(searchStocks(catalog, 'Ｓ＆Ｐ５００')[0]?.code).toBe('00646');
        expect(JSON.stringify(snapshot.entries)).not.toMatch(/&(?:amp|#\d+);/);
    });
    it('finds 0053 under both its daily current name and the prior official fund name', async () => {
        m.baseRows.mockResolvedValue({ contracts: [base('0053')] });
        m.names.mockResolvedValue([]);
        const { loadStockCatalog, searchStocks } = await import('./stock-index');
        const catalog = await loadStockCatalog();
        expect(searchStocks(catalog, '元大科技市值')[0]).toMatchObject({ code: '0053', name: '元大科技市值', kind: 'ETF' });
        expect(searchStocks(catalog, '元大電子')[0]?.code).toBe('0053');
    });
});
