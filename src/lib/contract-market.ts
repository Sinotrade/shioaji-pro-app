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

// 權證代號（TWSE《一般交易電腦作業手冊》O-001 T30 表二「證券種類及產業類別代碼對照表」，
// 櫃買《上櫃股票-等價交易電腦作業手冊》同表）：六碼，集中市場 03000–08999、
// 櫃買 70000–73999 開頭，第六碼為數字（國內標的認購）或 P／U／T（國內標的認售）、
// F（外國標的認購）、Q（外國標的認售）、C／B（牛熊證）、X／Y（可展延牛熊證）。
const WARRANT_CODE = /^(?:0[3-8]\d{3}|7[0-3]\d{3})[0-9PUTFQCBXY]$/;
const FOREIGN_WARRANT_CODE = /^(?:0[3-8]\d{3}|7[0-3]\d{3})[FQ]$/;

/** 代號是否落在權證編碼區間（不看 security_type）。 */
export function isWarrantCode(code: string | undefined | null): boolean {
    return typeof code === 'string' && WARRANT_CODE.test(code);
}

/**
 * 合約是不是權證：WRT 一定是；SDK 1.7 以前權證可能標成 STK，
 * 這時以代號編碼區間判斷（只在 STK 時才看代號，期權、指數不受影響）。
 */
export function isWarrantContract(contract: { security_type?: SecurityType | string; code?: string } | null | undefined): boolean {
    if (!contract) return false;
    if (contract.security_type === 'WRT') return true;
    return contract.security_type === 'STK' && isWarrantCode(contract.code);
}

/** 外國標的權證（第六碼 F／Q）：買賣辦法第 7 條「均採無升降幅度限制」。 */
export function isForeignUnderlyingWarrant(code: string | undefined | null): boolean {
    return typeof code === 'string' && FOREIGN_WARRANT_CODE.test(code);
}
