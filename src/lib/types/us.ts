// src/lib/types/us.ts — 美股（複委託 H 帳戶）HTTP 形狀
//
// 美股沒有新的下單 endpoint：下單、改量、刪單、查委託沿用台股 route，靠
// contract（region US）與 account_type "H" 分流。美股的價格與數量在 JSON
// 是 decimal 字串（送單時數字或字串都收），這裡一律保留原字串顯示。

import type { Action, OrderStatusName } from './order';
import type { Account } from './portfolio';

/** decimal 字串（如 "173.97"、"10"）；舊 sidecar 可能回數字 */
export type UsAmount = string | number;

export type UsExchange = 'NASDAQ' | 'NYSE' | 'BATS' | 'TXSE' | (string & {});

/** GET /data/contracts?security_type=STK&region=US 的一列（沒有名稱） */
export interface UsContractRecord {
    security_type: 'STK' | string;
    region: 'US' | string;
    exchange: UsExchange;
    code: string;
    target_code?: string | null;
    /** 目前 SDK 沒有；之後若清單帶名稱就直接用 */
    name?: string;
}

/** GET /data/contracts/{code}/info?region=US（UsStockContractInfoRecord） */
export interface UsContractInfo {
    dataset?: string;
    security_type: 'STK' | string;
    region: 'US' | string;
    exchange: UsExchange;
    code: string;
    exchange_mic?: string | null;
    name?: string | null;
    short_name?: string | null;
    underlying_code?: string | null;
    instrument_type?: string | null;
    currency?: string | null;
    round_lot?: number | null;
    /** 前一日參考價 */
    reference?: number | string | null;
    reference_date?: string | null;
    trading_suspended?: boolean | null;
    industry_l1?: string | null;
    industry_l2?: string | null;
    update_date?: string | null;
}

export type UsPriceType = 'LMT' | 'MKT';
export type UsTimeInForce = 'DAY' | 'OPG' | 'ATC';

/** place_order 的 stock_order（美股）：不得帶 order_lot／order_cond／
 *  daytrade_short／custom_field（SDK 本地就拒絕） */
export interface UsOrderReq {
    action: Action;
    /** decimal 字串；市價送 "0" */
    price: string;
    /** 整股 */
    quantity: number;
    price_type: UsPriceType;
    time_in_force: UsTimeInForce;
}

export interface UsDeal {
    seq: string;
    price: UsAmount;
    quantity: UsAmount;
    ts: number;
}

/** 美股 Trade：與台股 Trade 同結構，但數量價格是 decimal 字串 */
export interface UsTrade {
    contract: {
        security_type: string;
        exchange: string | null;
        code: string;
        region?: string;
        target_code?: string | null;
        name?: string;
        currency?: string;
    };
    order: {
        id: string;
        seqno: string;
        ordno: string;
        action: Action;
        price: UsAmount;
        quantity: UsAmount;
        price_type?: string;
        time_in_force?: string;
        order_type?: string;
        all_or_none?: boolean;
        currency?: string;
        region?: string;
        session?: string;
        trade_date?: string;
        account?: { broker_id: string; account_id: string; account_type: string };
    };
    status: {
        id: string;
        status: OrderStatusName;
        status_code: string;
        order_ts?: number;
        order_quantity: UsAmount;
        deal_quantity: UsAmount;
        cancel_quantity: UsAmount;
        msg: string;
        deals: UsDeal[];
        avg_price?: string;
    };
}

export type AccountedUsTrade = UsTrade & { account: Account };

/** feat/intl-portfolio：position_unit 對 H 帳戶的列（Decimal 皆為字串） */
export interface IntlPosition {
    id: number | string;
    account_type?: 'H' | string;
    code: string;
    direction: Action;
    quantity: UsAmount;
    price: UsAmount;
    cost_basis?: UsAmount;
    market_price?: UsAmount | null;
    market_value?: UsAmount | null;
    pnl?: UsAmount | null;
    /** 百分比（5.55 代表 5.55%） */
    pnl_pct?: UsAmount | null;
    currency?: string;
    base_currency?: string;
}
