import { describe, expect, it, vi } from 'vitest';

import {
    cancellationConfirmation,
    tradeMatchesId,
    waitForCancellationConfirmation,
} from './cancel-verification';
import type { Trade } from './types/order';

function trade(overrides: Partial<Trade['status']> = {}): Trade {
    return {
        contract: {
            code: 'TXFJ6', target_code: null, exchange: 'TAIFEX',
            security_type: 'FUT',
        },
        order: {
            id: '007DEB', seqno: '1', ordno: '007DEB', action: 'Buy',
            price: 41155, quantity: 1,
        },
        status: {
            id: '007DEB', status: 'Submitted', status_code: '00',
            order_quantity: 1, deal_quantity: 0, cancel_quantity: 0,
            modified_price: 0, msg: '', deals: [], ...overrides,
        },
    };
}

describe('cancel verification', () => {
    it('matches either broker order id representation', () => {
        const row = trade();
        expect(tradeMatchesId(row, '007DEB')).toBe(true);
        expect(tradeMatchesId(row, 'other')).toBe(false);
    });

    it('accepts disappearance as confirmed cancellation', () => {
        expect(cancellationConfirmation(trade(), undefined)).toEqual({
            confirmation: 'absent',
        });
    });

    it('accepts cancellation only when cancellation quantity covers remaining quantity', () => {
        const before = trade({ order_quantity: 3, deal_quantity: 1 });
        const short = trade({ order_quantity: 3, deal_quantity: 1, cancel_quantity: 1 });
        const quantityOnly = trade({
            order_quantity: 3,
            deal_quantity: 1,
            cancel_quantity: 2,
            status: 'Submitted',
        });
        const covered = trade({ order_quantity: 3, deal_quantity: 1, cancel_quantity: 2, status: 'Cancelled' });
        expect(cancellationConfirmation(before, short)).toBeNull();
        expect(cancellationConfirmation(before, quantityOnly)).toBeNull();
        expect(cancellationConfirmation(before, covered)).toMatchObject({
            confirmation: 'cancel_quantity',
        });
    });

    it('never accepts a Submitted row with zero cancellation despite a successful cancel response', async () => {
        const before = trade();
        const read = vi.fn().mockResolvedValue([before]);
        const error = await waitForCancellationConfirmation(
            '007DEB',
            before,
            read,
            { attempts: 3, delayMs: 0, sleep: async () => undefined },
        ).catch((caught: unknown) => caught);

        expect(read).toHaveBeenCalledTimes(3);
        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({
            code: 'CANCEL_UNCONFIRMED',
            mutationOutcomeUnknown: true,
            reconcileRequired: true,
            tradeId: '007DEB',
            observedStatus: 'Submitted',
            observedCancelQuantity: 0,
        });
    });

    it('polls until the cancellation quantity is confirmed', async () => {
        const before = trade();
        const cancelled = trade({ status: 'Cancelled', cancel_quantity: 1 });
        const read = vi.fn()
            .mockResolvedValueOnce([before])
            .mockResolvedValueOnce([cancelled]);
        await expect(waitForCancellationConfirmation(
            '007DEB',
            before,
            read,
            { attempts: 3, delayMs: 0, sleep: async () => undefined },
        )).resolves.toMatchObject({ confirmation: 'cancel_quantity' });
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('does not treat a transient readback error as disappearance', async () => {
        const before = trade();
        const read = vi.fn().mockRejectedValue(new Error('offline'));
        await expect(waitForCancellationConfirmation(
            '007DEB',
            before,
            read,
            { attempts: 2, delayMs: 0, sleep: async () => undefined },
        )).rejects.toMatchObject({ mutationOutcomeUnknown: true });
    });
});
