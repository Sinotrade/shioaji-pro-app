// src/lib/flash-order-totals.ts — 閃電下單的委託合計（客戶回報：當沖 40–50 張
// 看不到「委託多少、成交多少、先賣回補多少」）。
//
// 只從委託與成交回報算（trades 的 order.quantity／status.deal_quantity／
// cancel_quantity），不經過持倉投影：當沖先賣的持倉投影目前不準，這組數字
// 跟委託成交查詢一致。
//
// 範圍＝面板目前看到的：同一帳戶（呼叫端已 scopedFlashRows）、同一個實際
// 月份的商品（sameContractMonth）、同一單位（整股／零股分開，#204）、本交易日
// （/order/trades 會帶前一時段的成交）：期貨用 futures-fifo 的 tradingDayStart
// （前一日 15:00 夜盤起），股票用台北時間當日 00:00（flashTotalsSince）。
import { ACTIVE_ORDER_STATUSES, type AccountedTrade, type Trade } from './types/order';
import type { ContractBase } from './types/contract';
import { stockDayStart, stockOrderConditions, type StockOrderConditions } from './stock-order-conditions';
import { tradingDayStart } from './futures-fifo';

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
    /** 時間未知的成交（deal_quantity 多於成交明細、或明細沒有時間）：先賣或現股買進
     * 的這部分不猜時間、不進重播，回補狀態改顯示「待確認」 */
    untimedSell: number;
    untimedBuy: number;
}

export interface FlashOrderTotals {
    buy: SideTotals;
    sell: SideTotals;
    /** 股票才有；沒有先賣、也沒有條件未知的賣出成交＝null */
    dayShort: DayShortTotals | null;
}

const empty = (): SideTotals => ({ ordered: 0, filled: 0, working: 0, cancelled: 0 });
const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** 連續月別名（TXFR1／MXFR2）：本身不是實際月份 */
const isContinuousAlias = (code: string) => /R[12]$/.test(code);
/** 明確的實際月份：有 target_code 用它；沒有時代碼本身不是連續月別名才算 */
const realMonth = (c: { code: string; target_code?: string | null }): string | undefined =>
    c.target_code || (isContinuousAlias(c.code) ? undefined : c.code);

/** 委託與面板是不是同一個實際月份。兩邊都有明確實際月份時只比實際月份（換月後
 * MXFR1→MXFI6 的舊委託不是 MXFR1→MXFJ6 面板的委託）；只有一方知道實際月份時，
 * 才用連續月別名（代碼、target_code、串流登記的別名）比對 */
export function sameContractMonth(t: Trade, panel: Pick<ContractBase, 'code' | 'target_code'>, aliasOf?: (code: string) => string | undefined): boolean {
    const tc = t.contract.code;
    const tReal = realMonth(t.contract);
    const pReal = realMonth(panel);
    if (tReal && pReal) return tReal === pReal;
    return tc === panel.code || (!!tReal && tReal === panel.code) || (!!pReal && tc === pReal) || (!!aliasOf && aliasOf(tc) === panel.code);
}

/** 本交易日的委託：有委託時間就看委託時間；沒有時看成交時間，或仍在場上 */
function isToday(t: Trade, since: number): boolean {
    const ts = t.status.order_ts;
    if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) return ts >= since;
    const deals = t.status.deals ?? [];
    if (deals.length > 0) return deals.some(d => !(d.ts < since));
    return true;
}

/** 合計計入的委託：面板範圍、不是送單失敗、本交易日、數量合法 */
function counted(t: Trade, matches: (t: Trade) => boolean, since: number): boolean {
    if (!matches(t) || t.status.status === 'Failed' || !isToday(t, since)) return false;
    if (t.order.action !== 'Buy' && t.order.action !== 'Sell') return false;
    return [t.order.quantity, t.status.deal_quantity, t.status.cancel_quantity].every(ok);
}
/** 有效委託量＝原始委託 − 已刪，至少是已成交 */
const effectiveQty = (t: Trade) => Math.max(t.status.deal_quantity, t.order.quantity - t.status.cancel_quantity);
/** 仍在場上未成交的量（合計的「未成交」） */
const workingQty = (t: Trade) => ACTIVE_ORDER_STATUSES.has(t.status.status) ? Math.max(0, effectiveQty(t) - t.status.deal_quantity) : 0;

/** 合計「未成交」算到的委託，逐筆列出：買全刪／賣全刪的目標就是這一組（同一個
 * 判斷，按鈕上的筆數＝實際送出的刪單） */
export function flashWorkingOrders(trades: readonly Trade[], matches: (t: Trade) => boolean, since: number): { buy: Trade[]; sell: Trade[] } {
    const out = { buy: [] as Trade[], sell: [] as Trade[] };
    for (const t of trades) {
        if (!counted(t, matches, since) || workingQty(t) <= 0) continue;
        out[t.order.action === 'Buy' ? 'buy' : 'sell'].push(t);
    }
    return out;
}

type ConditionsOf = (t: Trade) => StockOrderConditions | undefined;
/** 信用條件：委託列（HTTP／回報投影）優先；現沖先賣旗標只有本 App 送單時記下的 */
const recordedConditions: ConditionsOf = t => stockOrderConditions((t as AccountedTrade).account ?? t.order.account, { seqno: t.order.seqno, ordno: t.order.ordno });

/**
 * @param matches 這個面板的委託（商品、單位）
 * @param stock 股票才算當沖先賣回補
 * @param since 本交易日起點（epoch 秒，tradingDayStart）
 */
export function flashOrderTotals(trades: readonly Trade[], matches: (t: Trade) => boolean, stock: boolean, since: number,
    conditionsOf: ConditionsOf = recordedConditions): FlashOrderTotals {
    const buy = empty();
    const sell = empty();
    const ds = { unknownSell: 0, unknownBuy: 0, untimedSell: 0, untimedBuy: 0 };
    const fills: Fill[] = [];
    for (const t of trades) {
        if (!counted(t, matches, since)) continue;
        const side = t.order.action === 'Buy' ? buy : sell;
        const { quantity } = t.order;
        const { deal_quantity: deal, cancel_quantity: cancel } = t.status;
        side.ordered += effectiveQty(t);
        side.filled += deal;
        side.cancelled += Math.min(cancel, quantity);
        side.working += workingQty(t);
        if (!stock || deal <= 0) continue;
        // 條件不明時不猜成現股：不算先賣、也不算回補，另外計數
        const recorded = conditionsOf(t);
        const cond = t.order.order_cond || recorded?.cond;
        if (t.order.action === 'Buy') {
            if (!cond) ds.unknownBuy += deal;
            else if (cond === 'Cash') ds.untimedBuy += dealFills(t, deal, 'cover', fills); // 融資買不是現沖回補
        } else {
            const short = t.order.daytrade_short ?? recorded?.daytradeShort;
            if (!cond || (cond === 'Cash' && short === undefined)) ds.unknownSell += deal;
            else if (cond === 'Cash' && short) ds.untimedSell += dealFills(t, deal, 'short', fills);
            // 一般現股賣出、融資賣、融券賣不影響待回補
        }
    }
    // 依成交時間重播：先賣成交增加待回補，之後的現股買進才扣（最多扣到 0）；
    // 先賣之前的現股買進不算回補。同一秒時買進排前面（不當成回補）：寧可多顯示
    // 待補，也不要誤報補齊
    fills.sort((a, b) => a.ts - b.ts || (a.kind === b.kind ? 0 : a.kind === 'cover' ? -1 : 1));
    let sold = 0;
    let covered = 0;
    let open = 0;
    for (const f of fills) {
        if (f.kind === 'short') { sold += f.qty; open += f.qty; } else {
            const c = Math.min(open, f.qty);
            covered += c;
            open -= c;
        }
    }
    // 買進條件未知只在還有先賣要回補時才有影響
    const any = sold > 0 || ds.unknownSell > 0 || ds.untimedSell > 0;
    return {
        buy,
        sell,
        dayShort: stock && any ? { sold, covered, open, ...ds } : null,
    };
}

interface Fill { ts: number; kind: 'short' | 'cover'; qty: number }
/** 一筆委託有時間的成交明細放進 out（重播用）；回傳時間未知的量：deal_quantity
 * 多於明細合計的差額，加上沒有成交時間的明細。不用委託時間或最後一筆成交時間
 * 代替（會誤判回補順序） */
function dealFills(t: Trade, deal: number, kind: Fill['kind'], out: Fill[]): number {
    let left = deal;
    let untimed = 0;
    for (const d of t.status.deals ?? []) {
        if (left <= 0) break;
        if (!ok(d.quantity) || d.quantity === 0) continue;
        const qty = Math.min(left, d.quantity);
        left -= qty;
        if (typeof d.ts === 'number' && Number.isFinite(d.ts) && d.ts > 0) out.push({ ts: d.ts, kind, qty });
        else untimed += qty;
    }
    return untimed + left;
}

/** 合計的本交易日起點（epoch 秒）：期貨含前一日 15:00 起的夜盤；股票是台北時間當日
 * 00:00，15:00 之後仍是今天（不能套期貨的邊界，否則收盤後合計歸零） */
export function flashTotalsSince(stock: boolean, nowMs = Date.now()): number {
    return stock ? stockDayStart(nowMs) : tradingDayStart(nowMs / 1000);
}
