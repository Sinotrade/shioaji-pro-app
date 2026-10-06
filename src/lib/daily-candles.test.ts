import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Candle, KBars } from './types/market';
import type { DailyCacheValue } from './daily-candles';
import { getApiBase } from './runtime';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), today: '2026-10-01' }));
vi.mock('./chart-history', () => ({ fetchChartHistory: mocks.fetch, nextChartHistoryRevision: () => 1 }));
vi.mock('./utils/kbars', async () => {
    const actual = await vi.importActual<typeof import('./utils/kbars')>('./utils/kbars');
    return { ...actual, dateStrOffset: (days: number) => {
        const time = Date.parse(`${mocks.today}T00:00:00Z`) - days * 86400_000;
        return new Date(time).toISOString().slice(0, 10);
    } };
});

const contract = { code: 'TXFR1', exchange: 'TAIFEX', security_type: 'FUT', target_code: 'TXFJ6' } as const;
const scopedKey = JSON.stringify(['FUT', 'TAIFEX', 'TXFR1', 'TXFJ6']);
const t = (date: string) => Date.parse(date.length === 10 ? `${date}T00:00:00Z` : `${date}Z`) / 1000;
const candle = (day: string, volume = 100): Candle => ({ time: t(day), open: 100, high: 110, low: 90, close: 105, volume });
function longSetup(): Candle[] {
    let price = 100;
    const pattern = [0.9, 0.5, -0.4, 0.6, -0.3];
    return Array.from({ length: 40 }, (_, i) => {
        const open = price;
        const close = price + (i === 39 ? 2 : pattern[i % 5]!);
        price = close;
        return { time: t('2026-10-01') - (39 - i) * 86400, open: Math.min(open, close),
            high: Math.max(open, close) + 0.3, low: Math.min(open, close) - 0.3,
            close, volume: i === 39 ? 300 : 100 };
    });
}
function oneRaw(bar: Candle, end: number): KBars {
    return { datetime: [new Date(end * 1000).toISOString().slice(0, 19)],
        Open: [bar.open], High: [bar.high], Low: [bar.low], Close: [bar.close], Volume: [bar.volume], Amount: [0] };
}
function history(rows: Array<[string, number, number]>): KBars {
    return { datetime: rows.map(row => row[0]), Open: rows.map(row => row[1]), High: rows.map(row => row[1]),
        Low: rows.map(row => row[1]), Close: rows.map(row => row[1]), Volume: rows.map(row => row[2]), Amount: rows.map(() => 0) };
}

// Minimal asynchronous IDB fixture. All quote/history calls are mocked and
// no real browser storage, brokerage API or network is touched by this test.
const stored = new Map<string, DailyCacheValue>();
beforeEach(() => {
    vi.resetModules();
    mocks.today = '2026-10-01';
    mocks.fetch.mockReset().mockResolvedValue(history([]));
    stored.clear();
    const request = <T>(result: T) => {
        const req = { result, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
        queueMicrotask(() => req.onsuccess?.());
        return req;
    };
    const db = { createObjectStore: () => {}, transaction: () => ({ objectStore: () => ({
        get: (key: string) => request(stored.get(key)),
        put: (value: DailyCacheValue, key: string) => { stored.set(key, value); return request(key); },
    }) }) };
    vi.stubGlobal('indexedDB', { open: () => request(db) });
});
afterEach(() => vi.unstubAllGlobals());

describe('daily incremental source range', () => {
    it('future closing-claimed cache rows cannot erase confirmed history around an unclosed tail', async () => {
        const stock = { code: '2330', exchange: 'TSE', security_type: 'STK', region: 'TW', target_code: null } as const;
        const key = JSON.stringify(['STK', 'TSE', '2330', null]);
        const rows = ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05'].map(day => candle(day));
        const original: DailyCacheValue = { candles: rows, updatedAt: 1,
            sourceApis: Object.fromEntries(rows.map(c => [c.time, getApiBase()])),
            sourceMinuteEnds: Object.fromEntries(rows.map((c, i) => [c.time, c.time + (i === 2 ? 9.5 : 13.5) * 3600])) };
        stored.set(key, original);
        const nowMs = Date.parse('2026-10-02T01:30:00Z'); // Taipei 09:30
        const { readCachedDailyCandles } = await import('./daily-candles');
        const { dailyBreakoutClosedSource } = await import('./research-daily-breakout-source');
        const checked = await readCachedDailyCandles(stock, { stockRegularCloseOnly: true, nowMs });
        expect(checked).toEqual(rows.slice(0, 2));
        expect(dailyBreakoutClosedSource(checked, stock, nowMs)).toEqual(rows.slice(0, 2));
        expect(await readCachedDailyCandles(stock, { stockRegularCloseOnly: true, nowMs: NaN })).toEqual([]);
        expect(await readCachedDailyCandles(stock)).toEqual([rows[0], rows[1], rows[3]]);
        expect(stored.get(key)).toBe(original);
        expect(mocks.fetch).not.toHaveBeenCalled();
    });
    it('new stock research resets after a known unproven history date but does not erase closed history for a partial tail', async () => {
        const stock = { code: '2330', exchange: 'TSE', security_type: 'STK', target_code: null } as const;
        const key = JSON.stringify(['STK', 'TSE', '2330', null]);
        const rows = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'].map(day => candle(day));
        stored.set(key, { candles: rows, updatedAt: 1,
            sourceApis: Object.fromEntries(rows.map(c => [c.time, getApiBase()])),
            sourceMinuteEnds: Object.fromEntries(rows.map((c, i) => [c.time, c.time + (i === 1 || i === 4 ? 9.5 : 13.5) * 3600])) });
        const { readCachedDailyCandles } = await import('./daily-candles');
        expect(await readCachedDailyCandles(stock, { stockRegularCloseOnly: true,
            nowMs: Date.parse('2026-10-06T06:00:00Z') })).toEqual(rows.slice(2, 4));
        expect(await readCachedDailyCandles(stock)).toEqual([rows[0], rows[2], rows[3]]);
        expect(mocks.fetch).not.toHaveBeenCalled();
    });
    it('stock swing cache requires exactly regular closing evidence, rejects unknown API and never downloads or writes', async () => {
        const stock = { code: '2330', exchange: 'TSE', security_type: 'STK', target_code: null } as const;
        const key = JSON.stringify(['STK', 'TSE', '2330', null]);
        const regular = candle('2026-09-28');
        const afterHours = candle('2026-09-29');
        const partial = candle('2026-09-30');
        const unknown = candle('2026-10-01');
        const wrongApi = candle('2026-10-02');
        const original: DailyCacheValue = { candles: [regular, afterHours, partial, unknown, wrongApi], updatedAt: 1,
            sourceApis: { [regular.time]: getApiBase(), [afterHours.time]: getApiBase(), [partial.time]: getApiBase(),
                [wrongApi.time]: 'http://different-fixture:21323' },
            sourceMinuteEnds: { [regular.time]: t('2026-09-28T13:30:00'), [afterHours.time]: t('2026-09-29T14:30:00'),
                [partial.time]: t('2026-09-30T09:30:00'), [unknown.time]: t('2026-10-01T13:30:00'),
                [wrongApi.time]: t('2026-10-02T13:30:00') } };
        stored.set(key, original);
        const { readCachedDailyCandles } = await import('./daily-candles');
        expect(await readCachedDailyCandles(stock, { stockRegularCloseOnly: true,
            nowMs: Date.parse('2026-10-06T06:00:00Z') })).toEqual([regular]);
        expect(await readCachedDailyCandles(stock)).toEqual([regular, afterHours]);
        expect(await readCachedDailyCandles(contract, { stockRegularCloseOnly: true })).toEqual([]);
        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(stored.get(key)).toBe(original);
    });
    it('reads proven existing daily cache without any history request or storage write', async () => {
        const closed = candle('2026-09-30');
        const partial = candle('2026-10-01');
        stored.set(scopedKey, { candles: [closed, partial], updatedAt: 1, sessionConvention: 2,
            sourceApis: { [String(closed.time)]: getApiBase(), [String(partial.time)]: getApiBase() },
            sourceMinuteEnds: { [String(closed.time)]: t('2026-09-30T13:45:00'),
                [String(partial.time)]: t('2026-10-01T09:00:00') } });
        const original = stored.get(scopedKey);
        const { readCachedDailyCandles } = await import('./daily-candles');
        expect(await readCachedDailyCandles(contract)).toEqual([closed]);
        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(stored.get(scopedKey)).toBe(original);
        expect(await readCachedDailyCandles({ ...contract, target_code: 'TXFK6' })).toEqual([]);
        expect(mocks.fetch).not.toHaveBeenCalled();
    });
    it('never requests a tomorrow start during tonight, and includes the prior night source date', async () => {
        const { dailyIncrementalPlan } = await import('./daily-candles');
        expect(dailyIncrementalPlan([candle('2026-10-02')], 'FUT', '2026-10-01'))
            .toEqual({ start: '2026-10-01', replaceFrom: t('2026-10-02') });
    });

    it('uses Friday source for Monday labels without an invalid future range on Friday night', async () => {
        const { dailyIncrementalPlan } = await import('./daily-candles');
        expect(dailyIncrementalPlan([candle('2026-09-28')], 'FUT', '2026-09-25'))
            .toEqual({ start: '2026-09-25', replaceFrom: t('2026-09-28') });
        expect(dailyIncrementalPlan([candle('2026-09-26')], 'FUT', '2026-09-28'))
            .toEqual({ start: '2026-09-25', replaceFrom: t('2026-09-28') });
    });

    it('leaves stock same-day incremental requests unchanged', async () => {
        const { dailyIncrementalPlan } = await import('./daily-candles');
        expect(dailyIncrementalPlan([candle('2026-10-01')], 'STK', '2026-10-01'))
            .toEqual({ start: '2026-10-01', replaceFrom: t('2026-10-01') });
    });
});

describe('legacy daily cache isolation', () => {
    it('preserves original weekend and paired Monday rows without blind volume addition', async () => {
        const { prepareDailyCache } = await import('./daily-candles');
        const original: DailyCacheValue = { updatedAt: 1, candles: [candle('2026-09-25', 500), candle('2026-09-26', 300), candle('2026-09-28', 800), candle('2026-09-29', 900)] };
        const result = prepareDailyCache(original, 'FUT');
        expect(result.candles.map(c => c.time)).toEqual([t('2026-09-25'), t('2026-09-29')]);
        expect(result.isolatedCandles).toEqual([
            { ...original.candles[1], isolationReason: 'legacy-weekend-label' },
            { ...original.candles[2], isolationReason: 'legacy-paired-monday' },
        ]);
        expect(original.candles).toHaveLength(4);
    });

    it('does not isolate an unpaired Monday or already migrated valid history', async () => {
        const { prepareDailyCache } = await import('./daily-candles');
        const value: DailyCacheValue = { updatedAt: 1, candles: [candle('2026-09-28')] };
        expect(prepareDailyCache(value, 'FUT').candles).toEqual(value.candles);
        const migrated: DailyCacheValue = { ...value, sessionConvention: 2 };
        expect(prepareDailyCache(migrated, 'FUT')).toEqual(migrated);
    });
});

describe('daily cache bounded integration', () => {
    it('refreshes the latest daily label while preserving an earlier complete candle from partial overlap', async () => {
        stored.set(scopedKey, { candles: [candle('2026-10-01', 1000), candle('2026-10-02', 4)], updatedAt: 1, sessionConvention: 2 });
        mocks.fetch.mockResolvedValue(history([
            ['2026-10-01T08:46:00', 90, 999],
            ['2026-10-01T15:01:00', 101, 10],
            ['2026-10-01T23:59:00', 103, 20],
        ]));
        const { getDailyCandles } = await import('./daily-candles');
        const result = await getDailyCandles(contract);
        expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(contract, '2026-10-01', '2026-10-01', undefined);
        expect(result[0]).toEqual(candle('2026-10-01', 1000));
        expect(result[1]).toMatchObject({ time: t('2026-10-02'), open: 101, close: 103, volume: 30 });
    });

    it('repairs only the legacy weekend tail and retains isolated original values in the same cache key', async () => {
        mocks.today = '2026-09-28';
        const fri = candle('2026-09-25', 1500);
        stored.set(scopedKey, { candles: [fri, candle('2026-09-26', 300), candle('2026-09-28', 800)], updatedAt: 1 });
        mocks.fetch.mockResolvedValue(history([
            ['2026-09-25T08:46:00', 90, 999],
            ['2026-09-25T15:01:00', 100, 10],
            ['2026-09-26T05:00:00', 101, 20],
            ['2026-09-28T08:46:00', 102, 30],
        ]));
        const { getDailyCandles } = await import('./daily-candles');
        const result = await getDailyCandles(contract);
        expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(contract, '2026-09-25', '2026-09-28', undefined);
        expect(result.map(c => c.time)).toEqual([t('2026-09-25'), t('2026-09-28')]);
        expect(result[0]).toEqual(fri);
        expect(result[1]).toMatchObject({ open: 100, close: 102, volume: 60 });
        const saved = stored.get(scopedKey)!;
        expect(saved.sessionConvention).toBe(2);
        expect(saved.isolatedCandles?.map(c => c.volume)).toEqual([300, 800]);
        expect(stored.size).toBe(1);
    });

    it('does not erase existing cache if a bounded fetch fails', async () => {
        const original: DailyCacheValue = { candles: [candle('2026-10-01')], updatedAt: 1 };
        stored.set(scopedKey, original);
        mocks.fetch.mockRejectedValue(new Error('offline fixture'));
        const { getDailyCandles } = await import('./daily-candles');
        await expect(getDailyCandles(contract)).rejects.toThrow('offline fixture');
        expect(stored.get(scopedKey)).toBe(original);
    });

    it('scopes daily cache and signal identity by security type and actual target month', async () => {
        const { dailyKey } = await import('./daily-candles');
        expect(dailyKey(contract)).not.toBe(dailyKey({ ...contract, target_code: 'TXFK6' }));
        expect(dailyKey(contract)).not.toBe(dailyKey({ ...contract, security_type: 'OPT' }));
    });

    it('preserves unknown-month legacy cache and warms up only four days in the new namespace', async () => {
        const legacy: DailyCacheValue = { updatedAt: 1, candles: [candle('2026-10-01', 99999)] };
        stored.set('TAIFEX:TXFR1', legacy);
        mocks.fetch.mockResolvedValue(history([
            ['2026-09-28T08:46:00', 100, 10],
            ['2026-09-28T15:01:00', 101, 20],
            ['2026-09-29T08:46:00', 102, 30],
            ['2026-09-29T15:01:00', 103, 40],
            ['2026-09-30T08:46:00', 104, 50],
            ['2026-09-30T15:01:00', 105, 60],
            ['2026-10-01T08:46:00', 106, 70],
        ]));
        const { getDailyCandles } = await import('./daily-candles');
        const result = await getDailyCandles(contract, { calendarDays: 180 });
        expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(contract, '2026-09-27', '2026-10-01', undefined);
        expect(stored.get('TAIFEX:TXFR1')).toBe(legacy);
        expect(result.map(c => c.time)).toEqual([t('2026-09-29'), t('2026-09-30'), t('2026-10-01')]);
        expect(result.at(-1)!.volume).toBe(130);
        expect(stored.get(scopedKey)).toMatchObject({ historyQuality: 'bounded-month-warmup', legacySourceKey: 'TAIFEX:TXFR1' });
    });

    it('copies non-continuous stock legacy cache without clearing history or expanding the range', async () => {
        const stock = { code: '2330', exchange: 'TSE', security_type: 'STK', target_code: null } as const;
        const legacy: DailyCacheValue = { updatedAt: 1, candles: [candle('2026-09-30', 500), candle('2026-10-01', 600)] };
        stored.set('TSE:2330', legacy);
        mocks.fetch.mockResolvedValue(history([['2026-10-01T09:01:00', 100, 10]]));
        const { getDailyCandles, dailyKey } = await import('./daily-candles');
        const result = await getDailyCandles(stock);
        expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(stock, '2026-10-01', '2026-10-01', undefined);
        expect(result[0]).toEqual(legacy.candles[0]);
        expect(stored.get('TSE:2330')).toBe(legacy);
        expect(stored.has(dailyKey(stock))).toBe(true);
    });

    it('also bounds a new continuous month when only another scoped month exists and no legacy key exists', async () => {
        const old = { candles: [candle('2026-10-01', 99999)], updatedAt: 1, sessionConvention: 2 } as const;
        stored.set(scopedKey, { ...old, candles: [...old.candles] });
        const nextMonth = { ...contract, target_code: 'TXFK6' };
        const { getDailyCandles, dailyKey } = await import('./daily-candles');
        await getDailyCandles(nextMonth, { calendarDays: 180 });
        expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(nextMonth, '2026-09-27', '2026-10-01', undefined);
        expect(stored.get(scopedKey)?.candles).toEqual(old.candles);
        expect(stored.get(dailyKey(nextMonth))?.historyQuality).toBe('bounded-month-warmup');
        await getDailyCandles(nextMonth, { calendarDays: 180 });
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
        expect(mocks.fetch).toHaveBeenNthCalledWith(2, nextMonth, '2026-09-27', '2026-10-01', undefined);
    });
});

describe('daily source-minute confirmation gate', () => {
    const stock = { code: '2330', exchange: 'TSE', security_type: 'STK', target_code: null } as const;
    const stockKey = JSON.stringify(['STK', 'TSE', '2330', null]);

    it('does not turn the same morning history Promise into a confirmed daily signal on a post-close load', async () => {
        const daily = longSetup();
        stored.set(stockKey, { candles: daily, updatedAt: 1, sessionConvention: 2,
            sourceApis: Object.fromEntries(daily.slice(0, -1).map(c => [String(c.time), getApiBase()])),
            sourceMinuteEnds: Object.fromEntries(daily.slice(0, -1).map(c => [String(c.time), c.time + 13.5 * 3600])) });
        const cachedPromise = Promise.resolve(oneRaw(daily.at(-1)!, t('2026-10-01T09:30:00')));
        mocks.fetch.mockReturnValue(cachedPromise);
        const { getDailyCandles } = await import('./daily-candles');
        const { confirmedDailySignals } = await import('../hooks/use-entry-signals');
        const morning = await getDailyCandles(stock, { completedOnly: true });
        expect(confirmedDailySignals(morning, 'STK', t('2026-10-01T09:30:00')).long.some(s => s.time === t('2026-10-01'))).toBe(false);
        const afterClose = await getDailyCandles(stock, { completedOnly: true });
        expect(confirmedDailySignals(afterClose, 'STK', t('2026-10-01T13:30:00')).long.some(s => s.time === t('2026-10-01'))).toBe(false);
        expect(mocks.fetch).toHaveBeenNthCalledWith(1, stock, '2026-10-01', '2026-10-01', undefined);
        expect(mocks.fetch).toHaveBeenNthCalledWith(2, stock, '2026-10-01', '2026-10-01', undefined);
        expect(mocks.fetch.mock.results[0]!.value).toBe(mocks.fetch.mock.results[1]!.value);
        expect(stored.get(stockKey)?.sourceMinuteEnds?.[String(t('2026-10-01'))]).toBe(t('2026-10-01T09:30:00'));
    });

    it('can collect a final stock daily signal only when the raw source really includes the 13:30 label', async () => {
        const daily = longSetup();
        stored.set(stockKey, { candles: daily, updatedAt: 1, sessionConvention: 2,
            sourceApis: Object.fromEntries(daily.slice(0, -1).map(c => [String(c.time), getApiBase()])),
            sourceMinuteEnds: Object.fromEntries(daily.slice(0, -1).map(c => [String(c.time), c.time + 13.5 * 3600])) });
        mocks.fetch.mockResolvedValue(oneRaw(daily.at(-1)!, t('2026-10-01T13:30:00')));
        const { getDailyCandles } = await import('./daily-candles');
        const { confirmedDailySignals } = await import('../hooks/use-entry-signals');
        const completed = await getDailyCandles(stock, { completedOnly: true });
        expect(completed).toHaveLength(40);
        expect(confirmedDailySignals(completed, 'STK', t('2026-10-01T13:30:00')).long.some(s => s.time === t('2026-10-01'))).toBe(true);
    });

    it('never uses old full-close proof to certify an incoming morning partial replacement', async () => {
        const full = candle('2026-10-01', 1000);
        stored.set(stockKey, { candles: [full], updatedAt: 1, sessionConvention: 2,
            sourceApis: { [String(full.time)]: getApiBase() },
            sourceMinuteEnds: { [String(full.time)]: t('2026-10-01T13:30:00') } });
        mocks.fetch.mockResolvedValue(oneRaw({ ...full, high: 999, volume: 5 }, t('2026-10-01T09:30:00')));
        const { getDailyCandles } = await import('./daily-candles');
        expect(await getDailyCandles(stock, { completedOnly: true })).toEqual([full]);
        expect(stored.get(stockKey)?.candles).toEqual([full]);
        expect(stored.get(stockKey)?.sourceMinuteEnds?.[String(full.time)]).toBe(t('2026-10-01T13:30:00'));
    });

    it('retains legacy daily values without source proof but never advertises them as confirmed', async () => {
        const legacy = [candle('2026-09-30'), candle('2026-10-01')];
        stored.set(stockKey, { candles: legacy, updatedAt: 1 });
        const { getDailyCandles } = await import('./daily-candles');
        expect(await getDailyCandles(stock, { completedOnly: true })).toEqual([]);
        expect(stored.get(stockKey)?.candles).toEqual(legacy);
        expect(await getDailyCandles(stock)).toEqual(legacy);
    });

    it('does not hydrate or certify daily prices from another or unknown API source', async () => {
        const full = candle('2026-09-30');
        for (const sourceApis of [undefined, { [String(full.time)]: 'http://another-source' }]) {
            const value = { candles: [full], updatedAt: 1, sessionConvention: 2 as const, sourceApis,
                sourceMinuteEnds: { [String(full.time)]: t('2026-09-30T13:30:00') } };
            stored.set(stockKey, value);
            const { readCachedDailyCandles, getDailyCandles } = await import('./daily-candles');
            expect(await readCachedDailyCandles(stock)).toEqual([]);
            expect(stored.get(stockKey)).toBe(value);
            expect(await getDailyCandles(stock, { completedOnly: true })).toEqual([]);
            expect(stored.get(stockKey)?.candles).toEqual([full]);
        }
    });

    it('requires the futures 13:45 source label, not the stock 13:30 label', async () => {
        const daily = candle('2026-10-01');
        stored.set(scopedKey, { candles: [daily], updatedAt: 1, sessionConvention: 2 });
        mocks.fetch.mockResolvedValueOnce(oneRaw(daily, t('2026-10-01T13:30:00')))
            .mockResolvedValueOnce(oneRaw(daily, t('2026-10-01T13:45:00')));
        const { getDailyCandles } = await import('./daily-candles');
        expect(await getDailyCandles(contract, { completedOnly: true })).toEqual([]);
        expect(await getDailyCandles(contract, { completedOnly: true })).toEqual([daily]);
    });
});
