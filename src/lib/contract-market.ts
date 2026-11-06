// src/lib/contract-market.ts — 商品歸屬的下單市場（單一判斷來源）

import type { SecurityType } from './types/contract';

export type ContractMarket = 'S' | 'F';

/**
 * 商品走哪個下單市場：S（證券帳戶、stock_order）或 F（期貨帳戶、futures_order）。
 * 權證與股票同一條路：SDK 1.7.11 起 STK／WRT 都收 stock_order，對上游一律送 STK，
 * 所以同一檔權證的委託在對帳結果裡也可能標成 STK，兩者不可分開判斷。
 * 指數不能下單，未知型別也不猜，都回 null。
 */
export function contractMarket(securityType: SecurityType | string | undefined): ContractMarket | null {
    if (securityType === 'STK' || securityType === 'WRT') return 'S';
    if (securityType === 'FUT' || securityType === 'OPT') return 'F';
    return null;
}

/** 權證：下單走股票路徑，但沒有零股。 */
export function isWarrant(securityType: SecurityType | string | undefined): boolean {
    return securityType === 'WRT';
}
