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
    it('replays trades received while history loads, skipping what history already covers', async () => {
        const d = deferred<any>();
        fetchMock.mockReturnValue(d.promise);
        const r = mount({ contract: stk, interval: '1m' });
        expect(r).toBeTruthy();
        await flush();
        pushTick('2026-09-25', '10:04:30', 999, 7); // 歷史 10:05 那根已含 → 不補
        pushTick('2026-09-25', '10:05:10', 101, 4); // 歷史之後 → 補成 10:06 那根
        d.resolve(kbars([['2026-09-25T10:00:00', '2026-09-25T10:05:00', () => 100]]));
        await flush();
        const u = updates();
        expect(u.some((b) => b.close === 999)).toBe(false);
        expect(u.at(-1)).toMatchObject({ time: T('2026-09-25T10:06:00'), close: 101 });
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
        const u = updates();
        expect(u.map((b) => b.time)).toEqual([T('2026-09-25T10:05:00'), T('2026-09-25T10:06:00')]);
    });

    it('a late trade for an older bucket updates that bar, never the latest one', async () => {
        fetchMock.mockResolvedValue(kbars([['2026-09-25T10:00:00', '2026-09-25T10:05:00', () => 100]]));
        mount({ contract: stk, interval: '1m' });
        await flush();
        pushTick('2026-09-25', '10:05:10', 101, 4); // 新的一根 10:06
        pushTick('2026-09-25', '10:03:20', 90, 1); // 晚到：屬於 10:04 那根
        const u = updates();
        const late = u.at(-1)!;
        expect(late).toMatchObject({ time: T('2026-09-25T10:04:00'), low: 90, close: 90, historical: true });
        // 最新一根 10:06 沒被改
        const tail = u.filter((b) => b.time === T('2026-09-25T10:06:00')).at(-1)!;
        expect(tail).toMatchObject({ open: 101, low: 101, close: 101 });
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
