import type { OrderEventReport } from './order-report';
import type { Account, AccountedPosition } from './types/portfolio';
import type { AccountedTrade } from './types/order';

type Rec = Record<string, unknown>;
const record = (v: unknown): Rec | undefined => v && typeof v === 'object' ? v as Rec : undefined;
const text = (v: unknown) => typeof v === 'string' ? v : '';
const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;

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
    const account = accounts.find(a => a.signed && a.account_type === type
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
    if (type === 'F' && text(body.full_code) && text(body.full_code) !== code) return null;
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

/** Local estimate only. Ambiguous lots/hedges leave the last snapshot intact. */
export function applyPositionFill(rows: AccountedPosition[], fill: PositionFill, multiplier: number): AccountedPosition[] | null {
    if (!positive(multiplier)) return null;
    const matches = rows.filter(p => sameAccount(p, fill) && p.code === fill.code
        && (fill.account.account_type === 'F' || !('cond' in p) || (p.cond ?? 'Cash') === fill.condition));
    const same = matches.filter(p => p.direction === fill.action);
    const opposite = matches.filter(p => p.direction !== fill.action);
    if (same.length > 1 || opposite.length > 1 || (same.length && opposite.length && fill.openClose === 'Auto')) return null;
    let remaining = fill.quantity;
    let next = rows.slice();
    if (fill.openClose !== 'New' && opposite.length) {
        const old = opposite[0]!;
        const closed = Math.min(old.quantity, remaining);
        remaining -= closed;
        next = next.flatMap(p => p !== old ? [p] : old.quantity === closed ? [] : [{
            ...p, quantity: p.quantity - closed, pnl: p.pnl * (p.quantity - closed) / p.quantity,
            ...('yd_quantity' in p ? { yd_quantity: Math.min(p.yd_quantity, p.quantity - closed) } : {}),
        }]);
    }
    if (remaining && fill.openClose === 'Cover') return null;
    // Cash sells beyond known holdings may be day-trade shorts or settlement
    // corrections: do not invent a short holding without that contract.
    if (remaining && fill.account.account_type === 'S' && fill.action === 'Sell') return null;
    if (!remaining) return next;
    if (same.length) {
        const old = same[0];
        next = next.map(p => p !== old ? p : {
            ...markPosition(p, fill.price, multiplier), quantity: p.quantity + remaining,
            price: (p.price * p.quantity + fill.price * remaining) / (p.quantity + remaining),
            // Existing P&L remains the baseline; new fills start at their price.
            last_price: fill.price,
        });
    } else {
        next.push({ id: -Math.floor(fill.ts * 1000), code: fill.code, direction: fill.action,
            quantity: remaining, price: fill.price, last_price: fill.price, pnl: 0, account: fill.account,
            ...(fill.account.account_type === 'S' ? { yd_quantity: 0, cond: fill.condition } : {}),
        });
    }
    return next;
}

export function markPosition(p: AccountedPosition, price: number, multiplier: number): AccountedPosition {
    if (!positive(price) || !positive(multiplier) || !Number.isFinite(p.last_price)) return p;
    return { ...p, last_price: price,
        pnl: p.pnl + (price - p.last_price) * p.quantity * multiplier * (p.direction === 'Buy' ? 1 : -1) };
}
