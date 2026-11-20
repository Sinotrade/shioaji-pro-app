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
    /** 回讀有明確結果：刪單成功，或刪單前已全部成交 */
    confirmed: boolean;
    /** 本次實際取消、可以重下的股數（確認後才有；保守計算） */
    cancelled?: string;
    /** 刪單前已全部成交：沒有取消任何股數，不重下 */
    filled?: boolean;
    /** 回讀後的委託列 */
    row?: AccountedUsTrade;
    /** 第一步開始時的伺服器與模式；改價第二步必須仍是同一個 */
    env: ServerModeGuard;
}

export const US_FILLED_BEFORE_CANCEL = '刪單前已全部成交';

const qty = (v: UsAmount | null | undefined) => (v === null || v === undefined ? '0' : String(v));
const minDec = (a: string, b: string) => (decCompare(a, b) <= 0 ? a : b);
const maxDec = (a: string, b: string) => (decCompare(a, b) >= 0 ? a : b);

export type UsCancelEvidence = { kind: 'cancelled'; cancelled: string } | { kind: 'filled' };

/**
 * 比較刪單前（伺服器回讀的基準）與刪單後回讀，判斷結果；看不出來回 null。
 * - 成交量不可比基準少（舊快照）→ null。
 * - 狀態 Filled 且取消量沒增加 → 刪單前已全部成交。
 * - 刪單成功需要：狀態 Cancelled（或 Filled／Inactive 且取消量增加），而且
 *   成交＋取消 ≥ max(基準委託量, 回讀委託量)。PendingSubmit、Failed 等不算。
 * - 可重下股數＝min(基準剩餘−期間新增成交, 取消量相對基準的增加)。
 */
export function cancelEvidence(before: UsTrade, now: UsTrade): UsCancelEvidence | null {
    const dealsBefore = qty(before.status.deal_quantity);
    const dealsNow = qty(now.status.deal_quantity);
    if (decCompare(dealsNow, dealsBefore) < 0) return null;
    const cancelBefore = qty(before.status.cancel_quantity);
    const cancelNow = qty(now.status.cancel_quantity);
    const cancelDelta = decSub(cancelNow, cancelBefore) ?? '0';
    const status = now.status.status;
    if (status === 'Filled' && !decIsPositive(cancelDelta)) return { kind: 'filled' };
    const terminalWithCancel = status === 'Cancelled'
        || ((status === 'Filled' || status === 'Inactive') && decIsPositive(cancelDelta));
    if (!terminalWithCancel) return null;
    const orderQty = maxDec(qty(before.order.quantity), qty(now.order.quantity));
    if (decCompare(decAdd(dealsNow, cancelNow) ?? '0', orderQty) < 0) return null;
    const filledMeanwhile = decSub(dealsNow, dealsBefore) ?? '0';
    const fromBaseline = decSub(usRemaining(before), filledMeanwhile) ?? '0';
    const cancelled = minDec(fromBaseline, cancelDelta);
    return { kind: 'cancelled', cancelled: decIsPositive(cancelled) ? cancelled : '0' };
}

const TERMINAL_STATUS: ReadonlySet<string> = new Set(['Cancelled', 'Filled', 'Failed', 'Inactive']);

/**
 * 刪單前的基準：伺服器回讀與本機已知列單調合併。成交／取消量取較大者，
 * 已終態不回退；委託量以伺服器為準（減量只會變小）。避免較舊的回讀把
 * 基準拉低，讓可重下股數算多。
 */
export function mergeMonotonic(local: AccountedUsTrade, server: AccountedUsTrade): AccountedUsTrade {
    const status = TERMINAL_STATUS.has(local.status.status) && !TERMINAL_STATUS.has(server.status.status)
        ? local.status.status
        : server.status.status;
    return {
        ...server,
        status: {
            ...server.status,
            status,
            deal_quantity: maxDec(qty(local.status.deal_quantity), qty(server.status.deal_quantity)),
            cancel_quantity: maxDec(qty(local.status.cancel_quantity), qty(server.status.cancel_quantity)),
        },
    };
}

/**
 * 刪單並回讀確認。送出前先向伺服器回讀（refresh）這筆委託當基準：別的終端機
 * 可能已減量，App 還沒看到。之後最多 readAttempts 次權威查詢，間隔 readDelayMs。
 */
export async function cancelUsTrade(row: AccountedUsTrade, opts: { readAttempts?: number; readDelayMs?: number } = {}): Promise<UsCancelResult> {
    const env = captureServerMode();
    const account = currentAccount(row);
    // 回讀前先記下本機已知的列（回報已投影）；伺服器回讀可能比它舊
    const local = findRow(row) ?? row;
    try {
        await refreshUsAccount(account);
    } catch (error) {
        throw Object.assign(new Error(`無法取得這筆委託的最新狀態，未刪單：${usErrorText(error)}`), { mutationNotStarted: true as const, cause: error });
    }
    if (!env()) throw Object.assign(new Error(SERVER_MODE_CHANGED_MESSAGE), { mutationNotStarted: true as const });
    const server = findRow(row);
    const before = server ? mergeMonotonic(local, server) : undefined;
    if (!before) throw Object.assign(new Error('伺服器查不到這筆委託，未刪單；請按更新查看'), { mutationNotStarted: true as const });
    if (!decIsPositive(usRemaining(before))) {
        if (before.status.status === 'Filled') return { confirmed: true, filled: true, cancelled: '0', row: before, env };
        throw Object.assign(new Error('這筆委託已沒有剩餘股數，未刪單'), { mutationNotStarted: true as const });
    }
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
        const evidence = now ? cancelEvidence(before, now) : null;
        if (!now || !evidence) continue;
        if (evidence.kind === 'filled') return { confirmed: true, filled: true, cancelled: '0', row: now, env };
        return { confirmed: true, cancelled: evidence.cancelled, row: now, env };
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
    const exchange = usRowExchange(row);
    if (!exchange) throw Object.assign(new Error(US_EXCHANGE_PENDING), { mutationNotStarted: true as const });
    try {
        const trade = await placeUsOrder({ code: row.contract.code, exchange }, order, account, { beforeDispatch: gate });
        observeUsTrade(trade, account);
        return trade;
    } catch (error) {
        throw Object.assign(new Error(usErrorText(error)), { cause: error });
    }
}

export const US_EXCHANGE_PENDING = '還在確認這檔美股的交易所，請稍後再改價';

/** 委託列的交易所：列本身沒有時看 store 裡同一筆（回報建立後才補上的） */
export function usRowExchange(row: AccountedUsTrade): string | null {
    return row.contract.exchange || findRow(row)?.contract.exchange || null;
}

/** 改價前的檢查：限價單才可改、價格不同 */
export function priceChangeProblem(row: AccountedUsTrade, newPrice: string): string | null {
    if (!decIsPositive(usRemaining(row))) return '這筆委託已沒有剩餘股數';
    // 重下需要交易所：查不到就不讓第一步刪單（避免刪了卻無法重下）
    if (!usRowExchange(row)) return US_EXCHANGE_PENDING;
    if (row.order.price_type && row.order.price_type !== 'LMT') return '只有限價單可以改價';
    const problem = usOrderProblem({ action: row.order.action, quantity: '1', priceType: 'LMT', timeInForce: 'DAY', price: newPrice });
    if (problem) return problem;
    if (decCompare(newPrice.trim(), row.order.price) === 0) return '新價格和原價格相同';
    return null;
}
