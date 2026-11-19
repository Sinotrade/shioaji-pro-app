// src/lib/chart-price-format.ts — K 線／走勢價格軸的小數位數
//
// 台股照 lightweight-charts 預設（2 位、minMove 0.01）；美股跟著價位：
// 1 美元以上 2 位、未滿 1 美元 4 位（與報價板、五檔一致）。同一個圖表元件
// 會換商品（美股 → 台股、0.8 → 1.2 美元），所以每次載入與每筆成交都要依
// 「目前商品 + 目前價格」重新決定，不能只在美股歷史載入成功時設一次。

import type { Region } from './types/contract';
import { usPriceDecimals } from './us/decimal';

export interface ChartPriceFormat {
    type: 'price';
    precision: number;
    minMove: number;
}

const TW_DIGITS = 2;

export function chartPriceDigits(contract: { region?: Region | string } | null | undefined, price?: number | null): number {
    if (contract?.region !== 'US') return TW_DIGITS;
    // 還沒有價格（空圖）先用 2 位，第一筆成交或參考價到了再換
    return price !== null && price !== undefined && Number.isFinite(price) && price > 0 ? usPriceDecimals(price) : TW_DIGITS;
}

export function chartPriceFormat(contract: { region?: Region | string } | null | undefined, price?: number | null): ChartPriceFormat {
    const precision = chartPriceDigits(contract, price);
    return { type: 'price', precision, minMove: 10 ** -precision };
}

/**
 * 只在位數真的改變時才 applyOptions（逐筆成交呼叫也不會每筆重設 series）。
 * reset() 在換商品／重建 series 時呼叫，下一次 sync 一定會套用。
 */
export function createPriceFormatSync(apply: (format: ChartPriceFormat) => void) {
    let current: number | null = null;
    return {
        sync(contract: { region?: Region | string } | null | undefined, price?: number | null) {
            const format = chartPriceFormat(contract, price);
            if (format.precision === current) return;
            current = format.precision;
            apply(format);
        },
        reset() {
            current = null;
        },
    };
}
