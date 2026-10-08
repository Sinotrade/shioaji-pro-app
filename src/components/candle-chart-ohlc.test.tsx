// candle-chart K 棒讀值列（issue #240）整合測試：游標移動選中 K 棒、離開回最新、
// tick 更新最新一根、顯示／隱藏開關跟面板設定
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { created, crosshairHandlers, kbars, T as wall } from './chart-session.test-harness';

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

const fut = { code: 'TXFR1', security_type: 'FUT', exchange: 'TAIFEX', target_code: 'TXFJ6', tick: 1 } as any;
const stk = { code: '2330', security_type: 'STK', exchange: 'TSE', target_code: null } as any;

const flush = async () => {
    for (let i = 0; i < 6; i++) await act(async () => {});
};
const frame = async () => {
    await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
    });
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
const field = (r: ReactTestRenderer, key: string): ReactTestInstance | undefined =>
    r.root.findAll((n) => n.props['data-ohlc'] === key && typeof n.type === 'string')[0];
const text = (n: ReactTestInstance | undefined): string =>
    n ? n.children.map((c) => (typeof c === 'string' ? c : text(c))).join('') : '';
const toggle = (r: ReactTestRenderer) =>
    r.root.findAll((n) => n.type === 'button' && n.props['aria-label'] === 'K 棒讀值')[0]!;
const move = async (time: number | undefined) => {
    for (const h of crosshairHandlers) h(time === undefined ? { point: undefined, time: undefined, seriesData: new Map() } : { point: { x: 10, y: 10 }, time, seriesData: new Map() });
    await frame();
};

// 1 分 K（時間標籤＝收盤時刻），5 分 K 聚合後：09:05 / 09:10 / 09:15 三根
const DATA = kbars([['2026-10-08T09:00:00', '2026-10-08T09:15:00', (t) => 20000 + (t - wall('2026-10-08T09:00:00')) / 60]]);

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
    crosshairHandlers.length = 0;
    quote = undefined;
    fetchMock.mockReset();
});
afterEach(() => {
    for (const m of mounted.splice(0)) act(() => m.unmount());
    listeners.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('CandleChart K 棒讀值（#240）', () => {
    it('預設顯示最新一根；游標移到某根顯示那根；離開回最新', async () => {
        setNow('2026-10-08T09:16:00');
        fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: fut });
        await flush();
        const bars = created.filter((c) => c.kind === 'Candlestick').at(-1)!.last as any[];
        expect(bars.length).toBe(3);
        const [first, second, last] = bars;
        // 最新一根
        expect(text(field(r, 'close'))).toBe(`收${last.close.toLocaleString('en-US')}`);
        expect(text(field(r, 'high'))).toBe(`高${last.high.toLocaleString('en-US')}`);
        expect(text(field(r, 'low'))).toBe(`低${last.low.toLocaleString('en-US')}`);
        // 游標移到第二根
        await move(second.time);
        expect(text(field(r, 'close'))).toBe(`收${second.close.toLocaleString('en-US')}`);
        expect(text(field(r, 'open'))).toBe(`開${second.open.toLocaleString('en-US')}`);
        expect(text(field(r, 'change'))).toContain(`+${second.close - first.close}`);
        // 游標離開
        await move(undefined);
        expect(text(field(r, 'close'))).toBe(`收${last.close.toLocaleString('en-US')}`);
    });

    it('tick 更新最新一根的收盤與高低', async () => {
        setNow('2026-10-08T09:14:00');
        fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: fut });
        await flush();
        quote = { tick: { code: 'TXFR1', date: '2026-10-08', time: '09:14:30', close: 20100, volume: 2 }, seq: 1, lastDir: 0, flashSeq: 0 };
        act(() => listeners.forEach((l) => l()));
        await flush();
        expect(text(field(r, 'close'))).toBe('收20,100');
        expect(text(field(r, 'high'))).toBe('高20,100');
    });

    it('股票依跳動價位顯示小數（2330 千元以上整數）', async () => {
        setNow('2026-10-08T09:16:00');
        fetchMock.mockResolvedValue(kbars([['2026-10-08T09:00:00', '2026-10-08T09:05:00', () => 1085]]));
        const r = mount({ contract: stk });
        await flush();
        expect(text(field(r, 'close'))).toBe('收1,085');
    });

    it('指數固定兩位小數', async () => {
        setNow('2026-10-08T09:16:00');
        fetchMock.mockResolvedValue(kbars([['2026-10-08T09:00:00', '2026-10-08T09:05:00', () => 49313.44]]));
        const r = mount({ contract: { code: '001', security_type: 'IND', exchange: 'TSE', target_code: null } });
        await flush();
        expect(text(field(r, 'close'))).toBe('收49,313.44');
    });

    it('面板設定：開關呼叫 onShowOhlcChange，受控關閉時不顯示', async () => {
        setNow('2026-10-08T09:16:00');
        fetchMock.mockResolvedValue(DATA);
        let shown: boolean | undefined;
        const onShowOhlcChange = (v: boolean) => (shown = v);
        const r = mount({ contract: fut, showOhlc: true, onShowOhlcChange });
        await flush();
        expect(toggle(r).props['aria-pressed']).toBe(true);
        act(() => toggle(r).props.onClick());
        expect(shown).toBe(false);
        act(() => r.update(createElement(CandleChart, { contract: fut, showOhlc: false, onShowOhlcChange } as any)));
        await flush();
        expect(field(r, 'row')).toBeUndefined();
        expect(toggle(r).props['aria-pressed']).toBe(false);
    });

    it('彈出視窗（不受控）：開關在元件內切換', async () => {
        setNow('2026-10-08T09:16:00');
        fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: fut });
        await flush();
        expect(field(r, 'row')).toBeDefined();
        act(() => toggle(r).props.onClick());
        expect(field(r, 'row')).toBeUndefined();
    });
});
