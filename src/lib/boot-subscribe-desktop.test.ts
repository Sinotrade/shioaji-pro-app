// Desktop: trade-report subscription goes through the native host (one
// check per account at a time, shared with the native engine — sw#183).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    accounts: vi.fn(), health: vi.fn(), subscribe: vi.fn(), notify: vi.fn(), invoke: vi.fn(),
}));
vi.mock('./features', () => ({ agentModule: null }));
vi.mock('./runtime', () => ({ EXPECTED_SERVER_VERSION: '', isTauri: true, getApiBase: () => 'http://127.0.0.1:21322' }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('./shioaji', () => ({
    fetchTradeCacheHealth: mocks.health,
    subscribeTradeEvents: mocks.subscribe,
}));
vi.mock('./account-store', () => ({ loadAccountsShared: mocks.accounts }));
vi.mock('./trading-state', () => ({ startTradingState: vi.fn() }));
vi.mock('./trade', () => ({ notify: mocks.notify }));
vi.mock('./stream', () => ({}));
vi.mock('./tauri', () => ({}));
vi.mock('./window-role', () => ({}));

import { subscribeTradeReports } from './boot';

const stock = { account_type: 'S', broker_id: 'fixture', account_id: 'stock', signed: true };
const futures = { account_type: 'F', broker_id: 'fixture', account_id: 'futures', signed: true };

beforeEach(() => {
    vi.clearAllMocks();
    mocks.accounts.mockResolvedValue([stock, futures]);
    mocks.health.mockResolvedValue({ state: 'Healthy', reasons: [] });
    mocks.subscribe.mockResolvedValue(undefined);
    mocks.invoke.mockResolvedValue('ok');
});

describe('subscribeTradeReports on desktop', () => {
    it('asks the native host for every signed account and never subscribes itself', async () => {
        await subscribeTradeReports();
        expect(mocks.invoke.mock.calls).toEqual([
            ['execution_ensure_trade_reports', { origin: 'http://127.0.0.1:21322', account: { accountType: 'S', brokerId: 'fixture', accountId: 'stock' } }],
            ['execution_ensure_trade_reports', { origin: 'http://127.0.0.1:21322', account: { accountType: 'F', brokerId: 'fixture', accountId: 'futures' } }],
        ]);
        expect(mocks.health).not.toHaveBeenCalled();
        expect(mocks.subscribe).not.toHaveBeenCalled();
    });

    it('keeps the direct path for a sidecar the App does not own', async () => {
        mocks.invoke.mockResolvedValue('unowned');
        mocks.health.mockResolvedValue({ state: 'Unknown', reasons: [{ event_type: 'StockOrder', reason: 'NotSubscribed' }] });
        await subscribeTradeReports();
        expect(mocks.subscribe.mock.calls).toEqual([[stock], [futures]]);
    });

    it('a native failure surfaces exactly like a subscribe failure', async () => {
        mocks.invoke.mockRejectedValueOnce(new Error('trade reports stock: subscribe_trade: HTTP 500'));
        await expect(subscribeTradeReports()).rejects.toThrow('HTTP 500');
        expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'err', title: '委託回報訂閱失敗' }));
        expect(mocks.subscribe).not.toHaveBeenCalled();
    });
});
