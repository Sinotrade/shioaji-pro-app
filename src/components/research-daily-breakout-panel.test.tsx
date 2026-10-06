import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ContractInfo } from '../lib/types/contract';
import type { Candle } from '../lib/types/market';
import { ResearchDailyBreakoutPanel } from './research-daily-breakout-panel';

const network = vi.hoisted(() => ({ request: vi.fn(), subscribe: vi.fn() }));
vi.mock('../lib/shioaji', () => ({ getKBars: network.request, getSnapshots: network.request, subscribe: network.subscribe }));
vi.mock('../hooks/use-quote', () => ({ useQuote: network.subscribe }));
vi.mock('./research-daily-breakout-panel.css', () => ({
    root: '', body: '', toolbar: '', title: '', badge: '', controls: '', label: '', control: '', note: '', warning: '', heading: '', subtitle: '', empty: '',
    row: { normal: '', selected: 'selected' }, identity: '', name: '', info: '', numbers: '', metrics: '', metric: '', metricValue: '', chartScroll: '', chart: '', legend: '', trendLegend: '', startLegend: '', exitLegend: '', event: '', eventTitle: '',
    status: { 'warming-up': '', waiting: '', excluded: '', start: '', tracking: '', exit: '', error: '' }, candleUp: '#f00', candleDown: '#0f0',
}));

let renderer: ReactTestRenderer | undefined;
const baseTime = Date.parse('2026-08-01T00:00:00Z') / 1000;
function oscillating(length = 30): Candle[] {
    return Array.from({ length }, (_, i) => {
        const close = 100 + (i % 2 ? -0.5 : 0.5);
        return { time: baseTime + i * 86400, open: close, high: close + 0.3, low: close - 0.3, close, volume: 100 };
    });
}
function append(bars: Candle[], close: number, volume: number): Candle[] {
    return [...bars, { time: bars.at(-1)!.time + 86400, open: 100, high: Math.max(100, close) + 0.3, low: Math.min(100, close) - 0.3, close, volume }];
}
const breakout = (volume = 200) => append(oscillating(), 102, volume);
const row = (code: string, daily: Candle[]) => ({ contract: { code, name: `研究股${code}`, security_type: 'STK', exchange: 'TSE', region: 'TW' } as ContractInfo, daily });
const dataText = () => JSON.stringify(renderer!.toJSON());
const candidates = () => renderer!.root.findAllByType('button').filter(button => button.props['data-candidate'] === true);
const stockRows = () => renderer!.root.findAllByType('button').filter(button => button.props['data-stock-code']);
const mount = async (rows: ReturnType<typeof row>[], loading = false, error: string | null = null, pick = vi.fn()) => {
    await act(async () => { renderer = create(<ResearchDailyBreakoutPanel rows={rows} loading={loading} error={error} onPick={pick} />); });
    return pick;
};
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.clearAllMocks(); });
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; vi.unstubAllGlobals(); });

it('renders empty/loading/error safely with no broker request or owned subscription', async () => {
    await mount([], true, '離線測試');
    expect(dataText()).toContain('日K波段研究');
    expect(dataText()).toContain('僅研究，不下單');
    expect(dataText()).toContain('研究預設，不是截圖原公式');
    expect(dataText()).toContain('有收盤來源證據');
    expect(dataText()).toContain('分鐘聚合／權息未校正');
    expect(dataText()).toContain('尚無已供資料的股票');
    expect(dataText()).toContain('離線測試');
    expect(candidates()).toHaveLength(0);
    expect(network.request).not.toHaveBeenCalled(); expect(network.subscribe).not.toHaveBeenCalled();
});

it('keeps warm-up and overheated rows outside TOP5 without filling missing places', async () => {
    await mount([row('1001', oscillating(10)), row('1002', append(oscillating(), 110, 300))]);
    expect(candidates()).toHaveLength(0);
    expect(dataText()).toContain('資料不足／暖機'); expect(dataText()).toContain('過熱排除');
    expect(dataText()).toContain('單日漲幅 ≥ 9%'); expect(dataText()).toContain('不補滿TOP5');
    expect(renderer!.root.findAllByType('svg')).toHaveLength(1);
});

it('lists only newly started same-date candidates and can select a stock and inspect the SVG', async () => {
    const first = breakout(), second = breakout(250);
    const pick = await mount([row('1001', first), row('1002', second), row('1003', append(first, 102, 100))]);
    // The later tracking row determines the shared newest valid data day.
    expect(candidates()).toHaveLength(0);
    expect(dataText()).toContain('較舊資料，不列TOP5'); expect(dataText()).toContain('研究追蹤中');
    const target = stockRows().find(button => button.props['data-stock-code'] === '1002')!;
    await act(async () => target.props.onClick());
    expect(pick).toHaveBeenCalledWith('1002'); expect(pick).toHaveBeenCalledTimes(1);
    expect(renderer!.root.findByType('svg').props['aria-label']).toContain('1002');
    expect(renderer!.root.findAllByType('polygon').some(polygon => polygon.props['data-research-event'] === 'start')).toBe(true);
    expect(dataText()).toContain('不是成交價');
    expect(renderer!.root.findByType('details').props.open).not.toBe(true);
    await act(async () => renderer!.root.findAllByType('select').find(select => select.props['aria-label'] === '查看股票日K')!.props.onChange({ target: { value: '1003' } }));
    expect(pick).toHaveBeenCalledWith('1003');
    expect(renderer!.root.findByType('svg').props['aria-label']).toContain('1003');
});

it('sorts eligible new starts by volume ratio and never pads the TOP5', async () => {
    await mount([row('1001', breakout(200)), row('1002', breakout(250)), row('1003', oscillating(31))]);
    expect(candidates().map(button => button.props['data-stock-code'])).toEqual(['1002', '1001']);
    expect(candidates()).toHaveLength(2);
    expect(dataText()).toContain('非即時／非最新保證');
});

it('caps TOP5 at five eligible stocks', async () => {
    await mount(Array.from({ length: 7 }, (_, index) => row(`${1000 + index}`, breakout(200 + index * 10))));
    expect(candidates()).toHaveLength(5);
    expect(candidates().map(button => button.props['data-stock-code'])).toEqual(['1006', '1005', '1004', '1003', '1002']);
});

it('shows a zero-volume price-line exit, no candidate and an explicit event breakdown', async () => {
    await mount([row('1001', append(breakout(), 99, 0))]);
    expect(candidates()).toHaveLength(0); expect(dataText()).toContain('破線退出提醒');
    const exit = renderer!.root.findAllByType('div').find(node => node.props['data-event-type'] === 'exit')!;
    expect(exit.findAllByType('div').flatMap(node => node.children).filter(child => typeof child === 'string').join('')).toContain('0.00倍');
    expect(dataText()).toContain('破線基準');
    expect(renderer!.root.findAllByType('polygon').some(polygon => polygon.props['data-research-event'] === 'exit')).toBe(true);
});

it('compares SMA/EMA and volume settings locally and labels recomputed tracking as non-holdings', async () => {
    await mount([row('1001', breakout(175))]);
    expect(candidates()).toHaveLength(1);
    await act(async () => renderer!.root.findAllByType('select').find(select => select.props['aria-label'] === '放量標準')!.props.onChange({ target: { value: '2' } }));
    expect(candidates()).toHaveLength(0);
    await act(async () => renderer!.root.findAllByType('select').find(select => select.props['aria-label'] === '研究趨勢線')!.props.onChange({ target: { value: 'ema' } }));
    expect(dataText()).toContain('EMA20'); expect(dataText()).toContain('非真實持倉');
    expect(dataText()).toContain('SMA20乖離');
    expect(network.request).not.toHaveBeenCalled(); expect(network.subscribe).not.toHaveBeenCalled();
});

it('fails closed for invalid candles while preserving an explicit row error', async () => {
    const invalid = oscillating(); invalid[5] = { ...invalid[5]!, volume: -1 };
    await mount([row('1001', invalid)]);
    expect(candidates()).toHaveLength(0); expect(dataText()).toContain('資料異常'); expect(dataText()).toContain('價量資料無效');
    expect(renderer!.root.findAllByType('svg')).toHaveLength(0);
});
