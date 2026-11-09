// src/lib/warrant-rules.ts — 台灣權證（認購／認售）的下單規則（單一判斷來源）
//
// 依據見 docs/qa/warrant-rules.md。這裡只放「交易所規則確定不收」的組合，
// 在確認前（下單面板、閃電、平倉）與送出前（placeStockOrder）都檢查一次，
// 任何路徑都不會把交易所必定退回的委託送出。

import { isForeignUnderlyingWarrant, isWarrantContract } from './contract-market';
import { isOddLot } from './odd-lot';
import type { SecurityType } from './types/contract';

/** 一交易單位 = 1,000 權證單位（TWSE 權證買賣辦法第 5 條）。 */
export const WARRANT_UNITS_PER_LOT = 1000;

export const WARRANT_TEXT = {
    oddLot: '權證不得零股交易（盤中零股、盤後零股都不收），請以整張下單（1 張 = 1,000 單位）',
    credit: '權證只能現股買賣，不適用融資、融券、借券賣出或現股當沖先賣',
    foreignMarket: '外國標的權證無漲跌幅限制，交易所不接受市價委託；請改用限價',
} as const;

/** 閃電面板對權證暫不開放的附加功能（不是交易所規則，是 App 範圍） */
export const WARRANT_FLASH_TEXT = {
    trigger: '權證暫不支援觸價單；請直接點價下單',
    protect: '權證暫不支援自動停損停利；請先在這個面板關閉自動停損停利再下單',
    /** 設定選單與提示列的短句（觸價欄、觸價設定、停損停利對權證都收起來） */
    menu: '權證暫不支援觸價與自動停損停利',
    /** 外國標的權證市價鈕旁的說明列 */
    foreignMarket: '外國標的權證不能下市價，請點價格下限價單',
} as const;

/** 下單面板價別列下的說明 */
export const WARRANT_TICKET_TEXT = {
    foreignMarket: '外國標的權證不能下市價，請用限價',
} as const;

type WarrantLike = { security_type?: SecurityType | string; code?: string } | null | undefined;

export interface WarrantOrderShape {
    price_type?: string;
    order_lot?: string;
    order_cond?: string;
    daytrade_short?: boolean;
}

/** 市價委託是否被交易所規則排除（營業細則第 58 條之 8：無升降幅度限制之有價證券不得市價）。 */
export function warrantMarketOrderBlock(contract: WarrantLike): string | null {
    if (!isWarrantContract(contract)) return null;
    return isForeignUnderlyingWarrant(contract?.code) ? WARRANT_TEXT.foreignMarket : null;
}

/** 權證不收的委託組合；非權證一律回 null（不影響股票規則）。 */
export function warrantOrderProblem(contract: WarrantLike, o: WarrantOrderShape): string | null {
    if (!isWarrantContract(contract)) return null;
    if (isOddLot(o.order_lot)) return WARRANT_TEXT.oddLot;
    if ((o.order_cond && o.order_cond !== 'Cash') || o.daytrade_short) return WARRANT_TEXT.credit;
    if (o.price_type !== undefined && o.price_type !== 'LMT') return warrantMarketOrderBlock(contract);
    return null;
}
