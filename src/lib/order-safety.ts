import type { ContractBase } from './types/contract';

export function orderMutationNotStarted(message: string) {
    return Object.assign(new Error(message), {
        mutationNotStarted: true as const,
    });
}

export function assertKnownOrderEnvironment(info: { simulation?: unknown }) {
    if (typeof info.simulation !== 'boolean') {
        throw orderMutationNotStarted(
            '無法確認交易環境（simulation/production），已拒絕送單',
        );
    }
    return info.simulation;
}

export function assertTradingStreamLive(status: string) {
    if (status !== 'live') {
        throw orderMutationNotStarted(
            '行情未連線（非 LIVE），已拒絕送單',
        );
    }
}

export interface ProductionRiskProfile {
    enabled: boolean;
    maxQty: number;
    maxDailyLoss: number;
    confirmManualOrders: boolean;
}

export const PRODUCTION_MAX_ORDER_QTY = 1;
export const PRODUCTION_MAX_DAILY_LOSS_TWD = 5_000;
export const MAX_QUOTE_AGE_MS = 15_000;

export type OrderIntent = 'manual' | 'automation' | 'agent' | 'unknown';

export function assertProductionOrderIntent(
    simulation: boolean,
    intent: OrderIntent = 'unknown',
) {
    if (!simulation && intent !== 'manual') {
        throw orderMutationNotStarted(
            '保守實單階段僅允許已人工確認的手動委託；自動、Agent 或來源不明的委託已封鎖',
        );
    }
}

export function assertProductionRiskConfigured(
    simulation: boolean,
    risk: ProductionRiskProfile,
) {
    if (simulation) return;
    if (
        !risk.enabled
        || !Number.isFinite(risk.maxQty)
        || risk.maxQty <= 0
        || risk.maxQty > PRODUCTION_MAX_ORDER_QTY
        || !Number.isFinite(risk.maxDailyLoss)
        || risk.maxDailyLoss <= 0
        || risk.maxDailyLoss > PRODUCTION_MAX_DAILY_LOSS_TWD
        || !risk.confirmManualOrders
    ) {
        throw orderMutationNotStarted(
            '正式交易前必須啟用風控、設定有限的單筆上限與日虧上限，並開啟手動下單確認',
        );
    }
}

export function assertFreshOrderQuote(
    receivedAt: number | undefined,
    now = Date.now(),
    maxAgeMs = MAX_QUOTE_AGE_MS,
) {
    const age = receivedAt === undefined ? Number.POSITIVE_INFINITY : now - receivedAt;
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) {
        throw orderMutationNotStarted(
            `即時行情已過期或缺失（需在 ${Math.round(maxAgeMs / 1000)} 秒內），已拒絕送單`,
        );
    }
}

export interface OrderQuoteSnapshot {
    updatedAt?: number;
    tick?: { close?: unknown };
    bidask?: {
        bid_price?: readonly unknown[];
        ask_price?: readonly unknown[];
    };
}

function positivePrice(value: unknown) {
    const price = Number(value);
    return Number.isFinite(price) && price > 0;
}

export function assertUsableOrderQuote(
    quote: OrderQuoteSnapshot | undefined,
    action: 'Buy' | 'Sell',
    priceType: string,
    now = Date.now(),
) {
    assertFreshOrderQuote(quote?.updatedAt, now);

    const bestBid = quote?.bidask?.bid_price?.[0];
    const bestAsk = quote?.bidask?.ask_price?.[0];
    const marketOrder = priceType === 'MKT' || priceType === 'MKP';
    if (marketOrder) {
        const executableSide = action === 'Buy' ? bestAsk : bestBid;
        if (!positivePrice(executableSide)) {
            throw orderMutationNotStarted(
                action === 'Buy'
                    ? '市價買單缺少有效賣一，已拒絕送單'
                    : '市價賣單缺少有效買一，已拒絕送單',
            );
        }
        return;
    }

    if (
        !positivePrice(quote?.tick?.close)
        && !positivePrice(bestBid)
        && !positivePrice(bestAsk)
    ) {
        throw orderMutationNotStarted(
            '即時行情沒有有效成交價或買賣價，已拒絕送單',
        );
    }
}

export function assertValidOrderQuantity(quantity: number) {
    if (!Number.isInteger(quantity) || quantity <= 0) {
        throw orderMutationNotStarted('委託數量必須是正整數');
    }
}

export function assertExplicitOrderContract(contract: ContractBase) {
    if (
        (contract.security_type === 'FUT' || contract.security_type === 'OPT')
        && /R[12]$/i.test(contract.code)
    ) {
        throw orderMutationNotStarted(
            `連續月 ${contract.code} 僅供行情，下單必須使用明確月份契約`,
        );
    }
}
