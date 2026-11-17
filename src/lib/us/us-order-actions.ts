// src/lib/us/us-order-actions.ts — 美股刪單、減量、改價（刪單後重下）
//
// - 刪單：送出後以該帳戶的權威查詢回讀確認；剛下單約 1 秒內刪單可能回
//   -2054「此委託不存在」→ 顯示「剛送出的委託稍後再刪」，讓使用者重試。
// - 減量：update_qty 的 quantity 是「要減掉的股數」。
// - 改價：美股 SDK 不支援 update_price（固定回驗證錯誤），改成兩步：
//   1) 刪單並回讀確認實際取消了幾股；2) 使用者再按一次才以新價格重下
//   「實際取消的股數」。兩步結果都回給對話框顯示。

import { getAccountState } from '../account-store';
import { canTrade } from '../account-tradable';
import { checkUsOrderAllowed } from '../risk';
import type { Account } from '../types/portfolio';
import type { AccountedUsTrade, UsOrderReq, UsTimeInForce, UsTrade } from '../types/us';
import { decCompare, decIsPositive, decSub, decToInt } from './decimal';
import { cancelUsOrder, placeUsOrder, reduceUsOrderQty, usErrorText } from './us-api';
import { isUsCancelTooEarly, US_CANCEL_TOO_EARLY_MESSAGE, US_TIME_IN_FORCE_ENABLED, usOrderProblem } from './us-order-rules';
import { getUsTradingState, observeUsTrade, refreshUsAccount, usRemaining } from './us-trading-state';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** 委託列的帳戶仍是目前可交易的 H 帳戶 */
function currentAccount(row: AccountedUsTrade): Account {
    const a = row.account;
    const current = getAccountState().accounts.find(x => x.account_type === 'H' && x.broker_id === a.broker_id && x.account_id === a.account_id);
    if (!current || !canTrade(current)) throw Object.assign(new Error('委託帳戶已不可交易，未送出'), { mutationNotStarted: true as const });
    return current;
}

function findRow(row: AccountedUsTrade): AccountedUsTrade | undefined {
    return getUsTradingState().trades.find(t => t.order.id === row.order.id
        && t.account.broker_id === row.account.broker_id && t.account.account_id === row.account.account_id);
}

export class UsCancelTooEarlyError extends Error {
    readonly tooEarly = true as const;
    constructor() { super(US_CANCEL_TOO_EARLY_MESSAGE); }
}

export interface UsCancelResult {
    /** 回讀確認已無剩餘 */
    confirmed: boolean;
    /** 本次實際取消的股數（確認後才有） */
    cancelled?: string;
    /** 回讀後的委託列 */
    row?: AccountedUsTrade;
}

/** 刪單並回讀確認（最多 readAttempts 次權威查詢，間隔 readDelayMs） */
export async function cancelUsTrade(row: AccountedUsTrade, opts: { readAttempts?: number; readDelayMs?: number } = {}): Promise<UsCancelResult> {
    const account = currentAccount(row);
    // 實際取消量＝刪單前剩餘−期間新增成交（不依賴 cancel_quantity 是否累計）
    const remainingBefore = usRemaining(row);
    const dealsBefore = row.status.deal_quantity ?? '0';
    try {
        const trade = await cancelUsOrder(row.order.id, account);
        if (trade?.order?.id) observeUsTrade(trade, account);
    } catch (error) {
        if (isUsCancelTooEarly(error instanceof Error ? error.message : String(error))) throw new UsCancelTooEarlyError();
        throw Object.assign(new Error(usErrorText(error)), { cause: error });
    }
    const attempts = opts.readAttempts ?? 3;
    for (let i = 0; i < attempts; i++) {
        await sleep(i === 0 ? (opts.readDelayMs ?? 600) : (opts.readDelayMs ?? 1000));
        try { await refreshUsAccount(account); } catch { continue; }
        const now = findRow(row);
        if (now && !decIsPositive(usRemaining(now))) {
            const filledMeanwhile = decSub(now.status.deal_quantity ?? '0', dealsBefore) ?? '0';
            const cancelled = decSub(remainingBefore, filledMeanwhile) ?? '0';
            return { confirmed: true, cancelled: decIsPositive(cancelled) ? cancelled : '0', row: now };
        }
    }
    return { confirmed: false, row: findRow(row) };
}

/** 減量 reduceBy 股（1..剩餘） */
export async function reduceUsTrade(row: AccountedUsTrade, reduceBy: number): Promise<UsTrade> {
    const account = currentAccount(row);
    const remaining = decToInt(usRemaining(row)) ?? 0;
    if (!Number.isSafeInteger(reduceBy) || reduceBy < 1 || reduceBy > remaining) {
        throw Object.assign(new Error(`減量股數需在 1 到 ${remaining} 之間`), { mutationNotStarted: true as const });
    }
    try {
        const trade = await reduceUsOrderQty(row.order.id, reduceBy, account);
        if (trade?.order?.id) observeUsTrade(trade, account);
        void refreshUsAccount(account).catch(() => undefined);
        return trade;
    } catch (error) {
        if (isUsCancelTooEarly(error instanceof Error ? error.message : String(error))) throw new UsCancelTooEarlyError();
        throw Object.assign(new Error(usErrorText(error)), { cause: error });
    }
}

/** 改價第二步要重下的委託（依第一步實際取消的股數） */
export function replacementOrder(row: AccountedUsTrade, cancelledShares: string, newPrice: string): UsOrderReq | string {
    const qty = decToInt(cancelledShares);
    if (qty === null || qty < 1) return '第一步沒有取消任何股數（可能已全部成交），不重下';
    const tif = (row.order.time_in_force ?? 'DAY') as UsTimeInForce;
    if (!US_TIME_IN_FORCE_ENABLED.includes(tif)) return `原委託時效 ${tif} 這個版本不開放，請用美股下單面板重新下單`;
    const problem = usOrderProblem({ action: row.order.action, quantity: String(qty), priceType: 'LMT', timeInForce: tif, price: newPrice });
    if (problem) return problem;
    return { action: row.order.action, price: newPrice.trim(), quantity: qty, price_type: 'LMT', time_in_force: tif };
}

/** 改價第二步：以新價格重下（風控鎖照樣檢查） */
export async function placeReplacement(row: AccountedUsTrade, order: UsOrderReq): Promise<UsTrade> {
    const blocked = checkUsOrderAllowed();
    if (blocked) throw Object.assign(new Error(blocked), { mutationNotStarted: true as const });
    const account = currentAccount(row);
    try {
        const trade = await placeUsOrder({ code: row.contract.code, exchange: row.contract.exchange }, order, account);
        observeUsTrade(trade, account);
        return trade;
    } catch (error) {
        throw Object.assign(new Error(usErrorText(error)), { cause: error });
    }
}

/** 改價前的檢查：限價單才可改、價格不同 */
export function priceChangeProblem(row: AccountedUsTrade, newPrice: string): string | null {
    if (!decIsPositive(usRemaining(row))) return '這筆委託已沒有剩餘股數';
    if (row.order.price_type && row.order.price_type !== 'LMT') return '只有限價單可以改價';
    const problem = usOrderProblem({ action: row.order.action, quantity: '1', priceType: 'LMT', timeInForce: 'DAY', price: newPrice });
    if (problem) return problem;
    if (decCompare(newPrice.trim(), row.order.price) === 0) return '新價格和原價格相同';
    return null;
}
