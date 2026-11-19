import { afterEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ post: vi.fn(), info: vi.fn(), base: vi.fn(() => 'http://127.0.0.1:21391') }));
vi.mock('../api', () => ({ apiPost: m.post }));
vi.mock('../server-info-store', () => ({ knownServerInfo: m.info }));
vi.mock('../runtime', () => ({ getApiBase: m.base }));

import {
    fetchUsKbars,
    fetchUsSnapshots,
    fetchUsTicks,
    isUsHistoryUnavailable,
    latestUsSessionBars,
    mergeUsTickIntoBars,
    nyWallClockSec,
    parseUsKbars,
    parseUsSnapshots,
    parseUsTicks,
    resetUsHistoryForTest,
    sdkHasUsHistory,
    usBarBucket,
    usHistoryAvailable,
    usTimeToMs,
} from './us-history';
import type { Candle } from '../types/market';

const AAPL = { code: 'AAPL', exchange: 'NASDAQ' };
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
        expect(rows[0]).toMatchObject({ bid: 352.39, ask: 352.41, tickType: 1, session: 'Regular', oddLot: true, time: '15:59:59.000000' });
        expect(rows[1]).toMatchObject({ bid: null, ask: null, session: 'AfterHours', oddLot: false, time: '15:59:59.500000' });
    });
    it('reads the Taiwan-shaped reply (datetime strings in UTC) and numeric sessions', () => {
        const rows = parseUsTicks({
            datetime: ['2026-11-18T14:30:00.026450'], close: [352.05], volume: [8], bid_price: [351.84], bid_volume: [20], ask_price: [352.17], ask_volume: [1], tick_type: [0], session: [2],
        })!;
        expect(rows[0]).toMatchObject({ time: '09:30:00.026450', price: 352.05, session: 'Regular' });
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
    it('sends LastCount for ticks', async () => {
        m.post.mockResolvedValueOnce({ datetime: [], close: [], volume: [] });
        await fetchUsTicks(AAPL, '2026-11-18', { lastCnt: 120 });
        expect(m.post.mock.calls[0]![1]).toMatchObject({ date: '2026-11-18', query_type: 'LastCount', last_cnt: 120 });
    });
    it('latches unavailable after a 4xx or a wrong shape, without retrying', async () => {
        m.post.mockRejectedValueOnce(Object.assign(new Error('422 Unprocessable'), { status: 422 }));
        await expect(fetchUsKbars(AAPL, 'a', 'b')).rejects.toSatisfy(isUsHistoryUnavailable);
        await expect(fetchUsTicks(AAPL, 'a')).rejects.toSatisfy(isUsHistoryUnavailable);
        expect(m.post).toHaveBeenCalledTimes(1);
        resetUsHistoryForTest();
        m.post.mockResolvedValueOnce([{ code: 'AAPL', close: 1 }]);
        await expect(fetchUsSnapshots([AAPL])).rejects.toSatisfy(isUsHistoryUnavailable);
        expect(usHistoryAvailable()).toBe(false);
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
