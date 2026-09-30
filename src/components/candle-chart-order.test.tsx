// #204 K 線圖下單設定：工具列一顆按鈕（數量＋單位）、彈出面板只列適用選項、
// 點價與停損停利實際使用這組設定（帳號、單位、數量、委託、開平倉）
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';

vi.hoisted(() => {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k), key: () => null, length: 0 };
    (globalThis as any).window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, location: { search: '', href: 'http://x/' } });
    (globalThis as any).document = { addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, getContext: () => null }), body: {} };
});
const m = vi.hoisted(() => ({
    place: vi.fn(), addTrigger: vi.fn(), notify: vi.fn(),
    click: [] as ((p: unknown) => void)[],
    accounts: [] as Account[],
    roundClose: 100 as number | null,
    oddClose: 100 as number | null,
}));
vi.mock('../lib/trade', () => ({ notify: m.notify, placeQuickOrder: m.place }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: async () => {}, updateOrderPrice: async () => {} }));
vi.mock('../lib/trigger-engine', () => ({ addTrigger: m.addTrigger, removeTrigger: vi.fn(), useTriggers: () => [] }));
vi.mock('../lib/account-store', () => ({ ensureAccounts: () => undefined,
    useAccounts: () => ({ loaded: true, accounts: m.accounts, selectedStock: m.accounts[0], selectedFutures: m.accounts[2] }) }));
vi.mock('../hooks/use-stream', () => ({ useQuote: (code: string | null, o?: { oddLot?: boolean }) => {
    if (!code) return undefined;
    const close = o?.oddLot ? m.oddClose : m.roundClose;
    return close === null ? undefined : { tick: { code, date: '2026/09/30', time: '11:00:00', close, volume: 1 }, seq: 1, lastDir: 0, flashSeq: 0 };
} }));
vi.mock('../lib/chart-history', () => ({ fetchChartHistory: async () => ({ candles: [], exhausted: true }), nextChartHistoryRevision: () => 1 }));
vi.mock('lightweight-charts', async () => {
    const h = await import('./chart-session.test-harness');
    const base = h.lwMock();
    const chart = () => {
        const inner = h.makeChart();
        return new Proxy({}, { get: (_t, p) => {
            if (p === 'subscribeClick') return (cb: (p: unknown) => void) => { m.click.push(cb); };
            if (p === 'addSeries') return (type: { kind: string }) => {
                const s = h.makeSeries(type.kind);
                return new Proxy(s, { get: (t, q) => (q === 'coordinateToPrice' ? () => 100 : t[q as keyof typeof t]) });
            };
            return inner[p];
        } });
    };
    return { ...base, createChart: chart };
});

import { CandleChart } from './candle-chart';

const S1 = { account_type: 'S', broker_id: 'B', account_id: '1111121', signed: true, person_id: '', username: '' } as Account;
const S2 = { ...S1, account_id: '2222207' } as Account;
const F1 = { ...S1, account_type: 'F', account_id: '3333307' } as Account;
const stk = { code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', target_code: null, reference: 100, limit_up: 110, limit_down: 90 } as any;
const fut = { code: 'TXFR1', name: '臺股期貨', security_type: 'FUT', exchange: 'TAIFEX', target_code: 'TXFJ6', reference: 100 } as any;
const text = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : text(c))).join('');
let view!: ReactTestRenderer;
const chip = () => view.root.findAll(n => n.type === 'button' && String(n.props['aria-label'] ?? '').startsWith('圖表下單設定'))[0]!;
const pop = () => view.root.findAll(n => n.props.role === 'dialog')[0];
const button = (root: ReactTestInstance, label: string) => root.findAll(n => n.type === 'button' && text(n) === label)[0]!;
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => {}); };
async function mount(props: Record<string, unknown>) {
    await act(async () => {
        view = create(createElement(CandleChart, props as any), { createNodeMock: () => ({ clientWidth: 800, clientHeight: 400, getBoundingClientRect: () => ({ width: 800, height: 400, left: 0, top: 0 }), addEventListener() {}, removeEventListener() {}, style: {} }) });
    });
    await flush();
}
const clickChart = async () => { await act(async () => { m.click.at(-1)!({ point: { x: 10, y: 10 } }); }); await flush(); };

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('requestAnimationFrame', (cb: any) => setTimeout(cb, 0));
    vi.stubGlobal('cancelAnimationFrame', (id: any) => clearTimeout(id));
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    m.place.mockReset().mockResolvedValue({ status: { status: 'PendingSubmit' } });
    m.addTrigger.mockReset().mockResolvedValue(null);
    m.notify.mockReset();
    m.click.length = 0;
    m.accounts = [S1, S2, F1];
    m.roundClose = 100; m.oddClose = 100;
    (globalThis as any).localStorage.setItem('sj-pro-chart-order-defaults', '{}');
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

describe('chart order settings button', () => {
    it('replaces the 量 input and 零股 toggle with one chip that shows only quantity and unit', async () => {
        await mount({ contract: stk });
        expect(text(chip())).toBe('1 張');
        expect(view.root.findAll(n => n.type === 'button' && text(n) === '零股')).toHaveLength(0);
        expect(view.root.findAll(n => n.type === 'input' && String(n.props['aria-label']).startsWith('圖表下單數量'))).toHaveLength(0);
        expect(String(chip().props.title)).toContain('點價買／賣以 ROD 限價送出 1 張');
    });

    it('stock odd lot: hides the ROD/IOC/FOK row, summarises, and 點價買 sends IntradayOdd shares with the chosen account', async () => {
        const onOrderSettingsChange = vi.fn();
        let state: any = {};
        onOrderSettingsChange.mockImplementation(v => { state = v; });
        await mount({ contract: stk, panelId: 'c1', orderSettings: state, onOrderSettingsChange });
        await act(async () => { chip().props.onClick(); });
        expect(pop()).toBeDefined();
        expect(text(pop()!)).toContain('委託'); // round lot: ROD / IOC / FOK shown
        await act(async () => { button(pop()!, '盤中零股（股）').props.onClick(); });
        await act(async () => view.update(createElement(CandleChart, { contract: stk, panelId: 'c1', orderSettings: state, onOrderSettingsChange } as any)));
        await act(async () => { button(pop()!, '500').props.onClick(); });
        await act(async () => view.update(createElement(CandleChart, { contract: stk, panelId: 'c1', orderSettings: state, onOrderSettingsChange } as any)));
        const select = pop()!.findAll(n => n.type === 'select')[0]!;
        await act(async () => { select.props.onChange({ target: { value: 'S:B:2222207' } }); });
        await act(async () => view.update(createElement(CandleChart, { contract: stk, panelId: 'c1', orderSettings: state, onOrderSettingsChange } as any)));
        expect(state).toEqual({ S: { qty: 500, lot: 'IntradayOdd', orderType: 'ROD', octype: 'Auto', accountKey: 'S:B:2222207' } });
        const t = text(pop()!);
        expect(t).not.toContain('IOC');
        expect(t).not.toContain('當沖');
        expect(t).not.toContain('開平倉');
        expect(text(view.root.findAll(n => n.props['data-testid'] === 'order-settings-summary')[0]!)).toMatch(/^點價買／賣以 ROD 限價送出 500 股盤中零股，帳號 .*2207；停損停利觸發後以漲跌停價送零股限價 ROD/);
        expect(text(chip())).toBe('500 股');
        await act(async () => { button(pop()!, '完成').props.onClick(); });
        expect(pop()).toBeUndefined();

        await act(async () => { button(view.root, '點價買').props.onClick(); });
        expect(text(view.root)).toContain('點擊價位 → 限價買進 500 股');
        await clickChart();
        expect(m.place).toHaveBeenCalledTimes(1);
        const [, action, price, qty, opts] = m.place.mock.calls[0]!;
        expect([action, price, qty]).toEqual(['Buy', 100, 500]);
        expect(opts).toMatchObject({ orderLot: 'IntradayOdd', account: S2 });
        expect(opts.orderType).toBeUndefined();

        // a stop from the same settings: odd-lot trigger pinned to the chosen account
        await act(async () => { button(view.root, '停損').props.onClick(); });
        await clickChart();
        expect(m.addTrigger).toHaveBeenCalledTimes(1);
        expect(m.addTrigger.mock.calls[0]![0]).toMatchObject({ quantity: 500, kind: 'stop', orderLot: 'IntradayOdd' });
        expect(m.addTrigger.mock.calls[0]![2]).toEqual({ account: S2 });
    });

    it('round lot IOC following the main account: the order uses IOC and no odd lot', async () => {
        await mount({ contract: stk });
        await act(async () => { chip().props.onClick(); });
        await act(async () => { button(pop()!, 'IOC').props.onClick(); });
        await act(async () => { button(pop()!, '5').props.onClick(); });
        expect(text(chip())).toBe('5 張');
        await act(async () => { button(view.root, '點價賣').props.onClick(); });
        expect(text(view.root)).toContain('點擊價位 → 限價賣出 IOC 5 張');
        await clickChart();
        const [, action, , qty, opts] = m.place.mock.calls[0]!;
        expect([action, qty]).toEqual(['Sell', 5]);
        expect(opts).toMatchObject({ orderType: 'IOC', account: S1 });
        expect(opts.orderLot).toBeUndefined();
        // following the main selection: triggers use the default account path
        await act(async () => { button(view.root, '停利').props.onClick(); });
        await clickChart();
        expect(m.addTrigger.mock.calls[0]![2]).toBeUndefined();
    });

    it('futures: unit fixed at 口, no 單位 row, 類別 自動／新倉／平倉 flows into orders and stops', async () => {
        await mount({ contract: fut });
        expect(text(chip())).toBe('1 口');
        await act(async () => { chip().props.onClick(); });
        const t = text(pop()!);
        expect(t).not.toContain('整股');
        expect(t).toContain('自動');
        await act(async () => { button(pop()!, '平倉').props.onClick(); });
        await act(async () => { button(pop()!, '2').props.onClick(); });
        expect(text(view.root.findAll(n => n.props['data-testid'] === 'order-settings-summary')[0]!)).toContain('2 口（平倉）');
        await act(async () => { button(view.root, '點價買').props.onClick(); });
        await clickChart();
        expect(m.place.mock.calls[0]![4]).toMatchObject({ ocType: 'Cover', account: F1 });
        await act(async () => { button(view.root, '停損').props.onClick(); });
        await clickChart();
        expect(m.addTrigger.mock.calls[0]![0]).toMatchObject({ quantity: 2, octype: 'Cover' });
        expect(m.addTrigger.mock.calls[0]![0].orderLot).toBeUndefined();
    });

    it('Esc closes the popover; a pinned account that disappeared blocks the order', async () => {
        const target = new EventTarget();
        const w = window as any;
        const saved = { add: w.addEventListener, remove: w.removeEventListener, dispatch: w.dispatchEvent };
        w.addEventListener = vi.fn((...a: Parameters<EventTarget['addEventListener']>) => target.addEventListener(...a));
        w.removeEventListener = target.removeEventListener.bind(target);
        w.dispatchEvent = target.dispatchEvent.bind(target);
        onTestFinished(() => { w.addEventListener = saved.add; w.removeEventListener = saved.remove; w.dispatchEvent = saved.dispatch; });
        await mount({ contract: stk, orderSettings: { S: { qty: 1, lot: 'Common', orderType: 'ROD', octype: 'Auto', accountKey: 'S:B:gone' } }, onOrderSettingsChange: vi.fn() });
        // closed: no key listener is installed (chart hotkeys untouched)
        const spy = w.addEventListener as ReturnType<typeof vi.fn>;
        expect(spy.mock.calls.some(c => c[0] === 'keydown')).toBe(false);
        await act(async () => { chip().props.onClick(); });
        expect(pop()).toBeDefined();
        expect(spy.mock.calls.some(c => c[0] === 'keydown')).toBe(true);
        await act(async () => { window.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' })); });
        expect(pop()).toBeUndefined();
        await act(async () => { button(view.root, '點價買').props.onClick(); });
        await clickChart();
        expect(m.place).not.toHaveBeenCalled();
        expect(m.notify.mock.calls.at(-1)![0]).toMatchObject({ kind: 'err', body: expect.stringContaining('固定帳號已不可用') });
    });

    it('odd-lot stop/take pick their side from the odd-lot price, not the round-lot one', async () => {
        // round-lot last 105 and odd-lot last 95 straddle the click at 100
        m.roundClose = 105; m.oddClose = 95;
        await mount({ contract: stk, orderSettings: { S: { qty: 300, lot: 'IntradayOdd', orderType: 'ROD', octype: 'Auto' } }, onOrderSettingsChange: vi.fn() });
        await act(async () => { button(view.root, '停損').props.onClick(); });
        await clickChart();
        // 100 is ABOVE the odd-lot price → a buy stop on a rise (round-lot would say below/sell)
        expect(m.addTrigger.mock.calls[0]![0]).toMatchObject({ condition: 'above', action: 'Buy', orderLot: 'IntradayOdd', quantity: 300 });
        await act(async () => { button(view.root, '停利').props.onClick(); });
        await clickChart();
        expect(m.addTrigger.mock.calls[1]![0]).toMatchObject({ condition: 'above', action: 'Sell', kind: 'take' });
        // alerts keep the round-lot price
        await act(async () => { button(view.root, '警示').props.onClick(); });
        await clickChart();
        expect(m.addTrigger.mock.calls[2]![0]).toMatchObject({ condition: 'below', kind: 'alert' });
    });

    it('odd-lot stop without any odd-lot trade yet is refused with 等待零股行情', async () => {
        m.oddClose = null;
        await mount({ contract: stk, orderSettings: { S: { qty: 300, lot: 'IntradayOdd', orderType: 'ROD', octype: 'Auto' } }, onOrderSettingsChange: vi.fn() });
        await act(async () => { button(view.root, '停損').props.onClick(); });
        await clickChart();
        expect(m.addTrigger).not.toHaveBeenCalled();
        expect(m.notify.mock.calls.at(-1)![0]).toMatchObject({ kind: 'err', body: expect.stringContaining('等待零股行情') });
    });
});
