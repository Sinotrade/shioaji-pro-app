// src/lib/futures-fifo.ts — FIFO lot matching for one futures/options contract.
// Intra-session the broker returns separate Buy and Sell position rows for the
// same contract (netting happens after close), and the App's live projection
// does the same for New fills, so the rows alone cannot say which lots are
// still open. Replaying today's deals oldest-first against the
// oldest opposite lots gives the same open lots / cost the broker's FIFO
// netting will (#116). Pure: no stores, no network.

import type { Action, Trade } from './types/order';
import type { FuturePosition } from './types/portfolio';

export interface FifoFill {
    /** `<orderId>:<exchange seq>` — one identity per real fill. */
    key: string;
    orderId: string;
    /** Exchange seq; numbered per order, so it only orders one order's fills. */
    seq: string;
    action: Action;
    price: number;
    quantity: number;
    ts: number;
}

export interface FifoLot {
    action: Action;
    price: number;
    quantity: number;
}

export interface FifoPosition {
    /** Signed net lots (long > 0). */
    net: number;
    /** Weighted average price of the lots still open. */
    avg: number;
    /** Unrealised P&L of the open lots at the caller's last price, whole dollars. */
    pnl: number;
    lots: FifoLot[];
    /** Lots from earlier sessions were inferred from the rows. A missing
     * fill looks exactly like a carried lot, so a seeded result is not proof
     * of the FIFO cost and callers should present it as an estimate. */
    seeded: boolean;
}

type Row = Pick<FuturePosition, 'direction' | 'quantity' | 'price'>;

const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** Order of two same-time fills: the exchange seq, which counts per order
 * (two orders' first fills are both 000001), so only within one order. */
function seqOrder(a: FifoFill, b: FifoFill): number | null {
    if (a.orderId !== b.orderId || !/^\d+$/.test(a.seq) || !/^\d+$/.test(b.seq) || a.seq === b.seq) return null;
    return Number(a.seq) - Number(b.seq);
}

const TAIPEI_OFFSET = 8 * 3600;

/**
 * Start (epoch seconds) of the TAIFEX trading day `nowSec` belongs to: the
 * night session opening at 15:00 Taipei time on the previous weekday belongs
 * to the next trading day. `/order/trades` also returns the previous
 * session's fills, which must not be replayed against today's rows. Holidays
 * are not known here; around them the start is later than the real one,
 * which can only drop fills (→ estimate), never add old ones.
 */
export function tradingDayStart(nowSec: number): number {
    const local = nowSec + TAIPEI_OFFSET;
    const day = Math.floor(local / 86400);
    let start = day * 86400 + 15 * 3600; // today 15:00 local
    if (local < start) start -= 86400;
    // 1970-01-01 was a Thursday: weekday 0 = Sunday … 6 = Saturday.
    while ([0, 6].includes((Math.floor(start / 86400) + 4) % 7)) start -= 86400;
    return start - TAIPEI_OFFSET;
}

/** Legs a spread/combo trade code touches ("TXFI6/J6" → TXFI6, TXFJ6). */
function comboLegCodes(t: Trade): string[] {
    const legs = (t.contract as { legs?: { code?: string; target_code?: string | null }[] }).legs ?? [];
    const out = legs.flatMap(l => [l.code, l.target_code]).filter((c): c is string => !!c);
    for (const raw of [t.contract.code, t.contract.target_code]) {
        if (!raw?.includes('/')) continue;
        const [near = '', far = ''] = raw.split('/');
        out.push(near, far.length < near.length ? near.slice(0, near.length - far.length) + far : far);
    }
    return out;
}

/** Today's own-code fills include both a buy and a sell (any offsetting). */
export function hasTwoWayFills(trades: Trade[], code: string, since = -Infinity): boolean {
    const sides = new Set<Action>();
    for (const t of trades) {
        if ((t.contract.target_code || t.contract.code) !== code) continue;
        if ((t.status.deals ?? []).some(d => d.quantity > 0 && !(d.ts < since))) sides.add(t.order.action);
    }
    return sides.size === 2;
}

/**
 * Today's fills for one real contract month from the Trade rows the app holds
 * (already scoped to the account). Trades on a continuous alias resolve via
 * `target_code`. The same deal seen twice (snapshot + live report, or the
 * same order listed twice) counts once. Returns null when the fills cannot be
 * trusted for FIFO: a fill without seq or finite time, a spread/combo fill on
 * this contract (its leg is not an order on this code), or same-time fills
 * whose order cannot be told and would change the result.
 */
export function collectFills(trades: Trade[], code: string, since = -Infinity): FifoFill[] | null {
    const seen = new Map<string, FifoFill>();
    for (const t of trades) {
        const own = (t.contract.target_code || t.contract.code) === code;
        if (!own) {
            if (comboLegCodes(t).includes(code) && (t.status.deals ?? []).some(d => d.quantity && !(d.ts < since))) return null;
            continue;
        }
        for (const d of t.status.deals ?? []) {
            if (!d.quantity) continue;
            if (typeof d.seq !== 'string' || !d.seq || !positive(d.quantity) || !positive(Number(d.price))
                || typeof d.ts !== 'number' || !Number.isFinite(d.ts)) return null;
            if (d.ts < since) continue; // an earlier trading day
            const key = `${t.order.id}:${d.seq}`;
            if (seen.has(key)) continue;
            seen.set(key, { key, orderId: t.order.id, seq: d.seq, action: t.order.action, price: Number(d.price),
                quantity: d.quantity, ts: d.ts });
        }
    }
    let ambiguous = false;
    const fills = [...seen.values()].sort((a, b) => {
        if (a.ts !== b.ts) return a.ts - b.ts;
        const bySeq = seqOrder(a, b);
        if (bySeq !== null) return bySeq;
        if (a.action !== b.action || a.price !== b.price) ambiguous = true;
        return 0;
    });
    return ambiguous ? null : fills;
}

/** Row prices may be rounded to cents by the broker. */
const PRICE_EPS = 0.01;

/**
 * Quantities can balance while a buy/sell pair is missing from `fills`, so
 * without carried lots the rows' prices must also follow from the fills:
 * un-netted rows cost exactly what each side filled; rows the live
 * projection netted carry the average-netting replay's price.
 */
function pricesExplained(rowQty: Record<Action, number>, rowCost: Record<Action, number>,
    fillQty: Record<Action, number>, fillCost: Record<Action, number>, fills: FifoFill[]): boolean {
    if (rowQty.Buy === fillQty.Buy && rowQty.Sell === fillQty.Sell) {
        return (['Buy', 'Sell'] as const).every(a => Math.abs(rowCost[a] - fillCost[a]) <= PRICE_EPS * Math.max(1, rowQty[a]));
    }
    if (rowQty.Buy > 0 && rowQty.Sell > 0) return false; // partly netted rows: no known replay
    let pos = 0; // signed lots
    let avg = 0;
    for (const f of fills) {
        const signed = f.action === 'Buy' ? f.quantity : -f.quantity;
        if (pos === 0 || Math.sign(pos) === Math.sign(signed)) {
            avg = (avg * Math.abs(pos) + f.price * f.quantity) / (Math.abs(pos) + f.quantity);
            pos += signed;
        } else if (Math.abs(signed) <= Math.abs(pos)) {
            pos += signed; // closing at the average leaves it unchanged
            if (pos === 0) avg = 0;
        } else {
            pos += signed; // reversal: the remainder opens at the fill price
            avg = f.price;
        }
    }
    const side = pos > 0 ? 'Buy' : 'Sell';
    return pos === rowQty.Buy - rowQty.Sell && pos !== 0
        && Math.abs(rowCost[side] / rowQty[side] - avg) <= PRICE_EPS;
}

/**
 * Replays `fills` FIFO. Any net position today's fills do not explain is a
 * carried lot from an earlier session, seeded as the oldest lot at the
 * rows' remaining cost; that only works when the rows are the broker's
 * un-netted per-direction rows. Works for both un-netted snapshot rows and
 * locally netted rows when nothing is carried. Returns null when rows and
 * fills disagree, so the caller can fall back to an estimate.
 */
export function fifoPosition(rows: Row[], fills: FifoFill[], multiplier: number, last: number): FifoPosition | null {
    if (rows.length === 0 || !positive(multiplier) || !positive(last)) return null;
    const rowQty = { Buy: 0, Sell: 0 };
    const rowCost = { Buy: 0, Sell: 0 };
    for (const r of rows) {
        if (!positive(r.quantity) || !positive(r.price)) return null;
        rowQty[r.direction] += r.quantity;
        rowCost[r.direction] += r.price * r.quantity;
    }
    const fillQty = { Buy: 0, Sell: 0 };
    const fillCost = { Buy: 0, Sell: 0 };
    for (const f of fills) {
        fillQty[f.action] += f.quantity;
        fillCost[f.action] += f.price * f.quantity;
    }
    const rowsNet = rowQty.Buy - rowQty.Sell;
    const carried = rowsNet - (fillQty.Buy - fillQty.Sell);
    const lots: FifoLot[] = [];
    if (carried === 0) {
        // Rows holding more of a side than today filled means lots on both
        // sides predate today — not explainable.
        if (rowQty.Buy > fillQty.Buy || rowQty.Sell > fillQty.Sell) return null;
        if (!pricesExplained(rowQty, rowCost, fillQty, fillCost, fills)) return null;
    } else {
        const action = carried > 0 ? 'Buy' : 'Sell';
        const other = carried > 0 ? 'Sell' : 'Buy';
        const qty = Math.abs(carried);
        if (rowQty[action] - fillQty[action] !== qty || rowQty[other] !== fillQty[other]) return null;
        const price = (rowCost[action] - fillCost[action]) / qty;
        if (!positive(price)) return null;
        lots.push({ action, price, quantity: qty });
    }

    for (const f of fills) {
        let left = f.quantity;
        while (left > 0 && lots.length > 0 && lots[0]!.action !== f.action) {
            const oldest = lots[0]!;
            const closed = Math.min(oldest.quantity, left);
            left -= closed;
            if (closed === oldest.quantity) lots.shift();
            else lots[0] = { ...oldest, quantity: oldest.quantity - closed };
        }
        if (left > 0) lots.push({ action: f.action, price: f.price, quantity: left });
    }

    let net = 0;
    let qty = 0;
    let cost = 0;
    for (const l of lots) {
        net += l.action === 'Buy' ? l.quantity : -l.quantity;
        qty += l.quantity;
        cost += l.price * l.quantity;
    }
    // FIFO keeps the net: net = carried + today's net = the rows' net.
    const seeded = carried !== 0;
    if (qty === 0) return { net: 0, avg: 0, pnl: 0, lots, seeded };
    const avg = cost / qty;
    const pnl = Math.round((last - avg) * net * multiplier);
    return { net, avg, pnl: pnl === 0 ? 0 : pnl, lots, seeded };
}
