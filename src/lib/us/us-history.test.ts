import { afterEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ post: vi.fn(), info: vi.fn(), base: vi.fn(() => 'http://127.0.0.1:21391') }));
vi.mock('../api', () => ({ apiPost: m.post }));
vi.mock('../server-info-store', () => ({ knownServerInfo: m.info }));
vi.mock('../runtime', () => ({ getApiBase: m.base }));

import {
    fetchUsKbars,
    fetchUsSnapshots,
    fetchUsSnapshotShared,
    fetchUsTicks,
    isUsHistoryUnavailable,
    latestUsSessionBars,
    mergeUsTickIntoBars,
    nyWallClockSec,
    parseUsKbars,
    parseUsSnapshots,
    parseUsTicks,
    replayUsTrades,
    resetUsHistoryForTest,
    sdkHasUsHistory,
    splitDateRange,
    usBarBucket,
    usHistoryAvailable,
    usSnapshotQuote,
    usTimeToMs,
} from './us-history';
import type { Candle } from '../types/market';

const AAPL = { code: 'AAPL', exchange: 'NASDAQ' } as const;
const wall = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13), +s.slice(14, 16), +(s.slice(17, 19) || 0)) / 1000;

afterEach(() => { resetUsHistoryForTest(); vi.clearAllMocks(); m.info.mockReset(); });

describe('US time conversion', () => {
    it('reads ns/µs/ms numbers and zone-less strings as UTC', () => {
        const ms = Date.UTC(2026, 10, 18, 14, 31);
        expect(usTimeToMs(ms * 1e6)).toBe(ms);
        expect(usTimeToMs(ms * 1e3)).toBe(ms);
        expect(usTimeToMs(ms)).toBe(ms);
        expect(usTimeToMs('2026-11-18T14:31:00')).toBe(ms);
        expect(usTimeToMs('2026-11-18T14:31:00.026450')).toBe(ms + 26);
        expect(usTimeToMs('2026-11-18T09:31:00-05:00')).toBe(ms);
        expect(usTimeToMs('2026-11-18T14:31:00Z')).toBe(ms);
        expect(usTimeToMs('bad')).toBeNull();
    });
    it('maps UTC to the New York wall clock across DST', () => {
        // 11 月 EST（UTC−5）、7 月 EDT（UTC−4）
        expect(nyWallClockSec(Date.UTC(2026, 10, 18, 14, 31))).toBe(wall('2026-11-18T09:31:00'));
        expect(nyWallClockSec(Date.UTC(2026, 6, 15, 13, 31))).toBe(wall('2026-07-15T09:31:00'));
    });
});

describe('parseUsKbars', () => {
    it('turns UTC bar-end strings into NY wall-clock candles (bar end, sorted)', () => {
        const c = parseUsKbars({
            datetime: ['2026-11-18T21:00:00', '2026-11-18T14:31:00'],
            Open: [352.88, 351.87], High: [352.9, 353.9], Low: [352.1, 351.87], Close: [352.45, 353.84], Volume: [6112884, 883957], Amount: [0, 0],
        })!;
        expect(c.map(b => b.time)).toEqual([wall('2026-11-18T09:31:00'), wall('2026-11-18T16:00:00')]);
        expect(c[0]).toMatchObject({ open: 351.87, close: 353.84, volume: 883957 });
    });
    it('accepts a ts (ns) column', () => {
        const c = parseUsKbars({ ts: [Date.UTC(2026, 10, 18, 14, 31) * 1e6], Open: [1], High: [2], Low: [0.5], Close: [1.5], Volume: [10] })!;
        expect(c[0]!.time).toBe(wall('2026-11-18T09:31:00'));
    });
    it('returns empty for an empty reply and null for a wrong shape', () => {
        expect(parseUsKbars({ datetime: [], Open: [], High: [], Low: [], Close: [], Volume: [] })).toEqual([]);
        expect(parseUsKbars({ code: 500 })).toBeNull();
        expect(parseUsKbars([])).toBeNull();
    });
});

describe('parseUsTicks', () => {
    it('reads UsTicks with null bid/ask, session and odd lot', () => {
        const t0 = Date.UTC(2026, 10, 18, 20, 59, 59);
        const rows = parseUsTicks({
            ts: [(t0 + 500) * 1e6 + 123, t0 * 1e6],
            close: [352.45, 352.4], volume: [6112884, 3],
            bid_price: [null, 352.39], bid_volume: [null, 100], ask_price: [null, 352.41], ask_volume: [null, 200],
            tick_type: [0, 1], session: ['AfterHours', 'Regular'], updates_last: [true, true], odd_lot: [false, true],
        })!;
        expect(rows.map(r => r.price)).toEqual([352.4, 352.45]);
        expect(rows[0]).toMatchObject({ bid: 352.39, ask: 352.41, tickType: 1, session: 'Regular', oddLot: true, time: '15:59:59.000000', tsUs: t0 * 1000 });
        expect(rows[1]!.tsUs).toBe((t0 + 500) * 1000);
        expect(rows[1]).toMatchObject({ bid: null, ask: null, session: 'AfterHours', oddLot: false, time: '15:59:59.500000' });
    });
    it('reads the Taiwan-shaped reply (datetime strings in UTC) and numeric sessions', () => {
        const rows = parseUsTicks({
            datetime: ['2026-11-18T14:30:00.026450'], close: [352.05], volume: [8], bid_price: [351.84], bid_volume: [20], ask_price: [352.17], ask_volume: [1], tick_type: [0], session: [2],
        })!;
        expect(rows[0]).toMatchObject({ time: '09:30:00.026450', price: 352.05, session: 'Regular', tsUs: Date.UTC(2026, 10, 18, 14, 30) * 1000 + 26450 });
        expect(parseUsTicks({ datetime: ['2026-11-18T14:30:00'], close: [1], volume: [1] })![0]!.session).toBeNull();
    });
    it('rejects a wrong shape', () => {
        expect(parseUsTicks(null)).toBeNull();
        expect(parseUsTicks({ ts: [1] })).toBeNull();
    });
});

describe('parseUsSnapshots', () => {
    const us = { region: 'US', ts: Date.UTC(2026, 10, 18, 21) * 1e6, trade_date: '2026-11-18', code: 'AAPL', exchange: 'NASDAQ', open: 351, high: 355, low: 350, close: 352.45, reference: 350, change_price: 2.45, change_rate: 0.7, total_volume: 5e7, buy_price: null, sell_price: 352.5, session: 'Regular' };
    it('keeps input order and maps US rows', () => {
        const rows = parseUsSnapshots([us, { ...us, code: 'MSFT' }], 2)!;
        expect(rows.map(r => r?.code)).toEqual(['AAPL', 'MSFT']);
        expect(rows[0]).toMatchObject({ tradeDate: '2026-11-18', close: 352.45, reference: 350, buyPrice: null, sellPrice: 352.5, session: 'Regular' });
    });
    it('reads a real pre-market row from the 1.8.0b1 sidecar (regular open/high/low still 0)', () => {
        // POST /api/v1/data/snapshots，2026-11-19 美東盤前（ed7f77df build）
        const row = { region: 'US', ts: 1795092423642980000, trade_date: '2026-11-19', code: 'AAPL', exchange: 'NASDAQ', open: 0.0, high: 0.0, low: 0.0, close: 352.45, reference: 352.45, tick_type: 'None', change_price: 0.0, change_rate: 0.0, change_type: 'Unchanged', average_price: 354.35, volume: 20, total_volume: 252160, amount: 7081.2, total_amount: 46853795.0, yesterday_volume: 34209928, volume_ratio: 0.0074, buy_price: 354.06, sell_price: 354.26, buy_volume: 120, sell_volume: 100, session: 'PreMarket', tradable_status: 1, last_price: 354.06, ext_close: 353.98, ext_high: 356.0, ext_low: 353.58 };
        const tw = { region: 'TW', code: '2330', close: 2100 };
        const rows = parseUsSnapshots([tw, row], 2)!;
        expect(rows[0]).toBeNull();
        expect(rows[1]).toMatchObject({ open: 0, close: 352.45, session: 'PreMarket', lastPrice: 354.06, tradeDate: '2026-11-19', buyPrice: 354.06, buyVolume: 120, sellPrice: 354.26, sellVolume: 100 });
        expect(usSnapshotQuote(rows[1]!)).toEqual({ last: '352.45', close: 352.45, chg: 0, pct: 0 });
        expect(usSnapshotQuote({ ...rows[1]!, close: 0 })).toBeNull();
    });
    it('treats an all-Taiwan-shaped reply (old SDK) and a count mismatch as unsupported', () => {
        expect(parseUsSnapshots([{ code: 'AAPL', close: 1 }], 1)).toBeNull();
        expect(parseUsSnapshots([us], 2)).toBeNull();
    });
});

describe('availability and fetch', () => {
    it('gates on the SDK version', () => {
        expect(sdkHasUsHistory('1.8.0-beta.1')).toBe(true);
        expect(sdkHasUsHistory('1.8.0b1')).toBe(true);
        expect(sdkHasUsHistory('1.7.11')).toBe(false);
        expect(sdkHasUsHistory(undefined)).toBeNull();
        m.info.mockReturnValue({ version: '1.7.11' });
        expect(usHistoryAvailable()).toBe(false);
        m.info.mockReturnValue(undefined);
        expect(usHistoryAvailable()).toBe(true);
    });
    it('sends a region US contract and parses kbars', async () => {
        m.post.mockResolvedValueOnce({ datetime: ['2026-11-18T14:31:00'], Open: [1], High: [1], Low: [1], Close: [1], Volume: [1] });
        const bars = await fetchUsKbars({ code: 'brk.b', exchange: 'NYSE' }, '2026-11-18', '2026-11-18');
        expect(bars).toHaveLength(1);
        expect(m.post).toHaveBeenCalledWith('/api/v1/data/kbars', {
            contract: { security_type: 'STK', region: 'US', exchange: 'NYSE', code: 'BRK.B' }, start: '2026-11-18', end: '2026-11-18',
        }, expect.anything());
    });
    it('shares one snapshot request per contract and retries after a failure', async () => {
        const row = { region: 'US', code: 'AAPL', exchange: 'NASDAQ', close: 352.45, buy_price: 354.06, buy_volume: 120 };
        m.post.mockResolvedValueOnce([row]);
        const [a, b] = await Promise.all([fetchUsSnapshotShared(AAPL, 1000), fetchUsSnapshotShared(AAPL, 1001)]);
        expect(a).toBe(b);
        expect(a).toMatchObject({ buyPrice: 354.06, buyVolume: 120 });
        expect(m.post).toHaveBeenCalledTimes(1);
        m.post.mockResolvedValueOnce([row]);
        await fetchUsSnapshotShared(AAPL, 1000 + 15_000);
        expect(m.post).toHaveBeenCalledTimes(2);
        m.post.mockRejectedValueOnce(new Error('500'));
        await expect(fetchUsSnapshotShared(AAPL, 100_000)).rejects.toThrow('500');
        m.post.mockResolvedValueOnce([row]);
        await expect(fetchUsSnapshotShared(AAPL, 100_001)).resolves.toMatchObject({ code: 'AAPL' });
    });
    it('sends LastCount for ticks', async () => {
        m.post.mockResolvedValueOnce({ datetime: [], close: [], volume: [] });
        await fetchUsTicks(AAPL, '2026-11-18', { lastCnt: 120 });
        expect(m.post.mock.calls[0]![1]).toMatchObject({ date: '2026-11-18', query_type: 'LastCount', last_cnt: 120 });
    });
    it('splits kbars ranges into 30-day requests and merges them', async () => {
        expect(splitDateRange('2026-11-01', '2026-11-19')).toEqual([['2026-11-01', '2026-11-19']]);
        expect(splitDateRange('2026-07-23', '2026-11-19')).toEqual([
            ['2026-07-23', '2026-08-21'], ['2026-08-22', '2026-09-20'], ['2026-09-21', '2026-10-20'], ['2026-10-21', '2026-11-19'],
        ]);
        const k = (dt: string) => ({ datetime: [dt], Open: [1], High: [1], Low: [1], Close: [1], Volume: [1] });
        m.post.mockResolvedValueOnce(k('2026-09-01T14:31:00')).mockResolvedValueOnce(k('2026-10-01T14:31:00'));
        const bars = await fetchUsKbars(AAPL, '2026-09-01', '2026-10-15');
        expect(m.post).toHaveBeenCalledTimes(2);
        expect(bars).toHaveLength(2);
    });
    it('keeps history available after a 400 parameter error', async () => {
        m.post.mockRejectedValueOnce(Object.assign(new Error('400 Kbars date range must not exceed 30 days.'), { status: 400 }));
        await expect(fetchUsKbars(AAPL, '2026-11-01', '2026-11-02')).rejects.toThrow('400');
        expect(usHistoryAvailable()).toBe(true);
    });
    it('latches unavailable after a 404 or a wrong shape, without retrying', async () => {
        m.post.mockRejectedValueOnce(Object.assign(new Error('404 Not Found'), { status: 404 }));
        await expect(fetchUsKbars(AAPL, '2026-11-18', '2026-11-18')).rejects.toSatisfy(isUsHistoryUnavailable);
        await expect(fetchUsTicks(AAPL, 'a')).rejects.toSatisfy(isUsHistoryUnavailable);
        expect(m.post).toHaveBeenCalledTimes(1);
        resetUsHistoryForTest();
        m.post.mockResolvedValueOnce([{ code: 'AAPL', close: 1 }]);
        await expect(fetchUsSnapshots([AAPL])).rejects.toSatisfy(isUsHistoryUnavailable);
        expect(usHistoryAvailable()).toBe(false);
    });
    it('marks the sidecar that answered, not the one current when a late 404 arrives', async () => {
        let release!: (e: unknown) => void;
        m.post.mockReturnValueOnce(new Promise((_, rej) => { release = rej; }));
        m.base.mockReturnValue('http://old');
        const p = fetchUsKbars(AAPL, '2026-11-18', '2026-11-18');
        m.base.mockReturnValue('http://new');
        release(Object.assign(new Error('404 Not Found'), { status: 404 }));
        await expect(p).rejects.toSatisfy(isUsHistoryUnavailable);
        expect(usHistoryAvailable()).toBe(true);
        m.base.mockReturnValue('http://old');
        expect(usHistoryAvailable()).toBe(false);
        m.base.mockReturnValue('http://127.0.0.1:21391');
    });
    it('marks the sidecar the request was actually dispatched to (boot gate rebase)', async () => {
        m.base.mockReturnValue('http://127.0.0.1:1111');
        m.post.mockImplementationOnce(async (_p: string, _b: unknown, opts: { beforeDispatch?: (url?: string) => void }) => {
            m.base.mockReturnValue('http://127.0.0.1:2222'); // 啟動閘門改派到 B
            opts.beforeDispatch?.('http://127.0.0.1:2222/api/v1/data/snapshots');
            throw Object.assign(new Error('404 Not Found'), { status: 404 });
        });
        await expect(fetchUsSnapshots([AAPL])).rejects.toSatisfy(isUsHistoryUnavailable);
        expect(usHistoryAvailable()).toBe(false); // B
        m.base.mockReturnValue('http://127.0.0.1:1111');
        expect(usHistoryAvailable()).toBe(true);
        m.base.mockReturnValue('http://127.0.0.1:21391');
    });
    it('uses the dispatched URL even when the current base moved again before dispatch (native transport wait)', async () => {
        m.base.mockReturnValue('http://127.0.0.1:1111');
        m.post.mockImplementationOnce(async (_p: string, _b: unknown, opts: { beforeDispatch?: (url?: string) => void }) => {
            m.base.mockReturnValue('http://127.0.0.1:2222'); // URL 已對 A 建好，等待期間目前 base 變成 B
            opts.beforeDispatch?.('http://127.0.0.1:1111/api/v1/data/snapshots');
            throw Object.assign(new Error('404 Not Found'), { status: 404 });
        });
        await expect(fetchUsSnapshots([AAPL])).rejects.toSatisfy(isUsHistoryUnavailable);
        expect(usHistoryAvailable()).toBe(true); // B 不受影響
        m.base.mockReturnValue('http://127.0.0.1:1111');
        expect(usHistoryAvailable()).toBe(false); // A 才是回應者
        m.base.mockReturnValue('http://127.0.0.1:21391');
    });
    it('normalizes the sidecar base the same way when marking and looking up', async () => {
        m.base.mockReturnValue('https://sidecar.test:443');
        m.post.mockImplementationOnce(async (_p: string, _b: unknown, opts: { beforeDispatch?: (url?: string) => void }) => {
            opts.beforeDispatch?.('https://sidecar.test/api/v1/data/snapshots');
            throw Object.assign(new Error('404 Not Found'), { status: 404 });
        });
        await expect(fetchUsSnapshots([AAPL])).rejects.toSatisfy(isUsHistoryUnavailable);
        expect(usHistoryAvailable()).toBe(false);
        m.base.mockReturnValue('https://sidecar.test');
        expect(usHistoryAvailable()).toBe(false);
        m.base.mockReturnValue('http://127.0.0.1:21391');
    });
    it('does not latch on 5xx', async () => {
        m.post.mockRejectedValueOnce(Object.assign(new Error('500 decode error'), { status: 500 }));
        await expect(fetchUsSnapshots([AAPL])).rejects.toThrow('500');
        expect(usHistoryAvailable()).toBe(true);
    });
    it('does not call the server on an old SDK', async () => {
        m.info.mockReturnValue({ version: '1.7.11' });
        await expect(fetchUsKbars(AAPL, 'a', 'b')).rejects.toSatisfy(isUsHistoryUnavailable);
        expect(m.post).not.toHaveBeenCalled();
    });
    it('finds the latest trade date with bars, skipping weekends and empty days', async () => {
        // 2026-11-23 週一 08:00 紐約 → 今天沒資料、跳過週末、落到 11-20（週五）
        const now = Date.UTC(2026, 10, 23, 13, 0);
        const empty = { datetime: [], Open: [], High: [], Low: [], Close: [], Volume: [] };
        m.post.mockResolvedValueOnce(empty).mockResolvedValueOnce({ datetime: ['2026-11-20T14:31:00'], Open: [1], High: [1], Low: [1], Close: [2], Volume: [3] });
        const r = await latestUsSessionBars(AAPL, { nowMs: now });
        expect(r?.date).toBe('2026-11-20');
        expect(m.post.mock.calls.map(c => (c[1] as { start: string }).start)).toEqual(['2026-11-23', '2026-11-20']);
    });
});

describe('replayUsTrades', () => {
    it('skips trades before the last 1-minute bar end and adds the rest', () => {
        const bars: Candle[] = [{ time: wall('2026-11-18T09:31:00'), open: 10, high: 11, low: 9, close: 10, volume: 5 }];
        const changed = replayUsTrades(bars, [
            { wall: wall('2026-11-18T09:30:40'), price: 50, volume: 9 }, // 歷史已含，不重複
            { wall: wall('2026-11-18T09:31:05'), price: 12, volume: 2 },
            { wall: wall('2026-11-18T09:31:30'), price: 13, volume: 3 },
        ], 1, wall('2026-11-18T09:31:00'));
        expect(changed).toBe(true);
        expect(bars[0]).toMatchObject({ high: 11, volume: 5 });
        expect(bars[1]).toMatchObject({ time: wall('2026-11-18T09:32:00'), open: 12, high: 13, close: 13, volume: 5 });
    });
    it('builds bars from scratch when history is empty', () => {
        const bars: Candle[] = [];
        replayUsTrades(bars, [{ wall: wall('2026-11-18T09:30:10'), price: 1, volume: 1 }], 5, -Infinity);
        expect(bars).toHaveLength(1);
    });
    it('merges a trade into the aggregated tail bar when history ends mid-bucket (5m, 1D)', () => {
        // 5 分 K：歷史 1 分 K 到 09:32（聚合標籤 09:35），09:32:10 的成交要併進 09:35 那根
        const five: Candle[] = [{ time: wall('2026-11-18T09:35:00'), open: 10, high: 11, low: 9, close: 10, volume: 5 }];
        replayUsTrades(five, [{ wall: wall('2026-11-18T09:32:10'), price: 12, volume: 2 }], 5, wall('2026-11-18T09:32:00'));
        expect(five).toHaveLength(1);
        expect(five[0]).toMatchObject({ high: 12, close: 12, volume: 7 });
        const day: Candle[] = [{ time: wall('2026-11-18T00:00:00'), open: 10, high: 11, low: 9, close: 10, volume: 5 }];
        replayUsTrades(day, [{ wall: wall('2026-11-18T10:00:30'), price: 8, volume: 1 }], 1440, wall('2026-11-18T10:00:00'));
        expect(day[0]).toMatchObject({ low: 8, close: 8, volume: 6 });
    });
});

describe('live tick merge', () => {
    it('buckets close-label-right and daily by calendar day', () => {
        expect(usBarBucket(wall('2026-11-18T09:30:00'), 1)).toBe(wall('2026-11-18T09:31:00'));
        expect(usBarBucket(wall('2026-11-18T09:34:59'), 5)).toBe(wall('2026-11-18T09:35:00'));
        expect(usBarBucket(wall('2026-11-18T15:59:00'), 1440)).toBe(wall('2026-11-18T00:00:00'));
    });
    it('updates the tail, opens a new bar, and ignores older ticks', () => {
        const bars: Candle[] = [{ time: wall('2026-11-18T09:31:00'), open: 10, high: 11, low: 9, close: 10, volume: 5 }];
        mergeUsTickIntoBars(bars, wall('2026-11-18T09:30:30'), 12, 2, 1);
        expect(bars[0]).toMatchObject({ high: 12, close: 12, volume: 7 });
        mergeUsTickIntoBars(bars, wall('2026-11-18T09:31:10'), 8, 1, 1);
        expect(bars).toHaveLength(2);
        expect(bars[1]).toMatchObject({ time: wall('2026-11-18T09:32:00'), open: 8, volume: 1 });
        expect(mergeUsTickIntoBars(bars, wall('2026-11-18T09:29:00'), 1, 1, 1)).toBeNull();
    });
});
