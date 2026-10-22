// candle-chart K 線週期跟版面一起存（#331）元件層測試
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
import { dateStrOffset } from '../lib/utils/kbars';

const stk = { code: '2330', security_type: 'STK', exchange: 'TSE', target_code: null } as any;

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
const setNow = (s: string) => vi.setSystemTime(new Date(`${s}+08:00`));
const btn = (r: ReactTestRenderer, label: string) =>
    r.root.findAll((n) => n.type === 'button' && n.children.join('') === label);


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

const BARS = kbars([['2026-09-25T09:00:00', '2026-09-25T13:30:00', () => 1000]]);
const fromDays = () => fetchMock.mock.calls.map((c) => c[1]);

describe('CandleChart interval persistence (#331)', () => {
    it('defaults to 5m when the panel has no stored interval', async () => {
        setNow('2026-09-25T20:00:00');
        fetchMock.mockResolvedValue(BARS);
        mount({ contract: { ...stk }, onIntervalChange: () => {} });
        await flush();
        expect(fromDays()[0]).toBe(dateStrOffset(10));
    });

    it('loads the stored interval and reports clicks without keeping private state', async () => {
        setNow('2026-09-25T20:00:00');
        fetchMock.mockResolvedValue(BARS);
        const onChange = vi.fn();
        const r = mount({ contract: { ...stk }, interval: '1D', onIntervalChange: onChange });
        await flush();
        expect(fromDays().at(-1)).toBe(dateStrOffset(240));
        act(() => btn(r, '60m')[0]!.props.onClick());
        expect(onChange).toHaveBeenCalledWith('60m');
        await flush();
        // controlled: until the workspace stores the new value the chart stays on 1D
        expect(fromDays().at(-1)).toBe(dateStrOffset(240));
        act(() => r.update(createElement(CandleChart, { contract: { ...stk }, interval: '60m', onIntervalChange: onChange } as any)));
        await flush();
        expect(fromDays().at(-1)).toBe(dateStrOffset(60));
    });

    it('ignores an unknown stored interval and falls back to 5m', async () => {
        setNow('2026-09-25T20:00:00');
        fetchMock.mockResolvedValue(BARS);
        mount({ contract: { ...stk }, interval: '3h', onIntervalChange: () => {} });
        await flush();
        expect(fromDays()[0]).toBe(dateStrOffset(10));
    });

    it('popouts use the interval only as the initial value', async () => {
        setNow('2026-09-25T20:00:00');
        fetchMock.mockResolvedValue(BARS);
        const r = mount({ contract: { ...stk }, interval: '15m' });
        await flush();
        expect(fromDays().at(-1)).toBe(dateStrOffset(20));
        act(() => btn(r, '1m')[0]!.props.onClick());
        await flush();
        expect(fromDays().at(-1)).toBe(dateStrOffset(3));
    });
});
