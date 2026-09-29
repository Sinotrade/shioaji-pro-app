import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { IChartApi, ISeriesApi, MouseEventParams } from 'lightweight-charts';
import { ResearchFibonacci } from './research-fibonacci';
vi.mock('./research-fibonacci.css', () => ({ root: '', row: '', button: '', message: '', summary: '', summaryHint: '' }));
let root: ReactTestRenderer;
let click: (event: MouseEventParams) => void;
let store: Map<string, string>;
const capture = { current: false };
const detach = vi.fn();
const chart = { subscribeClick: vi.fn(fn => { click = fn; }), unsubscribeClick: vi.fn() } as unknown as IChartApi;
const series = { coordinateToPrice: (y: number) => y, attachPrimitive: vi.fn(), detachPrimitive: detach } as unknown as ISeriesApi<'Candlestick'>;
const bars = [
    { time: 100, open: 101, close: 105, high: 110, low: 100, volume: 10 },
    { time: 200, open: 195, close: 199, high: 200, low: 190, volume: 20 },
];
beforeEach(() => {
    store = new Map(); capture.current = false;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k), setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
});
afterEach(async () => { if (root) await act(async () => root.unmount()); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const render = (key = 'one', data = bars) => <ResearchFibonacci key={key} storageKey={key} chart={chart} series={series} bars={data} capture={capture} />;
const press = async (text: string) => act(async () => root.root.findAllByType('button').find(b => b.children.includes(text))!.props.onClick());
const point = async (time: number, y: number, paneIndex = 0) => act(async () => click({ time, point: { x: 5, y }, paneIndex } as MouseEventParams));
it('draws, freezes prices, hides, cancels replacement, clears and detaches', async () => {
    await act(async () => { root = create(render()); });
    await press('手動畫線'); expect(capture.current).toBe(true);
    await point(100, 101); await point(200, 199);
    expect(capture.current).toBe(false);
    expect(JSON.parse(store.get('one')!)).toEqual({ start: { time: 100, price: 100 }, end: { time: 200, price: 200 } });
    expect(JSON.stringify(root.toJSON())).toContain('161.8');
    await act(async () => root.update(render('one', bars.map(b => ({ ...b, high: b.high + 500 })))));
    expect(JSON.stringify(root.toJSON())).toContain('161.8');
    await press('隱藏回撤線'); expect(JSON.stringify(root.toJSON())).toContain('顯示回撤線');
    await press('重新畫線'); await point(100, 101); await press('取消');
    expect(store.has('one')).toBe(true);
    await press('清除'); expect(store.has('one')).toBe(false); expect(detach).toHaveBeenCalled();
});
it('rejects other panes, absent bars and reverse time; scopes stored data by key', async () => {
    await act(async () => { root = create(render()); });
    await press('手動畫線'); await point(100, 101, 1); await point(300, 101);
    expect(store.has('one')).toBe(false);
    await point(200, 199); await point(100, 101);
    expect(JSON.stringify(root.toJSON())).toContain('終點需晚於起點');
    await act(async () => root.update(render('two')));
    expect(capture.current).toBe(false);
    expect(JSON.stringify(root.toJSON())).toContain('手動畫線');
});
it('closing the tool cancels point capture without deleting a saved drawing', async () => {
    await act(async () => { root = create(render()); });
    await press('手動畫線'); await point(100, 101); await point(200, 199);
    const saved = store.get('one');
    await press('重新畫線'); await point(100, 101);
    expect(capture.current).toBe(true);
    await act(async () => root.root.findByType('details').props.onToggle({ currentTarget: { open: false } }));
    expect(capture.current).toBe(false);
    expect(store.get('one')).toBe(saved);
    await point(200, 199);
    expect(store.get('one')).toBe(saved);
});
