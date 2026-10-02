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

// 債券 ETF（代號以 B 結尾，如 00679B）證交稅停徵至 2026-12-31（證券交易稅條例
// 第 2 條之 2）；之後回到 ETF 0.1%。台灣時間 2027-01-01 00:00 起恢復課徵。
const BOND_ETF_TAX_FREE_UNTIL = Date.parse('2027-01-01T00:00:00+08:00');

export function isBondEtfCode(code: string): boolean {
    return /^00\d{3,4}B$/.test(code);
}

// 證交稅（賣出）：一般股票 0.3%、ETF 與權證 0.1%、債券 ETF 停徵期間 0
export function stockTaxRate(contract: ContractInfo, now: number = Date.now()): number {
    const code = contract.code;
    if (isBondEtfCode(code) && now < BOND_ETF_TAX_FREE_UNTIL) return 0;
    if (
        contract.security_type === 'WRT' ||
        code.startsWith('00') ||
        contract.underlying_kind === 'E'
    ) {
        return 0.001;
    }
    return 0.003;
}

// ---- 台股手續費與證交稅（整數元；下單面板試算與整零價差共用） ----
//
// 手續費 = 成交金額 × 0.1425% × 折數，四捨五入到元，每筆委託最低
// 整股 20 元、零股 1 元（最低手續費由券商訂定，可由呼叫端覆寫）；證交稅 = 賣出成交金額 × 稅率，四捨五入到元。
// 金額以「分」整數、費率以百萬分之一整數計算，避免浮點誤差在 .5 邊界
// 捨入錯邊（1,085 元 × 1,000 股 × 0.0855% = 927.675 → 928）。

export const STOCK_FEE_RATE = 0.001425;
export const STOCK_MIN_FEE_ROUND = 20;
export const STOCK_MIN_FEE_ODD = 1;

/** 價格（元，最多兩位小數）→ 分 */
export function priceCents(price: number): number {
    return Math.round(price * 100);
}

// round(a / b)，a、b 為非負 BigInt，四捨五入
function divRoundHalfUp(a: bigint, b: bigint): bigint {
    return (a * 2n + b) / (2n * b);
}

/** 成交金額（分）× 比率 → 四捨五入到元。rate 以小數表示（0.003 = 0.3%）。 */
export function applyRateYuan(notionalCents: number, rate: number): number {
    if (!(notionalCents > 0) || !(rate > 0)) return 0;
    // 比率放大 1e10（折數 0.28 × 0.1425% = 0.000399 仍是整數）
    const scaled = BigInt(Math.round(rate * 1e10));
    return Number(divRoundHalfUp(BigInt(Math.round(notionalCents)) * scaled, 100n * 10_000_000_000n));
}

/** 單筆委託手續費（元）。discount 為折數小數（6 折 = 0.6，無折扣 = 1）。 */
export function stockTradeFee(notionalCents: number, opts: { odd: boolean; discount?: number; minFee?: number }): number {
    if (!(notionalCents > 0)) return 0;
    const discount = opts.discount ?? 1;
    const fee = applyRateYuan(notionalCents, STOCK_FEE_RATE * discount);
    return Math.max(opts.minFee ?? (opts.odd ? STOCK_MIN_FEE_ODD : STOCK_MIN_FEE_ROUND), fee);
}

/** 單筆賣出證交稅（元） */
export function stockSellTax(notionalCents: number, taxRate: number): number {
    return applyRateYuan(notionalCents, taxRate);
}
