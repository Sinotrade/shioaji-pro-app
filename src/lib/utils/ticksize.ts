// src/lib/utils/ticksize.ts — TW market tick sizes
//
// 期權（FUT/OPT）級距不寫死：以 server tick-bands API 為權威（skill 紀律
// 「Do not hard-code futures tick sizes」）— tick_rule 命名的級距表由
// lib/tick-bands 快取，尚未載入時 fallback 到 contract.tick。現貨（STK/
// ETF）交易所級距表 server 不提供，維持本地表。

import { bandTickFor, prefetchTickBands } from '../tick-bands';
import type { ContractBase, ContractInfo } from '../types/contract';

// 有 info metadata（tick_rule/tick）時走 server 級距；仍接受只有
// ContractBase 的呼叫端（metadata 缺席 → 走舊 fallback）
type TickContract = ContractBase &
    Partial<Pick<ContractInfo, 'tick_rule' | 'tick' | 'underlying_kind'>>;

// TWSE/TPEX equities
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
    const st = contract.security_type;
    if (st === 'FUT' || st === 'OPT') {
        // banded 商品（個股期 tw_stock_fut_price_band、TXO premium band
        // 等）：查 server 級距表；未載入先預取（冪等），本輪先走 fallback
        if (contract.tick_rule) {
            prefetchTickBands(contract.tick_rule, st);
            const bt = bandTickFor(contract.tick_rule, price);
            if (bt !== undefined) return bt;
        }
        // fixed basis（指數期等）或 bands 尚未載入：server 給的 tick
        //（banded 商品的 tick 為參考價所在 band，帶內正確）
        const t = Number(contract.tick);
        if (Number.isFinite(t) && t > 0) return t;
        // 無 metadata 的舊資料最後防線
        if (st === 'OPT') return price >= 10 ? 1 : 0.1;
        return contract.underlying_kind === 'S' ? stockTick(price) : 1;
    }
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
