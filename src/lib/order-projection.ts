import type { OrderEventReport } from './order-report';
import { reportBody } from './portfolio-projection';
import type { Account } from './types/portfolio';
import type { AccountedTrade, OrderStatusName } from './types/order';

const rec = (v: unknown) => v && typeof v === 'object' ? v as Record<string, unknown> : undefined;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
function statusOf(quantity: number, deals: number, cancelled: number): OrderStatusName {
    if (deals >= quantity && quantity > 0) return 'Filled';
    if (cancelled + deals >= quantity && cancelled > 0) return 'Cancelled';
    return deals > 0 ? 'PartFilled' : 'Submitted';
}

// Display projection from documented raw reports; native trading continues to
// validate against broker state. Null means insufficient/ambiguous evidence.
export function projectOrderReport(rows: AccountedTrade[], report: OrderEventReport, accounts: Account[]): AccountedTrade[] | null {
    if (report.kind !== 'order') return null;
    const body = reportBody(report);
    const order = rec(body?.order);
    const ref = rec(order?.account);
    const contract = rec(body?.contract);
    const account = accounts.find(a => a.signed && a.account_type === (report.market === 'stock' ? 'S' : 'F')
        && a.broker_id === ref?.broker_id && a.account_id === ref?.account_id);
    if (!account || !report.id || !report.ts || !order || !contract
        || !['Buy', 'Sell'].includes(report.action ?? '') || !num(order.quantity)
        || !num(order.price) || !num(rec(body?.status)?.cancel_quantity)
        || typeof contract.code !== 'string' || !['STK', 'FUT', 'OPT', 'WRT'].includes(String(contract.security_type))) return null;
    const old = rows.find(t => t.order.id === report.id && t.account?.account_type === account.account_type && t.account?.account_id === account.account_id && t.account?.broker_id === account.broker_id);
    const code = report.market === 'futures'
        ? (typeof contract.full_code === 'string' && contract.full_code ? contract.full_code : old?.contract.target_code || old?.contract.code)
        : contract.code;
    if (!code || (old && (old.contract.target_code || old.contract.code) !== code)) return null;
    if (report.failed && report.opType !== 'New') return rows; // rejected cancel/change must not erase a working order
    if (!old && report.opType !== 'New') return null;
    const quantity = report.orderQuantity || old?.status.order_quantity || report.quantity;
    const deals = old?.status.deal_quantity ?? 0;
    const cancelled = Math.max(old?.status.cancel_quantity ?? 0, report.cancelQuantity);
    if (!quantity || deals + cancelled > quantity) return null;
    const next: AccountedTrade = {
        account,
        contract: { code, security_type: contract.security_type as 'STK' | 'FUT' | 'OPT' | 'WRT',
            exchange: contract.exchange as 'TSE' | 'OTC' | 'OES' | 'TAIFEX', target_code: null },
        order: { ...old?.order, id: report.id, seqno: report.seqno, ordno: report.ordno,
            action: report.action as 'Buy' | 'Sell', price: report.price, quantity: report.quantity,
            order_lot: report.orderLot, octype: report.ocType, account,
            ...(['LMT', 'MKT', 'MKP'].includes(report.priceType) ? { price_type: report.priceType } : {}),
            ...(['ROD', 'IOC', 'FOK'].includes(report.orderType) ? { order_type: report.orderType as 'ROD' | 'IOC' | 'FOK' } : {}),
            ...(typeof order.custom_field === 'string' ? { custom_field: order.custom_field } : {}) },
        status: { ...old?.status, id: report.id, order_ts: old?.status.order_ts ?? report.ts,
            status: report.failed ? 'Failed' : statusOf(quantity, deals, cancelled),
            status_code: report.opCode, msg: report.opMsg, order_quantity: quantity,
            deal_quantity: deals, cancel_quantity: cancelled, modified_price: report.modifiedPrice,
            deals: old?.status.deals ?? [] },
    };
    return old ? rows.map(t => t === old ? next : t) : [...rows, next];
}

export function projectTradeDeal(rows: AccountedTrade[], report: OrderEventReport): AccountedTrade[] | null {
    if (report.kind !== 'deal' || !report.ts || report.quantity <= 0 || report.price <= 0) return null;
    const body = reportBody(report);
    const seq = body?.exchange_seq;
    if (typeof seq !== 'string' || !seq) return null;
    const old = rows.find(t => t.order.id === report.tradeId && t.account?.account_id === body?.account_id
        && t.account?.broker_id === body?.broker_id && t.account?.account_type === (report.market === 'stock' ? 'S' : 'F'));
    if (!old) return null;
    const code = report.market === 'futures' ? body?.full_code : body?.code;
    if (code !== (old.contract.target_code || old.contract.code)) return null;
    if (old.status.deals.some(d => d.seq === seq)) return rows;
    const quantity = old.status.deal_quantity + report.quantity;
    if (quantity + old.status.cancel_quantity > old.status.order_quantity) return null;
    return rows.map(t => t !== old ? t : { ...t, status: { ...t.status, deal_quantity: quantity,
        status: statusOf(t.status.order_quantity, quantity, t.status.cancel_quantity),
        deals: [...t.status.deals, { seq, ts: report.ts!, quantity: report.quantity, price: report.price }] } });
}
