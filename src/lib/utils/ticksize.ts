// src/lib/utils/ticksize.ts — TW market tick size tables

import type { ContractBase, ContractInfo } from '../types/contract';

// 有 info metadata（TAIFEX 1.7 的 tick_rule/spec_kind 等）時能選對級距表；
// 仍接受只有 ContractBase 的呼叫端（metadata 缺席 → 走舊 fallback）
type TickContract = ContractBase &
    Partial<
        Pick<
            ContractInfo,
            | 'tick_rule'
            | 'tick'
            | 'underlying_kind'
            | 'spec_kind'
            | 'underlying_code'
        >
    >;

// TWSE/TPEX equities；個股期同級距（TAIFEX tw_stock_fut_price_band）
function stockTick(price: number): number {
    if (price < 10) return 0.01;
    if (price < 50) return 0.05;
    if (price < 100) return 0.1;
    if (price < 500) return 0.5;
    if (price < 1000) return 1;
    return 5;
}

// ETFs (codes starting with 00)
function etfTick(price: number): number {
    return price < 50 ? 0.01 : 0.05;
}

export function tickSizeFor(contract: TickContract, price: number): number {
    if (contract.security_type === 'FUT') {
        // 個股期跳動跟現股同級距，以 server 的 tick_rule 為準；沒有
        // metadata 的舊資料用 underlying_kind 'S' 判別，但要排除 ETF 期
        // （級距不同，交給下面的 server tick fallback）
        const isEtfFut =
            contract.spec_kind === 'etf_fut' ||
            (contract.underlying_code ?? '').startsWith('00');
        if (
            contract.tick_rule === 'tw_stock_fut_price_band' ||
            (!contract.tick_rule &&
                !isEtfFut &&
                (contract.spec_kind === 'stock_fut' ||
                    contract.underlying_kind === 'S'))
        ) {
            return stockTick(price);
        }
        // 非 1 點跳動的其他期貨（ETF 期等）以 server 提供的 tick 為準
        const t = Number(contract.tick);
        if (Number.isFinite(t) && t > 0) return t;
        return 1; // TXF/MXF/TMF index futures
    }
    if (contract.security_type === 'OPT') return price >= 10 ? 1 : 0.1;
    if (contract.code.startsWith('00')) return etfTick(price);
    return stockTick(price);
}

export function roundToTick(contract: TickContract, price: number): number {
    const tick = tickSizeFor(contract, price);
    const rounded = Math.round(price / tick) * tick;
    // avoid float dust (0.1 steps)
    return Number(rounded.toFixed(2));
}

export function stepPrice(
    contract: TickContract,
    price: number,
    steps: number,
): number {
    let p = price;
    for (let i = 0; i < Math.abs(steps); i++) {
        const tick = tickSizeFor(contract, steps > 0 ? p : p - 0.0001);
        p = Number((p + (steps > 0 ? tick : -tick)).toFixed(2));
    }
    return p;
}
