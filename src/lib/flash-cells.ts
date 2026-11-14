// src/lib/flash-cells.ts — #402 閃電梯子每個價位的「我的委託」格。
//
// 每個價位、每一邊一格：未成交（掛在這個價位、目前單位、還在場上的委託剩餘量）與
// 已成交（今日在這個價位成交的量，依成交價歸位，含市價單與以較好價格成交的限價單）。
// 委託格設定（齒輪選單「委託格」）：
//   分段（預設）：一個膠囊，外側實心＝已成交、內側外框＝未成交
//   精簡：只顯示未成交；這個價位沒有未成交才顯示實心成交數
// 分段只有左右並排一種排法；面板寬度 < SPLIT_MIN_WIDTH 時整個面板改用精簡。
// 只看面板寬度、不看數字位數：同樣寬度一定同樣排法，成交量變大不會讓面板跳版。
import { fmtCompactInt } from './utils/format';
import type { Trade } from './types/order';

/** 分段需要的最小面板寬度（px）。七欄時我的委託欄 3.5rem（兩段合計 8 個字，零股
 * 9999｜9999）、觸價欄 1.6rem、價格欄 3.9rem，量欄在這個寬度仍有約 3rem（五位數量） */
export const SPLIT_MIN_WIDTH = 330;

export type FlashOrderCells = 'split' | 'compact';

/** 實際用哪一種寫法；設定分段但面板太窄時 fallback 是給齒輪選單的原因。
 * width 未知（尚未量到，或測試環境）照設定 */
export function flashCellsMode(setting: FlashOrderCells, width: number | null): { split: boolean; fallback: string | null } {
    if (setting === 'compact') return { split: false, fallback: null };
    if (width !== null && width > 0 && width < SPLIT_MIN_WIDTH) {
        return { split: false, fallback: `面板寬度不到 ${SPLIT_MIN_WIDTH}px，放不下分段` };
    }
    return { split: true, fallback: null };
}

/** 格子裡的數量：一萬以下照寫、不加千分位（9999），一萬以上用「萬」（同五檔量精簡寫法）；
 * 完整數字在滑鼠提示 */
export function fmtCellQty(v: number): string {
    return v >= 10_000 ? fmtCompactInt(v) : String(Math.round(v));
}

/** 提示裡逐筆列出的委託 */
export interface CellOrder {
    id: string;
    ordno: string;
    /** 這筆委託還在這個價位的未成交量（不在這個價位、或已不在場上＝0） */
    working: number;
    /** 這筆委託今日在這個價位的成交量 */
    filled: number;
}

export interface LadderCell {
    working: number;
    filled: number;
    /** 這個價位、這一邊還在場上的委託筆數（點一下會刪的筆數） */
    orders: number;
    /** 這些在場上的委託全部已送出刪單、還沒有結果 */
    pending: boolean;
    detail: CellOrder[];
}

export type LadderCells = Map<string, { buy?: LadderCell; sell?: LadderCell }>;

const sideOf = (t: Trade): 'buy' | 'sell' | null => (t.order.action === 'Buy' ? 'buy' : t.order.action === 'Sell' ? 'sell' : null);

/** 梯子每個價位的格子。working／fills 的範圍由呼叫端決定（和點價刪單同一套規則）。 */
export function ladderCells(trades: readonly Trade[], opts: {
    /** 還在場上、算進這個面板梯子的委託（同 onLadder）；回傳剩餘量，0＝不在梯子上 */
    workingQty: (t: Trade) => number;
    /** 委託掛在哪個價位（改價後的價格） */
    orderKey: (t: Trade) => string;
    /** 成交算進這個面板（同商品／別名、目前單位） */
    fillScope: (t: Trade) => boolean;
    /** 成交價的價位 key */
    priceKey: (p: number) => string;
    /** 已送出刪單、還沒有結果的委託 id */
    cancelling?: ReadonlySet<string>;
}): LadderCells {
    const m: LadderCells = new Map();
    const cellAt = (key: string, side: 'buy' | 'sell'): LadderCell => {
        const row = m.get(key) ?? {};
        if (!m.has(key)) m.set(key, row);
        return (row[side] ??= { working: 0, filled: 0, orders: 0, pending: true, detail: [] });
    };
    const orderAt = (c: LadderCell, t: Trade): CellOrder => {
        let o = c.detail.find(d => d.id === t.order.id);
        if (!o) {
            o = { id: t.order.id, ordno: t.order.ordno || t.order.seqno || '', working: 0, filled: 0 };
            c.detail.push(o);
        }
        return o;
    };
    for (const t of trades) {
        const side = sideOf(t);
        if (!side) continue;
        const w = opts.workingQty(t);
        if (w > 0) {
            const c = cellAt(opts.orderKey(t), side);
            c.working += w;
            c.orders += 1;
            if (!opts.cancelling?.has(t.order.id)) c.pending = false;
            orderAt(c, t).working += w;
        }
        if (!opts.fillScope(t)) continue;
        for (const d of t.status.deals ?? []) {
            if (!d.quantity) continue;
            const c = cellAt(opts.priceKey(Number(d.price)), side);
            c.filled += d.quantity;
            orderAt(c, t).filled += d.quantity;
        }
    }
    // pending 只在有在場上的委託、且全部都在刪單中才成立
    for (const row of m.values()) {
        for (const c of [row.buy, row.sell]) if (c && c.orders === 0) c.pending = false;
    }
    return m;
}

/** 格子的滑鼠提示。第一行是點一下會做的事（同舊 chip：「刪除 100.00 買單 3」）；
 * 有成交或多筆時逐筆列出。遮金額時不帶任何數量與委託書號 */
export function cellTitle(side: 'buy' | 'sell', priceText: string, c: LadderCell, unit: string, priv: boolean): string {
    const word = side === 'buy' ? '買' : '賣';
    const lines: string[] = [];
    if (priv) {
        if (c.working > 0) lines.push(`刪除 ${priceText} ${word}單`);
        if (c.filled > 0) lines.push(`今日${word === '買' ? '買進' : '賣出'}在 ${priceText} 有成交`);
        if (c.pending) lines.push('刪單送出中…');
        return lines.join('\n');
    }
    if (c.working > 0) lines.push(`刪除 ${priceText} ${word}單 ${c.working}`);
    if (c.pending) lines.push('刪單送出中…');
    if (c.filled > 0 || c.orders > 1) {
        lines.push(`今日${word === '買' ? '買進' : '賣出'}成交 ${c.filled} @ ${priceText}・未成交 ${c.working} ${unit}`);
        for (const o of c.detail) {
            const parts = [o.filled > 0 ? `成交 ${o.filled}` : '', o.working > 0 ? `未成交 ${o.working}` : ''].filter(Boolean);
            lines.push(`・${o.ordno ? `委託 ${o.ordno}` : '委託'}：${parts.join('、')}`);
        }
    }
    return lines.join('\n');
}

// ---- 刪單送出中 ----
// 點格子刪單後，格子顯示「刪單送出中」直到委託狀態更新為不在場上（已刪或已成交），或刪單
// 失敗；刪單請求回來不算（券商確認後的狀態更新可能更晚）。最多 CANCEL_PENDING_MAX_MS，
// 狀態一直沒更新也會恢復，不會卡住。

/** 刪單送出中最長顯示時間 */
export const CANCEL_PENDING_MAX_MS = 15_000;

/** 委託已不在場上（或已不在清單）就不再算刪單送出中；沒有變化時回傳同一個 Set */
export function settleCancelling(cancelling: ReadonlySet<string>, trades: readonly Trade[], workingQty: (t: Trade) => number): ReadonlySet<string> {
    if (cancelling.size === 0) return cancelling;
    const working = new Set(trades.filter(t => workingQty(t) > 0).map(t => t.order.id));
    const next = new Set([...cancelling].filter(id => working.has(id)));
    return next.size === cancelling.size ? cancelling : next;
}

/** 刪單請求的結果裡，失敗（沒送出、被拒、結果不明）的委託 id：立即恢復，不等狀態更新 */
export function failedCancels(ids: readonly string[], results: readonly PromiseSettledResult<unknown>[]): string[] {
    return ids.filter((_, i) => results[i]?.status !== 'fulfilled');
}
