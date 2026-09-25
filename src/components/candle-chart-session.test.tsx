// candle-chart 全盤/僅日盤（issue #73）元件層測試
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
import { newInstance, saveInstances } from '../lib/indicator-defs';

const fut = { code: 'TXFR1', security_type: 'FUT', exchange: 'TAIFEX', target_code: 'TXFJ6' } as any;
const stk = { code: '2330', security_type: 'STK', exchange: 'TSE', target_code: null } as any;

function pushTick(date: string, time: string, close: number, code = 'TXFR1') {
    quote = { tick: { code, date, time, close, volume: 3 }, seq: Math.random(), lastDir: 0, flashSeq: 0 };
    act(() => listeners.forEach((l) => l()));
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
const candles = () => {
    const s = created.filter((c) => c.kind === 'Candlestick');
    return s[s.length - 1]!;
};
const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 16);
const setNow = (s: string) => vi.setSystemTime(new Date(`${s}+08:00`));
const btn = (r: ReactTestRenderer, label: string) =>
    r.root.findAll((n) => n.type === 'button' && n.children.join('') === label);

// day bars price 100, night bars price 200 — a day-only SMA must stay 100
const DATA = kbars([
    ['2026-09-23T08:45:00', '2026-09-23T13:45:00', () => 100],
    ['2026-09-23T15:00:00', '2026-09-24T05:00:00', () => 200],
    ['2026-09-24T08:45:00', '2026-09-24T13:45:00', () => 100],
    ['2026-09-24T15:00:00', '2026-09-25T05:00:00', () => 200],
    ['2026-09-25T08:45:00', '2026-09-25T13:45:00', () => 100],
    ['2026-09-25T15:00:00', '2026-09-25T20:00:00', () => 200],
]);

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
        key: () => null,
        length: 0,
    });
    vi.stubGlobal('requestAnimationFrame', (cb: any) => setTimeout(cb, 0));
    vi.stubGlobal('cancelAnimationFrame', (id: any) => clearTimeout(id));
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    vi.useFakeTimers({ toFake: ['Date'] });
    created.length = 0;
    quote = undefined;
    fetchMock.mockReset();
    const sma = newInstance('sma');
    sma.params = { ...sma.params, period: 20 };
    saveInstances([sma, newInstance('vwap')]);
});
afterEach(() => {
    for (const m of mounted.splice(0)) act(() => m.unmount());
    listeners.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('CandleChart 全盤/日盤 ', () => {
    it('stocks show no 全盤/日盤 control', async () => {
        setNow('2026-09-25T20:00:00');
        fetchMock.mockResolvedValue(kbars([['2026-09-25T09:00:00', '2026-09-25T13:30:00', () => 1000]]));
        const r = mount({ contract: { ...stk } });
        await flush();
        expect(btn(r, '全盤')).toHaveLength(0);
        expect(btn(r, '日盤')).toHaveLength(0);
    });

    it('day-only: history filtered, indicators day-only, night live tick ignored, day tick drawn', async () => {
        setNow('2026-09-25T20:00:30');
        fetchMock.mockResolvedValue(DATA);
        let mode: any;
        const onChange = (m: any) => (mode = m);
        const r = mount({ contract: fut, onSessionModeChange: onChange });
        await flush();
        // default all → night bars present (5m)
        let d = candles().last as any[];
        expect(d.some((b) => b.close === 200)).toBe(true);
        const [toggle] = btn(r, '日盤');
        expect(toggle!.props['aria-pressed']).toBe(false);
        expect(toggle!.props.title).toContain('08:45–13:45');
        const before = created.length;
        act(() => btn(r, '日盤')[0]!.props.onClick());
        expect(mode).toBe('day');
        // 受控：父層（App 的 setBlockSessionConfig）寫回 block 後才生效
        act(() => r.update(createElement(CandleChart, { contract: fut, sessionMode: mode, onSessionModeChange: onChange } as any)));
        await flush();
        d = candles().last as any[];
        expect(d.length).toBeGreaterThan(0);
        expect(d.every((b) => b.close === 100)).toBe(true);
        const times = d.map((b) => iso(b.time).slice(11));
        // 5m buckets: first 08:50, last 13:45 (13:46–13:49 grace would be 13:50)
        expect(times[0]).toBe('08:50');
        expect(times[times.length - 1]).toBe('13:45');
        // indicator line series (SMA / VWAP) values: all 100
        const lines = created.slice(before).filter((c) => c.kind === 'Line' && (c.last as any[]).length > 0);
        expect(lines.length).toBeGreaterThan(0);
        for (const l of lines) {
            const vals = (l.last as any[]).filter((p) => p.value !== undefined).map((p) => p.value);
            expect(vals.every((v) => Math.abs(v - 100) < 1e-9)).toBe(true);
        }
        // night tick ignored
        const n = candles().update.mock.calls.length;
        pushTick('2026-09-25', '20:01:02', 250);
        await flush();
        expect(candles().update.mock.calls.length).toBe(n);
    });

    it('day-only live boundaries: 08:45:00 open drawn, 13:45:00 print drawn, 15:00:00 ignored', async () => {
        setNow('2026-09-25T08:44:00');
        fetchMock.mockResolvedValue(
            kbars([
                ['2026-09-24T08:45:00', '2026-09-24T13:45:00', () => 100],
                ['2026-09-24T15:00:00', '2026-09-25T05:00:00', () => 200],
            ]),
        );
        const r = mount({ contract: fut, sessionMode: 'day', onSessionModeChange: () => {} });
        await flush();
        act(() => btn(r, '1m')[0]!.props.onClick());
        await flush();
        const up = () => candles().update.mock.calls;
        let n = up().length;
        pushTick('2026-09-25', '08:45:00', 101);
        await flush();
        expect(up().length).toBe(n + 1);
        expect(iso(up().at(-1)![0].time)).toBe('2026-09-25T08:46');
        n = up().length;
        pushTick('2026-09-25', '13:45:00', 102);
        await flush();
        expect(up().length).toBe(n + 1);
        n = up().length;
        pushTick('2026-09-25', '15:00:00', 300);
        await flush();
        expect(up().length).toBe(n);
    });

    it('prop cleared (layout loaded without chartSession) → back to 全盤', async () => {
        setNow('2026-09-25T20:00:30');
        fetchMock.mockResolvedValue(DATA);
        let mode: any;
        const onChange = (m: any) => (mode = m);
        const r = mount({ contract: fut, sessionMode: mode, onSessionModeChange: onChange });
        await flush();
        act(() => btn(r, '日盤')[0]!.props.onClick());
        act(() => r.update(createElement(CandleChart, { contract: fut, sessionMode: mode, onSessionModeChange: onChange } as any)));
        await flush();
        act(() => r.update(createElement(CandleChart, { contract: fut, sessionMode: undefined, onSessionModeChange: onChange } as any)));
        await flush();
        expect(btn(r, '日盤')[0]!.props['aria-pressed']).toBe(false);
    });

    it('long day-session products (FX, underlying E) get no toggle and keep all bars', async () => {
        setNow('2026-09-25T20:00:30');
        fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: { ...fut, code: 'RTFR1', underlying_kind: 'E' }, sessionMode: 'day', onSessionModeChange: () => {} });
        await flush();
        expect(btn(r, '日盤')).toHaveLength(0);
        expect((candles().last as any[]).some((b) => b.close === 200)).toBe(true);
    });

    it('popout: inherited 日盤 is the initial value, then local', async () => {
        setNow('2026-09-25T20:00:30');
        fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: fut, sessionMode: 'day' });
        await flush();
        expect((candles().last as any[]).every((b) => b.close === 100)).toBe(true);
        expect(btn(r, '日盤')[0]!.props['aria-pressed']).toBe(true);
        act(() => btn(r, '日盤')[0]!.props.onClick()); // 單一切換鈕：再按回全盤
        await flush();
        expect((candles().last as any[]).some((b) => b.close === 200)).toBe(true);
    });

    it('unknown persisted value falls back to 全盤', async () => {
        setNow('2026-09-25T20:00:30');
        fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: fut, sessionMode: 'foo', onSessionModeChange: () => {} });
        await flush();
        expect(btn(r, '日盤')[0]!.props['aria-pressed']).toBe(false);
        expect((candles().last as any[]).some((b) => b.close === 200)).toBe(true);
    });

    it('the toggle is a single compact button (no separate 全盤 button)', async () => {
        setNow('2026-09-25T20:00:30');
        fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: fut, onSessionModeChange: () => {} });
        await flush();
        expect(btn(r, '全盤')).toHaveLength(0);
        expect(btn(r, '日盤')).toHaveLength(1);
    });

    // 回歸：換組（全盤↔日盤/週期/商品）後新歷史尚未回來，圖上不可留舊 K 棒
    const deferred = () => {
        let resolve!: (v: unknown) => void;
        const promise = new Promise((res) => (resolve = res));
        return { promise, resolve };
    };
    const shown = () => [
        ...(candles().last as any[]),
        ...(created.filter((c) => c.kind === 'Histogram').at(-1)?.last as any[] ?? []),
    ];
    const rerender = (r: ReactTestRenderer, props: any) =>
        act(() => r.update(createElement(CandleChart, props)));

    it('toggle 全盤→日盤 with the reload pending shows no stale mixed bars', async () => {
        setNow('2026-09-25T20:00:30');
        fetchMock.mockResolvedValueOnce(DATA);
        fetchMock.mockReturnValueOnce(new Promise(() => {})); // 卡住
        let mode: any = 'all';
        const onChange = (m: any) => (mode = m);
        const r = mount({ contract: fut, sessionMode: mode, onSessionModeChange: onChange });
        await flush();
        expect(shown().some((b) => b.close === 200)).toBe(true);
        act(() => btn(r, '日盤')[0]!.props.onClick());
        rerender(r, { contract: fut, sessionMode: mode, onSessionModeChange: onChange });
        await flush();
        expect(btn(r, '日盤')[0]!.props['aria-pressed']).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(shown()).toHaveLength(0);
    });

    it('timeframe switch with the reload pending clears the old bars', async () => {
        setNow('2026-09-25T20:00:30');
        fetchMock.mockResolvedValueOnce(DATA);
        fetchMock.mockReturnValueOnce(new Promise(() => {}));
        const r = mount({ contract: fut, sessionMode: 'all', onSessionModeChange: () => {} });
        await flush();
        expect(shown().length).toBeGreaterThan(0);
        act(() => btn(r, '1m')[0]!.props.onClick());
        await flush();
        expect(shown()).toHaveLength(0);
    });

    it('contract switch with the reload pending clears the old bars', async () => {
        setNow('2026-09-25T20:00:30');
        fetchMock.mockResolvedValueOnce(DATA);
        fetchMock.mockReturnValueOnce(new Promise(() => {}));
        const r = mount({ contract: fut, sessionMode: 'all', onSessionModeChange: () => {} });
        await flush();
        expect(shown().length).toBeGreaterThan(0);
        rerender(r, { contract: { ...fut, code: 'MXFR1' }, sessionMode: 'all', onSessionModeChange: () => {} });
        await flush();
        expect(shown()).toHaveLength(0);
    });

    it('same-key reload (更新歷史) keeps the bars while pending', async () => {
        setNow('2026-09-25T20:00:30');
        fetchMock.mockResolvedValueOnce(DATA);
        fetchMock.mockReturnValueOnce(new Promise(() => {}));
        const r = mount({ contract: fut, sessionMode: 'all', onSessionModeChange: () => {} });
        await flush();
        const before = shown().length;
        const refresh = r.root.find((n) => n.type === 'button' && n.props['aria-label'] === '更新歷史');
        act(() => refresh.props.onClick());
        await flush();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(shown()).toHaveLength(before);
    });

    it('an older request resolving after a newer switch never draws', async () => {
        setNow('2026-09-25T20:00:30');
        const a = deferred();
        const b = deferred();
        fetchMock.mockResolvedValueOnce(DATA);
        fetchMock.mockReturnValueOnce(a.promise); // 日盤 5m
        fetchMock.mockReturnValueOnce(b.promise); // 日盤 1m
        let mode: any = 'all';
        const onChange = (m: any) => (mode = m);
        const r = mount({ contract: fut, sessionMode: mode, onSessionModeChange: onChange });
        await flush();
        act(() => btn(r, '日盤')[0]!.props.onClick());
        rerender(r, { contract: fut, sessionMode: mode, onSessionModeChange: onChange });
        await flush();
        act(() => btn(r, '1m')[0]!.props.onClick());
        await flush();
        b.resolve(DATA);
        await flush();
        const oneMin = (candles().last as any[]).map((x) => x.time);
        expect(oneMin.length).toBeGreaterThan(0);
        // 1 分 K：label 間距 60 秒
        expect(oneMin[1] - oneMin[0]).toBe(60);
        const setCalls = candles().setData.mock.calls.length;
        a.resolve(DATA); // 舊的 5m 請求晚到
        await flush();
        expect(candles().setData.mock.calls.length).toBe(setCalls);
        expect((candles().last as any[]).map((x) => x.time)).toEqual(oneMin);
    });
});
