import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    fetchAccountBalance,
    fetchKbars,
    fetchProfitLoss,
    fetchHealth,
    fetchScanner,
    fetchSettlements,
    fetchSnapshots,
    placeStockOrder,
    subscribeMarketSignal,
    subscribeQuote,
} from './kgi-adapter';
import type { ContractBase } from '../types/contract';

const contract: ContractBase = {
    region: 'TW',
    exchange: 'TSE',
    code: '2330',
    security_type: 'STK',
    target_code: null,
};

function mockJson(status: number, body: unknown) {
    return Promise.resolve(
        new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
        }),
    );
}

describe('KGI backend adapter', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('passes disconnected backend health through without mock fallback', async () => {
        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(() =>
                mockJson(200, {
                    status: 'disconnected',
                    connected: false,
                    version: 'kgisuperpy',
                    timestamp: '2026-08-17T00:00:00',
                    token_expires_in_seconds: 0,
                    token_stale: true,
                    next_maintenance: '',
                }),
            );

        await expect(fetchHealth()).resolves.toMatchObject({
            status: 'disconnected',
            token_stale: true,
        });
        expect(fetchMock).toHaveBeenCalledWith(
            'http://127.0.0.1:21323/api/v1/health',
        );
    });

    it('posts quote requests to the Python backend', async () => {
        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(() => mockJson(200, [{ code: '2330' }]));

        await fetchSnapshots([contract]);

        expect(fetchMock).toHaveBeenCalledWith(
            'http://127.0.0.1:21323/api/v1/data/snapshots',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ contracts: [contract] }),
            }),
        );
    });

    it('posts K-bar timeframe to the Python backend', async () => {
        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(() =>
                mockJson(200, {
                    datetime: ['2026-08-18'],
                    Open: [1],
                    High: [1],
                    Low: [1],
                    Close: [1],
                    Volume: [1],
                    Amount: [1],
                }),
            );

        await fetchKbars(contract, '2026-08-18', '2026-08-18', 1440);

        expect(fetchMock).toHaveBeenCalledWith(
            'http://127.0.0.1:21323/api/v1/data/kbars',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    contract,
                    start: '2026-08-18',
                    end: '2026-08-18',
                    minute: 1440,
                }),
            }),
        );
    });

    it('passes nullable real account values without client fallback', async () => {
        vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
            mockJson(200, {
                acc_balance: null,
                total_assets: null,
                realized_pnl: 0,
                date: '2026-08-18',
                errmsg: '',
            }),
        );

        await expect(fetchAccountBalance()).resolves.toMatchObject({
            acc_balance: null,
            total_assets: null,
            realized_pnl: 0,
        });
    });

    it('keeps settlement zero distinct from unavailable', async () => {
        vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
            mockJson(200, [
                { T: 0, date: '2026-08-18', amount: 0 },
                { T: 1, date: '2026-08-19', amount: null },
            ]),
        );

        await expect(fetchSettlements()).resolves.toEqual([
            { T: 0, date: '2026-08-18', amount: 0 },
            { T: 1, date: '2026-08-19', amount: null },
        ]);
    });

    it('posts realized P&L date filters to the Python backend', async () => {
        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(() => mockJson(200, []));

        await fetchProfitLoss('S', '2026-08-18', '2026-08-18');

        expect(fetchMock).toHaveBeenCalledWith(
            'http://127.0.0.1:21323/api/v1/portfolio/profit_loss',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    account_type: 'S',
                    begin_date: '2026-08-18',
                    end_date: '2026-08-18',
                }),
            }),
        );
    });

    it('surfaces scanner entitlement errors for the ranking UI', async () => {
        vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
            mockJson(403, { message: '此帳戶無排行資料權限' }),
        );

        await expect(fetchScanner('AmountRank', 20, true)).rejects.toThrow(
            '此帳戶無排行資料權限',
        );
    });

    it('subscribes through the backend stream endpoint', async () => {
        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(() =>
                mockJson(200, { success: true, message: 'ok' }),
            );

        await expect(subscribeQuote(contract, 'Tick')).resolves.toMatchObject({
            success: true,
        });
        expect(fetchMock).toHaveBeenCalledWith(
            'http://127.0.0.1:21323/api/v1/stream/subscribe',
            expect.objectContaining({ method: 'POST' }),
        );
    });

    it('uses broker-neutral capability stream endpoints', async () => {
        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(() =>
                mockJson(200, { success: true, message: 'ok' }),
            );

        await subscribeMarketSignal('bid_near_limit_up', 'TSE');

        expect(fetchMock).toHaveBeenCalledWith(
            'http://127.0.0.1:21323/api/v1/stream/subscribe/market_signal',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    scanner: 'bid_near_limit_up',
                    exchange: 'TSE',
                }),
            }),
        );
    });

    it('posts stock orders with a client request id', async () => {
        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(() =>
                mockJson(200, {
                    contract,
                    order: { id: 'req-1', action: 'Buy', quantity: 1 },
                    status: { status: 'Submitted' },
                }),
            );

        await expect(
            placeStockOrder(contract, {
                action: 'Buy',
                price: 100,
                quantity: 1,
                price_type: 'LMT',
                order_type: 'ROD',
                client_request_id: 'req-1',
            }),
        ).resolves.toMatchObject({ status: { status: 'Submitted' } });
        expect(fetchMock).toHaveBeenCalledWith(
            'http://127.0.0.1:21323/api/v1/order/place_order',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    contract,
                    stock_order: {
                        action: 'Buy',
                        price: 100,
                        quantity: 1,
                        price_type: 'LMT',
                        order_type: 'ROD',
                        client_request_id: 'req-1',
                    },
                    client_request_id: 'req-1',
                }),
            }),
        );
    });
});
