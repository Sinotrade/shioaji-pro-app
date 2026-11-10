// src/lib/flash-order-totals.ts — 閃電下單的委託合計（客戶回報：當沖 40–50 張
// 看不到「委託多少、成交多少、先賣回補多少」）。
//
// 只從委託與成交回報算（trades 的 order.quantity／status.deal_quantity／
// cancel_quantity），不經過持倉投影：當沖先賣的持倉投影目前不準，這組數字
// 跟委託成交查詢一致。
//
// 範圍＝面板目前看到的：同一帳戶（呼叫端已 scopedFlashRows）、同一個實際
// 月份的商品（sameContractMonth）、同一單位（整股／零股分開，#204）、本交易日
// （/order/trades 會帶前一時段的成交，用 futures-fifo 的同一個交易日起點）。
import { ACTIVE_ORDER_STATUSES, type AccountedTrade, type Trade } from './types/order';
import type { ContractBase } from './types/contract';
import { stockOrderConditions, type StockOrderConditions } from './stock-order-conditions';

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

export interface DayShortTotals {
    /** 現股當沖先賣成交 */
    sold: number;
    /** 其中已用現股買進回補 */
    covered: number;
    /** 待回補 */
    open: number;
    /** 條件未知的成交（不算先賣也不算回補）：不是本 App 送出的現股賣出（回報
     * 不帶當沖先賣旗標），或信用條件還沒收到的買賣 */
    unknownSell: number;
    unknownBuy: number;
}

export interface FlashOrderTotals {
    buy: SideTotals;
    sell: SideTotals;
    /** 股票才有；沒有先賣、也沒有條件未知的賣出成交＝null */
    dayShort: DayShortTotals | null;
}

const empty = (): SideTotals => ({ ordered: 0, filled: 0, working: 0, cancelled: 0 });
const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** 委託與面板是不是同一個實際月份：連續月別名（MXFR1→MXFI6）兩邊都可能出現，
 * 用 target_code（實際月份）雙向比對，再加上串流登記的別名 */
export function sameContractMonth(t: Trade, panel: Pick<ContractBase, 'code' | 'target_code'>, aliasOf?: (code: string) => string | undefined): boolean {
    const tc = t.contract.code;
    const tReal = t.contract.target_code || tc;
    const pReal = panel.target_code || panel.code;
    return tc === panel.code || tReal === pReal || tReal === panel.code || tc === pReal || (!!aliasOf && aliasOf(tc) === panel.code);
}

/** 本交易日的委託：有委託時間就看委託時間；沒有時看成交時間，或仍在場上 */
function isToday(t: Trade, since: number): boolean {
    const ts = t.status.order_ts;
    if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) return ts >= since;
    const deals = t.status.deals ?? [];
    if (deals.length > 0) return deals.some(d => !(d.ts < since));
    return true;
}

type ConditionsOf = (t: Trade) => StockOrderConditions | undefined;
/** 信用條件：委託列（HTTP／回報投影）優先；現沖先賣旗標只有本 App 送單時記下的 */
const recordedConditions: ConditionsOf = t => stockOrderConditions((t as AccountedTrade).account ?? t.order.account, t.order.id);

/**
 * @param matches 這個面板的委託（商品、單位）
 * @param stock 股票才算當沖先賣回補
 * @param since 本交易日起點（epoch 秒，tradingDayStart）
 */
export function flashOrderTotals(trades: readonly Trade[], matches: (t: Trade) => boolean, stock: boolean, since: number,
    conditionsOf: ConditionsOf = recordedConditions): FlashOrderTotals {
    const buy = empty();
    const sell = empty();
    const ds = { sold: 0, cash: 0, unknownSell: 0, unknownBuy: 0 };
    for (const t of trades) {
        if (!matches(t) || t.status.status === 'Failed' || !isToday(t, since)) continue;
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
        if (!stock || deal <= 0) continue;
        // 條件不明時不猜成現股：不算先賣、也不算回補，另外計數
        const recorded = conditionsOf(t);
        const cond = t.order.order_cond || recorded?.cond;
        if (t.order.action === 'Buy') {
            if (!cond) ds.unknownBuy += deal;
            else if (cond === 'Cash') ds.cash += deal; // 融資買不是現沖回補
        } else {
            const short = t.order.daytrade_short ?? recorded?.daytradeShort;
            if (!cond || (cond === 'Cash' && short === undefined)) ds.unknownSell += deal;
            else if (cond === 'Cash' && short) ds.sold += deal;
        }
    }
    const covered = Math.min(ds.sold, ds.cash);
    // 買進條件未知只在還有先賣要回補時才有影響
    const any = ds.sold > 0 || ds.unknownSell > 0;
    return {
        buy,
        sell,
        dayShort: stock && any ? { sold: ds.sold, covered, open: ds.sold - covered, unknownSell: ds.unknownSell, unknownBuy: ds.unknownBuy } : null,
    };
}
