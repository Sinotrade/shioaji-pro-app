// Order-flow calculations from historical ticks (presentation-only, no orders).
// tick_type: 1 = 外盤 (trade at ask, aggressive buy), 2 = 內盤 (trade at bid,
// aggressive sell), 0 = unknown. Delta/CVD follow the aggressor side.

import type { Candle } from './types/market';
import type { HistoryTicks } from './types/tick';
import { wallClockToUtc } from './utils/kbars';

export interface OrderFlowTrade {
    time: number;
    price: number;
    volume: number;
    side: 1 | -1 | 0;
}
export interface OrderFlowBar {
    time: number;
    buy: number;      // 外盤（主動買）
    sell: number;     // 內盤（主動賣）
    delta: number;    // buy - sell
    cvd: number;      // 累計 delta
    imbalance: number; // (buy-sell)/(buy+sell)，-1~1
}
export interface OrderFlowSummary {
    buy: number;
    sell: number;
    delta: number;
    cvd: number;
    buyPct: number;   // 外盤 %
    sellPct: number;  // 內盤 %
    bars: number;
}

/** Normalize column-array HistoryTicks into time-sorted aggressor trades. */
export function ticksToTrades(h: HistoryTicks): OrderFlowTrade[] {
    const n = Math.min(
        h.datetime.length, h.close.length, h.volume.length, h.tick_type.length,
    );
    const trades: OrderFlowTrade[] = [];
    for (let i = 0; i < n; i++) {
        const dt = h.datetime[i];
        const vol = h.volume[i] ?? 0;
        if (!dt || vol <= 0) continue;
        const tt = h.tick_type[i] ?? 0;
        trades.push({
            time: wallClockToUtc(dt),
            price: h.close[i] ?? 0,
            volume: vol,
            side: tt === 1 ? 1 : tt === 2 ? -1 : 0,
        });
    }
    trades.sort((a, b) => a.time - b.time);
    return trades;
}

/** Bucket trades into the chart's bar intervals and accumulate delta / CVD.
 *  Times align to the given bars; untilTime cuts both ticks and bars (replay). */
export function buildOrderFlow(
    tradesInput: OrderFlowTrade[] | HistoryTicks,
    bars: Candle[],
    untilTime = Number.POSITIVE_INFINITY,
): OrderFlowBar[] {
    const trades = Array.isArray(tradesInput)
        ? tradesInput
        : ticksToTrades(tradesInput);
    const flow: OrderFlowBar[] = [];
    let cvd = 0;
    let ti = 0;
    for (let bi = 0; bi < bars.length; bi++) {
        const bar = bars[bi]!;
        if (bar.time >= untilTime) break;
        const next = bi + 1 < bars.length ? bars[bi + 1]!.time : Infinity;
        const end = Math.min(next, untilTime);
        let buy = 0;
        let sell = 0;
        while (ti < trades.length) {
            const tr = trades[ti]!;
            if (tr.time < bar.time) {
                ti++;
                continue;
            }
            if (tr.time >= end) break;
            if (tr.side === 1) buy += tr.volume;
            else if (tr.side === -1) sell += tr.volume;
            ti++;
        }
        const delta = buy - sell;
        cvd += delta;
        const tot = buy + sell;
        flow.push({
            time: bar.time, buy, sell, delta, cvd,
            imbalance: tot > 0 ? delta / tot : 0,
        });
    }
    return flow;
}

/** Whole-session order-flow totals. */
export function summarizeOrderFlow(flow: OrderFlowBar[]): OrderFlowSummary {
    let buy = 0;
    let sell = 0;
    for (const b of flow) {
        buy += b.buy;
        sell += b.sell;
    }
    const delta = buy - sell;
    const tot = buy + sell;
    return {
        buy, sell, delta,
        cvd: flow.at(-1)?.cvd ?? 0,
        buyPct: tot > 0 ? (buy / tot) * 100 : 0,
        sellPct: tot > 0 ? (sell / tot) * 100 : 0,
        bars: flow.length,
    };
}
