// src/lib/us/us-tick.ts — 美股閃電梯形的價格級距（decimal 字串運算，不用浮點）
//
// 【假設】美股沒有像台股的升降單位表；這裡依 Reg NMS Rule 612（sub-penny rule）
// 假設：價格 ≥ 1 USD 的報價單位是 0.01，< 1 USD 是 0.0001。交易所／券商實際
// 接受的級距若不同（例如某些 ETF 或 TXSE 另有規定），只要改 usTickSize 一處。
// 不套用台股漲跌停（美股 limit_up／limit_down 為 0，不是價格限制）。

import { decAdd, decCompare, decIsPositive, decNormalize, decRound, decSub } from './decimal';

export type UsTick = '0.01' | '0.0001';

/** 【假設】價格 ≥ 1 → 0.01；< 1 → 0.0001（Reg NMS sub-penny rule） */
export function usTickSize(price: string): UsTick {
    const c = decCompare(price, '1');
    return Number.isNaN(c) || c >= 0 ? '0.01' : '0.0001';
}

const digitsOf = (tick: UsTick) => (tick === '0.01' ? 2 : 4);

/**
 * 四捨五入到該價格所在區間的級距；不合法或 ≤ 0 回 null。
 * 0.99995 → 1（進到 ≥ 1 區間，結果仍是 0.01 的整數倍）。
 */
export function usRoundToTick(price: string): string | null {
    if (!decIsPositive(price)) return null;
    const rounded = decRound(price, digitsOf(usTickSize(price)));
    if (rounded === null) return null;
    // 落到 ≥ 1 區間時再對 0.01 取一次（例：0.99995 → 1.0000 → 1）
    const again = decRound(rounded, digitsOf(usTickSize(rounded)));
    return again && decIsPositive(again) ? decNormalize(again) : null;
}

/**
 * 從 price 往上（ticks > 0）或往下（ticks < 0）走幾檔；每一步依所在區間決定級距：
 * 往上用目前價格的級距（0.9999 → 1 → 1.01），往下時目前價格 ≤ 1 就用 0.0001
 * （1 → 0.9999）。先對齊級距再走；走到 ≤ 0 回 null。
 */
export function usStepPrice(price: string, ticks: number): string | null {
    let p = usRoundToTick(price);
    if (p === null || !Number.isSafeInteger(ticks)) return null;
    const n = Math.abs(ticks);
    for (let i = 0; i < n; i++) {
        if (ticks > 0) {
            p = decAdd(p, usTickSize(p));
        } else {
            const tick: UsTick = decCompare(p, '1') > 0 ? '0.01' : '0.0001';
            p = decSub(p, tick);
        }
        if (p === null || !decIsPositive(p)) return null;
        p = decNormalize(p)!;
    }
    return p;
}
