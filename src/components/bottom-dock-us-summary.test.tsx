// dock 摘要列：美股損益（USD）另列，絕不加進台幣總損益；美股列資料交給 pane
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const H = { account_type: 'H', person_id: 'P', broker_id: '9A95', account_id: '0000001', signed: true, username: 'u' };
const S = { ...H, account_type: 'S' };
const q = { updatedAt: 1, error: null, needsReconcile: false, reasons: [] };
const m = vi.hoisted(() => ({ us: {} as Record<string, unknown>, panes: {} as Record<string, Record<string, unknown>>, refreshUsPositions: vi.fn(), refreshUsTrades: vi.fn() }));
vi.mock('../lib/trading-state', () => ({
    RECONCILE_REASON_LABELS: {}, refreshTradingState: vi.fn(),
    useTradingState: () => ({ loading: false, funds: [], queries: { positions: q, orders: q, account: q } }),
}));
vi.mock('../lib/dock-events', () => ({ useOpenOrdersTabRequest: () => undefined }));
vi.mock('../lib/account-store', () => ({ useAccounts: () => ({ accounts: [S, H], selectedStock: S, selectedFutures: null }), ensureAccounts: () => undefined, selectAccount: vi.fn() }));
vi.mock('../lib/account-tradable', () => ({ canTrade: () => true }));
vi.mock('../lib/privacy', () => ({ usePrivacyMode: () => false, usePrivacyMoney: () => false, maskAccountId: (id: string) => id, maskMoney: (t: string) => t }));
vi.mock('../lib/us/us-trading-state', async () => {
    const real = await vi.importActual<typeof import('../lib/us/us-trading-state')>('../lib/us/us-trading-state');
    return { ...real, getUsTradingState: () => m.us, subscribeUsTradingState: () => () => undefined, refreshUsPositions: m.refreshUsPositions, refreshUsTrades: m.refreshUsTrades };
});
vi.mock('../lib/risk', () => ({ checkUsOrderAllowed: () => null }));
vi.mock('../lib/stream', () => ({ ensureStream: vi.fn(), getStreamStatus: () => 'down', onOrderEvent: () => () => undefined, onAnyTick: () => () => undefined, onUsTickStreamReset: () => () => undefined, subscribeStatusStore: () => () => undefined }));
vi.mock('../lib/quote-ownership', () => ({ retainQuote: () => () => undefined }));
vi.mock('./bottom-dock-positions', () => ({ PositionsPane: (p: Record<string, unknown>) => { m.panes.positions = p; return null; } }));
vi.mock('./bottom-dock-orders', () => ({ OrdersPane: (p: Record<string, unknown>) => { m.panes.orders = p; return null; } }));
vi.mock('./bottom-dock-account', () => ({ AccountPane: () => null, UsAccountSection: () => '美股帳務' }));
vi.mock('./bottom-dock-shared', async original => ({ ...await original<object>(), useDockPref: (_k: string, _a: unknown, fallback: string) => [fallback, vi.fn()] }));
import { BottomDock } from './bottom-dock';

const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
let view: ReactTestRenderer | undefined;
const twPos = { account: S, id: 1, code: '2330', direction: 'Buy', quantity: 1000, price: 1000, last_price: 1100, pnl: 100000, yd_quantity: 1000 };
const usPos = { account: H, id: 0, code: 'AAPL', direction: 'Buy', quantity: '10', price: '170', market_price: '175.4', pnl: '54', pnl_pct: '3.17' };

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    m.us = { trades: [], loading: false, updatedAt: 1, error: null, hint: null, positions: [usPos], positionsStatus: 'ready', positionsError: null };
    m.panes = {};
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('shows USD pnl separately and never adds it to the TWD total', async () => {
    await act(async () => { view = create(createElement(BottomDock, { positions: [twPos] as never, trades: [], onTradesChanged: vi.fn(), onSelectCode: vi.fn() })); });
    const all = text(view!.root);
    expect(all).toContain('總損益（台幣）');
    expect(all).toContain('+100,000');
    expect(all).not.toContain('100,054');
    expect(all).toContain('美股損益（USD）');
    expect(all).toContain('+54.00');
    expect(all).toContain('持倉 Positions [2]');
    // 美股庫存交給持倉 pane 併表，不再另列區段
    expect(m.panes.positions!.us).toEqual({ positions: [usPos], status: 'ready', error: null });
    expect(m.panes.positions!.onSelectCode).toBeTypeOf('function');
    expect(m.refreshUsPositions).toHaveBeenCalled();
});
