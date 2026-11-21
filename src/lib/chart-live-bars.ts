// src/lib/chart-live-bars.ts — 即時成交併進 K 棒（K 線面板台股、美股共用）
//
// 規則：
// - 成交落在比尾端新的桶 → 開新的一根
// - 落在尾端那一桶 → 更新尾端
// - 落在比尾端舊的桶（亂序、晚到）→ 丟掉，尾端與舊 K 棒都不動。舊 K 棒
//   多半來自歷史、已含這筆成交，改它會改錯收盤、重複算量，指標也不會重算
// - 歷史載入期間收到的成交先暫存；歷史回來後先在記憶體併成 K 棒，再一次
//   畫出（不逐筆更新圖表）。暫存滿了就標 overflow，由呼叫端重抓歷史

import type { ChartTrade } from './chart-trade';
import type { Candle } from './types/market';

export type MergeResult = { kind: 'new' | 'tail'; bar: Candle } | null;

/**
 * bars 是畫在圖上的 K 棒（依時間排序，新開的一根會 push 進去）；tail 是
 * 目前最新一根。barTime 是成交所屬 K 棒的標籤。比 tail 舊回 null。
 */
export function mergeTradeIntoBars(
    bars: Candle[],
    tail: Candle | null,
    barTime: number,
    price: number,
    volume: number,
): MergeResult {
    if (!Number.isFinite(barTime) || !Number.isFinite(price)) return null;
    if (!tail || barTime > tail.time) {
        const bar: Candle = { time: barTime, open: price, high: price, low: price, close: price, volume };
        bars.push(bar);
        return { kind: 'new', bar };
    }
    if (barTime < tail.time) return null;
    tail.high = Math.max(tail.high, price);
    tail.low = Math.min(tail.low, price);
    tail.close = price;
    tail.volume += volume;
    return { kind: 'tail', bar: tail };
}

export const PENDING_TRADE_LIMIT = 50_000;

/** 歷史載入期間暫存的成交；滿了標 overflow（之後的成交沒記到，要重抓歷史） */
export interface PendingTrades {
    key: string;
    trades: ChartTrade[];
    overflow: boolean;
}

export function emptyPending(key = ''): PendingTrades {
    return { key, trades: [], overflow: false };
}

/** 暫存一筆；超過上限回 false 並標 overflow */
export function pushPending(p: PendingTrades, trade: ChartTrade, limit = PENDING_TRADE_LIMIT): boolean {
    if (p.trades.length >= limit) {
        p.overflow = true;
        return false;
    }
    p.trades.push(trade);
    return true;
}

/**
 * 把暫存的成交併進 bars（只動記憶體，不碰圖表）。coveredLabel 是歷史最後
 * 一根 1 分 K 的標籤：1 分 K 標籤 ≤ 它的成交已含在歷史裡，跳過；沒有歷史
 * 時傳 -Infinity。minuteLabel、barTime 由呼叫端給（時段、聚合週期）；
 * barTime 回 null 表示這筆不入圖（例如只看日盤時的夜盤成交）。
 * 回傳最新一根（沒有就 null）。
 */
export function mergePendingTrades(
    bars: Candle[],
    trades: readonly ChartTrade[],
    coveredLabel: number,
    minuteLabel: (t: number) => number,
    barTime: (label: number, t: number) => number | null,
): Candle | null {
    let tail = bars[bars.length - 1] ?? null;
    for (const tr of trades) {
        const label = minuteLabel(tr.time);
        if (!(label > coveredLabel)) continue;
        const bt = barTime(label, tr.time);
        if (bt === null) continue;
        const r = mergeTradeIntoBars(bars, tail, bt, tr.price, tr.volume);
        if (r) tail = r.bar;
    }
    return tail;
}
