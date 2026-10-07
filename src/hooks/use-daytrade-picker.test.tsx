import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../lib/types/contract';
import type { Candle, Snapshot } from '../lib/types/market';
import { buildDaytradePool, scanDaytrade, useDaytradePicker } from './use-daytrade-picker';

const mocks = vi.hoisted(() => ({
    research: true, items: [] as { contract: ContractInfo }[],
    scanner: vi.fn(), snapshots: vi.fn(), ensure: vi.fn(), prime: vi.fn(),
    get: vi.fn(), post: vi.fn(), daily: vi.fn(), cached: vi.fn(), background: vi.fn(), evaluate: vi.fn(),
}));
vi.mock('./use-watchlist', () => ({ useWatchlist: () => ({ items: mocks.items }) }));
vi.mock('../lib/workspace', () => ({ get V9_RESEARCH_MODE() { return mocks.research; } }));
vi.mock('../lib/api', () => ({ apiGet: mocks.get, apiPost: mocks.post }));
vi.mock('../lib/contracts-cache', () => ({ ensureContract: mocks.ensure, primeContract: mocks.prime }));
vi.mock('../lib/daily-candles', () => ({ getDailyCandles: mocks.daily, readCachedDailyCandles: mocks.cached }));
vi.mock('../lib/shioaji', () => ({ fetchScanner: mocks.scanner, fetchSnapshots: mocks.snapshots }));
vi.mock('../lib/research-background', () => ({
    researchBackgroundKey: (c: ContractInfo) => `${c.exchange}:${c.code}`,
    researchBackgroundStore: { get: mocks.background },
}));
vi.mock('../lib/daytrade-picker', () => ({ evaluateDaytrade: mocks.evaluate }));

const NOW = Date.parse('2026-10-07T09:30:00+08:00');
function contract(code: string, overrides: Partial<ContractInfo> = {}): ContractInfo {
    return {
        code, security_type: code === 'IX0001' ? 'IND' : 'STK', region: 'TW', exchange: 'TSE',
        target_code: null, name: `測試${code}`, currency: 'TWD', category: '24',
        limit_up: 110, limit_down: 90, reference: 100, day_trade: 'Yes', update_date: '2026-10-07',
        margin_trading_balance: 0, short_selling_balance: 0, unit: 1000,
        trading_suspended: false, disposition_level: 0, ...overrides,
    };
}
function bar(day: string, time = '00:00:00'): Candle {
    return { time: Date.parse(`${day}T${time}Z`) / 1000, open: 100, high: 102, low: 99, close: 101, volume: 100 };
}
function snapshot(code = '2330', exchange = 'TSE'): Snapshot {
    return { code, exchange, datetime: '2026-10-07T09:30:00', change_rate: 2 } as Snapshot;
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
let renderer: ReactTestRenderer | undefined;
let result: ReturnType<typeof useDaytradePicker>;
function Probe({ enabled = false }: { enabled?: boolean }) { result = useDaytradePicker(enabled); return null; }

beforeEach(() => {
    vi.resetAllMocks(); mocks.research = true; mocks.items = [{ contract: contract('2330') }];
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', { setInterval, clearInterval });
    mocks.scanner.mockResolvedValue([]);
    mocks.ensure.mockImplementation((code: string) => Promise.resolve(contract(code)));
    mocks.get.mockImplementation((path: string) => Promise.resolve(contract(path.match(/contracts\/(\d+)\//)![1]!)));
    mocks.post.mockResolvedValue([]);
    mocks.daily.mockResolvedValue([bar('2026-10-06')]);
    mocks.cached.mockResolvedValue([bar('2026-10-06'), bar('2026-10-07'), bar('2026-10-08')]);
    mocks.background.mockReturnValue({ minutes: [bar('2026-10-07', '09:01:00')], daily: [] });
    mocks.snapshots.mockResolvedValue([snapshot(), snapshot('IX0001')]);
    mocks.evaluate.mockImplementation((inputs, now, indexChangeRate) => ({ inputs, now, indexChangeRate }));
});
afterEach(async () => {
    if (renderer) await act(async () => renderer!.unmount());
    renderer = undefined;
    vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('balanced research-only 40-stock universe', () => {
    it('interleaves watch, gainers, losers, volume and amount instead of exhausting all slots with volume', async () => {
        const watch = Array.from({ length: 45 }, (_, i) => contract(String(2000 + i)));
        mocks.scanner.mockImplementation((kind: string, _count: number, ascending: boolean) => {
            // Shioaji's ascending=true wire flag means descending values.
            const base = kind === 'ChangePercentRank' ? (ascending ? 3000 : 4000) : kind === 'VolumeRank' ? 5000 : 6000;
            return Promise.resolve(Array.from({ length: 25 }, (_, i) => ({ code: String(base + i) })));
        });
        const { pool } = await buildDaytradePool(watch);
        expect(pool).toHaveLength(40);
        expect(pool.slice(0, 10).map(c => c.code)).toEqual(['2000', '3000', '4000', '5000', '6000', '2001', '3001', '4001', '5001', '6001']);
        expect(new Set(pool.map(c => c.code)).size).toBe(40);
        expect(pool.filter(c => c.code.startsWith('4'))).toHaveLength(8);
        expect(mocks.scanner.mock.calls).toEqual([
            ['ChangePercentRank', 20, true], ['ChangePercentRank', 20, false],
            ['VolumeRank', 25, true], ['AmountRank', 25, true],
        ]);
    });
    it('deduplicates and keeps only ordinary Taiwan stock identities, not ETF/futures/warrants/aliases', async () => {
        mocks.scanner.mockResolvedValue([{ code: '2330' }, { code: '1101' }, { code: '0050' }, { code: '006208' }, { code: 'TXFR1' }]);
        mocks.ensure.mockResolvedValue(contract('1101', { security_type: 'FUT', exchange: 'TAIFEX' }));
        const watch = [contract('2330'), contract('0050'), contract('3008', { currency: 'USD' }),
            contract('2454', { target_code: 'other' }), contract('3711', { region: 'US' }), contract('6505', { exchange: 'OES' })];
        const { pool } = await buildDaytradePool(watch);
        expect(pool.map(c => c.code)).toEqual(['2330']);
        expect(mocks.ensure).toHaveBeenCalledExactlyOnceWith('1101', 'STK');
    });
    it('keeps remaining sources usable on scanner or contract failure and reports the degraded pool', async () => {
        mocks.scanner.mockImplementation((kind: string, _count: number, ascending: boolean) => {
            if (kind === 'VolumeRank') return Promise.reject(new Error('fixture unavailable'));
            return Promise.resolve(kind === 'ChangePercentRank' && !ascending ? [{ code: '1101' }] : []);
        });
        mocks.ensure.mockImplementation((code: string) => code === '1101' ? Promise.reject(new Error('not listed')) : Promise.resolve(contract(code)));
        const scan = await buildDaytradePool([contract('2330')]);
        expect(scan.pool.map(c => c.code)).toEqual(['2330']);
        expect(scan.warnings).toEqual(expect.arrayContaining(['VolumeRank排行榜未取得', '1101契約未取得']));
    });
});

describe('daytrade data adapter identity, causality and bounded requests', () => {
    it('reuses one normal daily history call per stock and captures minutes before awaiting the cache/LRU', async () => {
        const minute = bar('2026-10-07', '09:01:00');
        mocks.background.mockReturnValue({ minutes: [minute], daily: [] });
        mocks.cached.mockImplementation(async () => {
            mocks.background.mockReturnValue({ minutes: [], daily: [] });
            return [bar('2026-10-06'), bar('2026-10-07'), bar('2026-10-08')];
        });
        const scan = await scanDaytrade([contract('2330')]);
        expect(mocks.daily).toHaveBeenCalledExactlyOnceWith(contract('2330'));
        expect(mocks.cached).toHaveBeenCalledExactlyOnceWith(contract('2330'), { stockRegularCloseOnly: true, nowMs: NOW });
        expect(scan.inputs[0]!.minutes).toEqual([minute]);
        expect(scan.inputs[0]!.daily).toEqual([bar('2026-10-06')]);
        expect(mocks.get).not.toHaveBeenCalled();
        expect(mocks.snapshots).toHaveBeenCalledTimes(1);
    });
    it('fetches fresh quotes only after all selected history/cache tasks finish', async () => {
        const pending = deferred<Candle[]>();
        mocks.cached.mockReturnValue(pending.promise);
        const scanPromise = scanDaytrade([contract('2330')]);
        await vi.waitFor(() => expect(mocks.cached).toHaveBeenCalledTimes(1));
        expect(mocks.snapshots).not.toHaveBeenCalled();
        vi.setSystemTime(NOW + 90_000);
        pending.resolve([bar('2026-10-06')]);
        const scan = await scanPromise;
        expect(mocks.snapshots).toHaveBeenCalledTimes(1);
        expect(scan.inputs[0]!.snapshot?.datetime).toBe('2026-10-07T09:30:00');
        // Keep the broker timestamp, do not rewrite it to fetch completion time.
        expect(mocks.snapshots.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.cached.mock.invocationCallOrder[0]!);
    });
    it('refreshes stale metadata locally without replacing the shared formal contract cache', async () => {
        const stale = contract('2330', { update_date: '2026-10-06', day_trade: 'No' });
        const fresh = contract('2330', { day_trade: 'OnlyBuy' });
        mocks.get.mockResolvedValue(fresh);
        const scan = await scanDaytrade([stale]);
        expect(scan.inputs[0]!.contract).toEqual(fresh);
        expect(mocks.get).toHaveBeenCalledTimes(1);
        expect(mocks.get.mock.calls[0]![0]).toBe('/api/v1/data/contracts/2330/info?security_type=STK&region=TW');
        expect(mocks.prime).not.toHaveBeenCalled();
        expect(stale.day_trade).toBe('No');
        expect(mocks.post).not.toHaveBeenCalled(); // OnlyBuy is never queried as a short candidate.
    });
    it('keeps stale permissions unknown on refresh failure or changed contract identity', async () => {
        const stale = contract('2330', { update_date: '2026-10-06' });
        mocks.get.mockResolvedValue(contract('2330', { exchange: 'OTC' }));
        const wrongExchange = await scanDaytrade([stale]);
        expect(wrongExchange.inputs[0]!.contract).toEqual(stale);
        mocks.get.mockRejectedValue(new Error('fixture offline'));
        const failed = await scanDaytrade([stale]);
        expect(failed.inputs[0]!.contract.update_date).toBe('2026-10-06');
        expect(mocks.prime).not.toHaveBeenCalled();
    });
    it('does not join a quote for the same code on the wrong exchange', async () => {
        mocks.snapshots.mockResolvedValue([snapshot('2330', 'OTC'), snapshot('IX0001')]);
        const scan = await scanDaytrade([contract('2330')]);
        expect(scan.inputs[0]!.snapshot).toBeUndefined();
        expect(scan.indexChangeRate).toBe(2);
    });
    it.each([
        { security_type: 'STK' }, { region: 'US' }, { exchange: 'OTC' },
    ] as Partial<ContractInfo>[])('does not trust an index cache hit with wrong identity %j', async identity => {
        mocks.ensure.mockImplementation((code: string) => Promise.resolve(contract(code, code === 'IX0001' ? identity : {})));
        mocks.snapshots.mockResolvedValue([snapshot(), snapshot('IX0001', identity.exchange ?? 'TSE')]);
        const scan = await scanDaytrade([contract('2330')]);
        expect(scan.indexChangeRate).toBeUndefined();
        expect(scan.warnings).toContain('大盤相對強弱未取得');
    });
    it('batch-reads current broker inventory for Yes stocks only, not a credit-balance permission', async () => {
        const watch = [contract('2330'), contract('1101', { day_trade: 'OnlyBuy' }), contract('1102', { day_trade: 'No' })];
        mocks.post.mockResolvedValue([{ code: '2330', short_stock_source: 7, datetime: '2026-10-07T09:30:00' }]);
        const scan = await scanDaytrade(watch);
        expect(mocks.post).toHaveBeenCalledExactlyOnceWith('/api/v1/data/short_stock_sources', {
            contracts: [{ security_type: 'STK', region: 'TW', exchange: 'TSE', code: '2330', target_code: null }],
        }, { timeoutMs: 10_000 });
        expect(scan.inputs.find(i => i.contract.code === '2330')!.shortSource).toEqual({ quantity: 7, datetime: '2026-10-07T09:30:00' });
        expect(scan.inputs.find(i => i.contract.code === '1101')!.shortSource).toBeUndefined();
        expect(scan.inputs.find(i => i.contract.code === '1102')!.shortSource).toBeUndefined();
    });
    it('preserves the actual timezone-free borrow wire label and never rewrites it to appear fresh', async () => {
        vi.setSystemTime(Date.parse('2026-10-07T12:50:00+08:00'));
        mocks.post.mockResolvedValue([{ code: '2330', short_stock_source: 678, datetime: '2026-10-07T04:49:22' }]);
        const scan = await scanDaytrade([contract('2330')]);
        expect(scan.inputs[0]!.shortSource).toEqual({ quantity: 678, datetime: '2026-10-07T04:49:22' });
        // The pure core owns the Taipei age check; the adapter must not infer
        // an undocumented UTC convention or overwrite the source timestamp.
    });
    it('keeps failed history/quotes/inventory as explicit missing data without another history download', async () => {
        mocks.daily.mockRejectedValue(new Error('history unavailable'));
        mocks.snapshots.mockRejectedValue(new Error('quotes unavailable'));
        mocks.post.mockRejectedValue(new Error('inventory unavailable'));
        const scan = await scanDaytrade([contract('2330')]);
        expect(scan.inputs[0]!.daily).toEqual([]); expect(scan.inputs[0]!.minutes).toEqual([]);
        expect(scan.inputs[0]!.snapshot).toBeUndefined(); expect(scan.inputs[0]!.shortSource).toBeUndefined();
        expect(scan.warnings).toEqual(expect.arrayContaining(['即時快照未取得；不產生盤中確認名單', '券商券源未確認；空方僅供觀察']));
        expect(mocks.daily).toHaveBeenCalledTimes(1); expect(mocks.cached).not.toHaveBeenCalled();
    });
    it.each([
        ['stale', '2026-10-07T09:26:59', 2],
        ['future', '2026-10-07T09:31:00', 2],
        ['wrong date', '2026-10-06T09:30:00', 2],
        ['nonfinite change', '2026-10-07T09:30:00', NaN],
    ])('does not score %s index data as current relative strength', async (_label, datetime, change_rate) => {
        mocks.snapshots.mockResolvedValue([snapshot(), { ...snapshot('IX0001'), datetime, change_rate }]);
        const scan = await scanDaytrade([contract('2330')]);
        expect(scan.indexChangeRate).toBeUndefined();
        expect(scan.warnings).toContain('大盤相對強弱未取得');
    });
    it('stops before daily/history requests when cancelled while metadata is pending', async () => {
        const metadata = deferred<ContractInfo>();
        mocks.get.mockReturnValue(metadata.promise);
        let cancelled = false;
        const promise = scanDaytrade([contract('2330', { update_date: '2026-10-06' })], () => cancelled);
        await vi.waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1));
        cancelled = true; metadata.resolve(contract('2330'));
        const scan = await promise;
        expect(mocks.daily).not.toHaveBeenCalled(); expect(mocks.snapshots).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
        expect(scan.inputs).toEqual([]);
    });
    it('stops before cache and quotes when cancelled while normal daily history is pending', async () => {
        const daily = deferred<Candle[]>(); mocks.daily.mockReturnValue(daily.promise);
        let cancelled = false;
        const promise = scanDaytrade([contract('2330')], () => cancelled);
        await vi.waitFor(() => expect(mocks.daily).toHaveBeenCalledTimes(1));
        cancelled = true; daily.resolve([bar('2026-10-06')]);
        await promise;
        expect(mocks.cached).not.toHaveBeenCalled(); expect(mocks.snapshots).not.toHaveBeenCalled();
    });
    it('stops before quotes/inventory when cancelled while index lookup is pending', async () => {
        const index = deferred<ContractInfo>();
        mocks.ensure.mockImplementation((code: string) => code === 'IX0001' ? index.promise : Promise.resolve(contract(code)));
        let cancelled = false;
        const promise = scanDaytrade([contract('2330')], () => cancelled);
        await vi.waitFor(() => expect(mocks.ensure).toHaveBeenCalledWith('IX0001', 'IND'));
        cancelled = true; index.resolve(contract('IX0001'));
        await promise;
        expect(mocks.snapshots).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
    });
    it('stops before inventory when cancelled while snapshots are pending', async () => {
        const quotes = deferred<Snapshot[]>(); mocks.snapshots.mockReturnValue(quotes.promise);
        let cancelled = false;
        const promise = scanDaytrade([contract('2330')], () => cancelled);
        await vi.waitFor(() => expect(mocks.snapshots).toHaveBeenCalledTimes(1));
        cancelled = true; quotes.resolve([snapshot()]);
        await promise;
        expect(mocks.post).not.toHaveBeenCalled();
    });
});

describe('opt-in hook and quote-clock re-evaluation', () => {
    it('does not request data or install polling by default', async () => {
        await act(async () => { renderer = create(<Probe />); });
        expect(mocks.scanner).not.toHaveBeenCalled(); expect(mocks.daily).not.toHaveBeenCalled();
        expect(mocks.snapshots).not.toHaveBeenCalled(); expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('does not request the research scan even when enabled in formal mode', async () => {
        mocks.research = false;
        await act(async () => { renderer = create(<Probe enabled />); });
        expect(mocks.scanner).not.toHaveBeenCalled(); expect(mocks.daily).not.toHaveBeenCalled();
        expect(mocks.snapshots).not.toHaveBeenCalled(); expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('uses four scanners only when opted in and re-evaluates the quote clock without re-fetching history', async () => {
        await act(async () => { renderer = create(<Probe enabled />); });
        expect(mocks.scanner).toHaveBeenCalledTimes(4); expect(mocks.daily).toHaveBeenCalledTimes(1);
        expect(result.lastUpdated).toBe(NOW); expect(result.poolSize).toBe(1); expect(result.loading).toBe(false);
        await act(async () => { vi.advanceTimersByTime(15_000); });
        expect(mocks.evaluate.mock.lastCall![1]).toBe(NOW + 15_000);
        expect(mocks.daily).toHaveBeenCalledTimes(1); expect(mocks.snapshots).toHaveBeenCalledTimes(1);
        await act(async () => { renderer!.update(<Probe enabled={false} />); });
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => { vi.advanceTimersByTime(240_000); });
        expect(mocks.daily).toHaveBeenCalledTimes(1);
    });
    it('expires the index from its broker timestamp rather than scan completion time', async () => {
        mocks.snapshots.mockResolvedValue([snapshot(), { ...snapshot('IX0001'), datetime: '2026-10-07T09:27:01' }]);
        await act(async () => { renderer = create(<Probe enabled />); });
        expect(mocks.evaluate.mock.lastCall![2]).toBe(2);
        await act(async () => { vi.advanceTimersByTime(15_000); });
        expect(mocks.evaluate.mock.lastCall![2]).toBeUndefined();
        expect(mocks.snapshots).toHaveBeenCalledTimes(1);
    });
    it('does not restart a still-running history scan at the automatic polling deadline', async () => {
        const daily = deferred<Candle[]>(); mocks.daily.mockReturnValue(daily.promise);
        await act(async () => { renderer = create(<Probe enabled />); });
        expect(mocks.daily).toHaveBeenCalledTimes(1); expect(result.loading).toBe(true);
        await act(async () => { vi.advanceTimersByTime(120_000); });
        expect(mocks.scanner).toHaveBeenCalledTimes(4);
        expect(mocks.daily).toHaveBeenCalledTimes(1);
        await act(async () => { daily.resolve([bar('2026-10-06')]); });
        expect(result.loading).toBe(false); expect(mocks.snapshots).toHaveBeenCalledTimes(1);
    });
    it('refreshes its evaluation clock immediately on reopen even while new history is pending', async () => {
        await act(async () => { renderer = create(<Probe enabled />); });
        await act(async () => { renderer!.update(<Probe enabled={false} />); });
        vi.setSystemTime(NOW + 300_000);
        const daily = deferred<Candle[]>(); mocks.daily.mockReturnValue(daily.promise);
        await act(async () => { renderer!.update(<Probe enabled />); });
        expect(result.loading).toBe(true);
        expect(mocks.evaluate.mock.lastCall![1]).toBe(NOW + 300_000);
        expect(mocks.evaluate.mock.lastCall![2]).toBeUndefined();
        await act(async () => { daily.resolve([bar('2026-10-06')]); });
    });
});
