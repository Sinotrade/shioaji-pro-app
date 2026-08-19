// src/lib/order-report.ts — normalize SSE order_event payloads and format
// them into readable report messages（委託/成交回報）shared by the toasts,
// 通知中心 and bracket matching.
//
// Older bridge payloads serialize `OrderEvent { state, data }` with an
// externally-tagged enum, so the event body sits one level under its variant
// name — NOT flat:
//   {"state":"FuturesOrder","data":{"FuturesOrder":{operation,order,status,contract}}}
//   {"state":"StockDeal","data":{"StockDeal":{trade_id,code,price,quantity,...}}}
// normalizeOrderEvent unwraps that (and tolerates legacy flat payloads) into
// a discriminated union every consumer can rely on.

import type { Action } from './types/order';
import { fmtInt, fmtPrice } from './utils/format';

export type OrderMarket = 'stock' | 'futures';

export interface OrderReport {
    kind: 'order';
    market: OrderMarket;
    opType: string; // New | Cancel | UpdatePrice | UpdateQty | Reject
    opCode: string; // '00' = success
    opMsg: string;
    failed: boolean;
    code: string;
    name: string; // contract name（股票才有，期貨為空）
    action?: Action;
    price: number;
    quantity: number;
    orderType: string; // ROD/IOC/FOK
    priceType: string; // LMT/MKT/MKP
    ocType: string; // futures: Auto/New/Cover/DayTrade
    orderCond: string; // stocks: Cash/MarginTrading/ShortSelling/...
    orderLot: string; // stocks: Common/Odd/IntradayOdd/...
    id: string;
    seqno: string;
    ordno: string;
    orderQuantity: number; // status.order_quantity
    cancelQuantity: number; // status.cancel_quantity
    modifiedPrice: number; // status.modified_price（改價後的新價）
    ts?: number; // exchange timestamp, epoch seconds
    raw: unknown;
}

export interface DealReport {
    kind: 'deal';
    market: OrderMarket;
    code: string;
    action?: Action;
    price: number;
    quantity: number;
    seqno: string;
    ordno: string;
    tradeId: string;
    orderLot: string;
    ts?: number;
    raw: unknown;
}

export type OrderEventReport = OrderReport | DealReport;

type Rec = Record<string, unknown>;

function asRec(v: unknown): Rec | null {
    return v !== null && typeof v === 'object' ? (v as Rec) : null;
}

function num(v: unknown): number {
    const n = typeof v === 'string' ? Number(v) : (v as number);
    return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
    return typeof v === 'string' ? v : '';
}

// timestamps arrive as epoch seconds (f64), but guard against ms/ns feeds
function epochSeconds(v: unknown): number | undefined {
    const n = num(v);
    if (n <= 0) return undefined;
    if (n > 1e14) return n / 1e9; // nanoseconds
    if (n > 1e11) return n / 1e3; // milliseconds
    return n;
}

function buildOrderReport(market: OrderMarket, body: Rec, raw: unknown): OrderReport {
    const op = asRec(body.operation) ?? {};
    const order = asRec(body.order) ?? {};
    const status = asRec(body.status) ?? {};
    const contract = asRec(body.contract) ?? {};
    const opCode = str(op.op_code);
    return {
        kind: 'order',
        market,
        opType: str(op.op_type),
        opCode,
        opMsg: str(op.op_msg),
        failed: !!opCode && opCode !== '00',
        code: str(contract.code) || str(order.ordno),
        name: str(contract.name),
        action: (str(order.action) || undefined) as Action | undefined,
        price: num(order.price),
        quantity: num(order.quantity),
        orderType: str(order.order_type),
        priceType: str(order.price_type),
        ocType: str(order.oc_type),
        orderCond: str(order.order_cond),
        orderLot: str(order.order_lot),
        id: str(order.id),
        seqno: str(order.seqno),
        ordno: str(order.ordno),
        orderQuantity: num(status.order_quantity),
        cancelQuantity: num(status.cancel_quantity),
        modifiedPrice: num(status.modified_price),
        ts: epochSeconds(status.exchange_ts),
        raw,
    };
}

function buildDealReport(market: OrderMarket, body: Rec, raw: unknown): DealReport {
    return {
        kind: 'deal',
        market,
        code: str(body.code),
        action: (str(body.action) || undefined) as Action | undefined,
        price: num(body.price),
        quantity: num(body.quantity),
        seqno: str(body.seqno),
        ordno: str(body.ordno),
        tradeId: str(body.trade_id),
        orderLot: str(body.order_lot),
        ts: epochSeconds(body.ts),
        raw,
    };
}

const VARIANTS: [string, OrderMarket, 'order' | 'deal'][] = [
    ['StockOrder', 'stock', 'order'],
    ['StockDeal', 'stock', 'deal'],
    ['FuturesOrder', 'futures', 'order'],
    ['FuturesDeal', 'futures', 'deal'],
];

export function normalizeOrderEvent(payload: unknown): OrderEventReport | null {
    const rec = asRec(payload);
    if (!rec) return null;

    // wrapped form {state, data: {<Variant>: {...}}}
    const data = asRec(rec.data);
    if (data) {
        for (const [key, market, shape] of VARIANTS) {
            const body = asRec(data[key]);
            if (!body) continue;
            return shape === 'order'
                ? buildOrderReport(market, body, payload)
                : buildDealReport(market, body, payload);
        }
    }

    // legacy flat forms (older server builds / python-style relays)
    if (asRec(rec.operation)) {
        const order = asRec(rec.order);
        const market: OrderMarket = order && 'oc_type' in order ? 'futures' : 'stock';
        return buildOrderReport(market, rec, payload);
    }
    if (rec.code !== undefined && rec.price !== undefined) {
        const market: OrderMarket = 'security_type' in rec ? 'futures' : 'stock';
        return buildDealReport(market, rec, payload);
    }
    return null;
}

// ---- formatting（給 toast / 通知中心共用）----

export interface ReportMessage {
    kind: 'deal' | 'ok' | 'err' | 'info';
    title: string;
    lines: { text: string; dir?: 'up' | 'down' }[];
}

const OP_TITLE: Record<string, string> = {
    New: '委託成功',
    Cancel: '委託已取消',
    UpdatePrice: '改價成功',
    UpdateQty: '減量成功',
    Reject: '委託被拒',
};

const COND_LABEL: Record<string, string> = {
    Cash: '現股',
    Netting: '現股當沖',
    MarginTrading: '融資',
    ShortSelling: '融券',
    Emerging: '興櫃',
};

const OC_LABEL: Record<string, string> = {
    New: '新倉',
    Cover: '平倉',
    DayTrade: '當沖',
    // Auto 是預設，不值得佔版面
};

const LOT_LABEL: Record<string, string> = {
    Odd: '盤後零股',
    IntradayOdd: '盤中零股',
    Fixing: '定盤',
    BlockTrade: '鉅額',
};

function actionText(action?: Action): string {
    return action === 'Buy' ? '買進' : action === 'Sell' ? '賣出' : '';
}

function actionDir(action?: Action): 'up' | 'down' | undefined {
    return action === 'Buy' ? 'up' : action === 'Sell' ? 'down' : undefined;
}

function unitText(r: { market: OrderMarket; orderLot?: string }): string {
    if (r.market === 'futures') return '口';
    return r.orderLot === 'Odd' || r.orderLot === 'IntradayOdd' ? '股' : '張';
}

function symbolText(code: string, name: string): string {
    return name ? `${code} ${name}` : code;
}

function priceText(priceType: string, price: number): string {
    if (priceType === 'MKT') return '市價';
    if (priceType === 'MKP') return '範圍市價';
    return price > 0 ? `@ ${fmtPrice(price)}` : '市價';
}

function timeText(ts?: number): string {
    if (!ts) return '';
    return new Date(ts * 1000).toLocaleTimeString('en-GB');
}

// e.g. 「ROD 融資 ｜ 委託書號 A1234 ｜ 13:45:02」
// （價格型態不重複列 — 主行已寫「@ 價格」或「市價」）
function orderMeta(r: OrderReport): string {
    const cond =
        r.market === 'futures'
            ? OC_LABEL[r.ocType] ?? ''
            : [COND_LABEL[r.orderCond] ?? '', LOT_LABEL[r.orderLot] ?? '']
                  .filter(Boolean)
                  .join(' ');
    const spec = [r.orderType, cond].filter(Boolean).join(' ');
    return [spec, r.ordno ? `委託書號 ${r.ordno}` : '', timeText(r.ts)]
        .filter(Boolean)
        .join(' ｜ ');
}

export function describeOrderReport(r: OrderEventReport): ReportMessage {
    if (r.kind === 'deal') {
        const line = [
            actionText(r.action),
            r.code,
            `${fmtInt(r.quantity)} ${unitText(r)}`,
            `@ ${fmtPrice(r.price)}`,
        ]
            .filter(Boolean)
            .join(' ');
        const meta = [r.ordno ? `委託書號 ${r.ordno}` : '', timeText(r.ts)]
            .filter(Boolean)
            .join(' ｜ ');
        return {
            kind: 'deal',
            title: `成交回報 ${r.code}`,
            lines: [
                { text: line, dir: actionDir(r.action) },
                ...(meta ? [{ text: meta }] : []),
            ],
        };
    }

    const symbol = symbolText(r.code, r.name);
    const unit = unitText(r);
    const act = actionText(r.action);
    const dir = actionDir(r.action);

    if (r.failed || r.opType === 'Reject') {
        return {
            kind: 'err',
            title: `委託失敗 ${r.code}`,
            lines: [
                {
                    text: [act, symbol, `${fmtInt(r.quantity)} ${unit}`, priceText(r.priceType, r.price)]
                        .filter(Boolean)
                        .join(' '),
                    dir,
                },
                { text: `${r.opMsg || '請檢查委託條件'}（代碼 ${r.opCode}）` },
            ],
        };
    }

    let main: string;
    switch (r.opType) {
        case 'Cancel': {
            const qty = r.cancelQuantity > 0 ? r.cancelQuantity : r.quantity;
            main = [act, symbol, `已取消 ${fmtInt(qty)} ${unit}`]
                .filter(Boolean)
                .join(' ');
            break;
        }
        case 'UpdatePrice': {
            const to = r.modifiedPrice > 0 ? r.modifiedPrice : r.price;
            main = [act, symbol, `${fmtInt(r.quantity)} ${unit}`, `改價 → ${fmtPrice(to)}`]
                .filter(Boolean)
                .join(' ');
            break;
        }
        case 'UpdateQty': {
            const cut = r.cancelQuantity;
            main = [
                act,
                symbol,
                cut > 0 ? `減量 ${fmtInt(cut)} ${unit}` : '數量已更新',
            ]
                .filter(Boolean)
                .join(' ');
            break;
        }
        default:
            // New（或未知 op — 照委託內容顯示）
            main = [act, symbol, `${fmtInt(r.quantity)} ${unit}`, priceText(r.priceType, r.price)]
                .filter(Boolean)
                .join(' ');
    }

    const meta = orderMeta(r);
    return {
        kind: 'ok',
        title: `${OP_TITLE[r.opType] ?? '委託回報'} ${r.code}`,
        lines: [{ text: main, dir }, ...(meta ? [{ text: meta }] : [])],
    };
}
