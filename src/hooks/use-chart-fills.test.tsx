// useChartFills 生命週期：圖層掛載／卸載、owner 先移除圖表、StrictMode、游標命中與分組更新
import { createElement, StrictMode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChartFill, ProjectionCache } from '../lib/chart-fills';

const m = vi.hoisted(() => ({ fills: [] as unknown[], unplaced: [] as unknown[], calls: [] as any[], caches: [] as ProjectionCache[], missing: false, missingCalls: [] as any[], missingCaches: [] as (ProjectionCache | undefined)[], cost: 0, now: 0 }));
// 換月月份（rolloverCodes）、priceKey 用真的；投影與明細檢查換成記錄參數
vi.mock('../lib/chart-fills', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/chart-fills')>()),
    // cost：模擬一次投影花的時間（配合 performance.now 的替身）
    projectChartFills: (input: unknown, cache: ProjectionCache) => { m.calls.push(input); m.caches.push(cache); m.now += m.cost; return { fills: m.fills, unplaced: m.unplaced }; },
    missingDeals: (input: unknown, cache?: ProjectionCache) => { m.missingCalls.push(input); m.missingCaches.push(cache); return m.missing; },
}));
const cc = vi.hoisted(() => ({ cached: new Map<string, unknown>(), get: vi.fn(), ensure: vi.fn() }));
vi.mock('../lib/contracts-cache', () => ({
    getCachedContract: (code: string) => { cc.get(code); return cc.cached.get(code); },
    ensureContract: (...args: unknown[]) => cc.ensure(...args),
}));

import { priceKey } from '../lib/chart-fills';
import { FillMarksLayer, type FillMarkShape, type FillMarkStyle } from '../lib/chart-fill-marks';
import { useChartFills } from './use-chart-fills';
import { ChartFillDetails } from '../components/chart-fill-details';

const fill = (id: string, time: number, price: number, action: 'Buy' | 'Sell', more: Partial<ChartFill> = {}): ChartFill =>
    ({ id, time, ts: time, price, quantity: 1, unit: '口', action, code: 'TXFJ6', account: ACCOUNT, ...more });
// 分組鍵：商品｜K 棒｜方向｜整數價格｜單位
const K = (time: number, action: 'Buy' | 'Sell', price: number, unit = '口', code = 'TXFJ6') => `${code}|${time}|${action}|${priceKey(price)}|${unit}`;

function fakes() {
    const handlers: ((event: unknown) => void)[] = [];
    const chart = {
        subscribeCrosshairMove: vi.fn((fn: (event: unknown) => void) => { handlers.push(fn); }),
        unsubscribeCrosshairMove: vi.fn(),
    };
    const series = { attachPrimitive: vi.fn(), detachPrimitive: vi.fn() };
    return { chart, series, handlers, chartRef: { current: chart as any }, seriesRef: { current: series as any } };
}

// 固定參照：只有 trades／account／dataVersion／visible 等相依改變才會重算成交
const TRADES: never[] = [];
const BARS: never[] = [];
const CONTRACT = { code: 'TXFJ6', security_type: 'FUT', exchange: 'TAIFEX' } as any;
const ACCOUNT = { account_type: 'F', broker_id: 'B', account_id: '1' } as any;
const SIM = 'http://127.0.0.1:21323|simulation';
const PROD = 'http://127.0.0.1:21323|production';
const NO_DECIMALS = () => 0;
let view!: ReturnType<typeof useChartFills>;
let renders = 0;
function Probe({ refs, visible = true, version = 0, trades = TRADES, account = ACCOUNT, accounts, dayOnly = false, colors = ['#f00', '#0f0', '#111'], contract = CONTRACT,
    ready = true, retain = true, env = SIM, style = 'price', shape, minutes = 5, decimals = NO_DECIMALS }: {
    refs: ReturnType<typeof fakes>; visible?: boolean; version?: number; trades?: never[]; account?: unknown; accounts?: unknown[]; dayOnly?: boolean; colors?: string[]; contract?: unknown;
    ready?: boolean; retain?: boolean; env?: string | null; style?: FillMarkStyle; shape?: FillMarkShape; minutes?: number; decimals?: (price: number) => number;
}) {
    renders++;
    view = useChartFills({
        chartRef: refs.chartRef, seriesRef: refs.seriesRef, trades, contract: contract as any, account: account as any, accounts: accounts as any,
        bars: BARS, dataVersion: version, minutes, dayOnly, visible, ready, retain, env,
        context: 'ctx', style, shape, priceDecimals: decimals, up: colors[0]!, down: colors[1]!, labelBg: colors[2]!,
    });
    return null;
}

const mounted: ReactTestRenderer[] = [];
function mount(element: Parameters<typeof create>[0]) {
    let r!: ReactTestRenderer;
    act(() => { r = create(element); });
    mounted.push(r);
    return r;
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    m.fills = [];
    m.unplaced = [];
    m.calls = [];
    m.caches = [];
    m.missing = false;
    m.missingCalls = [];
    m.missingCaches = [];
    cc.cached.clear();
    cc.get.mockReset();
    cc.ensure.mockReset();
    renders = 0;
});
afterEach(() => {
    for (const r of mounted.splice(0)) act(() => r.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

it('掛載時掛上圖層並訂閱游標各一次；卸載時各解除一次', () => {
    const refs = fakes();
    const r = mount(createElement(Probe, { refs }));
    expect(refs.series.attachPrimitive).toHaveBeenCalledTimes(1);
    const layer = refs.series.attachPrimitive.mock.calls[0]![0];
    expect(layer).toBeInstanceOf(FillMarksLayer);
    expect(refs.chart.subscribeCrosshairMove).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
    expect(refs.series.detachPrimitive).toHaveBeenCalledTimes(1);
    expect(refs.series.detachPrimitive).toHaveBeenCalledWith(layer);
    expect(refs.chart.unsubscribeCrosshairMove).toHaveBeenCalledTimes(1);
    expect(refs.chart.unsubscribeCrosshairMove).toHaveBeenCalledWith(refs.handlers[0]);
});

it('owner 已先移除圖表（chartRef 為 null）時，卸載不碰舊圖表也不拋錯', () => {
    const refs = fakes();
    const r = mount(createElement(Probe, { refs }));
    refs.chartRef.current = null;
    expect(() => act(() => r.unmount())).not.toThrow();
    expect(refs.series.detachPrimitive).not.toHaveBeenCalled();
    expect(refs.chart.unsubscribeCrosshairMove).not.toHaveBeenCalled();
});

it('StrictMode 掛載→清理→再掛載：只留新建的圖層在作用中', () => {
    const setGroups = vi.spyOn(FillMarksLayer.prototype, 'setGroups');
    const hitAt = vi.spyOn(FillMarksLayer.prototype, 'hitAt');
    m.fills = [fill('1', 600, 100, 'Buy')];
    const refs = fakes();
    mount(createElement(StrictMode, null, createElement(Probe, { refs })));
    const attached = refs.series.attachPrimitive.mock.calls.map((c) => c[0]);
    const detached = refs.series.detachPrimitive.mock.calls.map((c) => c[0]);
    expect(attached.length).toBeGreaterThan(1); // StrictMode 確實重跑了 effect
    expect(attached.length).toBe(detached.length + 1);
    const active = attached.at(-1);
    expect(detached).not.toContain(active);
    expect(refs.chart.unsubscribeCrosshairMove.mock.calls.map((c) => c[0])).toEqual(refs.handlers.slice(0, -1));
    // 作用中的圖層收到最新分組，游標回呼也走它
    expect(setGroups.mock.contexts.at(-1)).toBe(active);
    act(() => refs.handlers.at(-1)!({ point: { x: 1, y: 2 }, time: 600, paneIndex: 0 }));
    expect(hitAt.mock.contexts.at(-1)).toBe(active);
});

it('游標回呼以座標與 K 棒時間呼叫 hitAt；不在主圖或沒有 point 時不呼叫並清除 hover', () => {
    m.fills = [fill('1', 600, 100, 'Buy'), fill('2', 600, 101, 'Sell')];
    const hitAt = vi.spyOn(FillMarksLayer.prototype, 'hitAt').mockReturnValue(K(600, 'Sell', 101));
    const refs = fakes();
    mount(createElement(Probe, { refs }));
    const fire = (event: unknown) => act(() => refs.handlers[0]!(event));
    fire({ point: { x: 3, y: 4 }, time: 600, paneIndex: 0 });
    expect(hitAt).toHaveBeenLastCalledWith(3, 4, 600);
    expect(view.hoveredFills.map((f) => f.id)).toEqual(['2', '1']); // 滑到的那組在前
    fire({ point: { x: 3, y: 4 }, time: 600, paneIndex: 1 });
    expect(hitAt).toHaveBeenCalledTimes(1);
    expect(view.hoveredFills).toEqual([]);
    fire({ point: { x: 3, y: 4 }, time: 600 }); // 沒帶 paneIndex 視為主圖
    expect(hitAt).toHaveBeenCalledTimes(2);
    expect(view.hoveredFills).toHaveLength(2);
    fire({ point: undefined, time: undefined });
    expect(hitAt).toHaveBeenCalledTimes(2);
    expect(view.hoveredFills).toEqual([]);
    fire({ point: { x: 3, y: 4 }, time: { year: 2026, month: 10, day: 8 } }); // 非數字時間不當 K 棒時間
    expect(hitAt).toHaveBeenLastCalledWith(3, 4, undefined);
});

it('成交改變時以新分組呼叫 setGroups；隱藏時收到空陣列', () => {
    const setGroups = vi.spyOn(FillMarksLayer.prototype, 'setGroups');
    m.fills = [fill('1', 600, 100, 'Buy'), fill('2', 600, 100, 'Buy'), fill('3', 600, 101, 'Sell')];
    const refs = fakes();
    const r = mount(createElement(Probe, { refs }));
    expect(setGroups).toHaveBeenCalledTimes(1);
    expect(setGroups.mock.lastCall![0]).toEqual([
        expect.objectContaining({ key: K(600, 'Buy', 100), time: 600, price: 100, action: 'Buy', text: '100 2口' }),
        expect.objectContaining({ key: K(600, 'Sell', 101), time: 600, price: 101, action: 'Sell', text: '101' }),
    ]);
    act(() => r.update(createElement(Probe, { refs })));
    expect(setGroups).toHaveBeenCalledTimes(1); // 成交沒變不重設
    m.fills = [fill('4', 900, 99, 'Sell')];
    act(() => r.update(createElement(Probe, { refs, version: 1 })));
    expect(setGroups).toHaveBeenCalledTimes(2);
    expect(setGroups.mock.lastCall![0]).toEqual([expect.objectContaining({ key: K(900, 'Sell', 99), time: 900, price: 99, action: 'Sell' })]);
    act(() => r.update(createElement(Probe, { refs, version: 1, visible: false })));
    expect(setGroups).toHaveBeenCalledTimes(3);
    expect(setGroups.mock.lastCall![0]).toEqual([]);
});

it('成交投影的相依：只換 trades、只換 account 或 dayOnly 都會重算，並把當下的參數交給 projectChartFills', () => {
    const setGroups = vi.spyOn(FillMarksLayer.prototype, 'setGroups');
    m.fills = [fill('1', 600, 100, 'Buy')];
    const refs = fakes();
    const r = mount(createElement(Probe, { refs }));
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]).toMatchObject({ trades: TRADES, account: ACCOUNT, dayOnly: false, minutes: 5, contract: CONTRACT });
    // 新成交回報：trades 換新陣列，K 棒（dataVersion）完全沒動
    const next = [] as never[];
    m.fills = [fill('1', 600, 100, 'Buy'), fill('2', 900, 101, 'Sell')];
    act(() => r.update(createElement(Probe, { refs, trades: next })));
    expect(m.calls).toHaveLength(2);
    expect(m.calls[1].trades).toBe(next);
    expect(setGroups.mock.lastCall![0]).toHaveLength(2);
    // 切換圖表帳戶
    const other = { account_type: 'F', broker_id: 'B', account_id: '2' };
    act(() => r.update(createElement(Probe, { refs, trades: next, account: other })));
    expect(m.calls).toHaveLength(3);
    expect(m.calls[2].account).toBe(other);
    // 僅日盤
    act(() => r.update(createElement(Probe, { refs, trades: next, account: other, dayOnly: true })));
    expect(m.calls).toHaveLength(4);
    expect(m.calls[3].dayOnly).toBe(true);
});

it('換主題色時圖層用新的顏色重新上色', () => {
    const setStyle = vi.spyOn(FillMarksLayer.prototype, 'setStyle');
    const refs = fakes();
    const r = mount(createElement(Probe, { refs }));
    expect(setStyle.mock.lastCall![0]).toEqual({ up: '#f00', down: '#0f0', labelBg: '#111', style: 'price', shape: 'triangle' });
    act(() => r.update(createElement(Probe, { refs, colors: ['#00f', '#ff0', '#eee'] })));
    expect(setStyle.mock.lastCall![0]).toEqual({ up: '#00f', down: '#ff0', labelBg: '#eee', style: 'price', shape: 'triangle' });
});

it('形狀交給圖層：沒傳就是三角形；換形狀時圖層收到新的 shape，分組（位置與字串）不重算', () => {
    const setStyle = vi.spyOn(FillMarksLayer.prototype, 'setStyle');
    const setGroups = vi.spyOn(FillMarksLayer.prototype, 'setGroups');
    m.fills = [fill('1', 600, 100, 'Buy'), fill('2', 900, 101, 'Sell')];
    const refs = fakes();
    const r = mount(createElement(Probe, { refs }));
    expect(setStyle.mock.lastCall![0]).toMatchObject({ shape: 'triangle' });
    const groupCalls = setGroups.mock.calls.length;
    const projections = m.calls.length;
    for (const shape of ['arrow', 'circle', 'diamond', 'triangle'] as const) {
        act(() => r.update(createElement(Probe, { refs, shape })));
        expect(setStyle.mock.lastCall![0]).toEqual({ up: '#f00', down: '#0f0', labelBg: '#111', style: 'price', shape });
    }
    // 形狀只影響怎麼畫：不重新投影成交，也不重送分組
    expect(m.calls.length).toBe(projections);
    expect(setGroups.mock.calls.length).toBe(groupCalls);
});

it('游標停在同一組上不會重繪；換到另一組才會', () => {
    m.fills = [fill('1', 600, 100, 'Buy'), fill('2', 600, 101, 'Sell')];
    const hitAt = vi.spyOn(FillMarksLayer.prototype, 'hitAt').mockReturnValue(K(600, 'Buy', 100));
    const refs = fakes();
    mount(createElement(Probe, { refs }));
    const fire = () => act(() => refs.handlers[0]!({ point: { x: 3, y: 4 }, time: 600, paneIndex: 0 }));
    fire();
    const after = renders;
    for (let i = 0; i < 6; i++) fire(); // React 可能為同值的 setState 多渲染一次，但不會每次游標移動都重繪
    expect(renders).toBeLessThanOrEqual(after + 1);
    expect(view.hoveredFills.map((f) => f.id)).toEqual(['1', '2']);
    hitAt.mockReturnValue(K(600, 'Sell', 101));
    const before = renders;
    fire();
    expect(renders).toBeGreaterThan(before);
    expect(view.hoveredFills.map((f) => f.id)).toEqual(['2', '1']);
});

// 近月 TXFR1 已換到 11 月（TXFK6）：換月前 TXFR1 指的是 10 月（TXFJ6），10 月到期日 13:30 是分界
const ALIAS = { code: 'TXFR1', security_type: 'FUT', exchange: 'TAIFEX', target_code: 'TXFK6' } as any;
const OCT = { code: 'TXFJ6', security_type: 'FUT', last_trading_date: '2026-10-21' };
const OCT_CUTOFF = Date.parse('2026-10-21T13:30:00+08:00') / 1000;
// 今天的委託裡有換月掉的那個合約（只有換月日才會有；委託清單只放當日）
const ON = (code: string) => [{ contract: { code, security_type: 'FUT', exchange: 'TAIFEX', target_code: '' } }] as never[];
const ROLLED = ON('TXFJ6');
const deferred = () => {
    let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
    const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    return { promise, resolve, reject };
};

it('連續月別名：快取有近月就直接用，不另外查；分界是近月最後交易日 13:30（Unix 秒），交給成交投影與明細檢查', () => {
    cc.cached.set('TXFJ6', OCT);
    mount(createElement(Probe, { refs: fakes(), contract: ALIAS, trades: ROLLED }));
    expect(cc.get).toHaveBeenCalledWith('TXFJ6');
    expect(cc.ensure).not.toHaveBeenCalled();
    // 第一次投影就帶分界，不會先用舊行為畫一次
    expect(m.calls[0].rollover).toEqual({ previous: 'TXFJ6', cutoff: OCT_CUTOFF });
    expect(m.missingCalls.at(-1)).toMatchObject({ trades: ROLLED, contract: ALIAS, account: ACCOUNT, rollover: { previous: 'TXFJ6', cutoff: OCT_CUTOFF } });
});

it('快取沒有近月：以 FUT 查詢，查到前與查詢失敗都退回舊行為（rollover 為 null）', async () => {
    const lookup = deferred();
    cc.ensure.mockReturnValue(lookup.promise);
    mount(createElement(Probe, { refs: fakes(), contract: ALIAS, trades: ROLLED }));
    expect(cc.ensure).toHaveBeenCalledWith('TXFJ6', 'FUT');
    expect(m.calls.at(-1).rollover).toBeNull();
    await act(async () => lookup.resolve(OCT));
    expect(m.calls.at(-1).rollover).toEqual({ previous: 'TXFJ6', cutoff: OCT_CUTOFF });
    // 另一個別名查詢失敗、或查到的合約沒有最後交易日：都沒有分界
    cc.ensure.mockRejectedValueOnce(new Error('404'));
    mount(createElement(Probe, { refs: fakes(), contract: { ...ALIAS, code: 'MXFR1', target_code: 'MXFK6' }, trades: ON('MXFJ6') }));
    await act(async () => {});
    expect(cc.ensure).toHaveBeenLastCalledWith('MXFJ6', 'FUT');
    expect(m.calls.at(-1).rollover).toBeNull();
    cc.ensure.mockResolvedValueOnce({ code: 'TMFJ6', security_type: 'FUT' });
    mount(createElement(Probe, { refs: fakes(), contract: { ...ALIAS, code: 'TMFR1', target_code: 'TMFK6' }, trades: ON('TMFJ6') }));
    await act(async () => {});
    expect(m.calls.at(-1).rollover).toBeNull();
});

it('不是連續月別名（真實月份、股票）或成交隱藏時不查合約', () => {
    mount(createElement(Probe, { refs: fakes() })); // TXFJ6
    mount(createElement(Probe, { refs: fakes(), contract: { code: '2330', security_type: 'STK', exchange: 'TSE', target_code: null } }));
    mount(createElement(Probe, { refs: fakes(), contract: ALIAS, visible: false }));
    expect(cc.get).not.toHaveBeenCalled();
    expect(cc.ensure).not.toHaveBeenCalled();
    expect(m.missingCalls.every((input) => input.rollover === null)).toBe(true);
});

it('今天沒有這張圖月份的委託：連續月別名不查合約、不讀快取，rollover 為 null', () => {
    cc.cached.set('TXFJ6', OCT);
    mount(createElement(Probe, { refs: fakes(), contract: ALIAS, trades: ON('MXFK6') }));
    mount(createElement(Probe, { refs: fakes(), contract: ALIAS }));
    expect(cc.get).not.toHaveBeenCalled();
    expect(cc.ensure).not.toHaveBeenCalled();
    expect(m.calls.every((input) => input.rollover === null)).toBe(true);
});

it('只有現在月份或換月前月份的委託也會分界（R1 只做 K6；R2 只做換月前的 K6）', () => {
    cc.cached.set('TXFJ6', OCT);
    mount(createElement(Probe, { refs: fakes(), contract: ALIAS, trades: ON('TXFK6') }));
    expect(m.calls.at(-1).rollover).toEqual({ previous: 'TXFJ6', cutoff: OCT_CUTOFF });
    mount(createElement(Probe, { refs: fakes(), contract: { ...ALIAS, code: 'TXFR2', target_code: 'TXFL6' }, trades: ON('TXFK6') }));
    expect(m.calls.at(-1).rollover).toEqual({ previous: 'TXFK6', cutoff: OCT_CUTOFF });
});

it('查不到最後交易日的近月，同一個工作階段不重查', async () => {
    cc.ensure.mockRejectedValue(new Error('404'));
    const alias = { ...ALIAS, code: 'TEFR1', target_code: 'TEFK6' };
    mount(createElement(Probe, { refs: fakes(), contract: alias, trades: ON('TEFK6') }));
    await act(async () => {});
    mount(createElement(Probe, { refs: fakes(), contract: alias, trades: ON('TEFK6') }));
    await act(async () => {});
    expect(cc.ensure.mock.calls.filter(([code]) => code === 'TEFJ6')).toHaveLength(1);
    expect(m.calls.at(-1).rollover).toBeNull();
});

it('換商品後不沿用上一個別名的分界；查詢中換掉再換回，晚到的舊結果不寫回', async () => {
    cc.ensure.mockResolvedValueOnce(OCT);
    const refs = fakes();
    const r = mount(createElement(Probe, { refs, contract: ALIAS, trades: ROLLED }));
    await act(async () => {});
    expect(m.calls.at(-1).rollover).toEqual({ previous: 'TXFJ6', cutoff: OCT_CUTOFF });
    act(() => r.update(createElement(Probe, { refs })));
    expect(m.calls.at(-1).rollover).toBeNull();
    // 查詢中切走又切回：第一次查詢的結果晚到，只認第二次
    const first = deferred();
    const second = deferred();
    cc.ensure.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    act(() => r.update(createElement(Probe, { refs, contract: { ...ALIAS, code: 'TXFR2', target_code: 'TXFL6' }, trades: ROLLED })));
    act(() => r.update(createElement(Probe, { refs })));
    act(() => r.update(createElement(Probe, { refs, contract: { ...ALIAS, code: 'TXFR2', target_code: 'TXFL6' }, trades: ROLLED })));
    expect(cc.ensure.mock.calls.slice(-2)).toEqual([['TXFJ6', 'FUT'], ['TXFJ6', 'FUT']]); // 次月別名換月看的也是近月到期
    await act(async () => first.resolve({ ...OCT, last_trading_date: '2026-09-16' }));
    expect(m.calls.at(-1).rollover).toBeNull();
    await act(async () => second.resolve(OCT));
    expect(m.calls.at(-1).rollover).toEqual({ previous: 'TXFK6', cutoff: OCT_CUTOFF });
});

it('成交明細缺漏（incomplete）時當成未就緒：不投影、圖層收到空分組、沒有 hover，並回傳 incomplete', () => {
    const setGroups = vi.spyOn(FillMarksLayer.prototype, 'setGroups');
    vi.spyOn(FillMarksLayer.prototype, 'hitAt').mockReturnValue(K(600, 'Buy', 100));
    m.fills = [fill('1', 600, 100, 'Buy')];
    m.missing = true;
    const refs = fakes();
    const r = mount(createElement(Probe, { refs }));
    expect(view.incomplete).toBe(true);
    expect(m.calls).toHaveLength(0);
    expect(setGroups.mock.lastCall![0]).toEqual([]);
    act(() => refs.handlers[0]!({ point: { x: 3, y: 4 }, time: 600, paneIndex: 0 }));
    expect(view.hoveredFills).toEqual([]);
    // 明細讀齊（新的 trades）後恢復
    m.missing = false;
    act(() => r.update(createElement(Probe, { refs, trades: [] as never[] })));
    expect(view.incomplete).toBe(false);
    expect(setGroups.mock.lastCall![0]).toHaveLength(1);
});

// 顯示組鍵：同商品｜K 棒｜方向｜單位（跨價位）
const R = (time: number, action: 'Buy' | 'Sell', unit = '口', code = 'TXFJ6') => `range:${code}|${time}|${action}|${unit}`;
it('分組：每價分組（同價不同 seq 合計、0.1+0.2 與 0.3 同一價）交給滑過；圖層收顯示組（同棒同方向同單位同月份跨價位，單一價位就是原本的每價分組）', () => {
    const setGroups = vi.spyOn(FillMarksLayer.prototype, 'setGroups');
    vi.spyOn(FillMarksLayer.prototype, 'hitAt').mockReturnValue(K(600, 'Buy', 0.3));
    m.fills = [
        fill('1', 600, 100, 'Buy'), fill('2', 600, 100, 'Buy', { quantity: 2 }), // 同價同秒不同 seq：兩筆、合計 3 口
        fill('3', 600, 100, 'Buy', { code: 'TXFK6' }), // 換月日的另一個月份
        fill('4', 600, 12.5, 'Sell', { unit: '張' }), fill('5', 600, 12.5, 'Sell', { unit: '股', quantity: 87 }),
        fill('6', 600, 13, 'Sell', { unit: '張' }),
        fill('7', 600, 0.1 + 0.2, 'Buy'), fill('8', 600, 0.3, 'Buy'),
    ];
    const refs = fakes();
    mount(createElement(Probe, { refs }));
    expect(setGroups.mock.lastCall![0].map((g: any) => [g.key, g.price, g.text, g.members?.map((m: any) => m.key)])).toEqual([
        // 買 100×3 與 0.3×2：三角形在最低買價、均價 (100×3＋0.3×2)÷5＝60.12
        [R(600, 'Buy'), 0.1 + 0.2, '均 60.1 5口', [K(600, 'Buy', 0.3), K(600, 'Buy', 100)]],
        [K(600, 'Buy', 100, '口', 'TXFK6'), 100, '100', undefined],
        // 賣 12.5 張與 13 張：三角形在最高賣價、均價 12.75
        [R(600, 'Sell', '張'), 13, '均 12.8 2張', [K(600, 'Sell', 12.5, '張'), K(600, 'Sell', 13, '張')]],
        [K(600, 'Sell', 12.5, '股'), 12.5, '12.5 87股', undefined],
    ]);
    // 滑到 0.3 那條刻度：那個價位的兩筆排最前
    act(() => refs.handlers[0]!({ point: { x: 3, y: 4 }, time: 600, paneIndex: 0 }));
    expect(view.hoveredFills.map((f) => f.id)).toEqual(['7', '8', '1', '2', '3', '4', '5', '6']);
});

// 使用者截圖那根：19 筆買、22 口、9 個價位
const SHOT: [number, number[]][] = [[46474, [1]], [46459, [1, 1, 1, 1, 1]], [46471, [1, 2]], [46467, [1, 3, 1]], [46464, [1]],
    [46465, [1, 1, 1]], [46463, [1]], [46460, [1, 1]], [46458, [1]]];
const shotFills = (action: 'Buy' | 'Sell' = 'Buy') => SHOT.flatMap(([price, qs], i) => qs.map((quantity, j) => fill(`${action}${i}-${j}`, 600, price, action, { quantity })));
it('截圖情境：一根 9 個價位合成一組——三角形在最低買價、均價標籤、members 依價格；下一根單價照舊；三種樣式', () => {
    const setGroups = vi.spyOn(FillMarksLayer.prototype, 'setGroups');
    m.fills = [...shotFills(), fill('next', 900, 46454, 'Buy')];
    const refs = fakes();
    const r = mount(createElement(Probe, { refs }));
    const [bundle, next] = setGroups.mock.lastCall![0] as any[];
    expect(bundle).toMatchObject({ key: R(600, 'Buy'), time: 600, price: 46458, action: 'Buy', text: '均 46,464.4 22口' });
    expect(bundle.labelPrice).toBeCloseTo(46464 + 9 / 22, 6); // (Σ價×量)÷22
    expect(bundle.members.map((m: any) => m.price)).toEqual([46458, 46459, 46460, 46463, 46464, 46465, 46467, 46471, 46474]);
    expect(bundle.members.map((m: any) => m.key)).toEqual(bundle.members.map((m: any) => K(600, 'Buy', m.price)));
    expect(next).toMatchObject({ key: K(900, 'Buy', 46454), price: 46454, text: '46,454' });
    expect(next.members).toBeUndefined();
    act(() => r.update(createElement(Probe, { refs, style: 'side' })));
    expect(setGroups.mock.lastCall![0].map((g: any) => g.text)).toEqual(['買 22口', '買']);
    act(() => r.update(createElement(Probe, { refs, style: 'dot' })));
    expect(setGroups.mock.lastCall![0].map((g: any) => g.text)).toEqual([null, null]);
});

it('多價位的賣：三角形在最高賣價；均價位數＝圖表位數、最多多 1 位，整數不補 0', () => {
    const setGroups = vi.spyOn(FillMarksLayer.prototype, 'setGroups');
    m.fills = [fill('1', 600, 46470, 'Sell', { quantity: 2 }), fill('2', 600, 46476, 'Sell'), fill('3', 900, 31.5, 'Sell'), fill('4', 900, 31.55, 'Sell', { quantity: 2 })];
    mount(createElement(Probe, { refs: fakes(), decimals: (price: number) => (price < 100 ? 2 : 0) }));
    expect(setGroups.mock.lastCall![0].map((g: any) => [g.price, g.text])).toEqual([
        [46476, '均 46,472 3口'], // (46470×2＋46476)÷3＝46472 整數
        [31.55, '均 31.533 3口'], // (31.5＋31.55×2)÷3＝31.5333… → 2＋1 位
    ]);
});

it('錨點穩定：同一根再成交區間內的價，三角形不動、只換均價；創新低才移到新的最低買價', () => {
    const setGroups = vi.spyOn(FillMarksLayer.prototype, 'setGroups');
    m.fills = shotFills();
    const refs = fakes();
    const r = mount(createElement(Probe, { refs }));
    expect(setGroups.mock.lastCall![0][0]!.price).toBe(46458);
    m.fills = [...shotFills(), fill('mid', 600, 46466, 'Buy')];
    act(() => r.update(createElement(Probe, { refs, trades: [] as never[] })));
    expect(setGroups.mock.lastCall![0][0]).toMatchObject({ price: 46458, text: '均 46,464.5 23口' });
    m.fills = [...shotFills(), fill('low', 600, 46450, 'Buy')];
    act(() => r.update(createElement(Probe, { refs, trades: [{}] as never[] })));
    expect(setGroups.mock.lastCall![0][0]!.price).toBe(46450);
});

it('標籤字串依樣式：dot 沒有字、side 買賣（多於 1 加數量）、price 價位最少取圖表位數、最多 8 位、不截小數；切樣式時圖層同時收到 style', () => {
    const setGroups = vi.spyOn(FillMarksLayer.prototype, 'setGroups');
    const setStyle = vi.spyOn(FillMarksLayer.prototype, 'setStyle');
    m.fills = [
        fill('1', 600, 46459, 'Buy'), fill('2', 600, 46459, 'Buy', { quantity: 2 }),
        fill('3', 900, 49.5, 'Sell'), fill('4', 900, 1.5, 'Sell', { quantity: 1000, unit: '股' }),
        fill('5', 1200, 1.123456789, 'Buy'), fill('6', 1500, 2, 'Buy'), // 不同根：各自是單價組
    ];
    const decimals = (price: number) => price === 1.5 ? 2 : price === 2 ? 12 : 0;
    const refs = fakes();
    const r = mount(createElement(Probe, { refs, decimals }));
    const texts = () => setGroups.mock.lastCall![0].map((g: any) => g.text);
    expect(texts()).toEqual(['46,459 3口', '49.5', '1.50 1,000股', '1.12345679', '2.00000000']);
    act(() => r.update(createElement(Probe, { refs, decimals, style: 'side' })));
    expect(texts()).toEqual(['買 3口', '賣', '賣 1,000股', '買', '買']);
    expect(setStyle.mock.lastCall![0]).toMatchObject({ style: 'side' });
    act(() => r.update(createElement(Probe, { refs, decimals, style: 'dot' })));
    expect(texts()).toEqual([null, null, null, null, null]);
    expect(setStyle.mock.lastCall![0]).toMatchObject({ style: 'dot' });
});

it('hover 依分組鍵：同棒同價同方向但不同單位是另一組，排在滑到的那組後面', () => {
    m.fills = [fill('1', 600, 100, 'Buy', { unit: '股' }), fill('2', 600, 100, 'Buy', { unit: '張' }), fill('3', 600, 100, 'Buy', { unit: '張' })];
    vi.spyOn(FillMarksLayer.prototype, 'hitAt').mockReturnValue(K(600, 'Buy', 100, '張'));
    const refs = fakes();
    mount(createElement(Probe, { refs }));
    act(() => refs.handlers[0]!({ point: { x: 3, y: 4 }, time: 600, paneIndex: 0 }));
    expect(view.hoveredFills.map((f) => f.id)).toEqual(['2', '3', '1']);
});

it('unplaced 只在確認時傳出；全部帳戶的 accounts 交給投影與明細檢查', () => {
    m.fills = [fill('1', 600, 100, 'Buy')];
    m.unplaced = [fill('2', 1200, 101, 'Buy')];
    const accounts = [ACCOUNT, { ...ACCOUNT, account_id: '2' }];
    const refs = fakes();
    const r = mount(createElement(Probe, { refs, accounts }));
    expect(view.unplaced).toBe(m.unplaced);
    expect(m.calls.at(-1).accounts).toBe(accounts);
    expect(m.missingCalls.at(-1).accounts).toBe(accounts);
    act(() => r.update(createElement(Probe, { refs, accounts, ready: false })));
    expect(view.unplaced).toEqual([]);
    expect(view.fills).toEqual([]);
});

// 待確認時保留
const lastGroups = (setGroups: { mock: { lastCall?: any[] } }) => setGroups.mock.lastCall![0] as any[];
it('確認時交給圖層的分組，待確認時保留成淡色：不可 hover、不列明細、retained；確認後換成新的，隱藏時不畫', () => {
    const setGroups = vi.spyOn(FillMarksLayer.prototype, 'setGroups');
    vi.spyOn(FillMarksLayer.prototype, 'hitAt').mockReturnValue(K(600, 'Buy', 100));
    m.fills = [fill('1', 600, 100, 'Buy')];
    const refs = fakes();
    const r = mount(createElement(Probe, { refs }));
    expect(lastGroups(setGroups)).toEqual([expect.objectContaining({ key: K(600, 'Buy', 100), text: '100' })]);
    expect(lastGroups(setGroups)[0].dimmed).toBeUndefined();
    expect(view.retained).toBe(false);
    act(() => r.update(createElement(Probe, { refs, ready: false })));
    expect(lastGroups(setGroups)).toEqual([expect.objectContaining({ key: K(600, 'Buy', 100), dimmed: true })]);
    expect(view.retained).toBe(true);
    expect(view.fills).toEqual([]);
    act(() => refs.handlers[0]!({ point: { x: 3, y: 4 }, time: 600, paneIndex: 0 }));
    expect(view.hoveredFills).toEqual([]);
    // 明細缺漏也是未確認
    act(() => r.update(createElement(Probe, { refs })));
    m.missing = true;
    act(() => r.update(createElement(Probe, { refs, trades: [] as never[] })));
    expect(lastGroups(setGroups)).toEqual([expect.objectContaining({ dimmed: true })]);
    // 隱藏時不畫保留的分組；只有確認時才寫入保留，所以再打開還在
    act(() => r.update(createElement(Probe, { refs, trades: [] as never[], visible: false })));
    expect(lastGroups(setGroups)).toEqual([]);
    act(() => r.update(createElement(Probe, { refs, trades: [] as never[] })));
    expect(lastGroups(setGroups)).toEqual([expect.objectContaining({ dimmed: true })]);
    // 確認後換成新的成交
    m.missing = false;
    m.fills = [fill('2', 900, 101, 'Sell')];
    act(() => r.update(createElement(Probe, { refs, trades: [] as never[] })));
    expect(lastGroups(setGroups)).toEqual([expect.objectContaining({ key: K(900, 'Sell', 101) })]);
    expect(lastGroups(setGroups)[0].dimmed).toBeUndefined();
    expect(view.retained).toBe(false);
});

it('新掛載的圖表從空開始：待確認時不從 trades 重建，也不沿用另一張圖保留的分組', () => {
    const setGroups = vi.spyOn(FillMarksLayer.prototype, 'setGroups');
    m.fills = [fill('1', 600, 100, 'Buy')];
    const a = fakes();
    const r = mount(createElement(Probe, { refs: a }));
    act(() => r.update(createElement(Probe, { refs: a, ready: false })));
    expect(lastGroups(setGroups)).toHaveLength(1); // 第一張圖保留中
    const calls = m.calls.length;
    mount(createElement(Probe, { refs: fakes(), ready: false }));
    expect(lastGroups(setGroups)).toEqual([]);
    expect(view.retained).toBe(false);
    expect(m.calls).toHaveLength(calls); // 待確認時不投影
});

it('模擬 → 正式 → 模擬：換成另一個已知環境就清空，切回原環境也不復活', () => {
    const setGroups = vi.spyOn(FillMarksLayer.prototype, 'setGroups');
    m.fills = [fill('1', 600, 100, 'Buy')];
    const refs = fakes();
    const r = mount(createElement(Probe, { refs, env: SIM }));
    act(() => r.update(createElement(Probe, { refs, env: PROD, ready: false })));
    expect(lastGroups(setGroups)).toEqual([]);
    act(() => r.update(createElement(Probe, { refs, env: SIM, ready: false })));
    expect(lastGroups(setGroups)).toEqual([]);
    expect(view.retained).toBe(false);
});

it('啟動時環境未知、之後才知道：以後來的已知環境比對，換到另一個環境照樣清空', () => {
    const setGroups = vi.spyOn(FillMarksLayer.prototype, 'setGroups');
    m.fills = [fill('1', 600, 100, 'Buy')];
    const refs = fakes();
    const r = mount(createElement(Probe, { refs, env: null, ready: false }));
    act(() => r.update(createElement(Probe, { refs, env: SIM })));
    act(() => r.update(createElement(Probe, { refs, env: PROD, ready: false })));
    expect(lastGroups(setGroups)).toEqual([]);
});

it('斷線時環境未知（null）、未簽署帳戶跟著解析不出來都保留；同一環境與帳戶回來仍保留', () => {
    const setGroups = vi.spyOn(FillMarksLayer.prototype, 'setGroups');
    m.fills = [fill('1', 600, 100, 'Buy')];
    const refs = fakes();
    const r = mount(createElement(Probe, { refs }));
    act(() => r.update(createElement(Probe, { refs, env: null, account: null, ready: false })));
    expect(lastGroups(setGroups)).toEqual([expect.objectContaining({ dimmed: true })]);
    act(() => r.update(createElement(Probe, { refs, ready: false })));
    expect(lastGroups(setGroups)).toEqual([expect.objectContaining({ dimmed: true })]);
    // 全部帳戶：環境未知時可交易帳戶清單會縮小，也當成未知
    const all = [ACCOUNT, { ...ACCOUNT, account_id: '2' }];
    const other = fakes();
    const g = mount(createElement(Probe, { refs: other, accounts: all }));
    act(() => g.update(createElement(Probe, { refs: other, accounts: [ACCOUNT], env: null, ready: false })));
    expect(lastGroups(setGroups)).toEqual([expect.objectContaining({ dimmed: true })]);
});

const ALL = [ACCOUNT, { ...ACCOUNT, account_id: '2' }];
it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ['換商品', {}, { contract: { ...CONTRACT, code: 'TXFK6' } }],
    ['換週期', {}, { minutes: 1 }],
    ['切僅日盤', {}, { dayOnly: true }],
    ['換帳戶', {}, { account: { ...ACCOUNT, account_id: '2' } }],
    ['目前帳戶 → 全部帳戶', {}, { accounts: [ACCOUNT] }],
    ['全部帳戶的帳戶清單改變', { accounts: ALL }, { accounts: [ACCOUNT] }],
    ['全部帳戶 → 目前帳戶', { accounts: ALL }, { accounts: undefined }],
    ['斷線（環境未知）時切到全部帳戶', {}, { accounts: ALL, env: null }],
    ['彈出視窗的主視窗已關閉（不可保留）', {}, { retain: false }],
    ['環境已知時帳戶消失（固定的帳戶不再可交易）', {}, { account: null }],
    ['連續月別名換月（target_code 改變）', { contract: { ...CONTRACT, code: 'TXFR1', target_code: 'TXFJ6' } },
        { contract: { ...CONTRACT, code: 'TXFR1', target_code: 'TXFK6' } }],
])('%s：保留的分組清空', (_label, before, change) => {
    const setGroups = vi.spyOn(FillMarksLayer.prototype, 'setGroups');
    m.fills = [fill('1', 600, 100, 'Buy')];
    const refs = fakes();
    const r = mount(createElement(Probe, { refs, ...before }));
    act(() => r.update(createElement(Probe, { refs, ...before, ready: false })));
    expect(lastGroups(setGroups)).toHaveLength(1);
    act(() => r.update(createElement(Probe, { refs, ...before, ...change, ready: false })));
    expect(lastGroups(setGroups)).toEqual([]);
    // 換回原本的條件也不復活
    act(() => r.update(createElement(Probe, { refs, ...before, ready: false })));
    expect(lastGroups(setGroups)).toEqual([]);
});

it('全部帳戶的清單只換順序不算範圍改變', () => {
    const setGroups = vi.spyOn(FillMarksLayer.prototype, 'setGroups');
    m.fills = [fill('1', 600, 100, 'Buy')];
    const refs = fakes();
    const r = mount(createElement(Probe, { refs, accounts: ALL }));
    act(() => r.update(createElement(Probe, { refs, accounts: [...ALL].reverse(), ready: false })));
    expect(lastGroups(setGroups)).toEqual([expect.objectContaining({ dimmed: true })]);
});

it('斷線（未知）期間記住上次已知的環境與帳戶：重連到另一個環境、或回來的是另一個帳戶都清空', () => {
    const setGroups = vi.spyOn(FillMarksLayer.prototype, 'setGroups');
    m.fills = [fill('1', 600, 100, 'Buy')];
    const a = fakes();
    const r = mount(createElement(Probe, { refs: a, env: SIM }));
    act(() => r.update(createElement(Probe, { refs: a, env: null, ready: false })));
    expect(lastGroups(setGroups)).toEqual([expect.objectContaining({ dimmed: true })]);
    act(() => r.update(createElement(Probe, { refs: a, env: PROD, ready: false })));
    expect(lastGroups(setGroups)).toEqual([]);
    const b = fakes();
    const g = mount(createElement(Probe, { refs: b }));
    act(() => g.update(createElement(Probe, { refs: b, env: null, account: null, ready: false })));
    expect(lastGroups(setGroups)).toEqual([expect.objectContaining({ dimmed: true })]);
    act(() => g.update(createElement(Probe, { refs: b, account: { ...ACCOUNT, account_id: '2' }, ready: false })));
    expect(lastGroups(setGroups)).toEqual([]);
});

it('確認狀態下換商品或帳戶：新的範圍確認後，待確認時保留的是新範圍的分組', () => {
    const setGroups = vi.spyOn(FillMarksLayer.prototype, 'setGroups');
    m.fills = [fill('1', 600, 100, 'Buy')];
    const refs = fakes();
    const other = { ...CONTRACT, code: 'TXFK6' };
    const b = { ...ACCOUNT, account_id: '2' };
    const r = mount(createElement(Probe, { refs }));
    // 真實投影每次回傳新陣列
    m.fills = [fill('2', 900, 101, 'Sell', { code: 'TXFK6' })];
    act(() => r.update(createElement(Probe, { refs, contract: other })));
    act(() => r.update(createElement(Probe, { refs, contract: other, ready: false })));
    expect(lastGroups(setGroups)).toEqual([expect.objectContaining({ key: K(900, 'Sell', 101, '口', 'TXFK6'), dimmed: true })]);
    m.fills = [fill('3', 1200, 102, 'Buy', { code: 'TXFK6', account: b })];
    act(() => r.update(createElement(Probe, { refs, contract: other, account: b })));
    act(() => r.update(createElement(Probe, { refs, contract: other, account: b, ready: false })));
    expect(lastGroups(setGroups)).toEqual([expect.objectContaining({ key: K(1200, 'Buy', 102, '口', 'TXFK6'), dimmed: true })]);
});

it('確認狀態下關掉顯示會蓋掉保留：再打開時若待確認就沒有淡色點', () => {
    const setGroups = vi.spyOn(FillMarksLayer.prototype, 'setGroups');
    m.fills = [fill('1', 600, 100, 'Buy')];
    const refs = fakes();
    const r = mount(createElement(Probe, { refs }));
    act(() => r.update(createElement(Probe, { refs, visible: false })));
    act(() => r.update(createElement(Probe, { refs, ready: false })));
    expect(lastGroups(setGroups)).toEqual([]);
    expect(view.retained).toBe(false);
});

it('成交多到重算很貴時合併連續回報：間隔內先不重算、到期一定算到最新；範圍一變立即用最新的委託', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    m.now = 1000;
    m.cost = 20; // 一次 20ms → 同範圍兩次重算至少隔 80ms
    vi.spyOn(performance, 'now').mockImplementation(() => m.now);
    m.fills = [fill('1', 600, 100, 'Buy')];
    const refs = fakes();
    const t0 = [] as never[], t1 = [{}] as never[], t2 = [{}, {}] as never[], t3 = [{}, {}, {}] as never[];
    try {
        const r = mount(createElement(Probe, { refs, trades: t0 }));
        expect(m.calls.at(-1).trades).toBe(t0);
        act(() => r.update(createElement(Probe, { refs, trades: t1 })));
        expect(m.calls.at(-1).trades).toBe(t1); // 安靜一陣子後的第一筆：立即算
        act(() => r.update(createElement(Probe, { refs, trades: t2 })));
        act(() => r.update(createElement(Probe, { refs, trades: t3 })));
        expect(m.calls).toHaveLength(2); // 間隔內：還在用 t1
        expect(m.missingCalls.at(-1).trades).toBe(t1); // 明細檢查與投影用同一份
        m.now += 100;
        act(() => { vi.advanceTimersByTime(100); });
        expect(m.calls.at(-1).trades).toBe(t3); // 到期：直接算最新的，跳過 t2
        expect(m.calls).toHaveLength(3);
        act(() => r.update(createElement(Probe, { refs, trades: t2 })));
        expect(m.calls).toHaveLength(3); // 剛算過：又進入間隔
        // 範圍改變（換帳戶）：不等間隔，立即用最新的委託
        act(() => r.update(createElement(Probe, { refs, trades: t0, account: { ...ACCOUNT, account_id: '2' } })));
        expect(m.calls.at(-1)).toMatchObject({ trades: t0, account: { account_id: '2' } });
        // 便宜的時候（< 8ms）每筆都立即算
        m.cost = 1;
        m.now += 1000;
        act(() => r.update(createElement(Probe, { refs, trades: t2, account: { ...ACCOUNT, account_id: '2' } })));
        act(() => r.update(createElement(Probe, { refs, trades: t1, account: { ...ACCOUNT, account_id: '2' } })));
        expect(m.calls.at(-1).trades).toBe(t1);
    } finally {
        vi.useRealTimers();
    }
});

it('關掉時不檢查明細也不投影；重新打開立刻檢查一次', () => {
    m.fills = [fill('1', 600, 100, 'Buy')];
    const refs = fakes();
    const r = mount(createElement(Probe, { refs }));
    const checks = m.missingCalls.length, projections = m.calls.length;
    act(() => r.update(createElement(Probe, { refs, visible: false })));
    for (let i = 0; i < 3; i++) act(() => r.update(createElement(Probe, { refs, visible: false, trades: [] as never[] })));
    expect(m.missingCalls).toHaveLength(checks);
    expect(m.calls).toHaveLength(projections);
    act(() => r.update(createElement(Probe, { refs })));
    expect(m.missingCalls).toHaveLength(checks + 1);
    expect(m.calls).toHaveLength(projections + 1);
});

it('明細檢查與投影共用這張圖的快取，關掉時釋放範圍', () => {
    const refs = fakes();
    const r = mount(createElement(Probe, { refs }));
    const cache = m.missingCaches.at(-1);
    expect(cache).toBeDefined();
    expect(m.caches.at(-1)).toBe(cache);
    cache!.scope = { trades: TRADES, contract: CONTRACT, account: ACCOUNT, rows: [] };
    act(() => r.update(createElement(Probe, { refs, visible: false })));
    expect(cache!.scope).toBeUndefined();
});

it('待確認時關掉：保留的分組不再帶逐筆成交', () => {
    const setGroups = vi.spyOn(FillMarksLayer.prototype, 'setGroups');
    m.fills = [fill('1', 600, 100, 'Buy'), fill('2', 600, 100, 'Buy')];
    const refs = fakes();
    const r = mount(createElement(Probe, { refs }));
    m.missing = true;
    act(() => r.update(createElement(Probe, { refs, trades: [] as never[] })));
    act(() => r.update(createElement(Probe, { refs, trades: [] as never[], visible: false })));
    act(() => r.update(createElement(Probe, { refs, trades: [] as never[] })));
    const kept = lastGroups(setGroups);
    expect(kept).toEqual([expect.objectContaining({ key: K(600, 'Buy', 100), text: '100 2口', dimmed: true })]);
    expect(kept[0]).not.toHaveProperty('fills');
});

it('同一根 K 棒裡換價位：hoveredBar 是同一個陣列（提示框摘要不必重算），hoveredFills 換成命中的那組在前', () => {
    m.fills = [fill('1', 600, 100, 'Buy'), fill('2', 600, 101, 'Buy'), fill('3', 900, 102, 'Sell')];
    const refs = fakes();
    mount(createElement(Probe, { refs }));
    const hit = vi.spyOn(FillMarksLayer.prototype, 'hitAt');
    hit.mockReturnValue(K(600, 'Buy', 100));
    act(() => refs.handlers[0]!({ point: { x: 1, y: 1 }, time: 600, paneIndex: 0 }));
    const bar = view.hoveredBar;
    expect(view.hoveredFills.map(f => f.id)).toEqual(['1', '2']);
    hit.mockReturnValue(K(600, 'Buy', 101));
    act(() => refs.handlers[0]!({ point: { x: 1, y: 2 }, time: 600, paneIndex: 0 }));
    expect(view.hoveredFills.map(f => f.id)).toEqual(['2', '1']);
    expect(view.hoveredBar).toBe(bar);
    expect(bar.map(f => f.id)).toEqual(['1', '2']);
});

// 明細的「這根 K 棒」：打開清單時標示最近查看的那根
const focusFills = () => [fill('1', 600, 100, 'Buy'), fill('2', 600, 101, 'Buy'), fill('3', 1200, 102, 'Sell')];
const focusOn = (time = 600) => act(() => view.focusBar({ scope: view.scope, time }));
it('focusBar 設定那根：time、label（日內 HH:MM、日 K MM-DD），fills 是那根的全部成交、和 hoveredBar 同一個陣列', () => {
    m.fills = focusFills();
    vi.spyOn(FillMarksLayer.prototype, 'hitAt').mockReturnValue(K(600, 'Buy', 100));
    const refs = fakes();
    mount(createElement(Probe, { refs }));
    act(() => refs.handlers[0]!({ point: { x: 3, y: 4 }, time: 600, paneIndex: 0 }));
    // 介面合約：回傳型別要能指派給合約的三個欄位
    const contract: {
        focus: { time: number; label: string; fills: readonly ChartFill[] } | null;
        focusBar: (last: { scope: string; time: number } | null) => void;
        clearFocus: () => void;
    } = view;
    expect(contract.focus).toBeNull();
    focusOn();
    expect(view.focus).toEqual({ time: 600, label: '00:10', fills: expect.any(Array), groups: expect.any(Array) });
    expect(view.focus!.fills).toBe(view.hoveredBar);
    expect(view.focus!.fills.map(f => f.id)).toEqual(['1', '2']);
    mount(createElement(Probe, { refs: fakes(), minutes: 1440 }));
    focusOn();
    expect(view.focus!.label).toBe('01-01');
});

it('focus.groups 是那根的每價分組（帶商品與那個價位的合計）；由分組算出的摘要行和逐筆算的一樣', () => {
    m.fills = [
        fill('1', 600, 100, 'Buy'), fill('2', 600, 100, 'Buy', { quantity: 3 }), fill('3', 600, 101.5, 'Buy'),
        fill('4', 600, 101, 'Sell', { quantity: 2 }), fill('5', 600, 103, 'Sell'), fill('6', 600, 100, 'Buy', { unit: '股', quantity: 30 }),
        fill('7', 600, 99, 'Buy', { code: 'TXFK6' }), fill('8', 600, 100, 'Buy', { quantity: 2 }), fill('9', 1200, 102, 'Sell'),
    ];
    mount(createElement(Probe, { refs: fakes() }));
    focusOn();
    expect(view.focus!.groups!.map(({ key, code, action, unit, price, quantity }) => ({ key, code, action, unit, price, quantity }))).toEqual([
        { key: K(600, 'Buy', 100), code: 'TXFJ6', action: 'Buy', unit: '口', price: 100, quantity: 6 },
        { key: K(600, 'Buy', 101.5), code: 'TXFJ6', action: 'Buy', unit: '口', price: 101.5, quantity: 1 },
        { key: K(600, 'Sell', 101), code: 'TXFJ6', action: 'Sell', unit: '口', price: 101, quantity: 2 },
        { key: K(600, 'Sell', 103), code: 'TXFJ6', action: 'Sell', unit: '口', price: 103, quantity: 1 },
        { key: K(600, 'Buy', 100, '股'), code: 'TXFJ6', action: 'Buy', unit: '股', price: 100, quantity: 30 },
        { key: K(600, 'Buy', 99, '口', 'TXFK6'), code: 'TXFK6', action: 'Buy', unit: '口', price: 99, quantity: 1 },
    ]);
    const line = (focus: Parameters<typeof ChartFillDetails>[0]['focus']) => {
        let r!: ReactTestRenderer;
        act(() => { r = create(createElement(ChartFillDetails, { fills: view.fills, focus, privacy: false, up: '#f00', down: '#0f0', decimalsFor: () => 0 })); });
        mounted.push(r);
        const node = r.root.find(n => n.type === 'div' && n.props['data-fill-focus']);
        const text = (n: typeof node | string): string => typeof n === 'string' ? n : n.children.map(text).join('');
        return text(node);
    };
    const grouped = line(view.focus!);
    expect(grouped).toContain('TXFJ6 ▲ 買 7 口 · 均 100.2 · 100～101.5');
    expect(grouped).toBe(line({ ...view.focus!, groups: undefined }));
});

it('focusBar 不設定：範圍不符、那根沒有成交、待確認時（確認後也不冒出來）；傳 null 取消', () => {
    m.fills = focusFills();
    const refs = fakes();
    const r = mount(createElement(Probe, { refs }));
    act(() => view.focusBar({ scope: 'x', time: 600 }));
    expect(view.focus).toBeNull();
    focusOn(900);
    expect(view.focus).toBeNull();
    // 待確認：範圍相符（用待確認時的 scope），只有「那根現在沒有圖上的成交」擋著
    act(() => r.update(createElement(Probe, { refs, ready: false })));
    focusOn();
    expect(view.focus).toBeNull();
    act(() => r.update(createElement(Probe, { refs })));
    expect(view.focus).toBeNull();
    focusOn();
    expect(view.focus).not.toBeNull();
    act(() => view.focusBar(null));
    expect(view.focus).toBeNull();
});

it.each<[string, Record<string, unknown>]>([
    ['換商品', { contract: { ...CONTRACT, code: 'TXFK6' } }],
    ['換週期', { minutes: 1 }],
    ['切僅日盤', { dayOnly: true }],
    ['換帳戶', { account: { ...ACCOUNT, account_id: '2' } }],
    ['目前帳戶 → 全部帳戶', { accounts: [ACCOUNT] }],
    ['關掉成交標記', { visible: false }],
    ['換成另一個已知環境', { env: PROD }],
])('%s：「這根 K 棒」取消，換回原值也不復活', (_label, change) => {
    m.fills = focusFills();
    const refs = fakes();
    const r = mount(createElement(Probe, { refs }));
    focusOn();
    expect(view.focus).not.toBeNull();
    act(() => r.update(createElement(Probe, { refs, ...change })));
    expect(view.focus).toBeNull();
    act(() => r.update(createElement(Probe, { refs })));
    expect(view.focus).toBeNull();
});

it('待確認、斷線（環境與帳戶暫時未知）時保留「這根 K 棒」：fills 暫時是空陣列，確認後回到那根的成交', () => {
    m.fills = focusFills();
    const refs = fakes();
    const r = mount(createElement(Probe, { refs }));
    focusOn();
    act(() => r.update(createElement(Probe, { refs, ready: false })));
    expect(view.focus).not.toBeNull();
    expect(view.focus!.fills).toEqual([]);
    act(() => r.update(createElement(Probe, { refs })));
    expect(view.focus!.fills.map(f => f.id)).toEqual(['1', '2']);
    // 斷線
    act(() => r.update(createElement(Probe, { refs, env: null, account: null, ready: false })));
    expect(view.focus).not.toBeNull();
    expect(view.focus!.fills).toEqual([]);
    act(() => r.update(createElement(Probe, { refs })));
    expect(view.focus!.fills.map(f => f.id)).toEqual(['1', '2']);
});

it('已確認時那根沒有成交了就取消，成交回來也不復活', () => {
    m.fills = focusFills();
    const refs = fakes();
    const r = mount(createElement(Probe, { refs }));
    focusOn();
    m.fills = [fill('3', 1200, 102, 'Sell')];
    act(() => r.update(createElement(Probe, { refs, version: 1 })));
    expect(view.focus).toBeNull();
    m.fills = focusFills();
    act(() => r.update(createElement(Probe, { refs, version: 2 })));
    expect(view.focus).toBeNull();
});

it('身分穩定：換顏色、成交沒變的重繪時 focus 是同一個物件；clearFocus 永遠是同一個函式', () => {
    m.fills = focusFills();
    const refs = fakes();
    const r = mount(createElement(Probe, { refs }));
    focusOn();
    const focus = view.focus, clear = view.clearFocus;
    const colors = ['#00f', '#ff0', '#eee'];
    act(() => r.update(createElement(Probe, { refs, colors })));
    expect(view.focus).toBe(focus);
    expect(view.clearFocus).toBe(clear);
    act(() => r.update(createElement(Probe, { refs, colors, version: 1 }))); // m.fills 同一個陣列
    expect(view.focus).toBe(focus);
    expect(view.clearFocus).toBe(clear);
    act(() => view.clearFocus());
    expect(view.focus).toBeNull();
    expect(view.clearFocus).toBe(clear);
});

it('標示之後滑過別根、游標離開都不影響「這根 K 棒」', () => {
    m.fills = focusFills();
    const hitAt = vi.spyOn(FillMarksLayer.prototype, 'hitAt');
    const refs = fakes();
    mount(createElement(Probe, { refs }));
    focusOn();
    const focus = view.focus;
    hitAt.mockReturnValue(K(1200, 'Sell', 102));
    act(() => refs.handlers[0]!({ point: { x: 3, y: 4 }, time: 1200, paneIndex: 0 }));
    expect(view.hoveredFills.map(f => f.id)).toEqual(['3']);
    act(() => refs.handlers[0]!({ point: undefined, time: undefined }));
    expect(view.focus).toBe(focus);
});
