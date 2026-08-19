// src/lib/types/order.ts — order/trade shapes

import type { ContractBase } from './contract';

export type Action = 'Buy' | 'Sell';
export type OrderType = 'ROD' | 'IOC' | 'FOK';
export type StockPriceType = 'LMT' | 'MKT';
export type FuturesPriceType = 'LMT' | 'MKT' | 'MKP';
export type FuturesOCType = 'Auto' | 'New' | 'Cover' | 'DayTrade';
export type StockOrderLot =
    | 'Common'
    | 'BlockTrade'
    | 'Fixing'
    | 'Odd'
    | 'IntradayOdd';
// 信用/借券條件：SBLShort=一般借券賣出（委託類別5）、
// SBLShortPriceExempt=價格豁免借券賣出（委託類別6，特殊金融商品）
export type StockOrderCond =
    | 'Cash'
    | 'MarginTrading'
    | 'ShortSelling'
    | 'SBLShort'
    | 'SBLShortPriceExempt';
export type OrderStatusName =
    | 'Cancelled'
    | 'Filled'
    | 'PartFilled'
    | 'Inactive'
    | 'Failed'
    | 'PendingSubmit'
    | 'PreSubmitted'
    | 'Submitted';

export interface StockOrderReq {
    action: Action;
    price: number;
    quantity: number;
    price_type: StockPriceType;
    order_type: OrderType;
    order_lot?: StockOrderLot;
    order_cond?: StockOrderCond;
    daytrade_short?: boolean;
    custom_field?: string; // tag for app-managed orders (e.g. grid)
    client_request_id?: string;
}

export interface FuturesOrderReq {
    action: Action;
    price: number;
    quantity: number;
    price_type: FuturesPriceType;
    order_type: OrderType;
    octype?: FuturesOCType;
    custom_field?: string;
}

export interface Deal {
    seq: string;
    price: number;
    quantity: number;
    ts: number;
}

export interface OrderResult {
    id: string;
    seqno: string;
    ordno: string;
    action: Action;
    price: number;
    quantity: number;
    order_type?: OrderType;
    price_type?: string;
    order_lot?: string;
    octype?: string;
    custom_field?: string;
    account?: { broker_id: string; account_id: string; account_type: string };
}

export interface OrderStatusInfo {
    id: string;
    status: OrderStatusName;
    status_code: string;
    order_ts?: number;
    order_quantity: number;
    deal_quantity: number;
    cancel_quantity: number;
    remaining_quantity?: number;
    modified_price: number;
    msg: string;
    deals: Deal[];
    order_id_present?: boolean;
}

export interface Trade {
    contract: ContractBase & { name?: string };
    order: OrderResult;
    status: OrderStatusInfo;
}

// statuses where the order is still working (cancellable / modifiable)
export const ACTIVE_ORDER_STATUSES: ReadonlySet<string> = new Set([
    'PendingSubmit',
    'PreSubmitted',
    'Submitted',
    'PartFilled',
]);

// SSE order_event payloads are normalized in lib/order-report.ts — the
// server nests the body under its serde variant name
// ({state, data:{FuturesOrder:{...}}}); consumers get OrderEventReport.
