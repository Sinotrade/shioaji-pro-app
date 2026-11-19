// src/lib/us/us-account-api.ts — 美股（H 帳戶）帳務查詢：餘額、交割、已實現損益、股利、庫存明細
//
// 形狀對照 shioaji 原始碼（src/api/api_v1/portf/intl.rs、src/server/http/portf.rs）：
//   POST /portfolio/account_balance      {account…, currency}      → IntlAccountBalance    （!509 draft）
//   POST /portfolio/settlements          {account…}                → IntlSettlement[]      （!509 draft）
//   POST /portfolio/profit_loss          {account…, begin_date, end_date, region:"US"} → IntlProfitLoss[]（beta 772abd2a）
//   POST /portfolio/profit_loss_detail   {account…, detail_id(字串)} → IntlProfitLossDetail[]（beta）
//   POST /portfolio/list_dividends       {account…, begin_date, end_date, region:"US"} → IntlDividend[]（beta；!509 改名 withholding_tax）
//   POST /portfolio/position_detail      {account…, detail_id(數字), region:"US"} → IntlPositionDetail[]（beta）
// 金額／數量都是 decimal 字串（舊版 sw 可能給數字，一律轉字串），日期是 YYYY-MM-DD。
// 金額一律 USD，絕不和台幣相加。BC gtrade 未部署時回 503：當成「尚未開放」，不是錯誤。

import type { Account } from '../types/portfolio';
import type { Action } from '../types/order';
import { decNormalize, decSub } from './decimal';
import { hQuery } from './us-api';

export interface IntlAccountBalance {
    account_type: 'H';
    currency: string;
    /** 帳戶現金餘額（不受委託影響） */
    balance: string;
    /** 可下單金額：買單送出即扣、刪單回補 */
    buying_power: string;
}

export interface IntlSettlement {
    account_type: 'H';
    trade_date: string;
    settlement_date: string;
    /** 含費用的淨額：正＝入帳、負＝扣款 */
    net_amount: string;
    currency: string;
}

export interface IntlProfitLoss {
    account_type: 'H';
    /** 查明細用，原樣帶回 */
    detail_id: string;
    code: string;
    direction: Action;
    date: string;
    quantity: string;
    price: string;
    cost: string;
    pnl: string;
    /** 已是百分比（12.3 代表 12.3%） */
    pnl_pct: string;
    currency: string;
    base_currency: string;
}

export interface IntlProfitLossDetail {
    account_type: 'H';
    acquired_date: string | null;
    quantity: string;
    price: string;
    cost: string;
    /** 整筆原始委託的手續費（不按股數分攤） */
    fee: string;
    /** 整筆原始委託的稅（不按股數分攤） */
    tax: string;
    other_fees: string;
    currency: string;
    base_currency: string;
}

export interface IntlDividend {
    account_type: 'H';
    code: string;
    pay_date: string;
    record_date: string;
    quantity: string;
    gross_amount: string;
    /** 來源國預扣稅（舊版欄位名 fee） */
    withholding_tax: string;
    net_amount: string;
    currency: string;
    base_currency?: string;
    settlement_currency: string;
}

export interface IntlPositionDetail {
    account_type: 'H';
    code: string;
    quantity: string;
    original_quantity: string;
    acquired_date: string;
    acquisition_type: 'Buy' | 'NonTrade' | string;
    price: string;
    cost: string;
    market_price: string | null;
    pnl: string | null;
    settlement_currency: string;
    currency: string;
    base_currency: string;
}

// ---- 正規化：數字轉 decimal 字串；缺值保留 null（不是 0） ----

const dec = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? decNormalize(v) ?? String(v) : '');
const optDec = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : dec(v));
const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object') : []);

export function normalizeBalance(raw: unknown): IntlAccountBalance | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (r.balance === undefined || r.buying_power === undefined) return null;
    return { account_type: 'H' as const, currency: str(r.currency) || 'USD', balance: dec(r.balance), buying_power: dec(r.buying_power) };
}

export function normalizeSettlements(raw: unknown): IntlSettlement[] {
    return rows(raw).map(r => ({
        account_type: 'H' as const, trade_date: str(r.trade_date), settlement_date: str(r.settlement_date),
        net_amount: dec(r.net_amount), currency: str(r.currency) || 'USD',
    })).sort((a, b) => a.settlement_date.localeCompare(b.settlement_date) || a.trade_date.localeCompare(b.trade_date));
}

export function normalizeProfitLoss(raw: unknown): IntlProfitLoss[] {
    return rows(raw).map(r => ({
        account_type: 'H' as const, detail_id: str(r.detail_id), code: str(r.code), direction: (str(r.direction) || 'Sell') as Action,
        date: str(r.date), quantity: dec(r.quantity), price: dec(r.price), cost: dec(r.cost), pnl: dec(r.pnl), pnl_pct: dec(r.pnl_pct),
        currency: str(r.currency) || 'USD', base_currency: str(r.base_currency) || 'USD',
    })).sort((a, b) => b.date.localeCompare(a.date));
}

export function normalizeProfitLossDetail(raw: unknown): IntlProfitLossDetail[] {
    return rows(raw).map(r => ({
        account_type: 'H' as const, acquired_date: r.acquired_date ? str(r.acquired_date) : null,
        quantity: dec(r.quantity), price: dec(r.price), cost: dec(r.cost),
        fee: dec(r.fee ?? 0), tax: dec(r.tax ?? 0), other_fees: dec(r.other_fees ?? 0),
        currency: str(r.currency) || 'USD', base_currency: str(r.base_currency) || 'USD',
    }));
}

export function normalizeDividends(raw: unknown): IntlDividend[] {
    return rows(raw).map(r => ({
        account_type: 'H' as const, code: str(r.code), pay_date: str(r.pay_date), record_date: str(r.record_date),
        quantity: dec(r.quantity), gross_amount: dec(r.gross_amount),
        // !509 改名 withholding_tax；beta 772abd2a 叫 fee
        withholding_tax: dec(r.withholding_tax ?? r.fee ?? 0),
        net_amount: dec(r.net_amount), currency: str(r.currency) || 'USD',
        base_currency: r.base_currency ? str(r.base_currency) : undefined,
        settlement_currency: str(r.settlement_currency) || str(r.currency) || 'USD',
    })).sort((a, b) => b.pay_date.localeCompare(a.pay_date));
}

export function normalizePositionDetail(raw: unknown): IntlPositionDetail[] {
    return rows(raw).map(r => ({
        account_type: 'H' as const, code: str(r.code), quantity: dec(r.quantity), original_quantity: dec(r.original_quantity ?? r.quantity),
        acquired_date: str(r.acquired_date), acquisition_type: str(r.acquisition_type) || 'Buy',
        price: dec(r.price), cost: dec(r.cost), market_price: optDec(r.market_price), pnl: optDec(r.pnl),
        settlement_currency: str(r.settlement_currency) || 'USD', currency: str(r.currency) || 'USD', base_currency: str(r.base_currency) || 'USD',
    }));
}

/** 圈存（已被委託占用）＝ 餘額 − 可下單金額 */
export function usHeldAmount(b: IntlAccountBalance): string | null {
    return decSub(b.balance, b.buying_power);
}

// ---- 查詢 ----

export async function fetchUsBalance(account: Account, currency = 'USD'): Promise<IntlAccountBalance> {
    const b = normalizeBalance(await hQuery<unknown>('/api/v1/portfolio/account_balance', account, { currency }));
    if (!b) throw new Error('美股餘額回應格式不符');
    return b;
}

export async function fetchUsSettlements(account: Account): Promise<IntlSettlement[]> {
    return normalizeSettlements(await hQuery<unknown>('/api/v1/portfolio/settlements', account));
}

export async function fetchUsProfitLoss(account: Account, beginDate: string, endDate: string): Promise<IntlProfitLoss[]> {
    return normalizeProfitLoss(await hQuery<unknown>('/api/v1/portfolio/profit_loss', account, { begin_date: beginDate, end_date: endDate, region: 'US' }));
}

export async function fetchUsProfitLossDetail(account: Account, detailId: string): Promise<IntlProfitLossDetail[]> {
    return normalizeProfitLossDetail(await hQuery<unknown>('/api/v1/portfolio/profit_loss_detail', account, { detail_id: detailId }));
}

export async function fetchUsDividends(account: Account, beginDate: string, endDate: string): Promise<IntlDividend[]> {
    return normalizeDividends(await hQuery<unknown>('/api/v1/portfolio/list_dividends', account, { begin_date: beginDate, end_date: endDate, region: 'US' }));
}

export async function fetchUsPositionDetail(account: Account, detailId: number): Promise<IntlPositionDetail[]> {
    return normalizePositionDetail(await hQuery<unknown>('/api/v1/portfolio/position_detail', account, { detail_id: detailId, region: 'US' }));
}

// ---- 服務未開放（BC gtrade 尚未部署） ----

export const US_ACCOUNT_UNAVAILABLE = '美股帳務服務尚未開放';

/** 503（gtrade 未部署）或 404（舊 SDK 沒有這支）：顯示「尚未開放」，不跳錯誤 */
export function isUsAccountUnavailable(error: unknown): boolean {
    const status = (error as { status?: unknown } | null)?.status;
    if (status === 503 || status === 404) return true;
    const message = error instanceof Error ? error.message : String(error ?? '');
    return /^(503|404)\b/.test(message);
}

/** 錯誤 → 顯示文字：尚未開放、或錯誤原文（去掉狀態碼） */
export function usAccountErrorText(error: unknown): string {
    if (isUsAccountUnavailable(error)) return US_ACCOUNT_UNAVAILABLE;
    const message = error instanceof Error ? error.message : String(error ?? '');
    if (/INVALID_CURRENCY/.test(message)) return '幣別不支援';
    if (/^502\b|UPSTREAM_ERROR/.test(message)) return '券商美股帳務暫時無法查詢，請稍後再試';
    return message.replace(/^\d{3}\s+/, '').trim() || message;
}
