// candle-chart 即時成交：載入中暫存補畫、亂序成交不改最新一根、價格位數跟著商品
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { created, kbars } from './chart-session.test-harness';

vi.hoisted(() => {
    const store = new Map<string, string>();
    const ls = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k), key: () => null, length: 0 };
    (globalThis as any).localStorage = ls;
    (globalThis as any).window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, location: { search: '', href: 'http://x/' } });
    (globalThis as any).document = { addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, getContext: () => null }), body: {} };
});
vi.mock('../lib/trade', () => ({ notify: () => {}, placeQuickOrder: async () => {} }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: async () => {}, updateOrderPrice: async () => {} }));
vi.mock('lightweight-charts', async () => (await import('./chart-session.test-harness')).lwMock());

let quote: any = undefined;
const listeners = new Set<() => void>();
vi.mock('../hooks/use-stream', async () => {
    const React = await import('react');
    return {
        useQuote: () =>
            React.useSyncExternalStore(
                (l: () => void) => {
                    listeners.add(l);
                    return () => listeners.delete(l);
                },
                () => quote,
            ),
    };
});
const fetchMock = vi.fn();
vi.mock('../lib/chart-history', () => ({
    fetchChartHistory: (...a: unknown[]) => fetchMock(...a),
    nextChartHistoryRevision: () => Math.random(),
}));

import { CandleChart } from './candle-chart';
import { recordUsTick, resetUsQuotesForTest } from '../lib/us/us-quotes';

const stk = { code: '2330', security_type: 'STK', exchange: 'TSE', target_code: null } as any;
const aapl = { code: 'AAPL', region: 'US', security_type: 'STK', exchange: 'NASDAQ', target_code: null } as any;

function pushTick(date: string, time: string, close: number, volume = 3, code = '2330') {
    quote = { tick: { code, date, time, close, volume }, seq: Math.random(), lastDir: 0, flashSeq: 0 };
    act(() => listeners.forEach((l) => l()));
}
function pushUs(isoUtc: string, price: string, volume = 5, session: 'Regular' | 'AfterHours' | 'PreMarket' = 'Regular') {
    const ms = Date.parse(`${isoUtc}Z`);
    act(() => recordUsTick({ key: 'US:AAPL', price, session, freshness: null, ts: ms, tsUs: ms * 1000, volume }));
}
const flush = async () => {
    for (let i = 0; i < 6; i++) await act(async () => {});
};
const mounted: ReactTestRenderer[] = [];
function mount(props: any) {
    let r!: ReactTestRenderer;
    act(() => {
        r = create(createElement(CandleChart, props), {
            createNodeMock: () => ({ clientWidth: 800, clientHeight: 400, getBoundingClientRect: () => ({ width: 800, height: 400, left: 0, top: 0 }), addEventListener() {}, removeEventListener() {}, style: {} }),
        });
    });
    mounted.push(r);
    return r;
}
const candles = () => created.filter((c) => c.kind === 'Candlestick').at(-1)!;
const T = (s: string) => Date.parse(`${s}Z`) / 1000;
const lastData = () => (candles().setData.mock.calls.at(-1)![0] as any[]);
const updates = () => candles().update.mock.calls.map((c) => ({ ...(c[0] as any), historical: c[1] === true }));

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k), key: () => null, length: 0 });
    vi.stubGlobal('requestAnimationFrame', (cb: any) => setTimeout(cb, 0));
    vi.stubGlobal('cancelAnimationFrame', (id: any) => clearTimeout(id));
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-25T10:10:00+08:00'));
    created.length = 0;
    quote = undefined;
    fetchMock.mockReset();
    resetUsQuotesForTest();
});
afterEach(() => {
    for (const m of mounted.splice(0)) act(() => m.unmount());
    listeners.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
}

describe('CandleChart live trades', () => {
    it('replays trades received while history loads in one setData, skipping what history already covers', async () => {
        const d = deferred<any>();
        fetchMock.mockReturnValue(d.promise);
        const r = mount({ contract: stk, interval: '1m' });
        expect(r).toBeTruthy();
        await flush();
        pushTick('2026-09-25', '10:04:30', 999, 7); // 歷史 10:05 那根已含 → 不補
        pushTick('2026-09-25', '10:05:10', 101, 4); // 歷史之後 → 補成 10:06 那根
        pushTick('2026-09-25', '10:05:40', 103, 1);
        pushTick('2026-09-25', '10:06:10', 102, 2); // 10:07
        const setDataBefore = candles().setData.mock.calls.length;
        d.resolve(kbars([['2026-09-25T10:00:00', '2026-09-25T10:05:00', () => 100]]));
        await flush();
        // 暫存的成交先在記憶體併好，一次 setData 畫出，不逐筆 update
        expect(updates()).toHaveLength(0);
        expect(candles().setData.mock.calls.length).toBe(setDataBefore + 1);
        const data = lastData();
        expect(data.some((x) => x.close === 999)).toBe(false);
        expect(data.find((x) => x.time === T('2026-09-25T10:05:00'))).toMatchObject({ close: 100 });
        expect(data.slice(-2)).toMatchObject([
            { time: T('2026-09-25T10:06:00'), open: 101, high: 103, close: 103 },
            { time: T('2026-09-25T10:07:00'), close: 102 },
        ]);
    });

    it('replays every buffered trade when history comes back empty or fails', async () => {
        const d = deferred<any>();
        fetchMock.mockReturnValue(d.promise);
        mount({ contract: stk, interval: '1m' });
        await flush();
        pushTick('2026-09-25', '10:04:30', 100, 2);
        pushTick('2026-09-25', '10:05:10', 101, 4);
        d.reject(new Error('offline'));
        await flush();
        expect(lastData().map((x) => x.time)).toEqual([T('2026-09-25T10:05:00'), T('2026-09-25T10:06:00')]);
        // 之後的成交接著畫
        pushTick('2026-09-25', '10:05:20', 105, 1);
        expect(updates().at(-1)).toMatchObject({ time: T('2026-09-25T10:06:00'), close: 105 });
    });

    it('marks the chart for a history reload when the pending buffer overflows', async () => {
        const d = deferred<any>();
        fetchMock.mockReturnValue(d.promise);
        vi.setSystemTime(new Date('2026-11-19T15:30:00Z'));
        mount({ contract: aapl, interval: '1m' });
        await flush();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const base = Date.parse('2026-11-19T15:00:00Z');
        act(() => {
            for (let i = 0; i < 50_001; i++) {
                const ms = base + i;
                recordUsTick({ key: 'US:AAPL', price: '350', session: 'Regular', freshness: null, ts: ms, tsUs: ms * 1000, volume: 1 });
            }
        });
        fetchMock.mockResolvedValue(kbars([]));
        d.resolve(kbars([['2026-11-19T14:31:00', '2026-11-19T14:59:00', () => 349]]));
        await flush();
        // 漏了的成交靠重抓歷史補回，不能就這樣消失
        expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    });

    it('drops a late trade for an older bucket and leaves the history and tail untouched', async () => {
        fetchMock.mockResolvedValue(kbars([['2026-09-25T10:00:00', '2026-09-25T10:05:00', () => 100]]));
        mount({ contract: stk, interval: '1m' });
        await flush();
        pushTick('2026-09-25', '10:05:10', 101, 4); // 新的一根 10:06
        const n = updates().length;
        const setDataN = candles().setData.mock.calls.length;
        pushTick('2026-09-25', '10:03:20', 90, 1); // 晚到：屬於 10:04 那根（歷史已含）
        expect(updates().length).toBe(n);
        expect(candles().setData.mock.calls.length).toBe(setDataN);
        pushTick('2026-09-25', '10:05:30', 102, 1);
        expect(updates().at(-1)).toMatchObject({ time: T('2026-09-25T10:06:00'), open: 101, low: 101, close: 102 });
    });

    it.each([
        ['1m', '2026-11-19T16:00:00'],
        ['5m', '2026-11-19T16:00:00'],
        ['60m', '2026-11-19T16:00:00'],
    ])('US closing cross lands in the 16:00 (NY) bar on %s', async (interval, expected) => {
        vi.setSystemTime(new Date('2026-11-19T21:10:00Z'));
        fetchMock.mockResolvedValue(kbars([['2026-11-19T15:50:00', '2026-11-19T15:58:00', () => 352]]));
        mount({ contract: aapl, interval });
        await flush();
        pushUs('2026-11-19T20:59:59.500', '352.40', 100); // 15:59:59.5 → 16:00
        pushUs('2026-11-19T21:00:01.445', '352.45', 5_000_000, 'AfterHours'); // 收盤競價
        expect(updates().at(-1)).toMatchObject({ time: T(expected), close: 352.45 });
        expect(updates().every((u) => u.time <= T(expected))).toBe(true);
    });

    it('drops a late trade that falls into a gap instead of touching the tail', async () => {
        fetchMock.mockResolvedValue(kbars([['2026-09-25T10:00:00', '2026-09-25T10:02:00', () => 100]]));
        mount({ contract: stk, interval: '1m' });
        await flush();
        pushTick('2026-09-25', '10:05:10', 101, 4);
        const n = updates().length;
        pushTick('2026-09-25', '10:03:20', 90, 1); // 10:04 那根不存在
        expect(updates().length).toBe(n);
    });
});

describe('CandleChart price precision', () => {
    it('US live-only sub-dollar symbol gets 4 decimals, crossing $1 goes back to 2, and TW stays 2 after switching', async () => {
        vi.setSystemTime(new Date('2026-11-19T15:00:00Z'));
        fetchMock.mockResolvedValue(kbars([]));
        const r = mount({ contract: aapl, interval: '1m' });
        await flush();
        expect(candles().options.priceFormat).toMatchObject({ precision: 2 });
        pushUs('2026-11-19T15:00:01', '0.5123');
        expect(candles().options.priceFormat).toMatchObject({ precision: 4, minMove: 0.0001 });
        pushUs('2026-11-19T15:00:02', '1.02');
        expect(candles().options.priceFormat).toMatchObject({ precision: 2, minMove: 0.01 });
        pushUs('2026-11-19T15:00:03', '0.9');
        expect(candles().options.priceFormat).toMatchObject({ precision: 4 });
        // 切到台股：恢復 2 位
        fetchMock.mockResolvedValue(kbars([['2026-11-19T10:00:00', '2026-11-19T10:05:00', () => 1000]]));
        act(() => r.update(createElement(CandleChart, { contract: stk, interval: '1m' } as any)));
        await flush();
        expect(candles().options.priceFormat).toMatchObject({ precision: 2, minMove: 0.01 });
    });

    it('US after-hours trades past the closing cross never touch the regular bars', async () => {
        vi.setSystemTime(new Date('2026-11-19T21:10:00Z'));
        fetchMock.mockResolvedValue(kbars([['2026-11-19T15:50:00', '2026-11-19T15:55:00', () => 352]]));
        mount({ contract: aapl, interval: '1m' });
        await flush();
        const n = updates().length;
        pushUs('2026-11-19T21:00:01', '352.45', 5_000_000, 'AfterHours'); // 收盤競價 16:00:01 → 畫
        expect(updates().length).toBe(n + 1);
        pushUs('2026-11-19T21:02:00', '360', 10, 'AfterHours'); // 16:02 盤後 → 不畫
        pushUs('2026-11-19T13:00:00', '340', 10, 'PreMarket');
        expect(updates().length).toBe(n + 1);
    });
});
