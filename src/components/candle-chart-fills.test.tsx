// 成交標記整合：實際價格、分筆資料、帳戶隔離，以及圖例列（顯示／隱藏／移除）與設定面板
import { createElement, useState, type ReactElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { created, crosshairHandlers, kbars, T as wall } from './chart-session.test-harness';

// 「指標」對話框會 portal 到 body；測試沒有 DOM，就地渲染
vi.mock('react-dom', () => ({ createPortal: (children: unknown) => children }));
vi.hoisted(() => {
    const store = new Map<string, string>();
    const ls = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k), key: () => null, length: 0 };
    (globalThis as any).localStorage = ls;
    (globalThis as any).window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, location: { search: '', href: 'http://x/' } });
    (globalThis as any).document = { addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, getContext: () => null }), body: {} };
});
vi.mock('../lib/trade', () => ({ notify: () => {}, placeQuickOrder: async () => {} }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: async () => {}, updateOrderPrice: async () => {} }));
const captured = vi.hoisted(() => ({ groups: [] as any[], history: [] as any[][], style: {} as any, hitKey: undefined as string | undefined, account: null as any, futuresAccount: null as any, accounts: undefined as any[] | undefined }));
vi.mock('lightweight-charts', async () => (await import('./chart-session.test-harness')).lwMock());
// 版面與命中在 chart-fill-marks.test.ts 驗；這裡只擷取交給圖層的組。
// 命中預設取游標所在 K 棒的第一組，hitKey 模擬直接滑到某一組。
vi.mock('../lib/chart-fill-marks', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/chart-fill-marks')>()),
    FillMarksLayer: class {
        groups: any[] = [];
        setGroups(groups: any[]) { this.groups = groups; captured.groups = groups; captured.history.push(groups); }
        setStyle(patch: any) { captured.style = { ...captured.style, ...patch }; }
        setAvoid() {}
        hitAt(_x: number, _y: number, barTime?: number) {
            // 多價位組（同棒同方向跨價位）跟真的圖層一樣回傳某個價位的每價分組鍵
            const g = this.groups.find((g) => g.time === barTime);
            return captured.hitKey ?? g?.members?.[0]?.key ?? g?.key ?? null;
        }
    },
}));
vi.mock('../lib/account-store', () => ({ ensureAccounts: () => {},
    useAccounts: () => ({ loaded: true, accounts: captured.accounts ?? [A, B, ...(captured.futuresAccount ? [captured.futuresAccount] : [])], selectedStock: captured.account, selectedFutures: captured.futuresAccount }),
}));
vi.mock('../lib/trigger-engine', () => ({ useTriggers: () => [], addTrigger: vi.fn(), removeTrigger: vi.fn() }));

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
import * as chartStyles from './candle-chart.css';
import * as fillStyles from './chart-fill-details.css';
import { DRAWING_PALETTE } from '../lib/chart-drawings';
import { priceKey } from '../lib/chart-fills';
import {
    getChartFillScope, getChartFillStyle, setChartFillBuy, setChartFillColor, setChartFillScope, setChartFillSell, setChartFillShape, setChartFillStyle,
    type ChartFillsState,
} from '../lib/chart-fill-prefs';
import { getChartColors } from '../lib/theme-store';
import { setPrivacyMode } from '../lib/privacy';
import type { AccountedTrade } from '../lib/types/order';
const A = { account_type: 'S', broker_id: 'B', account_id: '1111121', signed: true, person_id: '', username: '甲' };
const B = { ...A, account_id: '2222207', username: '乙' };

const fut = { code: 'TXFR1', security_type: 'FUT', exchange: 'TAIFEX', target_code: 'TXFJ6', tick: 1 } as any;
const stk = { code: '2330', security_type: 'STK', exchange: 'TSE', target_code: null } as any;
const ind = { code: '001', security_type: 'IND', exchange: 'TSE', target_code: null } as any;

const flush = async () => {
    for (let i = 0; i < 6; i++) await act(async () => {});
};
const frame = async () => {
    await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
    });
};
const mounted: ReactTestRenderer[] = [];
// 測試用 ResizeObserver 會把回呼留下來，讓案例回報圖表區寬度
const resizeCallbacks: ((entries: unknown[]) => void)[] = [];
const resizeTo = (width: number) => act(() => { for (const cb of resizeCallbacks) cb([{ contentRect: { width } }]); });
// CandleChart 預設把成交來源當成未確認；LiveCandleChart 確認後才傳 fillsReady。案例預設為已確認，要驗預設值時明傳 undefined。
const chart = (props: any) => createElement(CandleChart, { fillsReady: true, ...props });
// 設定面板根節點的假 DOM 節點：只有焦點測試會給（要有 ownerDocument 與 querySelector），平常用下面那個通用的
let settingsNode: unknown = null;
// 圖例列的假 DOM 節點：焦點測試要看關閉時焦點有沒有回到圖例列的第一顆鈕
let legendNode: unknown = null;
function mountElement(element: ReactElement) {
    let r!: ReactTestRenderer;
    act(() => {
        r = create(element, {
            createNodeMock: (el) => settingsNode && (el.props as { className?: string }).className === fillStyles.settings ? settingsNode
                : legendNode && (el.props as Record<string, unknown>)['data-fills-legend'] ? legendNode : ({ clientWidth: 800, clientHeight: 400, getBoundingClientRect: () => ({ width: 800, height: 400, left: 0, top: 0 }), addEventListener() {}, removeEventListener() {}, style: {}, querySelector: () => null, focus() {} }),
        });
    });
    mounted.push(r);
    return r;
}
const mount = (props: any) => mountElement(chart(props));
// 工作區的角色：fills／onFillsChange 是受控的，收到狀態就存起來再傳回圖表；log 記下每次交回的狀態
function Workspace({ log, initial = 'on', ...props }: { log: ChartFillsState[]; initial?: ChartFillsState; [key: string]: unknown }) {
    const [fills, setFills] = useState(initial);
    return chart({ ...props, fills, onFillsChange: (state: ChartFillsState) => { log.push(state); setFills(state); } });
}
const mountWorkspace = (props: any, log: ChartFillsState[] = []) => mountElement(createElement(Workspace, { ...props, log }));
const setNow = (s: string) => vi.setSystemTime(new Date(`${s}+08:00`));
const text = (n: ReactTestInstance | undefined): string =>
    n ? n.children.map((c) => (typeof c === 'string' ? c : text(c))).join('') : '';
// 圖例列（圖表左上角，data-fills-legend）：名稱鈕「成交」與齒輪開關設定面板、眼睛顯示／隱藏、× 從這張圖移除（從「指標」加回）
const legend = (r: ReactTestRenderer) => r.root.findAll((n) => typeof n.type === 'string' && n.props['data-fills-legend'])[0];
// 圖例列的文字（示意字元、買賣、筆數），不管中間的空白
const legendText = (r: ReactTestRenderer) => text(legend(r)).replace(/\s/g, '');
// 可見名稱：aria-label，否則是去掉 aria-hidden 示意後的文字
const named = (n: ReactTestInstance): string =>
    n.props['aria-label'] ?? n.children.map((c) => (typeof c === 'string' ? c : c.props['aria-hidden'] ? '' : named(c))).join('').trim();
const buttons = (root: ReactTestInstance | undefined) => root?.findAll((n) => n.type === 'button') ?? [];
const classes = (n: ReactTestInstance) => String(n.props.className ?? '').split(' ');
const legendNames = (r: ReactTestRenderer) => buttons(legend(r)).map(named);
const legendBtn = (r: ReactTestRenderer, name: string) => buttons(legend(r)).find((b) => named(b) === name)!;
const press = (r: ReactTestRenderer, name: string) => act(async () => legendBtn(r, name).props.onClick());
// 設定面板（成交標記設定）：形狀、標籤、顏色、帳戶，點了就生效（全域偏好），沒有「完成」鈕
const panel = (r: ReactTestRenderer) => r.root.findAll((n) => n.props.role === 'dialog' && n.props['aria-label'] === '成交標記設定')[0];
const panelBtn = (r: ReactTestRenderer, name: string) => buttons(panel(r)).find((b) => named(b) === name)!;
async function pick(r: ReactTestRenderer, name: string) {
    if (!panel(r)) await press(r, '成交');
    await act(async () => panelBtn(r, name).props.onClick());
}
// 形狀／標籤那一組的按鈕：[名稱, 是否選中]
const choices = (r: ReactTestRenderer, row: '形狀' | '標籤') =>
    buttons(panel(r)!.find((n) => n.props.role === 'group' && n.props['aria-label'] === row)).map((b) => [named(b), b.props['aria-pressed']]);
// 「跟 K 棒同色」是原生勾選框
const candleBox = (r: ReactTestRenderer) => panel(r)!.find((n) => n.type === 'input' && n.props.type === 'checkbox');
const toggleCandle = (r: ReactTestRenderer) => act(async () => {
    const checked = !candleBox(r).props.checked;
    candleBox(r).props.onChange({ target: { checked }, currentTarget: { checked } });
});
// 可見文字是「明細 N」，名稱要包含它（label in name）：「成交明細 N」
const listButton = (r: ReactTestRenderer) => r.root.findAll((n) => n.type === 'button' && String(n.props['aria-label'] ?? '').startsWith('成交明細'))[0]!;
const tooltips = (r: ReactTestRenderer) => r.root.findAll(n => n.props.role === 'tooltip');
const lists = (r: ReactTestRenderer) => r.root.findAll(n => n.props['data-fill-details'] === 'list');
const move = async (time: number | undefined) => {
    for (const h of crosshairHandlers) h(time === undefined ? { point: undefined, time: undefined, seriesData: new Map() } : { point: { x: 10, y: 10 }, time, seriesData: new Map() });
    await frame();
};

// 1 分 K（時間標籤＝收盤時刻），5 分 K 聚合後：09:05 / 09:10 / 09:15 三根
const DATA = kbars([['2026-10-08T09:00:00', '2026-10-08T09:15:00', (t) => 20000 + (t - wall('2026-10-08T09:00:00')) / 60]]);
const BAR = wall('2026-10-08T09:05:00');
// 分組鍵：商品｜K 棒｜方向｜整數價格｜單位
const KEY = (action: 'Buy' | 'Sell', price: number, time = BAR) => `2330|${time}|${action}|${priceKey(price)}|張`;

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
    resizeCallbacks.length = 0;
    vi.stubGlobal('ResizeObserver', class {
        constructor(cb: (entries: unknown[]) => void) { resizeCallbacks.push(cb); }
        observe() {} disconnect() {} unobserve() {}
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    created.length = 0;
    crosshairHandlers.length = 0;
    quote = undefined;
    fetchMock.mockReset();
    captured.groups = []; captured.history = []; captured.style = {}; captured.hitKey = undefined; captured.account = A; captured.futuresAccount = null; captured.accounts = undefined;
    setPrivacyMode(false);
    setChartFillStyle('price');
    setChartFillScope('active');
    setChartFillColor('distinct');
    setChartFillShape('triangle');
    setChartFillBuy('');
    setChartFillSell('');
    settingsNode = null;
    legendNode = null;
});
afterEach(() => {
    for (const m of mounted.splice(0)) act(() => m.unmount());
    listeners.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});


const trades = (account = A): AccountedTrade[] => [{
    contract: stk, account,
    order: { id: 'buy', seqno: 'b', ordno: 'b', action: 'Buy', price: 1, quantity: 3, order_lot: 'Common', account },
    status: { id: 'buy', status: 'Cancelled', status_code: '', order_quantity: 3, deal_quantity: 2,
        cancel_quantity: 1, modified_price: 0, msg: '', deals: [
            { seq: 'd1', price: 20003, quantity: 1, ts: Date.parse('2026-10-08T09:02:30+08:00') / 1000 },
            { seq: 'd2', price: 20003, quantity: 1, ts: Date.parse('2026-10-08T09:03:30+08:00') / 1000 },
        ] },
}];
const filledRows = (r: ReactTestRenderer) => r.root.findAll(n => n.type === 'tr' && n.props['data-fill-id']);

describe('CandleChart 實際成交標記', () => {
    it('成交價不同於委託價；同棒同價一組圓點，明細保留部分成交與撤單前成交', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: stk, trades: trades() }); await flush();
        expect(legend(r)).toBeDefined();
        expect(captured.groups).toMatchObject([{ key: KEY('Buy', 20003), time: BAR, price: 20003, action: 'Buy', text: '20,003 2張' }]);
        expect(captured.groups).toHaveLength(1);
        expect(captured.style).toEqual({ up: expect.any(String), down: expect.any(String), labelBg: expect.any(String), style: 'price', shape: 'triangle' });
        await act(async () => listButton(r).props.onClick());
        expect(filledRows(r)).toHaveLength(2);
        expect(text(filledRows(r)[0])).toContain('20,003');
        expect(text(filledRows(r)[0])).toContain('1 張');
    });
    it('圖例列的眼睛可隱藏標記與明細，並將狀態交回工作區', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const onFillsChange = vi.fn();
        const r = mount({ contract: stk, trades: trades(), fills: 'on', onFillsChange }); await flush();
        await act(async () => listButton(r).props.onClick());
        expect(lists(r)).toHaveLength(1);
        await press(r, '隱藏成交標記');
        expect(onFillsChange.mock.calls).toEqual([['hidden']]);
        // 狀態由工作區保管：還沒傳回來之前圖上不變
        expect(captured.groups).toHaveLength(1);
        await act(async () => r.update(chart({ contract: stk, trades: trades(), fills: 'hidden', onFillsChange })));
        expect(captured.groups).toEqual([]);
        expect(r.root.findAll(n => n.props['data-fill-details'])).toHaveLength(0);
    });
    it('切帳戶、商品後同步清除上一份成交；隱私模式遮蔽帳號', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const rows = [...trades(A), ...trades(B)];
        const r = mount({ contract: stk, trades: rows }); await flush();
        await act(async () => listButton(r).props.onClick());
        expect(text(r.root)).toContain('1111121');
        act(() => setPrivacyMode(true));
        expect(text(r.root)).not.toContain('1111121');
        captured.account = B;
        await act(async () => r.update(chart({ contract: stk, trades: rows })));
        expect(text(r.root)).not.toContain('1111121');
        expect(captured.groups).toHaveLength(1);
        await act(async () => r.update(chart({ contract: { ...stk, code: '2317' }, trades: rows })));
        expect(captured.groups).toEqual([]);
        expect(filledRows(r)).toHaveLength(0);
    });
    it('游標移到成交棒顯示明細，移開與切週期不保留舊 tooltip', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: stk, trades: trades() }); await flush();
        await move(BAR);
        expect(tooltips(r)).toHaveLength(1);
        await move(undefined);
        expect(tooltips(r)).toHaveLength(0);
        await move(BAR);
        await act(async () => r.root.findAll(n => n.type === 'button' && n.children.join('') === '1m')[0]!.props.onClick());
        await flush();
        expect(tooltips(r)).toHaveLength(0);
        expect(captured.groups.map(g => g.time)).toEqual([wall('2026-10-08T09:03:00'), wall('2026-10-08T09:04:00')]);
    });
    it('成交來源未確認時隱藏舊資料，不把舊環境成交當成本次結果', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: stk, trades: trades(), fillsReady: true }); await flush();
        expect(captured.groups).toHaveLength(1);
        await act(async () => r.update(chart({ contract: stk, trades: trades(), fillsReady: false } as any)));
        expect(captured.groups).toEqual([]);
        await act(async () => listButton(r).props.onClick());
        expect(text(r.root)).toContain('成交資料待確認');
        expect(filledRows(r)).toHaveLength(0);
    });
    it('帳戶往返也清掉 hover；成交價保留三位小數，小數秒才顯示毫秒', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const rows = trades(); rows[0]!.status.deals[0]!.price = 31.123; rows[0]!.status.deals[0]!.ts += 0.25;
        const r = mount({ contract: stk, trades: rows }); await flush();
        await move(BAR);
        const tip = text(r.root.findByProps({ role: 'tooltip' }));
        expect(tip).toContain('31.123');
        expect(tip).toContain('10-08 09:02:30.250');
        expect(tip).toContain('10-08 09:03:30');
        expect(tip).not.toContain('09:03:30.');
        captured.account = B;
        await act(async () => r.update(chart({ contract: stk, trades: rows })));
        captured.account = A;
        await act(async () => r.update(chart({ contract: stk, trades: rows })));
        expect(tooltips(r)).toHaveLength(0);
    });
    it('滑到某一組時先列該組，再接同一根 K 棒其他成交；tooltip 最多 4 筆', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const buy = trades()[0]!;
        const sell: AccountedTrade = { ...buy, order: { ...buy.order, id: 'sell', action: 'Sell' }, status: { ...buy.status, id: 'sell', deal_quantity: 3, deals: [
            { seq: 's1', price: 20004, quantity: 1, ts: Date.parse('2026-10-08T09:01:00+08:00') / 1000 },
            { seq: 's2', price: 20004, quantity: 1, ts: Date.parse('2026-10-08T09:04:00+08:00') / 1000 },
            { seq: 's3', price: 20002, quantity: 1, ts: Date.parse('2026-10-08T09:04:30+08:00') / 1000 },
        ] } };
        const r = mount({ contract: stk, trades: [buy, sell] }); await flush();
        const seqs = () => r.root.findByProps({ role: 'tooltip' }).findAll(n => n.type === 'tr')
            .map(n => JSON.parse(n.props['data-fill-id']).at(-1));
        captured.hitKey = KEY('Sell', 20004);
        await move(BAR);
        expect(seqs()).toEqual(['s1', 's2', 'd1', 'd2']);
        expect(text(r.root.findByProps({ role: 'tooltip' }))).toContain('另有 1 筆');
        captured.hitKey = KEY('Buy', 20003);
        await move(BAR);
        expect(seqs()).toEqual(['d1', 'd2', 's1', 's2']);
    });
    it('不能下單的圖表（指數）不畫、不留明細與 tooltip；換回可下單商品照舊', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        // 即使資料對得上指數，也不能顯示
        const rows = [...trades(), ...trades().map(t => ({ ...t, contract: ind }))];
        const show = async (contract: unknown) => {
            await act(async () => r.update(chart({ contract, trades: rows } as any)));
            await flush();
        };
        const r = mount({ contract: stk, trades: rows }); await flush();
        await move(BAR);
        expect(tooltips(r)).toHaveLength(1);
        expect(legend(r)).toBeDefined();
        await show(ind);
        expect(legend(r)).toBeUndefined();
        await move(BAR);
        expect(tooltips(r)).toHaveLength(0);
        expect(captured.groups).toEqual([]);
        await show(stk);
        await act(async () => listButton(r).props.onClick());
        expect(lists(r)).toHaveLength(1);
        await show(ind);
        expect(lists(r)).toHaveLength(0);
        await show(stk);
        expect(lists(r)).toHaveLength(1);
        expect(filledRows(r)).toHaveLength(2);
    });
    it('K 線載入中：明細數量顯示「…」，清單寫載入中而不是沒有成交', async () => {
        setNow('2026-10-08T09:16:00');
        let resolve!: (v: unknown) => void;
        fetchMock.mockReturnValue(new Promise((ok) => { resolve = ok; }));
        const r = mount({ contract: stk, trades: trades() }); await flush();
        expect(text(listButton(r))).toBe('明細 …');
        await act(async () => listButton(r).props.onClick());
        expect(text(lists(r)[0])).toContain('載入 K 線中…');
        expect(text(lists(r)[0])).not.toContain('沒有可顯示');
        await act(async () => resolve(DATA)); await flush();
        expect(text(listButton(r))).toBe('明細 2');
        expect(filledRows(r)).toHaveLength(2);
    });
    it('「明細」鈕的名稱包含可見文字（含筆數）；載入中與待確認時同樣是「…」', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: stk, trades: trades() }); await flush();
        expect(text(listButton(r))).toBe('明細 2');
        expect(listButton(r).props['aria-label']).toBe('成交明細 2');
        await act(async () => r.update(chart({ contract: stk, trades: trades(), fillsReady: false } as any)));
        expect(text(listButton(r))).toBe('明細 …');
        expect(listButton(r).props['aria-label']).toBe('成交明細 …');
    });
    it('明細清單可用鍵盤聚焦；展開時按鈕以 aria-controls 指向清單', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: fut, trades: [] }); await flush();
        expect(listButton(r).props['aria-controls']).toBeUndefined();
        await act(async () => listButton(r).props.onClick());
        const list = lists(r)[0]!;
        expect(list.props.tabIndex).toBe(0);
        expect(list.props.id).toEqual(expect.any(String));
        expect(listButton(r).props['aria-controls']).toBe(list.props.id);
        await act(async () => listButton(r).props.onClick());
        expect(listButton(r).props['aria-controls']).toBeUndefined();
    });
    it('成交來源未確認：工具列用 role=status 說明原因，明細按鈕與清單帶同一句；確認後消失', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const status = (r: ReactTestRenderer) => r.root.findAll(n => n.type === 'span' && n.props.role === 'status');
        const r = mount({ contract: stk, trades: trades(), fillsReady: false, fillsNote: '成交待對帳：串流中斷' }); await flush();
        expect(status(r).map(text)).toEqual(['成交待對帳：串流中斷']);
        expect(listButton(r).props.title).toContain('成交待對帳：串流中斷');
        expect(captured.groups).toEqual([]);
        await act(async () => listButton(r).props.onClick());
        expect(text(lists(r)[0])).toContain('成交待對帳：串流中斷');
        await act(async () => r.update(chart({ contract: stk, trades: trades(), fillsReady: false } as any)));
        expect(status(r).map(text)).toEqual(['成交待確認']); // 沒給原因就用預設說法
        await act(async () => r.update(chart({ contract: stk, trades: trades(), fillsReady: true } as any)));
        expect(status(r)).toHaveLength(0);
        expect(listButton(r).props.title).toBe('已載入 K 線範圍內的逐筆成交');
        expect(captured.groups).toHaveLength(1);
        // 這張圖沒有可查成交的帳戶時沒有東西被藏起來，不用常駐提示
        captured.account = null;
        await act(async () => r.update(chart({ contract: stk, trades: trades(), fillsReady: false, fillsNote: '成交待對帳' } as any)));
        expect(status(r)).toHaveLength(0);
    });
    it('成交數量和明細對不上（deal_quantity 2、deals 只有 1）：當成待對帳，不畫標記、明細不報數，說明缺漏與處置', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const status = (r: ReactTestRenderer) => r.root.findAll(n => n.type === 'span' && n.props.role === 'status');
        const short = trades(); short[0]!.status.deals = short[0]!.status.deals.slice(0, 1);
        const r = mount({ contract: stk, trades: short }); await flush(); // 來源已確認（fillsReady）
        expect(captured.groups).toEqual([]);
        expect(text(listButton(r))).toBe('明細 …');
        expect(status(r).map(text)).toEqual(['成交待對帳：成交明細缺漏']);
        expect(status(r)[0]!.props.title).toBe('可到委託分頁按更新');
        expect(listButton(r).props.title).toBe('成交待對帳：成交明細缺漏。確認前不顯示標記；可到委託分頁按更新。');
        await move(BAR);
        expect(tooltips(r)).toHaveLength(0);
        await act(async () => listButton(r).props.onClick());
        expect(filledRows(r)).toHaveLength(0);
        expect(text(lists(r)[0])).toContain('成交待對帳：成交明細缺漏');
        expect(text(lists(r)[0])).toContain('確認前不顯示成交；可到委託分頁按更新。');
        // 來源本身還沒確認時先講來源（連線），不講缺漏；處置沿用 LiveCandleChart 給的說法
        await act(async () => r.update(chart({ contract: stk, trades: short, fillsReady: false, fillsNote: '成交暫停：連線尚未就緒', fillsHint: '連線恢復後會自動確認' })));
        expect(status(r).map(text)).toEqual(['成交暫停：連線尚未就緒']);
        expect(status(r)[0]!.props.title).toBe('連線恢復後會自動確認');
        // 明細讀齊後恢復
        await act(async () => r.update(chart({ contract: stk, trades: trades() })));
        expect(status(r)).toHaveLength(0);
        expect(captured.groups).toHaveLength(1);
        expect(text(listButton(r))).toBe('明細 2');
    });
    it('處置說明：有 fillsHint 就用在明細鈕 title、工具列提示與清單；沒傳用預設的委託分頁更新', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const status = (r: ReactTestRenderer) => r.root.findAll(n => n.type === 'span' && n.props.role === 'status')[0]!;
        const r = mount({ contract: stk, trades: trades(), fillsReady: false, fillsNote: '成交暫停：連線尚未就緒', fillsHint: '連線恢復後會自動確認' }); await flush();
        expect(listButton(r).props.title).toBe('成交暫停：連線尚未就緒。確認前不顯示標記；連線恢復後會自動確認。');
        expect(status(r).props.title).toBe('連線恢復後會自動確認');
        await act(async () => listButton(r).props.onClick());
        expect(text(lists(r)[0])).toContain('確認前不顯示成交；連線恢復後會自動確認。');
        await act(async () => r.update(chart({ contract: stk, trades: trades(), fillsReady: false, fillsNote: '成交待對帳：串流中斷' })));
        expect(listButton(r).props.title).toBe('成交待對帳：串流中斷。確認前不顯示標記；可到委託分頁按更新。');
        expect(status(r).props.title).toBe('可到委託分頁按更新');
    });
    it('沒傳 fillsReady 就當成來源未確認（閘門預設是關的）：不畫標記、明細不報數、提示成交待確認', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: stk, trades: trades(), fillsReady: undefined }); await flush();
        expect(captured.groups).toEqual([]);
        expect(text(listButton(r))).toBe('明細 …');
        expect(r.root.findAll(n => n.type === 'span' && n.props.role === 'status').map(text)).toEqual(['成交待確認']);
        await act(async () => r.update(chart({ contract: stk, trades: trades() })));
        expect(captured.groups).toHaveLength(1);
        expect(text(listButton(r))).toBe('明細 2');
    });
    it('即時行情開出新 K 棒（barsRef 就地新增）後，落在該棒的成交才補上', async () => {
        setNow('2026-10-08T09:18:00'); fetchMock.mockResolvedValue(DATA);
        const late = trades();
        late[0]!.status.deal_quantity = 1;
        late[0]!.status.deals = [{ seq: 'late', price: 20020, quantity: 1, ts: Date.parse('2026-10-08T09:17:30+08:00') / 1000 }];
        const r = mount({ contract: stk, trades: late }); await flush();
        expect(captured.groups).toEqual([]); // 歷史只到 09:15，成交的 K 棒（09:20）還不存在
        expect(text(listButton(r))).toBe('明細 0'); // 盤中等待新棒，不算無對應 K 棒
        quote = { tick: { code: '2330', date: '2026-10-08', time: '09:17:40', close: 20020, volume: 3 }, seq: Math.random(), lastDir: 0, flashSeq: 0 };
        act(() => listeners.forEach((l) => l())); await flush();
        expect(captured.groups.map((g) => g.time)).toEqual([wall('2026-10-08T09:20:00')]);
        expect(filledRows(r)).toHaveLength(0); // 清單沒開
        await act(async () => listButton(r).props.onClick());
        expect(filledRows(r)).toHaveLength(1);
    });
    it('換商品、K 線還沒回來時，每次交給圖層的分組都是空的（不拿新商品配舊 K 棒）', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const other = trades(); other[0]!.contract = { ...stk, code: '2317' };
        const rows = [...trades(), ...other.map((t) => ({ ...t, order: { ...t.order, id: 'buy-2317' } }))];
        const r = mount({ contract: stk, trades: rows }); await flush();
        await act(async () => listButton(r).props.onClick());
        expect(captured.groups).toHaveLength(1);
        fetchMock.mockReturnValue(new Promise(() => {})); // 2317 的歷史永遠不回來
        const before = captured.history.length;
        await act(async () => r.update(chart({ contract: { ...stk, code: '2317' }, trades: rows })));
        await flush();
        expect(captured.history.length).toBeGreaterThan(before);
        expect(captured.history.slice(before).every((groups) => groups.length === 0)).toBe(true);
        expect(filledRows(r)).toHaveLength(0);
        expect(text(lists(r)[0])).toContain('載入 K 線中…');
    });
    it('無障礙語意：圖例列名稱鈕與齒輪 aria-haspopup／aria-expanded、眼睛的名稱跟著狀態換、明細 aria-expanded、清單 region 名稱與欄位 scope', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const onFillsChange = vi.fn();
        const r = mount({ contract: stk, trades: trades(), fills: 'on', onFillsChange }); await flush();
        expect(legendNames(r)).toEqual(['成交', '隱藏成交標記', '成交標記設定', '移除成交標記']);
        expect(['成交', '成交標記設定'].map((name) => legendBtn(r, name).props['aria-haspopup'])).toEqual(['dialog', 'dialog']);
        expect(['成交', '成交標記設定'].map((name) => legendBtn(r, name).props['aria-expanded'])).toEqual([false, false]);
        // 名稱鈕的說明講的是點了會做的事（開設定面板）
        expect(legendBtn(r, '成交').props.title).toContain('點一下設定形狀、標籤與顏色');
        await press(r, '成交');
        expect(panel(r)!.props.role).toBe('dialog');
        expect(['成交', '成交標記設定'].map((name) => legendBtn(r, name).props['aria-expanded'])).toEqual([true, true]);
        await press(r, '成交');
        expect(listButton(r).props['aria-expanded']).toBe(false);
        await act(async () => listButton(r).props.onClick());
        expect(listButton(r).props['aria-expanded']).toBe(true);
        const list = lists(r)[0]!;
        expect(list.props.role).toBe('region');
        expect(list.props['aria-label']).toBe('已載入成交明細');
        expect(r.root.findAll((n) => n.type === 'th').map((n) => n.props.scope)).toEqual(['col', 'col', 'col', 'col']);
        await press(r, '隱藏成交標記');
        expect(onFillsChange).toHaveBeenCalledWith('hidden');
        await act(async () => r.update(chart({ contract: stk, trades: trades(), fills: 'hidden', onFillsChange })));
        expect(legendNames(r)).toEqual(['成交', '顯示成交標記', '成交標記設定', '移除成交標記']); // 眼睛的名稱說的是按下去會做的事
        expect(r.root.findAll((n) => n.type === 'button' && String(n.props['aria-label'] ?? '').startsWith('成交明細'))).toHaveLength(0); // 隱藏後明細鈕也收起
    });
    // 同一根 K 棒（09:05）、不同價格的一筆委託，用來分辨顯示的是哪個帳戶／哪一批成交
    const tradeAt = (account: typeof A, price: number, id: string, action: 'Buy' | 'Sell' = 'Buy', date = '2026-10-08T09:02:30'): AccountedTrade => {
        const base = trades(account)[0]!;
        return { ...base, order: { ...base.order, id, action },
            status: { ...base.status, id, deal_quantity: 1, deals: [{ seq: `${id}-1`, price, quantity: 1, ts: Date.parse(`${date}+08:00`) / 1000 }] } };
    };
    it('顯示的是這張圖帳戶自己的成交：換帳戶換成交價，新的 trades 陣列（新成交）立即上圖', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const rows = [tradeAt(A, 20010, 'a'), tradeAt(B, 20020, 'b')];
        const r = mount({ contract: stk, trades: rows }); await flush();
        expect(captured.groups.map((g) => g.price)).toEqual([20010]);
        captured.account = B;
        await act(async () => r.update(chart({ contract: stk, trades: rows })));
        expect(captured.groups.map((g) => g.price)).toEqual([20020]);
        await act(async () => listButton(r).props.onClick());
        expect(filledRows(r).map((row) => JSON.parse(row.props['data-fill-id'])[2])).toEqual(['2222207']); // B 的帳號
        // 只換 trades（新成交回報），沒有任何 K 棒變動
        await act(async () => r.update(chart({ contract: stk, trades: [...rows, tradeAt(B, 20030, 'b2', 'Sell', '2026-10-08T09:07:30')] })));
        expect(captured.groups.map((g) => [g.action, g.price])).toEqual([['Buy', 20020], ['Sell', 20030]]);
    });
    it('這張圖沒有帳戶時不顯示任何人的成交，也不退而求其次用 trades 裡的帳戶', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        captured.account = null;
        const r = mount({ contract: stk, trades: [tradeAt(A, 20010, 'a')] }); await flush();
        expect(captured.groups).toEqual([]);
        await act(async () => listButton(r).props.onClick());
        expect(filledRows(r)).toHaveLength(0);
        expect(text(lists(r)[0])).toContain('請先選擇圖表帳戶以查看成交。');
    });
    it('彈出視窗（沒傳 onFillsChange）的圖例列用元件內狀態，fills 只當起始值', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: stk, trades: trades() }); await flush();
        expect(legendNames(r)).toContain('隱藏成交標記');
        expect(captured.groups).toHaveLength(1);
        await press(r, '隱藏成交標記');
        expect(legendNames(r)).toContain('顯示成交標記'); // 隱藏中：列還在
        expect(captured.groups).toEqual([]);
        await press(r, '顯示成交標記');
        expect(legendNames(r)).toContain('隱藏成交標記');
        expect(captured.groups).toHaveLength(1);
        await press(r, '移除成交標記');
        expect(legend(r)).toBeUndefined();
        expect(captured.groups).toEqual([]);
        // 沒有 onFillsChange 時 fills 只在掛載時讀一次，之後照樣能自己切換
        const hidden = mount({ contract: stk, trades: trades(), fills: 'hidden' }); await flush();
        expect(legendNames(hidden)).toContain('顯示成交標記');
        await press(hidden, '顯示成交標記');
        expect(legendNames(hidden)).toContain('隱藏成交標記');
        const off = mount({ contract: stk, trades: trades(), fills: 'off' }); await flush();
        expect(legend(off)).toBeUndefined();
    });
    it('僅日盤＋日 K：夜盤成交不上日盤那根 K 棒（dayOnly 一路傳到成交投影）', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const futAccount = { ...A, account_type: 'F' };
        captured.futuresAccount = futAccount;
        const day = tradeAt(futAccount, 20003, 'day'); day.contract = fut;
        const night = tradeAt(futAccount, 20009, 'night', 'Buy', '2026-10-08T21:30:00'); night.contract = fut;
        const onSessionModeChange = vi.fn(); // 受控模式：sessionMode 由外部決定
        const r = mount({ contract: fut, trades: [day, night], sessionMode: 'day', onSessionModeChange }); await flush();
        await act(async () => r.root.findAll((n) => n.type === 'button' && n.children.join('') === '1D')[0]!.props.onClick());
        await flush();
        expect(captured.groups.map((g) => g.price)).toEqual([20003]);
        // 全盤時兩筆都在同一根日 K 上
        await act(async () => r.update(chart({ contract: fut, trades: [day, night], sessionMode: 'all', onSessionModeChange } as any)));
        await flush();
        // 同一根日 K、同方向不同價：合成一組，兩個價位都在
        expect(captured.groups.flatMap((g) => g.members?.map((m: any) => m.price) ?? [g.price]).sort()).toEqual([20003, 20009]);
    });
    it('tooltip 的帳號隱私遮罩與買賣顏色：隱私模式遮帳號，買賣色與交給圖層的一致', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const rows = [tradeAt(A, 20010, 'a'), tradeAt(A, 20011, 'b', 'Sell')];
        const r = mount({ contract: stk, trades: rows }); await flush();
        await move(BAR);
        const tip = tooltips(r)[0]!;
        expect(text(tip)).toContain('帳戶 1111121');
        const [buy, sell] = tip.findAll((n) => n.type === 'td' && n.props.style?.color).map((n) => [text(n), n.props.style.color]);
        expect(buy).toEqual(['▲ 買', captured.style.up]);
        expect(sell).toEqual(['▼ 賣', captured.style.down]);
        expect(captured.style.up).not.toBe(captured.style.down);
        act(() => setPrivacyMode(true));
        await move(undefined); await move(BAR);
        expect(text(tooltips(r)[0])).toContain('帳戶 •••••21');
        expect(text(tooltips(r)[0])).not.toContain('1111121');
    });
    it('更新歷史（同組重載）期間明細數維持，不閃成「…」；組合商品沒有成交控制（圖例列、明細鈕）', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: stk, trades: trades() }); await flush();
        expect(text(listButton(r))).toBe('明細 2');
        fetchMock.mockReturnValue(new Promise(() => {})); // 重載一直沒回來
        await act(async () => r.root.findAll((n) => n.type === 'button' && n.props['aria-label'] === '更新歷史')[0]!.props.onClick());
        await flush();
        expect(text(listButton(r))).toBe('明細 2');
        expect(legend(r)).toBeDefined();
        const combo = mount({ contract: { ...stk, combo: { legs: [] } }, trades: trades() }); await flush();
        expect(legend(combo)).toBeUndefined();
        expect(combo.root.findAll((n) => n.type === 'button' && String(n.props['aria-label'] ?? '').startsWith('成交明細'))).toHaveLength(0);
    });
    it('權證圖（WRT，或代號在權證區間的 STK）沒有成交控制，也不畫', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        for (const contract of [{ ...stk, code: '030001', security_type: 'WRT' }, { ...stk, code: '030001' }]) {
            // 委託和圖表是同一個合約：拿掉權證條件就會畫出來
            const r = mount({ contract, trades: trades().map(t => ({ ...t, contract })) }); await flush();
            expect(legend(r)).toBeUndefined();
            expect(r.root.findAll((n) => n.type === 'button' && String(n.props['aria-label'] ?? '').startsWith('成交明細'))).toHaveLength(0);
            await move(BAR);
            expect(tooltips(r)).toHaveLength(0);
            expect(captured.groups).toEqual([]);
        }
    });
    it('窄面板（圖表區小於 380px）的 tooltip 省略月日，寬面板維持完整時間', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: stk, trades: trades() }); await flush();
        resizeTo(800);
        await move(BAR);
        expect(text(tooltips(r)[0])).toContain('10-08 09:02:30');
        resizeTo(300);
        await move(BAR);
        expect(text(tooltips(r)[0])).toContain('09:02:30');
        expect(text(tooltips(r)[0])).not.toContain('10-08');
        // 明細清單永遠是完整時間
        await act(async () => listButton(r).props.onClick());
        expect(text(lists(r)[0])).toContain('10-08 09:02:30');
    });
    it('樣式設定即時生效：圖層收到 style，標籤字串跟著換；價位最少位數沿用圖表的價格位數', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const rows = trades(); rows[0]!.status.deals[0]!.price = 31.5; // 31.5 的跳動 0.05：兩位小數
        rows[0]!.status.deals[1]!.ts += 300; // 第二筆移到下一根，各自是單價組
        mount({ contract: stk, trades: rows }); await flush();
        expect(captured.style.style).toBe('price');
        expect(captured.groups.map((g) => g.text)).toEqual(['31.50', '20,003']);
        act(() => setChartFillStyle('side'));
        expect(captured.style.style).toBe('side');
        expect(captured.groups.map((g) => g.text)).toEqual(['買', '買']);
        act(() => setChartFillStyle('dot'));
        expect(captured.style.style).toBe('dot');
        expect(captured.groups.map((g) => g.text)).toEqual([null, null]);
    });
    it('全部帳戶：同市場所有可交易帳戶的成交合併成點，明細與 tooltip 逐筆列出帳戶（套隱私遮罩），不收其他市場的帳戶', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        captured.futuresAccount = { ...A, account_type: 'F', account_id: '3333333' };
        const rows = [tradeAt(A, 20010, 'a'), tradeAt(B, 20010, 'b'), tradeAt(captured.futuresAccount, 20020, 'f')];
        act(() => setChartFillScope('all'));
        const r = mount({ contract: stk, trades: rows }); await flush();
        expect(captured.groups).toMatchObject([{ key: KEY('Buy', 20010), text: '20,010 2張' }]);
        expect(text(listButton(r))).toBe('明細 2');
        await act(async () => listButton(r).props.onClick());
        const list = lists(r)[0]!;
        expect(filledRows(r).map((row) => text(row.findAll((n) => n.type === 'td').at(-1)))).toEqual(['1111121', '2222207']);
        expect(text(list)).toContain('全部帳戶');
        expect(text(list)).not.toContain('帳戶 1111121');
        act(() => setPrivacyMode(true));
        expect(text(lists(r)[0])).not.toMatch(/1111121|2222207/);
        await act(async () => listButton(r).props.onClick());
        await move(BAR);
        expect(text(tooltips(r)[0])).toContain('此 K 棒成交 · 2 筆／2 張');
        expect(text(tooltips(r)[0])).toContain('•••••07');
        // 切回目前帳戶：只剩 A
        act(() => setChartFillScope('active'));
        expect(captured.groups).toMatchObject([{ key: KEY('Buy', 20010), text: '20,010' }]);
    });
    it('全部帳戶時沒有選定帳戶也照常顯示，待確認提示照常出現', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        captured.account = null;
        act(() => setChartFillScope('all'));
        const r = mount({ contract: stk, trades: [tradeAt(A, 20010, 'a')] }); await flush();
        expect(captured.groups).toHaveLength(1);
        await act(async () => r.update(chart({ contract: stk, trades: [tradeAt(A, 20010, 'a')], fillsReady: false })));
        expect(r.root.findAll((n) => n.type === 'span' && n.props.role === 'status').map(text)).toEqual(['成交待確認']);
        await act(async () => listButton(r).props.onClick());
        expect(text(lists(r)[0])).not.toContain('請先選擇圖表帳戶');
    });
    it('待確認時保留上次確認的淡色標記：明細「…」、提示與標題說明顯示的是上次確認的成交、清單不列舊明細；不可保留、換環境或換週期就清空', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const status = (r: ReactTestRenderer) => r.root.findAll(n => n.type === 'span' && n.props.role === 'status');
        const props = { contract: stk, trades: trades(), fillsRetain: true, fillsEnv: 'sim' };
        const r = mount(props); await flush();
        expect(captured.groups).toHaveLength(1);
        await act(async () => r.update(chart({ ...props, fillsReady: false, fillsNote: '成交待對帳：串流中斷' })));
        expect(captured.groups).toMatchObject([{ key: KEY('Buy', 20003), dimmed: true }]);
        expect(text(listButton(r))).toBe('明細 …');
        expect(status(r).map(text)).toEqual(['成交待對帳：串流中斷（顯示的是上次確認的成交）']);
        expect(listButton(r).props.title).toBe('成交待對帳：串流中斷（顯示的是上次確認的成交）。確認前不列明細；可到委託分頁按更新。');
        await act(async () => listButton(r).props.onClick());
        expect(filledRows(r)).toHaveLength(0);
        expect(text(lists(r)[0])).toContain('（顯示的是上次確認的成交）');
        await move(BAR);
        expect(tooltips(r)).toHaveLength(0);
        // 彈出視窗的主視窗關閉：立即清空，提示回到一般說法
        await act(async () => r.update(chart({ ...props, fillsReady: false, fillsRetain: false })));
        expect(captured.groups).toEqual([]);
        expect(status(r).map(text)).toEqual(['成交待確認']);
        // 模擬 → 正式（待確認）→ 模擬：換成另一個已知環境就清空，切回也不復活
        await act(async () => r.update(chart(props)));
        await act(async () => r.update(chart({ ...props, fillsReady: false, fillsEnv: 'prod' })));
        expect(captured.groups).toEqual([]);
        await act(async () => r.update(chart({ ...props, fillsReady: false })));
        expect(captured.groups).toEqual([]);
        // 重新確認後換週期（仍待確認）：不帶到新週期
        await act(async () => r.update(chart(props)));
        expect(captured.groups).toHaveLength(1);
        await act(async () => r.update(chart({ ...props, fillsReady: false })));
        expect(captured.groups).toHaveLength(1);
        await act(async () => r.root.findAll(n => n.type === 'button' && n.children.join('') === '1m')[0]!.props.onClick());
        await flush();
        expect(captured.groups).toEqual([]);
    });
    it('圖上沒有對應 K 棒的成交（盤後）不交給圖層，列在明細最後並計入明細數；日 K 有那根就上圖', async () => {
        setNow('2026-10-08T14:40:00'); fetchMock.mockResolvedValue(DATA);
        const rows = trades();
        rows[0]!.status.deal_quantity = 3;
        rows[0]!.status.deals.push({ seq: 'late', price: 20005, quantity: 1, ts: Date.parse('2026-10-08T14:30:00+08:00') / 1000 });
        const r = mount({ contract: stk, trades: rows }); await flush();
        expect(captured.groups.map((g) => g.time)).toEqual([BAR]);
        expect(text(listButton(r))).toBe('明細 3');
        await act(async () => listButton(r).props.onClick());
        expect(filledRows(r).map((row) => JSON.parse(row.props['data-fill-id']).at(-1))).toEqual(['d1', 'd2', 'late']);
        expect(text(lists(r)[0])).toContain('2 筆（圖上）＋1 筆無對應 K 棒');
        expect(text(lists(r)[0])).toContain('圖上無對應 K 棒（例如盤後）');
        // 待確認時不列（含無對應 K 棒）
        await act(async () => r.update(chart({ contract: stk, trades: rows, fillsReady: false })));
        expect(filledRows(r)).toHaveLength(0);
        expect(text(lists(r)[0])).not.toContain('無對應');
        await act(async () => r.update(chart({ contract: stk, trades: rows })));
        // 換週期、新週期的 K 線還沒回來：不拿舊 K 棒分類，數字是「…」
        let resolve!: (v: unknown) => void;
        fetchMock.mockReturnValue(new Promise((ok) => { resolve = ok; }));
        await act(async () => r.root.findAll((n) => n.type === 'button' && n.children.join('') === '1D')[0]!.props.onClick());
        await flush();
        expect(text(listButton(r))).toBe('明細 …');
        expect(filledRows(r)).toHaveLength(0);
        expect(text(lists(r)[0])).not.toContain('無對應');
        await act(async () => resolve(DATA)); await flush();
        expect(captured.groups.flatMap((g) => g.members?.map((m: any) => m.price) ?? [g.price]).sort()).toEqual([20003, 20005]);
        expect(text(listButton(r))).toBe('明細 3');
        expect(text(lists(r)[0])).not.toContain('無對應');
    });
    it('環境已知、固定的帳戶不再可交易：不畫那個帳戶保留的淡色標記', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const props = { contract: stk, trades: trades(A), fillsRetain: true, fillsEnv: 'sim',
            orderSettings: { S: { accountKey: 'S:B:1111121' } }, onOrderSettingsChange: () => {} };
        const r = mount(props); await flush();
        expect(captured.groups).toHaveLength(1);
        // 帳戶清單重新載入後沒有 A：委託快照作廢（待確認），這張圖解析不到帳戶
        captured.accounts = [B];
        await act(async () => r.update(chart({ ...props, fillsReady: false, fillsNote: '成交待確認：委託尚未讀回' })));
        await flush();
        expect(captured.groups).toEqual([]);
    });
    it('斷線時帳戶暫時解析不出來、圖上保留淡色標記：工具列照樣提示待確認，清單不叫人先選帳戶', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const status = (r: ReactTestRenderer) => r.root.findAll(n => n.type === 'span' && n.props.role === 'status');
        const props = { contract: stk, trades: trades(A), fillsRetain: true, fillsEnv: 'sim' };
        const r = mount(props); await flush();
        expect(captured.groups).toHaveLength(1);
        // 環境未知時未簽署的模擬帳戶不可交易 → 解析不到帳戶
        captured.account = null;
        captured.accounts = [];
        await act(async () => r.update(chart({ ...props, fillsEnv: null, fillsReady: false, fillsNote: '成交待對帳：串流中斷' })));
        await flush();
        expect(captured.groups).toEqual([expect.objectContaining({ dimmed: true })]);
        expect(status(r).map(text)).toEqual(['成交待對帳：串流中斷（顯示的是上次確認的成交）']);
        await act(async () => listButton(r).props.onClick());
        expect(text(lists(r)[0])).toContain('成交待對帳：串流中斷（顯示的是上次確認的成交）');
        expect(text(lists(r)[0])).not.toContain('請先選擇圖表帳戶');
    });
    it('同一根同方向多個價位：交給圖層的是一組（三角形在最低買價、均價標籤），滑過的提示框多一行均價摘要', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: stk, trades: [...trades(), tradeAt(A, 20010, 'x')] }); await flush();
        expect(captured.groups).toHaveLength(1);
        expect(captured.groups[0]).toMatchObject({ time: BAR, price: 20003, action: 'Buy', text: '均 20,005.3 3張' });
        expect(captured.groups[0].members.map((m: any) => m.price)).toEqual([20003, 20010]);
        await move(BAR);
        expect(text(tooltips(r)[0])).toContain('▲ 買 3 張 · 均 20,005.3 · 20,003～20,010');
        expect(text(tooltips(r)[0])).toContain('此 K 棒成交 · 3 筆／3 張');
    });
    // 明細的「這根 K 棒」：提示框真的出現、停留夠久才記下那根，打開清單時標示（用一次就忘）
    const focusLine = (r: ReactTestRenderer) => r.root.findAll(n => n.type === 'div' && n.props['data-fill-focus'])[0];
    const currentRows = (r: ReactTestRenderer) => r.root.findAll(n => n.type === 'tr' && n.props['aria-current'] === 'true');
    const clearButton = (r: ReactTestRenderer) => r.root.findAll(n => n.type === 'button' && n.props['aria-label'] === '取消標示這根 K 棒')[0];
    const click = (r: ReactTestRenderer, label: string) => act(async () => r.root.findAll(n => n.type === 'button' && text(n) === label)[0]!.props.onClick());
    // 停留：這次十字線事件時，時間已經過了 1 秒（夠過停留門檻）
    const dwell = async (time: number | undefined) => {
        const now = performance.now();
        const spy = vi.spyOn(performance, 'now').mockReturnValue(now + 1000);
        try { await move(time); } finally { spy.mockRestore(); }
    };
    // 滑過那根、停夠久 → 游標移到工具列（十字線已清掉 hover）→ 按「明細」
    const openFocused = async (r: ReactTestRenderer) => {
        await move(BAR);
        await dwell(undefined);
        await act(async () => listButton(r).props.onClick());
    };
    it('滑過有成交的 K 棒再按「明細」：清單頂端摘要那根、標亮那幾列，價格位數同圖表', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: stk, trades: trades() }); await flush();
        await openFocused(r);
        expect(text(focusLine(r))).toContain('09:05 這根：▲ 買 2 張 · 20,003');
        expect(currentRows(r)).toHaveLength(2);
        // 清單的說明是摘要那段，不含「×」按鈕
        const described = String(lists(r)[0]!.props['aria-describedby']);
        expect(text(focusLine(r)!.find((n) => n.props.id === described))).toBe('09:05 這根：▲ 買 2 張 · 20,003');
        // 股票 10～50 元跳動 0.05：摘要行和圖表一樣 2 位
        const cheap = trades();
        cheap[0]!.status.deals = cheap[0]!.status.deals.map((d) => ({ ...d, price: 31.5 }));
        const s = mount({ contract: stk, trades: cheap }); await flush();
        await openFocused(s);
        expect(text(focusLine(s))).toContain('09:05 這根：▲ 買 2 張 · 31.50');
    });
    it('沒有滑過直接按「明細」：沒有摘要行、沒有標亮', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: stk, trades: trades() }); await flush();
        await act(async () => listButton(r).props.onClick());
        expect(filledRows(r)).toHaveLength(2);
        expect(focusLine(r)).toBeUndefined();
        expect(currentRows(r)).toHaveLength(0);
    });
    it('移到工具列途中掠過別根不算查看：標示的是停留過的那根', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: stk, trades: [...trades(), tradeAt(A, 20010, 'x', 'Sell', '2026-10-08T09:07:30')] }); await flush();
        // 時間只往前走：在 BAR 停 1 秒 → 掠過 BAR + 300 只停 100ms → 移開 → 過 500ms 才按（掠過那根出現已超過門檻，但它停不到就消失了）
        const start = performance.now();
        const clock = vi.spyOn(performance, 'now').mockReturnValue(start);
        try {
            await move(BAR);
            clock.mockReturnValue(start + 1000);
            await move(BAR + 300);
            expect(tooltips(r)).toHaveLength(1);
            clock.mockReturnValue(start + 1100);
            await move(undefined);
            clock.mockReturnValue(start + 1600);
            await act(async () => listButton(r).props.onClick());
        } finally { clock.mockRestore(); }
        expect(text(focusLine(r))).toContain('09:05 這根：▲ 買 2 張 · 20,003');
    });
    it('滑鼠停在那根、用鍵盤按「明細」：停夠久就標示那根，剛滑到不算', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: stk, trades: trades() }); await flush();
        await move(BAR);
        await act(async () => listButton(r).props.onClick());
        expect(focusLine(r)).toBeUndefined();
        const s = mount({ contract: stk, trades: trades() }); await flush();
        await move(BAR);
        const spy = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 1000);
        try { await act(async () => listButton(s).props.onClick()); } finally { spy.mockRestore(); }
        expect(text(focusLine(s))).toContain('09:05 這根：▲ 買 2 張 · 20,003');
        // 先在別根停夠久、再停在這根：按下時停著的那根優先於先前查看的
        const u = mount({ contract: stk, trades: [...trades(), tradeAt(A, 20010, 'x', 'Sell', '2026-10-08T09:07:30')] }); await flush();
        const start = performance.now();
        const clock = vi.spyOn(performance, 'now').mockReturnValue(start);
        try {
            await move(BAR + 300);
            clock.mockReturnValue(start + 1000);
            await move(BAR);
            clock.mockReturnValue(start + 2000);
            await act(async () => listButton(u).props.onClick());
        } finally { clock.mockRestore(); }
        expect(text(focusLine(u))).toContain('09:05 這根：▲ 買 2 張 · 20,003');
    });
    it('用一次就忘：關掉再開（中間沒滑過）不再標示；清單開著時滑過不算查看', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: stk, trades: trades() }); await flush();
        await openFocused(r);
        expect(focusLine(r)).toBeDefined();
        await act(async () => listButton(r).props.onClick());
        await act(async () => listButton(r).props.onClick());
        expect(lists(r)).toHaveLength(1);
        expect(focusLine(r)).toBeUndefined();
        expect(currentRows(r)).toHaveLength(0);
        // 清單開著時滑過（提示框不出現）
        const s = mount({ contract: stk, trades: trades() }); await flush();
        await act(async () => listButton(s).props.onClick());
        await move(BAR);
        expect(tooltips(s)).toHaveLength(0);
        await dwell(undefined);
        await act(async () => listButton(s).props.onClick());
        await act(async () => listButton(s).props.onClick());
        expect(focusLine(s)).toBeUndefined();
    });
    it('點價武裝時滑過（提示框不出現）不算查看：解除後按「明細」沒有摘要行', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: stk, trades: trades() }); await flush();
        await click(r, '點價買');
        await move(BAR);
        expect(tooltips(r)).toHaveLength(0);
        await dwell(undefined);
        await click(r, '點價買');
        await act(async () => listButton(r).props.onClick());
        expect(lists(r)).toHaveLength(1);
        expect(focusLine(r)).toBeUndefined();
    });
    it('按摘要行的「×」：摘要行與標亮消失，清單仍開著', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: stk, trades: trades() }); await flush();
        await openFocused(r);
        expect(currentRows(r)).toHaveLength(2);
        await act(async () => clearButton(r)!.props.onClick());
        expect(focusLine(r)).toBeUndefined();
        expect(currentRows(r)).toHaveLength(0);
        expect(lists(r)).toHaveLength(1);
    });
    it.each<[string, (r: ReactTestRenderer, props: any) => Promise<void>, (r: ReactTestRenderer, props: any) => Promise<void>]>([
        ['換週期', (r) => click(r, '1m'), (r) => click(r, '5m')],
        ['換帳戶', (r, props) => { captured.account = B; return act(async () => r.update(chart(props))); },
            (r, props) => { captured.account = A; return act(async () => r.update(chart(props))); }],
        ['切全部帳戶', async () => act(() => setChartFillScope('all')), async () => act(() => setChartFillScope('active'))],
        ['換商品', (r, props) => act(async () => r.update(chart({ ...props, contract: { ...stk, code: '2317' } }))),
            (r, props) => act(async () => r.update(chart(props)))],
    ])('%s就取消這根 K 棒，換回原值也不復活', async (_name, change, back) => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const props = { contract: stk, trades: trades() };
        const r = mount(props); await flush();
        await openFocused(r);
        expect(focusLine(r)).toBeDefined();
        await change(r, props); await flush();
        expect(focusLine(r)).toBeUndefined();
        await back(r, props); await flush();
        expect(lists(r)).toHaveLength(1);
        expect(filledRows(r)).toHaveLength(2); // 換回來那根的成交還在
        expect(focusLine(r)).toBeUndefined();
        expect(currentRows(r)).toHaveLength(0);
    });
    it('寬提示框（圖表區 ≥ 380px）全部帳戶：帳戶也放第二列，第一列只有四格', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        act(() => setChartFillScope('all'));
        setPrivacyMode(true);
        const r = mount({ contract: stk, trades: [tradeAt(A, 20010, 'a'), tradeAt(B, 20010, 'b')] }); await flush();
        resizeTo(400);
        await move(BAR);
        const tip = tooltips(r)[0]!;
        const first = tip.findAll(n => n.type === 'tr' && n.props['data-fill-id']);
        expect(first).toHaveLength(2);
        for (const row of first) {
            expect(row.findAll(n => n.type === 'td')).toHaveLength(4);
            expect(text(row)).not.toContain('•••••');
        }
        expect(tip.findAll(n => n.type === 'tr' && !n.props['data-fill-id']).map(text).sort()).toEqual(['帳戶 •••••07', '帳戶 •••••21']);
    });
    it('畫圖工具開著時滑過（提示框不出現）不算查看：收起工具後按「明細」沒有摘要行', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: stk, trades: trades() }); await flush();
        const tool = (label: string) => act(async () => r.root.findAll(n => n.type === 'button' && String(n.props['aria-label'] ?? '').startsWith(label))[0]!.props.onClick());
        await tool('線條：');
        await move(BAR);
        expect(tooltips(r)).toHaveLength(0);
        await dwell(undefined);
        await tool('游標');
        await act(async () => listButton(r).props.onClick());
        expect(lists(r)).toHaveLength(1);
        expect(focusLine(r)).toBeUndefined();
    });
    it('報價重繪不會把停留起點歸零：滑到那根 200ms 時來一跳報價，350ms 按「明細」仍標示那根', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: stk, trades: trades() }); await flush();
        const start = performance.now();
        const clock = vi.spyOn(performance, 'now').mockReturnValue(start);
        try {
            await move(BAR);
            clock.mockReturnValue(start + 200);
            quote = { tick: { code: '2330', date: '2026-10-08', time: '09:15:40', close: 20020, volume: 3 }, seq: Math.random(), lastDir: 0, flashSeq: 0 };
            act(() => listeners.forEach((l) => l())); await flush();
            expect(tooltips(r)).toHaveLength(1);
            clock.mockReturnValue(start + 350);
            await act(async () => listButton(r).props.onClick());
        } finally { clock.mockRestore(); }
        expect(text(focusLine(r))).toContain('09:05 這根：▲ 買 2 張 · 20,003');
    });
    it('清單開著、有摘要行時，報價每跳清單收到的 props 都和上次相同（memo 不重繪）', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: stk, trades: trades() }); await flush();
        await openFocused(r);
        const before = lists(r)[0]!.parent!.props;
        quote = { tick: { code: '2330', date: '2026-10-08', time: '09:15:40', close: 20020, volume: 3 }, seq: Math.random(), lastDir: 0, flashSeq: 0 };
        act(() => listeners.forEach((l) => l())); await flush();
        const after = lists(r)[0]!.parent!.props;
        expect(Object.keys(after)).toEqual(Object.keys(before));
        for (const key of Object.keys(before)) expect(after[key], key).toBe(before[key]);
        expect(focusLine(r)).toBeDefined();
    });

    // ── 圖例列與設定面板 ──
    // [形狀, 名稱, 買的示意字元, 賣的示意字元]：圓點與菱形不分方向，賣方用空心
    const GLYPHS = [['triangle', '三角形', '▲', '▼'], ['arrow', '箭頭', '↑', '↓'], ['circle', '圓點', '●', '○'], ['diamond', '菱形', '◆', '◇']] as const;
    // 圖例列的示意字元（各自上色，後面的「買」「賣」兩字用前景色）：[字元, 顏色]
    const glyphs = (r: ReactTestRenderer) => legend(r)!.findAll((n) => n.type === 'span' && n.props.style?.color).map((n) => [text(n), n.props.style.color]);

    it('圖例列三種狀態：on 有示意與筆數；hidden 只剩名稱（轉灰）與三顆鈕，不畫、沒有明細與提示框；off 整列消失', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const props = { contract: stk, trades: trades(), onFillsChange: vi.fn() };
        const r = mount(props); await flush(); // 沒傳 fills：預設 on
        // 這列在圖表區裡：標成畫圖的浮動層，按在上面不會被委託線拖曳或畫圖工具接走
        expect(legend(r)!.props['data-drawing-overlay']).toBe('');
        const show = async (fills: ChartFillsState | undefined) => { await act(async () => r.update(chart({ ...props, fills }))); await flush(); };
        const countClasses = () => classes(legend(r)!.findAll((n) => n.type === 'span' && /筆$/.test(text(n))).at(-1)!);
        for (const fills of [undefined, 'on'] as const) {
            await show(fills);
            expect(legend(r)!.props.className).toBe(chartStyles.legendItem.normal);
            expect(legendText(r)).toBe('成交▲買▼賣2筆');
            expect(legendNames(r)).toEqual(['成交', '隱藏成交標記', '成交標記設定', '移除成交標記']);
            expect(classes(legendBtn(r, '成交'))).not.toContain(fillStyles.muted);
            expect(countClasses()).toContain(fillStyles.muted); // 筆數是次要資訊
            expect(captured.groups).toHaveLength(1);
            expect(text(listButton(r))).toBe('明細 2');
        }
        // 隱藏中：列留著、不整列變淡（控制鈕要看得清楚），只有名稱轉灰，眼睛換成「顯示」
        await show('hidden');
        expect(legend(r)!.props.className).toBe(chartStyles.legendItem.normal);
        expect(classes(legendBtn(r, '成交'))).toContain(fillStyles.muted);
        expect(legendText(r)).toBe('成交');
        expect(legendNames(r)).toEqual(['成交', '顯示成交標記', '成交標記設定', '移除成交標記']);
        expect(captured.groups).toEqual([]);
        expect(listButton(r)).toBeUndefined();
        await move(BAR);
        expect(tooltips(r)).toHaveLength(0);
        // 已移除：整列消失（從「指標」加回）
        await show('off');
        expect(legend(r)).toBeUndefined();
        expect(captured.groups).toEqual([]);
        expect(listButton(r)).toBeUndefined();
        await move(undefined); await move(BAR);
        expect(tooltips(r)).toHaveLength(0);
        await show('on');
        expect(legendText(r)).toBe('成交▲買▼賣2筆');
        expect(captured.groups).toHaveLength(1);
    });
    it('眼睛在顯示與隱藏之間切換、× 從這張圖移除：交回工作區的狀態依序是 hidden、on、off；隱藏中按 × 也是 off', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const log: ChartFillsState[] = [];
        const r = mountWorkspace({ contract: stk, trades: trades() }, log); await flush();
        await press(r, '隱藏成交標記');
        expect(log).toEqual(['hidden']);
        expect(captured.groups).toEqual([]);
        await press(r, '顯示成交標記');
        expect(log).toEqual(['hidden', 'on']);
        expect(captured.groups).toHaveLength(1);
        await press(r, '移除成交標記');
        expect(log).toEqual(['hidden', 'on', 'off']);
        expect(legend(r)).toBeUndefined();
        expect(captured.groups).toEqual([]);
        const hiddenLog: ChartFillsState[] = [];
        const hidden = mountWorkspace({ contract: stk, trades: trades(), initial: 'hidden' }, hiddenLog); await flush();
        await press(hidden, '移除成交標記');
        expect(hiddenLog).toEqual(['off']);
        expect(legend(hidden)).toBeUndefined();
    });
    it('圖例列的筆數和工具列明細數相同（K 線載入中、成交待確認是「…」）；示意字元跟著形狀偏好換、顏色和圖層相同', async () => {
        setNow('2026-10-08T09:16:00');
        let resolve!: (v: unknown) => void;
        fetchMock.mockReturnValue(new Promise((ok) => { resolve = ok; }));
        const r = mount({ contract: stk, trades: trades() }); await flush();
        const counts = () => [legendText(r).replace(/^.*賣/, ''), text(listButton(r))];
        expect(counts()).toEqual(['…筆', '明細 …']); // K 線載入中
        await act(async () => resolve(DATA)); await flush();
        expect(counts()).toEqual(['2筆', '明細 2']);
        await act(async () => r.update(chart({ contract: stk, trades: trades(), fillsReady: false })));
        expect(counts()).toEqual(['…筆', '明細 …']); // 成交來源待確認
        await act(async () => r.update(chart({ contract: stk, trades: trades() })));
        for (const [shape, , buy, sell] of GLYPHS) {
            act(() => setChartFillShape(shape));
            expect(captured.style.shape).toBe(shape);
            expect(glyphs(r)).toEqual([[buy, captured.style.up], [sell, captured.style.down]]);
            expect(legendText(r)).toBe(`成交${buy}買${sell}賣2筆`);
        }
    });
    it.each(['成交', '成交標記設定'] as const)('按圖例列的「%s」打開設定面板，再按一次或按另一顆都會收起；顯示中開關面板不動這張圖的狀態', async (name) => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const log: ChartFillsState[] = [];
        const r = mountWorkspace({ contract: stk, trades: trades() }, log); await flush();
        const other = name === '成交' ? '成交標記設定' : '成交';
        expect(panel(r)).toBeUndefined();
        await press(r, name);
        expect(panel(r)).toBeDefined();
        expect(text(panel(r))).toContain('所有 K 線圖共用');
        expect(buttons(panel(r)).map(named)).not.toContain('完成'); // 點了就生效，沒有「完成」鈕
        await press(r, name);
        expect(panel(r)).toBeUndefined();
        await press(r, name);
        expect(panel(r)).toBeDefined();
        await press(r, other); // 名稱鈕和齒輪是同一個開關
        expect(panel(r)).toBeUndefined();
        expect([name, other].map((n) => legendBtn(r, n).props['aria-expanded'])).toEqual([false, false]);
        expect(log).toEqual([]);
    });
    it('設定面板的形狀、標籤、帳戶：點了就生效（寫全域偏好，圖層與圖例跟著換），面板不關、不動這張圖的狀態', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const log: ChartFillsState[] = [];
        const r = mountWorkspace({ contract: stk, trades: trades() }, log); await flush();
        await press(r, '成交');
        expect(choices(r, '形狀')).toEqual([['三角形', true], ['箭頭', false], ['圓點', false], ['菱形', false]]);
        expect(choices(r, '標籤')).toEqual([['不標', false], ['買賣', false], ['價格', true]]);
        for (const [shape, name, buy, sell] of [...GLYPHS.slice(1), GLYPHS[0]]) {
            await pick(r, name);
            expect(captured.style.shape).toBe(shape);
            expect(choices(r, '形狀').filter(([, on]) => on)).toEqual([[name, true]]);
            expect(legendText(r)).toBe(`成交${buy}買${sell}賣2筆`);
        }
        for (const [name, style, label] of [['不標', 'dot', null], ['買賣', 'side', '買 2張'], ['價格', 'price', '20,003 2張']] as const) {
            await pick(r, name);
            expect([getChartFillStyle(), captured.style.style]).toEqual([style, style]);
            expect(choices(r, '標籤').filter(([, on]) => on)).toEqual([[name, true]]);
            expect(captured.groups.map((g) => g.text)).toEqual([label]);
        }
        // 帳戶：預設是這張圖的帳戶，可改成同一市場的全部帳戶
        expect(text(panel(r))).toContain('帳戶：');
        expect(text(panel(r))).toContain('1111121');
        await pick(r, '改成全部帳戶');
        expect(getChartFillScope()).toBe('all');
        expect(text(panel(r))).toContain('帳戶：全部帳戶');
        await pick(r, '改成目前帳戶');
        expect(getChartFillScope()).toBe('active');
        expect(text(panel(r))).not.toContain('帳戶：全部帳戶');
        expect(panel(r)).toBeDefined();
        expect(log).toEqual([]);
    });
    it('顏色：預設藍買橘賣；勾「跟 K 棒同色」改用漲跌色、取消就換回；買、賣各自展開色盤換色（跟 K 棒同色時換色會切回自己的買賣色）、「預設色」還原；圖層、圖例示意與提示框一起換', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const r = mount({ contract: stk, trades: [tradeAt(A, 20010, 'a'), tradeAt(A, 20011, 'b', 'Sell')] }); await flush();
        const candle = getChartColors({ mode: 'dark', convention: 'tw', fontScale: 1 });
        const used = () => [captured.style.up, captured.style.down];
        const palette = (side: '買' | '賣') => panel(r)!.findAll((n) => n.props.role === 'group' && n.props['aria-label'] === `${side}的顏色`)[0];
        const expanded = () => ['買的顏色', '賣的顏色'].map((name) => panelBtn(r, name).props['aria-expanded']);
        // 色盤裡選中的那一顆（色塊或「預設色」）
        const chosen = (side: '買' | '賣') => buttons(palette(side)).filter((b) => b.props['aria-pressed']).map(named);
        await press(r, '成交');
        // 預設藍買橘賣，和 K 棒的紅綠不同
        expect(used()).toEqual(['#38bdf8', '#fb923c']);
        expect([candle.up, candle.down]).not.toContain(captured.style.up);
        expect(text(panel(r))).toContain('跟 K 棒同色');
        expect(candleBox(r).props.checked).toBe(false);
        await toggleCandle(r);
        expect(candleBox(r).props.checked).toBe(true);
        expect(used()).toEqual([candle.up, candle.down]);
        await toggleCandle(r);
        expect(candleBox(r).props.checked).toBe(false);
        expect(used()).toEqual(['#38bdf8', '#fb923c']);
        // 買、賣各一顆鈕，點了在下面展開色盤（一次只開一邊）
        expect(expanded()).toEqual([false, false]);
        expect([palette('買'), palette('賣')]).toEqual([undefined, undefined]);
        const [buy, sell, other] = [DRAWING_PALETTE[7]!, DRAWING_PALETTE[2]!, DRAWING_PALETTE[4]!];
        await pick(r, '買的顏色');
        expect(expanded()).toEqual([true, false]);
        expect(chosen('買')).toEqual(['預設色']); // 還沒自選
        await pick(r, `顏色 ${buy}`);
        expect(used()).toEqual([buy, '#fb923c']);
        expect(chosen('買')).toEqual([`顏色 ${buy}`]);
        await pick(r, '賣的顏色');
        expect(expanded()).toEqual([false, true]);
        expect(palette('買')).toBeUndefined();
        await pick(r, `顏色 ${sell}`);
        expect(used()).toEqual([buy, sell]);
        expect(chosen('賣')).toEqual([`顏色 ${sell}`]);
        // 圖例示意與提示框和圖層同色
        expect(glyphs(r).map(([, color]) => color)).toEqual([buy, sell]);
        await move(BAR);
        expect(tooltips(r)[0]!.findAll((n) => n.type === 'td' && n.props.style?.color).map((n) => n.props.style.color)).toEqual([buy, sell]);
        // 跟 K 棒同色時再選色：切回自己的買賣色，另一邊的自選色還在
        await toggleCandle(r);
        expect(used()).toEqual([candle.up, candle.down]);
        if (!palette('買')) await pick(r, '買的顏色');
        expect(chosen('買')).toEqual([]); // 用的是 K 棒的顏色：色盤裡沒有選中的
        await pick(r, `顏色 ${other}`);
        expect(candleBox(r).props.checked).toBe(false);
        expect(used()).toEqual([other, sell]);
        // 「預設色」只還原正在換的那一邊
        await pick(r, '預設色');
        expect(used()).toEqual(['#38bdf8', sell]);
        expect(chosen('買')).toEqual(['預設色']);
    });
    it('面板打開後下一幀把焦點移到選中的形狀鈕；關閉時焦點若跟著面板消失就還給打開前的地方，已經移到別處就不搶', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        // 這個案例自己排幀：rAF 回呼只在 runFrame() 時執行（共用的 setTimeout 版會在 act 的等待裡提早跑，結果時好時壞）
        const queued: (() => void)[] = [];
        vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => queued.push(() => cb(0)));
        vi.stubGlobal('cancelAnimationFrame', (id: number) => { queued[id - 1] = () => {}; });
        const frame = () => act(async () => { queued.splice(0).forEach((run) => run()); });
        const selected = { focus: vi.fn() };
        const opener = { focus: vi.fn() };
        const doc = { body: {}, activeElement: opener as unknown };
        settingsNode = { ownerDocument: doc, querySelector: (selector: string) => (selector === '[aria-pressed="true"]' ? selected : null) };
        const r = mount({ contract: stk, trades: trades() }); await flush();
        await press(r, '成交');
        expect(selected.focus).not.toHaveBeenCalled(); // 彈出層第一次渲染還沒定位（隱藏），等一幀
        await frame();
        expect(selected.focus.mock.calls).toEqual([[{ preventScroll: true }]]);
        // 關閉後焦點落到 body（原本在面板裡）：還給打開前的地方
        doc.activeElement = doc.body;
        await press(r, '成交');
        expect(opener.focus.mock.calls).toEqual([[{ preventScroll: true }]]);
        // 關閉時焦點已經在別處（例如點了圖表）：留在那裡
        doc.activeElement = opener;
        await press(r, '成交'); await frame();
        doc.activeElement = { focus: vi.fn() };
        await press(r, '成交');
        expect(opener.focus).toHaveBeenCalledTimes(1);
        // 還沒到下一幀就關掉：不再移焦點
        selected.focus.mockClear();
        await press(r, '成交');
        await press(r, '成交');
        await frame();
        expect(selected.focus).not.toHaveBeenCalled();
    });
    it('從「指標」加回（原本已移除）並打開設定：打開時焦點不在任何元素上，關閉時還給圖例列的「成交」，不會掉到 body', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const queued: (() => void)[] = [];
        vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => queued.push(() => cb(0)));
        vi.stubGlobal('cancelAnimationFrame', (id: number) => { queued[id - 1] = () => {}; });
        const frame = () => act(async () => { queued.splice(0).forEach((run) => run()); });
        const doc = { body: {}, activeElement: null as unknown };
        doc.activeElement = doc.body; // 對話框卸載，原本在對話框裡的焦點掉到 body
        settingsNode = { ownerDocument: doc, querySelector: () => null };
        const name = { focus: vi.fn() };
        legendNode = { clientWidth: 800, clientHeight: 400, getBoundingClientRect: () => ({ width: 800, height: 400, left: 0, top: 0 }), addEventListener() {}, removeEventListener() {}, style: {}, focus() {},
            querySelector: (selector: string) => (selector === 'button' ? name : null) };
        const r = mountWorkspace({ contract: stk, trades: trades(), initial: 'off' }); await flush();
        expect(legend(r)).toBeUndefined();
        await act(async () => r.root.findAll((n) => n.type === 'button' && text(n) === '指標')[0]!.props.onClick());
        await act(async () => r.root.findAll((n) => n.type === 'button' && text(n).startsWith('成交標記'))[0]!.props.onClick());
        expect(panel(r)).toBeDefined();
        await frame();
        await press(r, '成交');
        expect(panel(r)).toBeUndefined();
        expect(name.focus.mock.calls).toEqual([[{ preventScroll: true }]]);
    });

    it('從「指標」點「成交標記」：對話框關掉的同時放一層透明遮罩，0.5 秒內的點擊在 window 就攔下（雙擊的第二下不會穿到底下），之後拿掉', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const r = mountWorkspace({ contract: stk, trades: trades() }); await flush();
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const add = vi.spyOn(window, 'addEventListener');
        const remove = vi.spyOn(window, 'removeEventListener');
        const shield = () => r.root.findAll((n) => n.props['data-click-shield'] === '');
        const types = ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'];
        // 只看指標類事件（Esc 堆疊等也會在 window 註冊 keydown）
        const guarded = (spy: typeof add) => spy.mock.calls.filter((c) => c[2] === true && types.includes(c[0])).map((c) => c[0]).sort();
        await act(async () => r.root.findAll((n) => n.type === 'button' && text(n) === '指標')[0]!.props.onClick());
        await act(async () => r.root.findAll((n) => n.type === 'button' && text(n).startsWith('成交標記'))[0]!.props.onClick());
        expect(panel(r)).toBeDefined();
        expect(shield()).toHaveLength(1);
        expect(guarded(add)).toEqual(types);
        expect(guarded(remove)).toEqual([]);
        await act(async () => { vi.advanceTimersByTime(499); });
        expect(shield()).toHaveLength(1);
        await act(async () => { vi.advanceTimersByTime(1); });
        expect(shield()).toHaveLength(0);
        expect(guarded(remove)).toEqual(types);
        expect(panel(r)).toBeDefined(); // 設定面板照樣開著
        // 從圖例列打開不放遮罩（那裡沒有被拿掉的全視窗遮罩）
        await press(r, '成交'); await press(r, '成交');
        expect(shield()).toHaveLength(0);
    });

    it.each(['成交', '成交標記設定'] as const)('隱藏中按「%s」：先恢復顯示（交回 on）再打開設定面板', async (name) => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const log: ChartFillsState[] = [];
        const r = mountWorkspace({ contract: stk, trades: trades(), initial: 'hidden' }, log); await flush();
        expect(captured.groups).toEqual([]);
        await press(r, name);
        expect(log).toEqual(['on']);
        expect(panel(r)).toBeDefined();
        expect(legendNames(r)).toContain('隱藏成交標記');
        expect(captured.groups).toHaveLength(1);
    });
    it.each([['隱藏成交標記', 'hidden'], ['移除成交標記', 'off']] as const)('面板開著時按「%s」：交回 %s 並關掉面板，之後恢復顯示也不會自己打開', async (name, state) => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const onFillsChange = vi.fn();
        const props = { contract: stk, trades: trades(), onFillsChange };
        const r = mount({ ...props, fills: 'on' }); await flush();
        await press(r, '成交');
        expect(panel(r)).toBeDefined();
        await press(r, name);
        expect(onFillsChange.mock.calls).toEqual([[state]]);
        // 工作區還沒把狀態傳回來（這張圖仍是 on）：面板已經關了
        expect(panel(r)).toBeUndefined();
        expect(legendBtn(r, '成交').props['aria-expanded']).toBe(false);
        await act(async () => r.update(chart({ ...props, fills: state })));
        await act(async () => r.update(chart({ ...props, fills: 'on' })));
        expect(legend(r)).toBeDefined();
        expect(panel(r)).toBeUndefined();
    });
    it.each([['工作區改成隱藏', { fills: 'hidden' }], ['工作區移除', { fills: 'off' }], ['換成指數', { contract: ind }]] as const)('面板開著時%s：面板收起、aria-expanded 回到 false，恢復後不會自己彈出來', async (_label, change) => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const props = { contract: stk, trades: trades(), fills: 'on', onFillsChange: vi.fn() };
        const r = mount(props); await flush();
        await press(r, '成交');
        expect(panel(r)).toBeDefined();
        await act(async () => r.update(chart({ ...props, ...change }))); await flush();
        expect(panel(r)).toBeUndefined();
        await act(async () => r.update(chart(props))); await flush();
        expect([panel(r), legendBtn(r, '成交').props['aria-expanded'], legendBtn(r, '成交標記設定').props['aria-expanded']]).toEqual([undefined, false, false]);
        expect(props.onFillsChange).not.toHaveBeenCalled();
    });
    it('從「指標」對話框：成交標記那一列是「已加入」，按移除後圖例列消失、對話框還開著；再點那一列就加回這張圖、關對話框並打開設定面板', async () => {
        setNow('2026-10-08T09:16:00'); fetchMock.mockResolvedValue(DATA);
        const log: ChartFillsState[] = [];
        const r = mountWorkspace({ contract: stk, trades: trades() }, log); await flush();
        // 對話框裡整列是一顆 <button>（名稱「成交標記」）；「移除」是列裡的 role=button
        const row = (of = r) => of.root.findAll((n) => n.type === 'button' && text(n).startsWith('成交標記'))[0];
        const remove = () => r.root.findAll((n) => n.props.role === 'button' && n.props['aria-label'] === '移除成交標記')[0];
        expect(row()).toBeUndefined();
        await click(r, '指標');
        expect(text(row())).toContain('已加入');
        await act(async () => remove()!.props.onClick({ stopPropagation() {} }));
        expect(log).toEqual(['off']);
        expect(legend(r)).toBeUndefined();
        expect(captured.groups).toEqual([]);
        // 對話框還開著，這一列變成可以加回
        expect(row()).toBeDefined();
        expect(text(row())).not.toContain('已加入');
        expect(remove()).toBeUndefined();
        await act(async () => row()!.props.onClick());
        expect(log).toEqual(['off', 'on']);
        expect(row()).toBeUndefined(); // 對話框關了
        expect(legendText(r)).toBe('成交▲買▼賣2筆');
        expect(panel(r)).toBeDefined(); // 剛加回來的圖例列掛上後，面板才有地方定位
        expect(captured.groups).toHaveLength(1);
        // 已經在圖上時點那一列：關對話框、開設定面板，狀態不變
        await press(r, '成交');
        expect(panel(r)).toBeUndefined();
        await click(r, '指標');
        await act(async () => row()!.props.onClick());
        expect([row(), !!panel(r), log]).toEqual([undefined, true, ['off', 'on']]);
        // 不能畫成交的圖（指數）：對話框沒有這一列
        const index = mount({ contract: ind, trades: trades() }); await flush();
        await click(index, '指標');
        expect(text(index.root)).toContain('技術指標');
        expect(row(index)).toBeUndefined();
    });
});
