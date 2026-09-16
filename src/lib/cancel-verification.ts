import type { Trade } from './types/order';

export type CancelConfirmation = 'absent' | 'cancel_quantity';

export interface CancelVerification {
    confirmation: CancelConfirmation;
    trade?: Trade;
}

export interface CancelVerificationOptions {
    attempts?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
}

function wait(ms: number) {
    return new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms));
}

export function tradeMatchesId(trade: Trade, tradeId: string) {
    return trade.order.id === tradeId || trade.status.id === tradeId;
}

export function cancellationConfirmation(
    before: Trade,
    current: Trade | undefined,
): CancelVerification | null {
    if (!current) return { confirmation: 'absent' };

    const brokerOrderQuantity = Number.isFinite(before.status.order_quantity)
        && before.status.order_quantity > 0
        ? before.status.order_quantity
        : before.order.quantity;
    const requiredTotalCancellation = Math.max(
        0,
        brokerOrderQuantity - before.status.deal_quantity,
    );
    if (
        current.status.status === 'Cancelled'
        && current.status.cancel_quantity >= requiredTotalCancellation
    ) {
        return { confirmation: 'cancel_quantity', trade: current };
    }
    return null;
}

export async function waitForCancellationConfirmation(
    tradeId: string,
    before: Trade,
    readTrades: () => Promise<Trade[]>,
    options: CancelVerificationOptions = {},
): Promise<CancelVerification> {
    const attempts = options.attempts ?? 8;
    const delayMs = options.delayMs ?? 500;
    const sleep = options.sleep ?? wait;
    let lastObserved: Trade | undefined = before;
    let lastReadError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt > 0) await sleep(delayMs);
        try {
            const trades = await readTrades();
            lastReadError = undefined;
            lastObserved = trades.find((trade) => tradeMatchesId(trade, tradeId));
            const confirmation = cancellationConfirmation(before, lastObserved);
            if (confirmation) return confirmation;
        } catch (error) {
            lastReadError = error;
        }
    }

    const observed = lastObserved
        ? `${lastObserved.status.status}; cancelled=${lastObserved.status.cancel_quantity}; deals=${lastObserved.status.deal_quantity}; quantity=${lastObserved.order.quantity}`
        : 'unavailable';
    const readFailure = lastReadError ? `; readback=${String(lastReadError)}` : '';
    throw Object.assign(
        new Error(
            `撤單結果未確認：${tradeId} 最後狀態 ${observed}${readFailure}`,
        ),
        {
            code: 'CANCEL_UNCONFIRMED' as const,
            mutationOutcomeUnknown: true as const,
            reconcileRequired: true as const,
            tradeId,
            observedStatus: lastObserved?.status.status ?? null,
            observedCancelQuantity:
                lastObserved?.status.cancel_quantity ?? null,
        },
    );
}
