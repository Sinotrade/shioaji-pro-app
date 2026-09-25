// 當日走勢牆（intraday-wall）換時段/更新歷史的元件層測試（issue #73）
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
const fetchMock = vi.fn();
vi.mock('../lib/chart-history', () => ({
    fetchChartHistory: (...a: unknown[]) => fetchMock(...a),
    nextChartHistoryRevision: () => Math.random(),
}));

const fut = {
    code: 'TXFR1',
    security_type: 'FUT',
    exchange: 'TAIFEX',
    target_code: 'TXFJ6',
    name: '台指期近月',
    currency: 'TWD',
    limit_up: 25000,
    limit_down: 20000,
    reference: 22500,
    day_trade: 'Yes',
    update_date: '',
    category: 'TXF',
    margin_trading_balance: 0,
    short_selling_balance: 0,
} as any;

vi.mock('../lib/shioaji', async (orig) => ({
    ...(await orig<typeof import('../lib/shioaji')>()),
    fetchWatchlists: async () => [
        {
            id: 'w1',
            name: 'W',
            contracts: [{ code: 'TXFR1', security_type: 'FUT', exchange: 'TAIFEX' }],
        },
    ],
    fetchSnapshots: async () => [],
}));
vi.mock('../lib/contracts-cache', async (orig) => ({
    ...(await orig<typeof import('../lib/contracts-cache')>()),
    ensureContract: async () => fut,
}));

import { IntradayWallPanel } from './intraday-wall';

function pushTick(date: string, time: string, close: number) {
    quote = {
        tick: {
            code: 'TXFR1',
            date,
            time,
            close,
            volume: 1,
            total_volume: 999999,
            price_chg: 0,
        },
        seq: Math.random(),
        lastDir: 0,
        flashSeq: 0,
    };
    act(() => listeners.forEach((l) => l()));
}

const flush = async () => {
    for (let i = 0; i < 8; i++) await act(async () => {});
};

const mounted: ReactTestRenderer[] = [];
async function mount() {
    let r!: ReactTestRenderer;
    act(() => {
        r = create(createElement(IntradayWallPanel, { initialCols: 1, initialRows: 1 }), {
            createNodeMock: () => ({ clientWidth: 500, clientHeight: 300, getBoundingClientRect: () => ({ width: 500, height: 300, left: 0, top: 0 }), addEventListener() {}, removeEventListener() {} }),
        });
    });
    mounted.push(r);
    await flush();
    return r;
}
const baselines = () => created.filter((c) => c.kind === 'Baseline');
const price = () => baselines()[baselines().length - 1]!;
const seriesOf = (kind: string) => created.filter((c) => c.kind === kind);
const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 16);
function deferred<V>() {
    let resolve!: (v: V) => void;
    let reject!: (e: unknown) => void;
    const p = new Promise<V>((a, b) => {
        resolve = a;
        reject = b;
    });
    return { p, resolve, reject };
}

// Fri 2026-09-25 night session so far: 15:00..20:00 = 300 1-min bars
const NIGHT = kbars([['2026-09-25T15:00:00', '2026-09-25T20:00:00', () => 22800]]);
// + Mon 2026-09-28 day session opening minutes
const NIGHT_AND_MON = kbars([
    ['2026-09-25T15:00:00', '2026-09-25T20:00:00', () => 22800],
    ['2026-09-28T08:45:00', '2026-09-28T08:50:00', () => 22900],
]);
const EMPTY = kbars([]);

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
    });
    vi.stubGlobal('requestAnimationFrame', (cb: any) => setTimeout(cb, 0));
    vi.stubGlobal('cancelAnimationFrame', (id: any) => clearTimeout(id));
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    vi.useFakeTimers({ toFake: ['Date'] });
    created.length = 0;
    quote = undefined;
    fetchMock.mockReset();
});
afterEach(() => {
    for (const m of mounted.splice(0)) act(() => m.unmount());
    listeners.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

const setNow = (s: string) => vi.setSystemTime(new Date(`${s}+08:00`));

// 夜盤 300 根畫好 → 週一 08:45:30 的 tick 越過夜盤結束，自動換時段重載
async function nightThenRollover(second: () => Promise<unknown>) {
    setNow('2026-09-25T20:00:30');
    fetchMock.mockResolvedValueOnce(NIGHT);
    await mount();
    const d = price().last as any[];
    expect(d).toHaveLength(300);
    expect(iso(d[0].time)).toBe('2026-09-25T15:01');
    const nBaselines = baselines().length;
    fetchMock.mockImplementationOnce(second);
    setNow('2026-09-28T08:45:30');
    pushTick('2026-09-28', '08:45:30', 22900);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 圖沒有重建 — 同一組 series 走 reload
    expect(baselines()).toHaveLength(nBaselines);
}

describe('IntradayWall session rollover / reload', () => {
    it('rollover reload rejects (403) → previous session curve cleared, new frame live', async () => {
        await nightThenRollover(() => Promise.reject(new Error('403')));
        await flush();
        expect(price().last).toEqual([]);
        for (const k of ['Bar', 'Histogram']) {
            for (const s of seriesOf(k)) expect(s.last).toEqual([]);
        }
        // 平均線（Line）中 filler 以外的都清空；filler 換成週一日盤框架
        const lines = seriesOf('Line');
        const filler = lines.find((s) => (s.last as any[]).length > 0)!;
        const fd = filler.last as any[];
        expect(iso(fd[0].time)).toBe('2026-09-28T08:46');
        expect(lines.filter((s) => s !== filler).every((s) => (s.last as any[]).length === 0)).toBe(true);
        // 新框架可直接接 live
        const upd = price().update.mock.calls.length;
        pushTick('2026-09-28', '08:46:10', 22910);
        expect(price().update.mock.calls.length).toBe(upd + 1);
        expect(price().update.mock.calls.at(-1)![0].time).toBe(T('2026-09-28T08:47:00'));
    });

    it('rollover reload returns zero kbars → previous session curve cleared', async () => {
        await nightThenRollover(() => Promise.resolve(EMPTY));
        await flush();
        expect(price().last).toEqual([]);
        for (const s of seriesOf('Bar')) expect(s.last).toEqual([]);
        for (const s of seriesOf('Histogram')) expect(s.last).toEqual([]);
    });

    it('manual 更新歷史 after a 403 → reloads and draws history', async () => {
        setNow('2026-09-25T20:00:30');
        fetchMock.mockImplementationOnce(() => Promise.reject(new Error('403')));
        const r = await mount();
        expect(price().last).toEqual([]);
        fetchMock.mockResolvedValueOnce(NIGHT);
        // 空框架才顯示「更新歷史」（有 live 成交後就收起）
        const btn = r.root.find((n) => n.type === 'button' && n.props['aria-label'] === '更新歷史');
        act(() => btn.props.onClick());
        await flush();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(price().last).toHaveLength(300);
    });

    it('successful rollover reload: curve kept while pending (no flash), then replaced', async () => {
        const second = deferred<unknown>();
        await nightThenRollover(() => second.p);
        const setCalls = price().setData.mock.calls.length;
        // pending — 舊曲線不閃掉，也不接新 tick
        expect(price().last).toHaveLength(300);
        const upd = price().update.mock.calls.length;
        pushTick('2026-09-28', '08:45:40', 22905);
        expect(price().update.mock.calls.length).toBe(upd);
        expect(price().setData.mock.calls.length).toBe(setCalls);
        second.resolve(NIGHT_AND_MON);
        await flush();
        const d = price().last as any[];
        expect(d).toHaveLength(5);
        expect(iso(d[0].time)).toBe('2026-09-28T08:46');
        // 中間沒有先 setData([]) 再畫
        expect(price().setData.mock.calls.slice(setCalls).every((c) => (c[0] as any[]).length > 0)).toBe(true);
    });

    it('live tick before history arrives is not drawn', async () => {
        setNow('2026-09-25T20:00:30');
        const first = deferred<unknown>();
        fetchMock.mockReturnValueOnce(first.p);
        await mount();
        pushTick('2026-09-25', '20:00:10', 22810);
        expect(price().update).not.toHaveBeenCalled();
        expect(price().last).toEqual([]);
        first.resolve(NIGHT);
        await flush();
        expect(price().last).toHaveLength(300);
    });
});
