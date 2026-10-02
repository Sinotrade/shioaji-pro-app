import { canTrade } from './account-tradable';
import type { OrderEventReport } from './order-report';
import type { Account, AccountedPosition } from './types/portfolio';
import type { AccountedTrade } from './types/order';
import { consumeFifo } from './futures-fifo';

type Rec = Record<string, unknown>;
const record = (v: unknown): Rec | undefined => v && typeof v === 'object' ? v as Rec : undefined;
const text = (v: unknown) => typeof v === 'string' ? v : '';
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

export function reportBody(report: OrderEventReport): Rec | undefined {
    const raw = record(report.raw);
    const data = record(raw?.data);
    return data ? record(data[`${report.market === 'stock' ? 'Stock' : 'Futures'}${report.kind === 'deal' ? 'Deal' : 'Order'}`]) : raw;
}

export interface PositionFill {
    key: string;
    tradeId: string;
    account: Account;
    code: string;
    action: 'Buy' | 'Sell';
    quantity: number;
    price: number;
    ts: number;
    condition: string;
    openClose: string;
}

// Notifications intentionally tolerate missing fields. Accounting must not:
// never infer an account or interpret a missing quantity as zero.
export function positionFill(report: OrderEventReport, accounts: Account[], trades: AccountedTrade[]): PositionFill | null {
    if (report.kind !== 'deal') return null;
    const body = reportBody(report);
    if (!body || !positive(report.price) || !positive(report.quantity) || !report.ts
        || !['Buy', 'Sell'].includes(report.action ?? '') || !text(body.exchange_seq)) return null;
    const type = report.market === 'stock' ? 'S' : 'F';
    const account = accounts.find(a => canTrade(a) && a.account_type === type
        && a.broker_id === text(body.broker_id) && a.account_id === text(body.account_id));
    if (!account || body.combo === true || (body.combo && typeof body.combo === 'object')) return null;
    const trade = trades.find(t => t.order.id === report.tradeId
        && t.account?.account_type === account.account_type
        && t.account?.account_id === account.account_id && t.account?.broker_id === account.broker_id);
    const lot = text(body.order_lot);
    if (type === 'S' && !['Common', 'Odd', 'IntradayOdd', 'Fixing', 'BlockTrade'].includes(lot)) return null;
    const condition = type === 'S' ? text(body.order_cond) : '';
    const openClose = type === 'F' ? trade?.order.octype ?? '' : '';
    if (type === 'S' && condition !== 'Cash') return null;
    if (type === 'F' && !['New', 'Cover', 'Auto'].includes(openClose)) return null;
    const code = trade?.contract.target_code || trade?.contract.code || text(body.full_code) || report.code;
    if (type === 'F' && (text(body.full_code) || text(body.code)) !== code) return null;
    if (!code || !report.tradeId) return null;
    return {
        key: `${type}:${account.broker_id}:${account.account_id}:${Math.floor(report.ts / 86400)}:${text(body.exchange_seq)}:${report.tradeId}`,
        tradeId: report.tradeId, account, code, action: report.action as 'Buy' | 'Sell',
        quantity: report.quantity * (type === 'S' && !['Odd', 'IntradayOdd'].includes(lot) ? 1000 : 1),
        price: report.price, ts: report.ts, condition, openClose,
    };
}

const sameAccount = (p: AccountedPosition, fill: PositionFill) => p.account?.account_type === fill.account.account_type
    && p.account?.broker_id === fill.account.broker_id && p.account?.account_id === fill.account.account_id;

type Lot = { price: number; quantity: number; aggregate?: boolean; snapshot?: boolean };

/** Open lots of a futures/options row, oldest first. Rows the projection built
 * always carry `lots`. A broker snapshot row carries none: it is one lot at
 * the row cost, marked `aggregate` when it holds more than one contract (its
 * real lots may have different prices). */
function rowLots(p: AccountedPosition): Lot[] {
    const lots = 'lots' in p ? p.lots : undefined;
    return lots?.length ? lots
        : [{ price: p.price, quantity: p.quantity, snapshot: true, ...(p.quantity > 1 ? { aggregate: true } : {}) }];
}

const lotCost = (lots: Lot[]) => lots.reduce((s, l) => s + l.price * l.quantity, 0);
const lotQty = (lots: Lot[]) => lots.reduce((s, l) => s + l.quantity, 0);

/**
 * Local estimate only. Ambiguous lots/hedges leave the last snapshot intact.
 *
 * Cost rules follow the broker's position_unit:
 * - Futures/options close FIFO (oldest lots first, as the Flash panel's
 *   replay and the broker netting do); the remaining lots keep their own
 *   prices and the closed lots' unrealized P&L leaves the row.
 * - Cash stock keeps the weighted average cost on a partial sale (the
 *   broker's 平均成本), shrinking P&L proportionally.
 *   Position_unit rows are aggregates (no per-lot detail; position_detail
 *   would cost one accounting query per row, outside #85's no-polling
 *   rule), so partly closing a snapshot row with several contracts cannot
 *   know which price closed: the row keeps the average and is flagged
 *   `costUncertain` so the caller marks positions 待對帳 until a refresh.
 * `mark` is the latest known market price; the fill price is only a fallback
 * when no tick is known, so a fill never rewinds a newer quote.
 */
export function applyPositionFill(rows: AccountedPosition[], fill: PositionFill, multiplier: number, mark?: number): AccountedPosition[] | null {
    if (!positive(multiplier)) return null;
    const futures = fill.account.account_type === 'F';
    const matches = rows.filter(p => sameAccount(p, fill) && p.code === fill.code
        && (futures || !('cond' in p) || (p.cond ?? 'Cash') === fill.condition));
    const same = matches.filter(p => p.direction === fill.action);
    const opposite = matches.filter(p => p.direction !== fill.action);
    if (same.length > 1 || opposite.length > 1 || (same.length && opposite.length && fill.openClose === 'Auto')) return null;
    // Another account's row may carry an older mark: only this account's rows
    // (their own last_price) or the caller's fresh tick are trusted.
    const known = positive(mark) ? mark
        : rows.find(p => sameAccount(p, fill) && p.code === fill.code && positive(p.last_price))?.last_price;
    const marked = (p: AccountedPosition) => positive(mark) ? markPosition(p, mark, multiplier) : p;
    let remaining = fill.quantity;
    let next = rows.slice();
    if (fill.openClose !== 'New' && opposite.length) {
        const old = opposite[0]!;
        const closed = Math.min(old.quantity, remaining);
        remaining -= closed;
        next = next.flatMap(p => {
            if (p !== old) return [p];
            if (old.quantity === closed) return [];
            const q = p.quantity - closed;
            if (!futures) {
                const m = marked(p);
                return [{ ...m, quantity: q, pnl: m.pnl * q / p.quantity,
                    ...('yd_quantity' in m ? { yd_quantity: Math.min(m.yd_quantity, q) } : {}) }];
            }
            const m = marked(p);
            const lots = rowLots(m);
            const { open } = consumeFifo(lots, closed);
            // A partly consumed aggregate snapshot lot: its real FIFO split is unknown.
            const uncertain = open[0]?.aggregate === true && open[0].quantity < lots[0]!.quantity;
            const sign = m.direction === 'Buy' ? 1 : -1;
            const theo = (l: Lot[]) => (m.last_price * lotQty(l) - lotCost(l)) * multiplier * sign;
            // Broker baseline adjustments (P&L not explained by the lots at
            // last_price) belong to the snapshot lot only: lots opened by
            // in-session fills carry none. They shrink with that lot and are
            // dropped once it is fully closed.
            const snapQty = (l: Lot[]) => l[0]?.snapshot ? l[0].quantity : 0;
            const adjust = snapQty(lots) > 0 ? (m.pnl - theo(lots)) * snapQty(open) / snapQty(lots) : 0;
            const pnl = theo(open) + adjust;
            const { lots: _drop, costUncertain: _was, ...rest } = m as AccountedPosition & { lots?: Lot[]; costUncertain?: boolean };
            return [{ ...rest, quantity: q, price: lotCost(open) / q, pnl,
                lots: open, ...(uncertain ? { costUncertain: true } : {}) }];
        });
    }
    if (remaining && fill.openClose === 'Cover') return null;
    // Cash sells beyond known holdings may be day-trade shorts or settlement
    // corrections: do not invent a short holding without that contract.
    if (remaining && !futures && fill.action === 'Sell') return null;
    if (!remaining) return next;
    if (same.length) {
        const old = same[0]!;
        next = next.map(p => {
            if (p !== old) return p;
            const m = marked(p);
            const last = positive(m.last_price) ? m.last_price : fill.price;
            const added = (last - fill.price) * remaining * multiplier * (m.direction === 'Buy' ? 1 : -1);
            const lots = futures ? [...rowLots(m), { price: fill.price, quantity: remaining }] : null;
            return { ...m, quantity: p.quantity + remaining, last_price: last, pnl: m.pnl + added,
                price: (m.price * m.quantity + fill.price * remaining) / (m.quantity + remaining),
                ...(lots ? { lots } : {}) };
        });
    } else {
        const last = positive(known) ? known : fill.price;
        const pnl = (last - fill.price) * remaining * multiplier * (fill.action === 'Buy' ? 1 : -1);
        next.push({ id: -Math.floor(fill.ts * 1000), code: fill.code, direction: fill.action,
            quantity: remaining, price: fill.price, last_price: last, pnl: pnl === 0 ? 0 : pnl, account: fill.account,
            // In-session lots are exact, whatever their size; only broker
            // aggregates (rows without lots) are uncertain.
            ...(!futures ? { yd_quantity: 0, cond: fill.condition } : { lots: [{ price: fill.price, quantity: remaining }] }),
        });
    }
    return next;
}

export function markPosition(p: AccountedPosition, price: number, multiplier: number): AccountedPosition {
    if (!positive(price) || !positive(multiplier) || !Number.isFinite(p.last_price)) return p;
    return { ...p, last_price: price,
        pnl: p.pnl + (price - p.last_price) * p.quantity * multiplier * (p.direction === 'Buy' ? 1 : -1) };
}
