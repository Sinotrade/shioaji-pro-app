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
import { captureServerMode, SERVER_MODE_CHANGED_MESSAGE, type ServerModeGuard } from '../server-info-store';
import type { Account } from '../types/portfolio';
import type { AccountedUsTrade, UsAmount, UsOrderReq, UsTimeInForce, UsTrade } from '../types/us';
import { decAdd, decCompare, decIsPositive, decSub, decToInt } from './decimal';
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
    /** 回讀看到刪單證據（狀態 Cancelled，或取消量補足剩餘）且成交量沒有倒退 */
    confirmed: boolean;
    /** 本次實際取消的股數（確認後才有；以回讀結果保守計算） */
    cancelled?: string;
    /** 回讀後的委託列 */
    row?: AccountedUsTrade;
    /** 第一步開始時的伺服器與模式；改價第二步必須仍是同一個 */
    env: ServerModeGuard;
}

const qty = (v: UsAmount | null | undefined) => (v === null || v === undefined ? '0' : String(v));
const minDec = (a: string, b: string) => (decCompare(a, b) <= 0 ? a : b);

/**
 * 回讀結果有沒有刪單證據，有的話回傳本次取消的股數。
 * - 成交量不可比刪單前少（舊快照）。
 * - 狀態 Cancelled，或 取消量增加且 成交＋取消 補足委託量。
 * - Failed／Inactive 等其他終態不算刪單成功，不可拿來重下。
 * 取消股數＝委託量−目前成交−刪單前已取消，再不超過取消量的增加（若有）。
 */
export function cancelEvidence(before: UsTrade, now: UsTrade): string | null {
    const dealsBefore = qty(before.status.deal_quantity);
    const dealsNow = qty(now.status.deal_quantity);
    if (decCompare(dealsNow, dealsBefore) < 0) return null;
    const cancelBefore = qty(before.status.cancel_quantity);
    const cancelNow = qty(now.status.cancel_quantity);
    const cancelDelta = decSub(cancelNow, cancelBefore) ?? '0';
    const covered = decCompare(decAdd(dealsNow, cancelNow) ?? '0', now.order.quantity) >= 0;
    const isCancelled = now.status.status === 'Cancelled';
    if (!isCancelled && !(decIsPositive(cancelDelta) && covered)) return null;
    let cancelled = decSub(decSub(now.order.quantity, dealsNow) ?? '0', cancelBefore) ?? '0';
    if (decIsPositive(cancelDelta)) cancelled = minDec(cancelled, cancelDelta);
    return decIsPositive(cancelled) ? cancelled : '0';
}

/** 刪單並回讀確認（最多 readAttempts 次權威查詢，間隔 readDelayMs） */
export async function cancelUsTrade(row: AccountedUsTrade, opts: { readAttempts?: number; readDelayMs?: number } = {}): Promise<UsCancelResult> {
    const env = captureServerMode();
    const account = currentAccount(row);
    // 以目前最新的列為基準（傳進來的列可能是舊畫面）
    const before = findRow(row) ?? row;
    try {
        const trade = await cancelUsOrder(before.order.id, account, {
            beforeDispatch: () => {
                if (!env()) throw Object.assign(new Error(SERVER_MODE_CHANGED_MESSAGE), { tradingGateRejected: true });
            },
        });
        if (trade?.order?.id) observeUsTrade(trade, account);
    } catch (error) {
        if (isUsCancelTooEarly(error instanceof Error ? error.message : String(error))) throw new UsCancelTooEarlyError();
        throw Object.assign(new Error(usErrorText(error)), { cause: error });
    }
    const attempts = opts.readAttempts ?? 3;
    for (let i = 0; i < attempts; i++) {
        await sleep(i === 0 ? (opts.readDelayMs ?? 600) : (opts.readDelayMs ?? 1000));
        if (!env()) break; // 換了伺服器或模式：回讀結果不能當作這筆刪單的證據
        try { await refreshUsAccount(account); } catch { continue; }
        const now = findRow(row);
        const cancelled = now ? cancelEvidence(before, now) : null;
        if (now && cancelled !== null) return { confirmed: true, cancelled, row: now, env };
    }
    return { confirmed: false, row: findRow(row), env };
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

/** 改價第二步：以新價格重下。必須和第一步同一個伺服器與模式；送出前一刻再查風控鎖 */
export async function placeReplacement(row: AccountedUsTrade, order: UsOrderReq, env: ServerModeGuard): Promise<UsTrade> {
    const gate = () => {
        const blocked = checkUsOrderAllowed();
        if (blocked) throw Object.assign(new Error(blocked), { mutationNotStarted: true as const, tradingGateRejected: true });
        if (!env()) throw Object.assign(new Error('伺服器或模式已和刪單時不同，這筆沒有重下，請重新下單'), { mutationNotStarted: true as const, tradingGateRejected: true });
    };
    gate();
    const account = currentAccount(row);
    try {
        const trade = await placeUsOrder({ code: row.contract.code, exchange: row.contract.exchange }, order, account, { beforeDispatch: gate });
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
