// src/lib/execution/pending-confirm-mock.ts — fake 待確認 data (#201 ③) for
// tests, the dev preview and screenshots until the background engine (①-3)
// implements the contract. Accounts and prices are made up.

import type { PendingConfirmItem, PendingConfirmSnapshot } from './pending-confirm-contract';

export function mockPendingConfirmItem(over: Partial<PendingConfirmItem> = {}): PendingConfirmItem {
    return {
        id: 'mock-1',
        revision: 1,
        state: 'needsConfirm',
        owner: { kind: 'trigger', id: 'trigger-1', leg: 'stop' },
        order: {
            code: 'TXFK6', name: '台指期 11', action: 'Sell', quantity: 1, quantityUnit: 'contract',
            priceType: 'MKT', price: null, orderType: 'IOC', triggerPrice: 17860, triggerCondition: null,
        },
        account: { accountType: 'F', accountId: '0000001', brokerId: 'F002000' },
        env: 'http://127.0.0.1:21323|simulation',
        tag: 'A1B2C3',
        submittedAt: Date.now() - 5 * 60_000,
        session: { tradingDay: '2026-10-08', period: 'day' },
        listingChecks: 3,
        lastCheckedAt: Date.now() - 60_000,
        expiredAt: null,
        ...over,
    };
}

export function mockPendingConfirmSnapshot(over: Partial<PendingConfirmSnapshot> = {}): PendingConfirmSnapshot {
    return { version: 2, runId: 'mock-run', sequence: 1, uncleanShutdown: false, items: [], ...over };
}

/** A varied fake set: trigger stop (MKT), bracket take (LMT), an option
 * trigger, and one whose session already changed. */
export function mockPendingConfirmDemo(env: string): PendingConfirmSnapshot {
    const now = Date.now();
    return mockPendingConfirmSnapshot({
        uncleanShutdown: true,
        items: [
            mockPendingConfirmItem({ id: 'demo-1', env, submittedAt: now - 4 * 60_000 }),
            mockPendingConfirmItem({
                id: 'demo-2', env, tag: 'D4E5F6', submittedAt: now - 3 * 60_000,
                owner: { kind: 'bracket', id: 'bracket-7', leg: 'take' },
                order: { code: 'MXFK6', name: '小台指 11', action: 'Buy', quantity: 2, quantityUnit: 'contract', priceType: 'LMT', price: 17650, orderType: 'ROD', triggerPrice: 17655, triggerCondition: 'below' },
                account: { accountType: 'F', accountId: '0000002', brokerId: 'F002000' },
            }),
            mockPendingConfirmItem({
                id: 'demo-3', env, tag: 'G7H8J9',
                submittedAt: new Date(2026, 9, 7, 10, 32, 5).getTime(),
                state: 'expired', expiredAt: new Date(2026, 9, 7, 13, 45).getTime(),
                session: { tradingDay: '2026-10-07', period: 'day' },
                owner: { kind: 'trigger', id: 'trigger-3', leg: 'take' },
                order: { code: 'TXO17800K6', name: '臺指選 11 月 17800 買權', action: 'Sell', quantity: 1, quantityUnit: 'contract', priceType: 'LMT', price: 128, orderType: 'ROD', triggerPrice: 130, triggerCondition: 'above' },
            }),
        ],
    });
}
