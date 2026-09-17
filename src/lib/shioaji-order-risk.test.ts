import { beforeEach, expect, it, vi } from 'vitest';
import type { Account } from './types/portfolio';

const m = vi.hoisted(() => ({
    blocked: null as string | null,
    post: vi.fn(),
    check: vi.fn((quantity: number) => {
        void quantity;
        return m.blocked;
    }),
}));

vi.mock('./api', () => ({
    apiDelete: vi.fn(),
    apiGet: vi.fn(async () => ({
        name: 'fixture',
        version: 'fixture',
        description: '',
        protocols: [],
        simulation: true,
    })),
    apiPost: m.post,
    apiPut: vi.fn(),
}));
vi.mock('./risk', () => ({
    checkOrderAllowed: m.check,
    getRiskSettings: () => ({
        enabled: false,
        maxQty: 0,
        maxDailyLoss: 0,
        locked: false,
        confirmManualOrders: false,
    }),
}));
vi.mock('./stream', () => ({
    getStreamStatus: () => 'live',
    getQuote: () => ({
        updatedAt: Date.now(),
        tick: { close: '45900' },
        bidask: { bid_price: ['45899'], ask_price: ['45901'] },
    }),
    registerCapabilitySubscription: vi.fn(),
    registerSubscription: vi.fn(),
    registerSubscriptionRaw: vi.fn(),
    unregisterCapabilitySubscription: vi.fn(),
    unregisterSubscription: vi.fn(),
}));
vi.mock('./account-store', () => ({
    accountFor: vi.fn(),
    getAccountState: () => ({ accounts: [] }),
}));
vi.mock('./trade-observations', () => ({ observeTradeResponse: vi.fn() }));

import { placeFuturesOrder, placeStockOrder } from './shioaji';

const account: Account = {
    account_type: 'F',
    broker_id: 'fixture',
    account_id: 'owner',
    signed: true,
    username: '',
    person_id: '',
};

beforeEach(() => {
    vi.clearAllMocks();
    m.blocked = '風控狀態已在確認期間改變，下單封鎖';
});

it('rechecks risk at the low-level futures mutation boundary', async () => {
    await expect(placeFuturesOrder(
        {
            code: 'TXFJ6',
            security_type: 'FUT',
            exchange: 'TAIFEX',
            target_code: null,
        },
        {
            action: 'Buy',
            price: 45_900,
            quantity: 1,
            price_type: 'LMT',
            order_type: 'ROD',
        },
        account,
        { orderIntent: 'manual' },
    )).rejects.toMatchObject({ mutationNotStarted: true });

    expect(m.check).toHaveBeenCalledWith(1);
    expect(m.post).not.toHaveBeenCalled();
});

it('rechecks risk at the low-level stock mutation boundary', async () => {
    await expect(placeStockOrder(
        {
            code: '2330',
            security_type: 'STK',
            exchange: 'TSE',
            target_code: null,
        },
        {
            action: 'Sell',
            price: 1_000,
            quantity: 2,
            price_type: 'LMT',
            order_type: 'ROD',
        },
        { ...account, account_type: 'S' },
        { orderIntent: 'manual' },
    )).rejects.toThrow('風控狀態已在確認期間改變');

    expect(m.check).toHaveBeenCalledWith(2);
    expect(m.post).not.toHaveBeenCalled();
});
