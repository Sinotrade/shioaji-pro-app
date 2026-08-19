// src/lib/utils/contract-cost.ts — 台灣市場契約乘數與交易稅率
// （order-ticket 成本試算與策略回測共用）。

import type { ContractInfo } from '../types/contract';

const FUT_MULTIPLIER: Record<string, number> = {
    TXF: 200,
    MXF: 50,
    TMF: 10,
    EXF: 4000,
    FXF: 1000,
};

// TAIFEX 契約單位: 股票期貨 2,000 股/口、ETF 期貨 10,000 受益權單位/口
// (issue #2: 股票期貨契約價值被算成 價格×50)
export function contractMultiplier(contract: ContractInfo): number {
    if (contract.multiplier && contract.multiplier > 0) {
        return contract.multiplier;
    }
    const root = contract.root ?? contract.category;
    const byRoot = FUT_MULTIPLIER[root];
    if (byRoot) return byRoot;
    const underlying = contract.underlying_code ?? '';
    if (contract.spec_kind === 'etf_fut' || underlying.startsWith('00')) {
        return 10000; // ETF futures
    }
    if (
        contract.spec_kind === 'stock_fut' ||
        contract.underlying_kind === 'S'
    ) {
        return 2000; // single-stock futures/options
    }
    return 50; // index products default (TXO-style)
}

// 期交稅率 per product family (per side, on contract value):
// equity-type futures 0.00002; options 0.001 on premium;
// gold futures 0.0000025; interest-rate futures 0.00000125
export function futuresTaxRate(contract: ContractInfo | string): number {
    const root =
        typeof contract === 'string'
            ? contract
            : (contract.root ?? contract.category);
    if (root === 'GDF' || root === 'TGF') return 0.0000025;
    if (root === 'GBF') return 0.00000125;
    return 0.00002;
}

// 證交稅（賣出）：一般股票 0.3%、ETF 與權證 0.1%
export function stockTaxRate(contract: ContractInfo): number {
    const code = contract.code;
    if (
        contract.security_type === 'WRT' ||
        code.startsWith('00') ||
        contract.underlying_kind === 'E'
    ) {
        return 0.001;
    }
    return 0.003;
}

export function stockOrderShares(quantity: number, oddLot: boolean): number {
    return oddLot ? quantity : quantity * 1000;
}

export function stockOrderNotional(
    limitPrice: number,
    quantity: number,
    oddLot: boolean,
): number {
    return limitPrice * stockOrderShares(quantity, oddLot);
}

// 漲停/跌停/買一/賣一 order-ticket price shortcuts — one pure function so
// "what counts as a usable price" is defined once and unit-testable
// directly, instead of only inline in the component. 0 is never a valid
// limit/bid/ask (the backend normalizes an unavailable KGI limit price to
// 0 — see backend/kgi_bridge/normalizers.py's number() NaN guard — so 0
// here means "no verified value", not "the limit is zero").
export function validShortcutPrice(
    value: number | null | undefined,
): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : null;
}

export interface PriceShortcuts {
    limitUp: number | null;
    limitDown: number | null;
    bid1: number | null;
    ask1: number | null;
}

// Reads straight from the given contract/bid-ask snapshot every call —
// deliberately takes no memoized/cached state, so calling it again for a
// newly-selected symbol can never return the previous symbol's values.
export function resolvePriceShortcuts(
    contract: Pick<ContractInfo, 'limit_up' | 'limit_down'>,
    bidAsk?: { bid_price?: string[]; ask_price?: string[] } | null,
): PriceShortcuts {
    return {
        limitUp: validShortcutPrice(contract.limit_up),
        limitDown: validShortcutPrice(contract.limit_down),
        bid1: validShortcutPrice(Number(bidAsk?.bid_price?.[0])),
        ask1: validShortcutPrice(Number(bidAsk?.ask_price?.[0])),
    };
}
