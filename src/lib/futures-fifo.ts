// src/lib/futures-fifo.ts — FIFO lot matching for one futures contract.
// Intra-session the broker returns separate Buy and Sell position rows for the
// same contract (netting happens after close), so the rows alone cannot say
// which lots are still open. Replaying today's deals oldest-first against the
// oldest opposite lots gives the same open lots / cost the broker's FIFO
// netting will (#116). Pure: no stores, no network.

import type { Action, Trade } from './types/order';
import type { FuturePosition } from './types/portfolio';

export interface FifoFill {
    /** `<orderId>:<exchange seq>` — one identity per real fill. */
    key: string;
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
    /** Unrealised P&L of the open lots at `last`, whole dollars. */
    pnl: number;
    lots: FifoLot[];
}

type Row = Pick<FuturePosition, 'direction' | 'quantity' | 'price' | 'last_price'>;

const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * Today's fills for one real contract month from the Trade rows the app holds
 * (already scoped to the account). Trades on a continuous alias resolve via
 * `target_code`. The same deal seen twice (snapshot + live report, or the
 * same order listed twice) counts once. Returns null when a fill cannot be
 * identified (no seq), since it could then be double counted.
 */
export function collectFills(trades: Trade[], code: string): FifoFill[] | null {
    const seen = new Map<string, FifoFill>();
    for (const t of trades) {
        if ((t.contract.target_code || t.contract.code) !== code) continue;
        for (const d of t.status.deals ?? []) {
            if (!d.quantity) continue;
            if (typeof d.seq !== 'string' || !d.seq || !positive(d.quantity) || !positive(Number(d.price))) return null;
            const key = `${t.order.id}:${d.seq}`;
            if (seen.has(key)) continue;
            seen.set(key, { key, action: t.order.action, price: Number(d.price), quantity: d.quantity,
                ts: Number.isFinite(d.ts) ? d.ts : 0 });
        }
    }
    // Stable sort keeps arrival order for equal timestamps.
    return [...seen.values()].sort((a, b) => a.ts - b.ts);
}

/**
 * Replays `fills` FIFO on top of the lots carried from earlier sessions.
 * Carried lots are the broker rows' quantity per direction that today's
 * fills do not explain, priced at the rows' remaining cost, and are the
 * oldest lots. Returns null when rows and fills disagree (a direction has
 * more fills than rows, carried lots on both sides, a missing price or
 * multiplier) so the caller can fall back to an estimate.
 */
export function fifoPosition(rows: Row[], fills: FifoFill[], multiplier: number): FifoPosition | null {
    if (rows.length === 0 || !positive(multiplier)) return null;
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
    const lots: FifoLot[] = [];
    let carriedSides = 0;
    for (const action of ['Buy', 'Sell'] as const) {
        const carried = rowQty[action] - fillQty[action];
        if (carried < 0) return null; // fills the broker rows do not hold
        if (carried === 0) continue;
        const price = (rowCost[action] - fillCost[action]) / carried;
        if (!positive(price)) return null;
        lots.push({ action, price, quantity: carried });
        carriedSides++;
    }
    if (carriedSides > 1) return null; // prior sessions are already netted

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
    if (net !== rowQty.Buy - rowQty.Sell) return null;
    if (qty === 0) return { net: 0, avg: 0, pnl: 0, lots };
    const last = rows.map(r => r.last_price).find(positive);
    if (last === undefined) return null;
    const avg = cost / qty;
    const pnl = Math.round((last - avg) * net * multiplier);
    return { net, avg, pnl: pnl === 0 ? 0 : pnl, lots };
}
