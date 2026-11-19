// intraday-chart 美股：時段框架、盤後成交、毫秒分桶、漏收補抓、空框架接手、價格位數
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { created, kbars, T } from './chart-session.test-harness';

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
const snap = vi.hoisted(() => ({ value: null as unknown, listeners: new Set<() => void>() }));
vi.mock('../hooks/use-us-snapshot', async () => {
    const React = await import('react');
    return {
        useUsSnapshot: () =>
            React.useSyncExternalStore(
                (l: () => void) => {
                    snap.listeners.add(l);
                    return () => snap.listeners.delete(l);
                },
                () => snap.value,
            ),
    };
});
const fetchMock = vi.fn();
let historyRevision = 0;
vi.mock('../lib/chart-history', () => ({
    fetchChartHistory: (...a: unknown[]) => fetchMock(...a),
    nextChartHistoryRevision: () => ++historyRevision,
}));

import { IntradayChart } from './intraday-chart';
import { recordUsTick, resetUsQuotesForTest } from '../lib/us/us-quotes';

const aapl = { code: 'AAPL', region: 'US', security_type: 'STK', exchange: 'NASDAQ', target_code: null, name: 'Apple', currency: 'USD', reference: 0, limit_up: 0, limit_down: 0 } as any;
const stk = { code: '2330', security_type: 'STK', exchange: 'TSE', target_code: null, name: '台積電', currency: 'TWD', reference: 1000, limit_up: 1100, limit_down: 900 } as any;

/** isoUtc：UTC 時間（紐約 = UTC−5，11 月） */
function pushUs(isoUtc: string, price: string, opts: { volume?: number; total?: number; session?: 'Regular' | 'AfterHours' | 'PreMarket' } = {}) {
    const ms = Date.parse(`${isoUtc}Z`);
    act(() => recordUsTick({ key: 'US:AAPL', price, session: opts.session ?? 'Regular', freshness: null, ts: Math.floor(ms), tsUs: Math.round(ms * 1000), volume: opts.volume ?? 5, totalVolume: opts.total }));
}
function setSnapshot(v: unknown) {
    snap.value = v;
    act(() => snap.listeners.forEach((l) => l()));
}
const flush = async () => {
    for (let i = 0; i < 6; i++) await act(async () => {});
};
const mounted: ReactTestRenderer[] = [];
function mount(props: any) {
    let r!: ReactTestRenderer;
    act(() => {
        r = create(createElement(IntradayChart, props), {
            createNodeMock: () => ({ clientWidth: 500, clientHeight: 300, getBoundingClientRect: () => ({ width: 500, height: 300, left: 0, top: 0 }), addEventListener() {}, removeEventListener() {} }),
        });
    });
    mounted.push(r);
    return r;
}
const price = () => created.filter((c) => c.kind === 'Baseline').at(-1)!;
const lastUpdate = () => price().update.mock.calls.at(-1)?.[0] as { time: number; value: number } | undefined;

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
    vi.stubGlobal('requestAnimationFrame', (cb: any) => setTimeout(cb, 0));
    vi.stubGlobal('cancelAnimationFrame', (id: any) => clearTimeout(id));
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-19T15:30:00Z')); // 紐約 10:30
    created.length = 0;
    quote = undefined;
    historyRevision = 0;
    snap.value = null;
    fetchMock.mockReset();
    resetUsQuotesForTest();
});
afterEach(() => {
    for (const m of mounted.splice(0)) act(() => m.unmount());
    listeners.clear();
    snap.listeners.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

// 紐約 11-19 09:30–10:00 的一般盤 1 分 K
const MORNING = kbars([['2026-11-19T09:30:00', '2026-11-19T10:00:00', () => 100]]);

describe('IntradayChart (US)', () => {
    it('keeps fractional seconds: the 09:30:00.026 opening print lands on 09:31, 10:01:00.5 on 10:02', async () => {
        fetchMock.mockResolvedValue(kbars([]));
        snap.value = { tradeDate: '2026-11-19', reference: 99 };
        mount({ contract: aapl });
        await flush();
        pushUs('2026-11-19T14:30:00.026', '101');
        expect(lastUpdate()).toMatchObject({ time: T('2026-11-19T09:31:00'), value: 101 });
        pushUs('2026-11-19T15:01:00.500', '102');
        expect(lastUpdate()).toMatchObject({ time: T('2026-11-19T10:02:00'), value: 102 });
    });

    it('draws the closing cross but no after-hours trade past it', async () => {
        vi.setSystemTime(new Date('2026-11-19T21:10:00Z'));
        fetchMock.mockResolvedValue(kbars([['2026-11-19T09:30:00', '2026-11-19T15:59:00', () => 352]]));
        snap.value = { tradeDate: '2026-11-19', reference: 350 };
        mount({ contract: aapl });
        await flush();
        const n = price().update.mock.calls.length;
        pushUs('2026-11-19T21:00:01.445', '352.45', { session: 'AfterHours', volume: 5_000_000 });
        expect(price().update.mock.calls.length).toBe(n + 1);
        expect(lastUpdate()).toMatchObject({ time: T('2026-11-19T16:00:00'), value: 352.45 });
        pushUs('2026-11-19T21:01:30', '360', { session: 'AfterHours' });
        pushUs('2026-11-19T21:03:59', '361', { session: 'AfterHours' });
        expect(price().update.mock.calls.length).toBe(n + 1);
        expect(lastUpdate()?.value).toBe(352.45);
    });

    it('reloads history when the cumulative volume shows trades were missed during a gap', async () => {
        fetchMock.mockResolvedValue(MORNING);
        snap.value = { tradeDate: '2026-11-19', reference: 99 };
        mount({ contract: aapl });
        await flush();
        const calls = fetchMock.mock.calls.length;
        pushUs('2026-11-19T15:00:30', '100', { volume: 5, total: 1_000 });
        vi.setSystemTime(new Date('2026-11-19T15:20:00Z'));
        // 睡醒：累計量跳了 50 萬，這筆只有 10 股 → 中間漏收，重抓歷史
        pushUs('2026-11-19T15:19:00', '101', { volume: 10, total: 501_010 });
        await flush();
        expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
    });

    it('a quiet symbol with no missed volume is not reloaded on every gap', async () => {
        fetchMock.mockResolvedValue(MORNING);
        snap.value = { tradeDate: '2026-11-19', reference: 99 };
        mount({ contract: aapl });
        await flush();
        const calls = fetchMock.mock.calls.length;
        pushUs('2026-11-19T15:00:30', '100', { volume: 5, total: 1_000 });
        pushUs('2026-11-19T15:19:00', '101', { volume: 10, total: 1_010 });
        await flush();
        expect(fetchMock.mock.calls.length).toBe(calls);
        expect(lastUpdate()).toMatchObject({ time: T('2026-11-19T10:19:00'), value: 101 }); // 整分照台股慣例歸自己的標籤
    });

    it('empty history with no reference still opens the frame; trades and a late snapshot take over', async () => {
        fetchMock.mockResolvedValue(kbars([]));
        mount({ contract: aapl });
        await flush();
        pushUs('2026-11-19T15:05:10', '0.5123');
        expect(lastUpdate()).toMatchObject({ time: T('2026-11-19T10:06:00'), value: 0.5123 });
        // 第一筆成交暫當基準；快照參考價到了換成正式的
        setSnapshot({ tradeDate: '2026-11-19', reference: 0.45 });
        expect(price().options.baseValue).toMatchObject({ price: 0.45 });
        // 未滿 1 美元：4 位
        expect(price().options.priceFormat).toMatchObject({ precision: 4, minMove: 0.0001 });
    });

    it('switching a sub-dollar US symbol to TW restores 2 decimals', async () => {
        fetchMock.mockResolvedValue(kbars([]));
        const r = mount({ contract: aapl });
        await flush();
        pushUs('2026-11-19T15:05:10', '0.5123');
        expect(price().options.priceFormat).toMatchObject({ precision: 4 });
        vi.setSystemTime(new Date('2026-11-19T10:30:00+08:00'));
        fetchMock.mockResolvedValue(kbars([['2026-11-19T09:00:00', '2026-11-19T10:30:00', () => 1005]]));
        act(() => r.update(createElement(IntradayChart, { contract: stk } as any)));
        await flush();
        expect(price().options.priceFormat).toMatchObject({ precision: 2, minMove: 0.01 });
    });
});
