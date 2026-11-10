// src/lib/flash-order-totals.ts — 閃電下單的委託合計（客戶回報：當沖 40–50 張
// 看不到「委託多少、成交多少、先賣回補多少」）。
//
// 只從委託與成交回報算（trades 的 order.quantity／status.deal_quantity／
// cancel_quantity），不經過持倉投影：當沖先賣的持倉投影目前不準，這組數字
// 跟委託成交查詢一致。
//
// 範圍＝面板目前看到的：同一帳戶（呼叫端已 scopedFlashRows）、同一商品
// （含連續月別名）、同一單位（整股／零股分開，#204）。trades 本身就是本交易日的。
import { ACTIVE_ORDER_STATUSES, type Trade } from './types/order';

export interface SideTotals {
    /** 有效委託量＝原始委託 − 已刪（減量）；送單失敗的不算 */
    ordered: number;
    /** 已成交 */
    filled: number;
    /** 未成交、仍在場上（可刪） */
    working: number;
    /** 刪單／減量（只放 tooltip） */
    cancelled: number;
}

export interface FlashOrderTotals {
    buy: SideTotals;
    sell: SideTotals;
    /** 現股當沖先賣：先賣成交、其中已用現股買進回補的量、待回補；沒有先賣成交＝null */
    dayShort: { sold: number; covered: number; open: number } | null;
}

const empty = (): SideTotals => ({ ordered: 0, filled: 0, working: 0, cancelled: 0 });
const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/**
 * @param matches 這個面板的委託（商品、單位）
 * @param stock 股票才算當沖先賣回補
 */
export function flashOrderTotals(trades: readonly Trade[], matches: (t: Trade) => boolean, stock: boolean): FlashOrderTotals {
    const buy = empty();
    const sell = empty();
    let shortSold = 0;
    let cashBought = 0;
    for (const t of trades) {
        if (!matches(t) || t.status.status === 'Failed') continue;
        const side = t.order.action === 'Buy' ? buy : t.order.action === 'Sell' ? sell : null;
        if (!side) continue;
        const { quantity } = t.order;
        const { deal_quantity: deal, cancel_quantity: cancel } = t.status;
        if (![quantity, deal, cancel].every(ok)) continue;
        const effective = Math.max(deal, quantity - cancel);
        side.ordered += effective;
        side.filled += deal;
        side.cancelled += Math.min(cancel, quantity);
        if (ACTIVE_ORDER_STATUSES.has(t.status.status)) side.working += Math.max(0, effective - deal);
        if (stock) {
            // 現股當沖：先賣＝現股＋daytrade_short；回補只算現股買進（融資買不是回補）
            const cash = (t.order.order_cond ?? 'Cash') === 'Cash';
            if (t.order.action === 'Sell' && cash && t.order.daytrade_short) shortSold += deal;
            if (t.order.action === 'Buy' && cash) cashBought += deal;
        }
    }
    const covered = Math.min(shortSold, cashBought);
    return { buy, sell, dayShort: shortSold > 0 ? { sold: shortSold, covered, open: shortSold - covered } : null };
}
