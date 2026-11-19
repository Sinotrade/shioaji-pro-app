// src/lib/chart-live-bars.ts — 即時成交併進 K 棒（K 線面板台股、美股共用）
//
// 規則：
// - 成交落在比尾端新的桶 → 開新的一根
// - 落在尾端那一桶 → 更新尾端
// - 落在比尾端舊的桶（亂序、晚到）→ 只更新那一根自己；找不到（落在缺口）
//   就丟掉。不能把舊成交的價格與量算進最新一根
// - 歷史載入期間收到的成交先暫存，歷史回來後只補歷史沒涵蓋的部分

import type { Candle } from './types/market';

export type MergeResult = { kind: 'new' | 'tail' | 'older'; bar: Candle } | null;

function touch(bar: Candle, price: number, volume: number) {
    bar.high = Math.max(bar.high, price);
    bar.low = Math.min(bar.low, price);
    bar.close = price;
    bar.volume += volume;
}

function findBar(bars: readonly Candle[], time: number): Candle | undefined {
    let lo = 0;
    let hi = bars.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const t = bars[mid]!.time;
        if (t === time) return bars[mid];
        if (t < time) lo = mid + 1;
        else hi = mid - 1;
    }
    return undefined;
}

/**
 * bars 是畫在圖上的 K 棒（依時間排序，新開的一根會 push 進去）；tail 是
 * 目前最新一根（通常就是 bars 的最後一根）。bucket 是成交所屬 K 棒的標籤。
 */
export function mergeTradeIntoBars(
    bars: Candle[],
    tail: Candle | null,
    bucket: number,
    price: number,
    volume: number,
): MergeResult {
    if (!Number.isFinite(bucket) || !Number.isFinite(price)) return null;
    if (!tail || bucket > tail.time) {
        const bar: Candle = { time: bucket, open: price, high: price, low: price, close: price, volume };
        bars.push(bar);
        return { kind: 'new', bar };
    }
    if (bucket === tail.time) {
        touch(tail, price, volume);
        return { kind: 'tail', bar: tail };
    }
    const older = findBar(bars, bucket);
    if (!older) return null;
    touch(older, price, volume);
    return { kind: 'older', bar: older };
}

export interface PendingTrade {
    /** 牆鐘編碼秒數（可含小數） */
    time: number;
    price: number;
    volume: number;
}

/**
 * 歷史載入期間暫存的成交，挑出要補畫的：coveredUntil 是歷史最後一根 1 分 K
 * 的標籤（結束時間），早於它的成交已含在歷史裡。沒有歷史（空結果、失敗）
 * 時傳 -Infinity，全部補上。順序維持收到的順序。
 */
export function replayPendingTrades(trades: readonly PendingTrade[], coveredUntil: number): PendingTrade[] {
    return trades.filter((t) => t.time >= coveredUntil);
}
