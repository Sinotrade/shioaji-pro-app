// LiveCandleChart：成交標記只看委託來源與對帳，持倉／餘額更新的 loading 不讓標記消失
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ live: true, env: null as string | null, state: null as any, props: null as any }));
vi.mock('../lib/trading-state', () => ({
    useTradingState: () => m.state,
    RECONCILE_REASON_LABELS: { disconnect: '串流中斷', 'sequence-gap': '回報跳號', 'mutation-outcome': '改刪待確認', 'query-failed': '查詢失敗' },
}));
vi.mock('../hooks/use-stream', () => ({ useTradingLive: () => m.live }));
vi.mock('../lib/protection-env', () => ({ currentProtectionEnv: () => m.env }));
const mirror = vi.hoisted(() => ({ fresh: true, listeners: new Set<() => void>() }));
vi.mock('../lib/trading-mirror-lease', () => ({
    getTradingMirrorFresh: () => mirror.fresh,
    subscribeTradingMirror: (listener: () => void) => { mirror.listeners.add(listener); return () => mirror.listeners.delete(listener); },
}));
const infoListeners = vi.hoisted(() => new Set<() => void>());
vi.mock('../lib/server-info-store', () => ({ subscribeServerInfo: (listener: () => void) => { infoListeners.add(listener); return () => infoListeners.delete(listener); } }));
vi.mock('./candle-chart', () => ({ CandleChart: (props: unknown) => { m.props = props; return null; } }));

import { LiveCandleChart } from './live-candle-chart';

const ENV = 'http://127.0.0.1:21323|simulation';
const trades = [{ order: { id: 'x' } }];
const ready = () => ({ trades, loading: false, ordersSnapshotEnv: ENV, queries: { orders: { needsReconcile: false, reasons: [] as string[] } } });
function chartProps() {
    let r!: ReturnType<typeof create>;
    act(() => { r = create(createElement(LiveCandleChart, { contract: { code: '2330' } as any })); });
    const props = m.props;
    expect(props.trades).toBe(trades);
    act(() => r.unmount());
    return props as { fillsReady: boolean; fillsNote?: string; fillsHint?: string };
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    m.live = true;
    m.env = ENV;
    m.state = ready();
    m.props = null;
    mirror.fresh = true;
});
afterEach(() => vi.unstubAllGlobals());

it('持倉／餘額更新中（loading）但委託來源與對帳都齊全 → 照常顯示成交，沒有提示', () => {
    m.state = { ...ready(), loading: true };
    const props = chartProps();
    expect(props.fillsReady).toBe(true);
    expect(props.fillsNote).toBeUndefined();
});

it.each([
    ['串流不健康', () => { m.live = false; }],
    ['環境不符', () => { m.env = 'http://127.0.0.1:21323|production'; }],
    ['尚無權威委託快照', () => { m.state.ordersSnapshotEnv = null; }],
    ['委託待對帳', () => { m.state.queries.orders.needsReconcile = true; }],
    ['環境未知', () => { m.env = null; m.state.ordersSnapshotEnv = null; }],
])('%s → 不顯示成交，並給出提示', (_label, apply) => {
    apply();
    const props = chartProps();
    expect(props.fillsReady).toBe(false);
    expect(props.fillsNote).toMatch(/^成交/);
});

it('提示說出原因：待對帳沿用帳務面板的原因名稱，其餘依串流與委託確認狀態區分', () => {
    m.state.queries.orders = { needsReconcile: true, reasons: [] };
    expect(chartProps().fillsNote).toBe('成交待對帳');
    m.state.queries.orders = { needsReconcile: true, reasons: ['disconnect'] };
    expect(chartProps().fillsNote).toBe('成交待對帳：串流中斷');
    m.state.queries.orders = { needsReconcile: true, reasons: ['disconnect', 'sequence-gap', 'mutation-outcome'] };
    expect(chartProps().fillsNote).toBe('成交待對帳：串流中斷、回報跳號 等 3 項');
    m.state = ready();
    m.live = false;
    expect(chartProps().fillsNote).toBe('成交暫停：連線尚未就緒');
    m.live = true;
    m.state.ordersSnapshotEnv = null;
    expect(chartProps().fillsNote).toBe('成交待確認：委託尚未確認');
    m.state = ready();
    m.env = 'http://127.0.0.1:21323|production';
    expect(chartProps().fillsNote).toBe('成交待確認：委託尚未確認');
});

it('連線尚未就緒且沒有待對帳原因：處置說明是等連線恢復；其他情況不傳，用 CandleChart 預設（到委託分頁按更新）', () => {
    m.live = false;
    expect(chartProps()).toMatchObject({ fillsNote: '成交暫停：連線尚未就緒', fillsHint: '連線恢復後會自動確認' });
    m.state.queries.orders = { needsReconcile: true, reasons: ['disconnect'] }; // 已有待對帳原因，要使用者更新
    expect(chartProps().fillsHint).toBeUndefined();
    m.live = true;
    m.state = ready();
    m.state.ordersSnapshotEnv = null; // 委託尚未確認
    expect(chartProps().fillsHint).toBeUndefined();
    m.state = ready();
    expect(chartProps().fillsHint).toBeUndefined();
});

it('小視窗連線尚未就緒：說明等主視窗的資料同步', async () => {
    vi.stubGlobal('location', { search: '?popout=chart&code=2330' });
    vi.resetModules();
    const { LiveCandleChart: Popout } = await import('./live-candle-chart');
    m.live = false;
    let r!: ReturnType<typeof create>;
    act(() => { r = create(createElement(Popout, { contract: { code: '2330' } as any })); });
    const hint = m.props.fillsHint;
    act(() => r.unmount());
    expect(hint).toBe('主視窗的資料同步後會自動確認');
});

it('持倉或帳戶資金待對帳不影響成交：只看委託這一類的來源與對帳', () => {
    m.state.queries.positions = { needsReconcile: true, reasons: ['query-failed'] };
    m.state.queries.account = { needsReconcile: true, reasons: ['query-failed'] };
    expect(chartProps().fillsReady).toBe(true);
});

it('交給 CandleChart 的其餘 props 原樣轉傳（showFills、onShowFillsChange、面板代號）', () => {
    const onShowFillsChange = vi.fn();
    let r!: ReturnType<typeof create>;
    act(() => { r = create(createElement(LiveCandleChart, { contract: { code: '2330' } as any, panelId: 'p1', showFills: false, onShowFillsChange })); });
    expect(m.props).toMatchObject({ panelId: 'p1', showFills: false, contract: { code: '2330' } });
    expect(m.props.onShowFillsChange).toBe(onShowFillsChange);
    act(() => r.unmount());
});

it('掛載之後環境或伺服器模式改變，會跟著重新判斷（訂閱 server-info，卸載時取消）', () => {
    let r!: ReturnType<typeof create>;
    act(() => { r = create(createElement(LiveCandleChart, { contract: { code: '2330' } as any })); });
    expect(m.props.fillsReady).toBe(true);
    expect(infoListeners.size).toBe(1);
    m.env = 'http://127.0.0.1:21323|production'; // 切到正式環境：舊的模擬成交不能再當作目前的
    act(() => infoListeners.forEach((listener) => listener()));
    expect(m.props.fillsReady).toBe(false);
    act(() => r.unmount());
    expect(infoListeners.size).toBe(0);
});

it('保留上次確認的標記：主視窗可以；彈出視窗的主視窗鏡像失效（主視窗關閉）時立即不可保留；環境照原值傳入', () => {
    let r!: ReturnType<typeof create>;
    act(() => { r = create(createElement(LiveCandleChart, { contract: { code: '2330' } as any })); });
    expect(m.props).toMatchObject({ fillsRetain: true, fillsEnv: ENV });
    expect(mirror.listeners.size).toBe(1);
    mirror.fresh = false; // main-gone → invalidateTradingMirror
    act(() => mirror.listeners.forEach((listener) => listener()));
    expect(m.props.fillsRetain).toBe(false);
    m.env = null; // 斷線：環境暫時未知
    act(() => infoListeners.forEach((listener) => listener()));
    expect(m.props.fillsEnv).toBeNull();
    act(() => r.unmount());
    expect(mirror.listeners.size).toBe(0);
});
