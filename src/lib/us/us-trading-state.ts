// src/lib/us/us-trading-state.ts — 美股（H 帳戶）委託與庫存的共用狀態
//
// 與台股 trading-state 分開：台股那邊有嚴格的快照邊界／對帳不變式，而美股
// 數量是 decimal 字串、回報語意也不同（order_quantity＝本次操作後數量）。
//
// 規則：
// - 委託以 POST /order/trades {account_type:"H", refresh:true}（update_status）
//   為準；回報不會重播，所以 SSE 重連、美股回報跳號或 trade_cache_health
//   不健康時，一律對所有 H 帳戶重新查詢（SDK 重連後會以 update_status 對帳並
//   送一筆彙總成交）。
// - IntlOrder／IntlDeal 回報能對上已知委託就就地更新；對不上（或已有彙總
//   成交時又收到逐筆成交）就重新查詢該帳戶，不猜。
// - 換日後過期的 DAY 單不顯示：只保留各帳戶最新交易日的委託。

import { useEffect, useSyncExternalStore } from 'react';
import { canTrade } from '../account-tradable';
import { getAccountState, subscribeAccounts } from '../account-store';
import type { OrderEventReport } from '../order-report';
import { reportBody } from '../portfolio-projection';
import { usReportLedger } from '../report-ledger';
import { getApiBase } from '../runtime';
import { getServerModeVersion, subscribeServerInfo } from '../server-info-store';
import { ensureStream, getStreamStatus, onAnyTick, onOrderEvent, subscribeStatusStore } from '../stream';
import { retainQuote } from '../quote-ownership';
import { usLinkKey } from '../contract-key';
import type { Account } from '../types/portfolio';
import type { OrderStatusName } from '../types/order';
import type { AccountedUsTrade, IntlPosition, UsAmount, UsDeal, UsTrade } from '../types/us';
import { decAdd, decCompare, decDivRound, decIsPositive, decMul, decNormalize, decSub, decToInt } from './decimal';
import { getUsContractRecord, resolveUsContract } from './us-contracts';
import { fetchUsPositions, fetchUsTradeCacheHealth, fetchUsTrades } from './us-api';
import { apiGet } from '../api';

export const US_DEAL_UNHEALTHY_HINT = '美股成交回報可能不完整，以委託查詢為準';
export const US_POSITIONS_UNAVAILABLE = '美股庫存將於後續版本提供';

export type UsPositionsStatus = 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';

export interface UsTradingState {
    trades: AccountedUsTrade[];
    loading: boolean;
    updatedAt: number | null;
    error: string | null;
    /** 回報可能漏收的提示（重連、跳號、快取不健康）；權威查詢成功後清除 */
    hint: string | null;
    positions: (IntlPosition & { account: Account })[];
    positionsStatus: UsPositionsStatus;
    positionsError: string | null;
    /** 每次庫存查詢成功就加一：SDK 每次查詢會重新編 id，庫存明細快取要跟著換 */
    positionsVersion: number;
}

const initial = (): UsTradingState => ({
    trades: [], loading: false, updatedAt: null, error: null, hint: null,
    positions: [], positionsStatus: 'idle', positionsError: null, positionsVersion: 0,
});
let state: UsTradingState = initial();
const listeners = new Set<() => void>();
function publish(next: Partial<UsTradingState>) {
    state = { ...state, ...next };
    listeners.forEach(l => l());
}

export const getUsTradingState = () => state;
export function subscribeUsTradingState(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

const keyOf = (a: { account_type: string; broker_id: string; account_id: string }) => `${a.account_type}:${a.broker_id}:${a.account_id}`;

export function usAccounts(): Account[] {
    return getAccountState().accounts.filter(a => a.account_type === 'H' && canTrade(a));
}

// ---- 數量 ----

const TERMINAL: ReadonlySet<string> = new Set(['Cancelled', 'Filled', 'Failed', 'Inactive']);

/** 未成交股數（decimal 字串）；終態或資料不合法回 "0" */
export function usRemaining(t: UsTrade): string {
    if (TERMINAL.has(t.status.status)) return '0';
    const left = decSub(t.order.quantity, decAdd(t.status.deal_quantity ?? '0', t.status.cancel_quantity ?? '0') ?? '0');
    return left && decIsPositive(left) ? left : '0';
}

export function usIsWorking(t: UsTrade): boolean {
    return decIsPositive(usRemaining(t));
}

function statusOf(t: UsTrade, quantity: UsAmount, deals: UsAmount, cancelled: UsAmount): OrderStatusName {
    if (decIsPositive(quantity) && decCompare(deals, quantity) >= 0) return 'Filled';
    const done = decAdd(deals, cancelled) ?? '0';
    if (decIsPositive(cancelled) && decCompare(done, quantity) >= 0) return 'Cancelled';
    if (decIsPositive(deals)) return 'PartFilled';
    return t.status.status === 'PendingSubmit' || t.status.status === 'PreSubmitted' ? 'Submitted' : t.status.status;
}

/** 美東日期 YYYYMMDD（美股交易日以美東為準） */
export function nyDate(now: number = Date.now()): string {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(new Date(now));
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
    return `${get('year')}${get('month')}${get('day')}`;
}

/** 美東換日：交易日早於今天的委託（DAY 單已過期）不再顯示 */
export function dropBeforeNyDate(rows: AccountedUsTrade[], today: string): AccountedUsTrade[] {
    return rows.filter(t => {
        const d = (t.order.trade_date ?? '').replace(/-/g, '');
        return !d || d >= today;
    });
}

/** 只留各帳戶最新交易日的委託：換日後過期的 DAY 單不顯示 */
export function dropExpiredDayOrders(rows: AccountedUsTrade[]): AccountedUsTrade[] {
    const latest = new Map<string, string>();
    for (const t of rows) {
        const d = t.order.trade_date;
        if (!d) continue;
        const k = keyOf(t.account);
        if ((latest.get(k) ?? '') < d) latest.set(k, d);
    }
    return rows.filter(t => {
        const d = t.order.trade_date;
        const newest = latest.get(keyOf(t.account));
        return !d || !newest || d >= newest;
    });
}

// ---- 權威查詢 ----

const accountInFlight = new Map<string, Promise<void>>();
const accountQueued = new Map<string, Promise<void>>();
/** 查詢進行中收到的回報：快照回來後疊回去（快照邊界） */
const duringQuery = new Map<string, OrderEventReport[]>();
let allInFlight: Promise<void> | null = null;
let allQueued: Promise<void> | null = null;

/**
 * 提示（重連、跳號）亮起後還沒權威重查成功的帳戶。每個帳戶的 update_status
 * 成功就移除；全部對帳完才依 trade_cache_health 重算提示 — 不論對帳是由
 * 「全部重查」還是單一帳戶重查完成，提示都不會卡住。
 */
const pendingReconcile = new Set<string>();
/** 提示每亮一次加一：亮起前就開始的查詢不算對帳過 */
let hintGeneration = 0;
function raiseHint() {
    hintGeneration += 1;
    for (const a of usAccounts()) pendingReconcile.add(keyOf(a));
    publish({ hint: US_DEAL_UNHEALTHY_HINT });
}
let hintCheck: { generation: number; run: Promise<void> } | null = null;
/** 每次健康度檢查加一：只有最新的那次能發布結果 */
let hintCheckSeq = 0;
/** 待對帳在全部重查進行中清空：重算延到全部重查結束（不論成功或失敗）再做 */
let recomputeOwed = false;
/** 所有帳戶都對帳過：依 trade_cache_health 重算提示（Degraded／IntlDeal 有原因才保留） */
function recomputeHint(): Promise<void> {
    // 只沿用同一個提示世代裡開始的檢查：提示亮起前開始的檢查結果可能已過期
    if (hintCheck && hintCheck.generation === hintGeneration) return hintCheck.run;
    const base = getApiBase();
    const generation = hintGeneration;
    const seq = ++hintCheckSeq;
    const run = anyDealUnhealthy(usAccounts()).then(unhealthy => {
        // 查詢期間又有新的跳號／重連、有更新的檢查，或換了伺服器：不採用這次結果
        if (generation !== hintGeneration || seq !== hintCheckSeq || pendingReconcile.size || base !== getApiBase()) return;
        publish({ hint: unhealthy ? US_DEAL_UNHEALTHY_HINT : null });
    }).finally(() => { if (hintCheck?.run === run) hintCheck = null; });
    hintCheck = { generation, run };
    return run;
}

/** 待對帳剛清空：全部重查進行中就記下，等它結束再重算；否則立刻重算 */
function onReconcileDrained() {
    if (allInFlight) recomputeOwed = true;
    else void recomputeHint().catch(() => undefined);
}

function mergeAccount(account: Account, rows: UsTrade[]) {
    const k = keyOf(account);
    const incoming = rows
        .filter(t => !t.order.account || (t.order.account.broker_id === account.broker_id && t.order.account.account_id === account.account_id
            && (!t.order.account.account_type || t.order.account.account_type === 'H')))
        .map(t => ({ ...t, account }));
    // 美東換日後，快照裡昨天的 DAY 單不採用（不只看資料裡的最大日期）
    return dropBeforeNyDate(dropExpiredDayOrders([...state.trades.filter(t => keyOf(t.account) !== k), ...incoming]), nyDate());
}

/**
 * 快照套不上期間回報時用：每筆委託的成交／取消量取目前狀態與快照的較大值
 * （數量只增不減），避免發布倒退的快照；之後再重查確認。
 */
function keepMonotonic(merged: AccountedUsTrade[], account: Account): AccountedUsTrade[] {
    const k = keyOf(account);
    const current = new Map(state.trades.filter(t => keyOf(t.account) === k).map(t => [t.order.id, t]));
    return merged.map(t => {
        if (keyOf(t.account) !== k) return t;
        const cur = current.get(t.order.id);
        if (!cur) return t;
        const dealCur = String(cur.status.deal_quantity ?? '0');
        const dealSnap = String(t.status.deal_quantity ?? '0');
        const cancelCur = String(cur.status.cancel_quantity ?? '0');
        const cancelSnap = String(t.status.cancel_quantity ?? '0');
        const dealAhead = decCompare(dealCur, dealSnap) > 0;
        const cancelAhead = decCompare(cancelCur, cancelSnap) > 0;
        if (!dealAhead && !cancelAhead) return t;
        const deals = dealAhead ? dealCur : dealSnap;
        const cancelled = cancelAhead ? cancelCur : cancelSnap;
        return { ...t, status: { ...t.status,
            deal_quantity: deals, cancel_quantity: cancelled,
            deals: dealAhead ? cur.status.deals : t.status.deals,
            status: statusOf(t, t.order.quantity, deals, cancelled) } };
    });
}

/**
 * 一個 H 帳戶的權威委託查詢（update_status）。同帳戶同時只跑一次；查詢中又
 * 被要求時，結束後再查一次（不吞掉必要的重查）。查詢期間收到的回報會在快照
 * 回來後重新套用，晚到的快照不會蓋掉較新的回報。
 */
export function refreshUsAccount(account: Account): Promise<void> {
    const k = keyOf(account);
    const existing = accountInFlight.get(k);
    if (existing) {
        let queued = accountQueued.get(k);
        if (!queued) {
            queued = existing.catch(() => undefined).then(() => {
                accountQueued.delete(k);
                return refreshUsAccount(account);
            });
            accountQueued.set(k, queued);
        }
        return queued;
    }
    const base = getApiBase();
    const generation = hintGeneration;
    const buffer: OrderEventReport[] = [];
    duringQuery.set(k, buffer);
    const run = fetchUsTrades(account, true).then(rows => {
        // 換了伺服器：結果作廢；模式穩定後的重查由 startUsTradingState 觸發
        if (base !== getApiBase()) return;
        let merged = mergeAccount(account, Array.isArray(rows) ? rows : []);
        let unapplied = false;
        for (const report of buffer) {
            const projected = projectUsReport(merged, report, account);
            if (projected) merged = projected; else unapplied = true;
        }
        // 期間的回報有套不上的：快照可能比回報舊 → 數量取較大值不倒退，再查一次確認
        if (unapplied) merged = keepMonotonic(merged, account);
        publish({ trades: merged, updatedAt: Date.now(), error: null });
        if (unapplied) scheduleAccountRefetch(account);
        // 最後一個待對帳帳戶由單一帳戶重查完成（例如全部重查曾失敗）：重算提示；
        // 全部重查進行中則由它收尾
        if (generation === hintGeneration && pendingReconcile.delete(k) && !pendingReconcile.size) onReconcileDrained();
    }).finally(() => {
        if (duringQuery.get(k) === buffer) duringQuery.delete(k);
        accountInFlight.delete(k);
    });
    accountInFlight.set(k, run);
    return run;
}

/** 所有 H 帳戶重新查詢；成功後檢查回報快取健康度決定是否保留提示 */
export function refreshUsTrades(): Promise<void> {
    if (allInFlight) {
        allQueued ??= allInFlight.catch(() => undefined).then(() => {
            allQueued = null;
            return refreshUsTrades();
        });
        return allQueued;
    }
    const accounts = usAccounts();
    if (!accounts.length) {
        // 沒有 H 帳戶：沒有可漏的回報，提示與錯誤一起清掉
        pendingReconcile.clear();
        publish({ trades: [], loading: false, hint: null, error: null });
        return Promise.resolve();
    }
    publish({ loading: true });
    allInFlight = (async () => {
        const results = await Promise.allSettled(accounts.map(refreshUsAccount));
        const failed = results.filter(r => r.status === 'rejected');
        if (failed.length) {
            const reason = (failed[0] as PromiseRejectedResult).reason;
            // 失敗的帳戶仍在 pendingReconcile：提示保留，之後重查成功才重算
            publish({ loading: false, error: `美股委託查詢失敗，保留上次資料；請按更新重試（${reason instanceof Error ? reason.message : String(reason)}）` });
            return;
        }
        // 全部成功＝每個帳戶都對帳過（帳戶清單在查詢期間變了的，剩下的鍵已不適用）
        for (const k of [...pendingReconcile]) if (!usAccounts().some(a => keyOf(a) === k)) pendingReconcile.delete(k);
        publish({ loading: false });
        // 查詢期間又亮起提示（pendingReconcile 非空）：保留，交給排隊中的重查收尾
        if (!pendingReconcile.size) { recomputeOwed = false; await recomputeHint(); }
    })().finally(() => {
        allInFlight = null;
        // 失敗分支也要收尾：期間待對帳已被單一帳戶重查清空的話，這裡補做重算
        if (recomputeOwed) {
            recomputeOwed = false;
            if (!pendingReconcile.size) void recomputeHint().catch(() => undefined);
        }
    });
    return allInFlight;
}

/** trade_cache_health：IntlDeal 有任何原因或狀態不是 Healthy → 成交回報可能不完整 */
async function anyDealUnhealthy(accounts: Account[]): Promise<boolean> {
    const healths = await Promise.allSettled(accounts.map(fetchUsTradeCacheHealth));
    return healths.some(h => h.status === 'fulfilled' && h.value && (h.value.state === 'Degraded'
        || (h.value.reasons ?? []).some(r => r.event_type === 'IntlDeal' && r.reason !== 'NoBaseline')));
}

// 回報對不上 → 該帳戶延遲 400ms 重查一次（合併短時間內的多筆）
const refetchTimers = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleAccountRefetch(account: Account) {
    const k = keyOf(account);
    if (refetchTimers.has(k)) return;
    refetchTimers.set(k, setTimeout(() => {
        refetchTimers.delete(k);
        void refreshUsAccount(account).catch(() => publish({ error: '美股委託查詢失敗，保留上次資料；請按更新重試' }));
    }, 400));
}

// ---- 回報投影 ----

function accountOfReport(report: OrderEventReport): Account | undefined {
    const body = reportBody(report);
    const ref = report.kind === 'order'
        ? (body?.order as { account?: { broker_id?: string; account_id?: string } } | undefined)?.account
        : { broker_id: body?.broker_id as string | undefined, account_id: body?.account_id as string | undefined };
    return usAccounts().find(a => a.broker_id === ref?.broker_id && a.account_id === ref?.account_id);
}

/**
 * 把一筆美股回報套到委託列。回傳新列陣列；null＝對不上，需要重新查詢。
 * 純函式（測試用）。
 */
export function projectUsReport(rows: AccountedUsTrade[], report: OrderEventReport, account: Account): AccountedUsTrade[] | null {
    if (report.market !== 'us') return null;
    if (report.kind === 'order') {
        const old = rows.find(t => t.order.id === report.id && keyOf(t.account) === keyOf(account));
        // 與台股 projectOrderReport 相同：New 回報比下單回應（或 update_status）早到時，
        // 由回報直接建立委託列；其他操作對不上就重新查詢
        if (!old) return report.opType === 'New' ? newRowFromReport(rows, report, account) : null;
        if (report.failed) {
            // 拒單：New 被拒標 Failed；刪改被拒保留原狀態，只記 op_msg 原文
            const status = report.opType === 'New' ? { ...old.status, status: 'Failed' as const, msg: report.opMsg, status_code: report.opCode }
                : { ...old.status, msg: report.opMsg, status_code: report.opCode };
            return rows.map(t => t === old ? { ...t, status } : t);
        }
        if (TERMINAL.has(old.status.status)) return rows;
        const deals = old.status.deal_quantity ?? '0';
        let cancelled: UsAmount = old.status.cancel_quantity ?? '0';
        if (report.opType === 'Cancel' || report.opType === 'UpdateQty') {
            // IntlOrder：status.cancel_quantity＝本次刪減量；order_quantity＝本次操作後的
            // 委託數量（刪單後 0）。HTTP Trade 的 cancel_quantity 是累計，這裡維持累計。
            const cut = decNormalize(report.cancelQuantityText);
            const after = decNormalize(report.orderQuantityText);
            if (report.opType === 'Cancel') {
                // 刪單＝剩下的全部取消
                const all = decSub(old.order.quantity, deals);
                if (all === null) return null;
                if (cut !== null && decCompare(decAdd(cancelled, cut) ?? '0', all) !== 0) return null;
                cancelled = all;
            } else {
                // 減量：以 order_quantity（本次操作後的數量）設定絕對值，重送或重播
                // 同一筆不會重複扣。已有成交時 order_quantity 是否含成交未確認 → 重查。
                if (after === null || decIsPositive(deals)) return null;
                const absolute = decSub(old.order.quantity, after);
                if (absolute === null || !decIsPositive(absolute) && !decIsPositive(cancelled)) return null;
                // 比目前已知的取消量小＝較舊的回報，保留現況
                if (decCompare(absolute, cancelled) < 0) return rows;
                cancelled = absolute;
            }
            if (decCompare(decAdd(cancelled, deals) ?? '0', old.order.quantity) > 0) return null;
        } else if (report.opType !== 'New') {
            return null; // 美股沒有改價回報；其他未知操作交給重新查詢
        }
        const next: AccountedUsTrade = {
            ...old,
            order: { ...old.order, seqno: report.seqno || old.order.seqno, ordno: report.ordno || old.order.ordno },
            status: { ...old.status, cancel_quantity: cancelled, status_code: report.opCode || old.status.status_code,
                msg: report.opMsg || old.status.msg, status: statusOf(old, old.order.quantity, deals, cancelled) },
        };
        return rows.map(t => t === old ? next : t);
    }
    const body = reportBody(report);
    const seq = typeof body?.exchange_seq === 'string' && body.exchange_seq ? body.exchange_seq : '';
    const old = rows.find(t => t.order.id === report.tradeId && keyOf(t.account) === keyOf(account));
    if (!old || !seq || old.contract.code !== report.code || !decIsPositive(report.quantityText)) return null;
    if (old.status.deals.some(d => d.seq === seq)) return rows;
    // update_status 只回一筆彙總成交（seq "1"、ts 0）：再收逐筆會重複計算，改重新查詢
    if (old.status.deals.some(d => d.seq === '1' && !d.ts)) return null;
    const deals = decAdd(old.status.deal_quantity ?? '0', report.quantityText!);
    if (deals === null || decCompare(decAdd(deals, old.status.cancel_quantity ?? '0') ?? '0', old.order.quantity) > 0) return null;
    const price = report.priceText || decNormalize(report.price);
    if (!price) return null;
    const dealRows: UsDeal[] = [...old.status.deals, { seq, ts: report.ts ?? 0, quantity: report.quantityText!, price }];
    const avg = usAveragePrice(dealRows);
    return rows.map(t => t !== old ? t : { ...t, status: { ...t.status, deal_quantity: deals,
        status: statusOf(t, t.order.quantity, deals, t.status.cancel_quantity ?? '0'),
        ...(avg !== null ? { avg_price: avg } : {}),
        deals: dealRows } });
}

/** SDK intl::US_AVG_PRICE_DECIMALS：成交均價最多 6 位小數 */
export const US_AVG_PRICE_DECIMALS = 6;

/**
 * 成交均價＝Σ(價×量)／Σ量，decimal 精算，超過 6 位小數四捨五入（遠離 0）並去尾 0；
 * 與 SDK intl::average_price 同一個算法，回報更新的委託列和 update_status 的 avg_price 一致。
 * 沒有成交或任一筆不合法回 null。
 */
export function usAveragePrice(deals: readonly UsDeal[]): string | null {
    let quantity = '0';
    let amount = '0';
    for (const d of deals) {
        const q = decAdd(quantity, d.quantity);
        const a = decMul(d.price, d.quantity);
        const sum = a === null ? null : decAdd(amount, a);
        if (q === null || sum === null) return null;
        quantity = q; amount = sum;
    }
    return decIsPositive(quantity) ? decDivRound(amount, quantity, US_AVG_PRICE_DECIMALS) : null;
}

/**
 * IntlOrder New 回報 → 委託列（對不上已知委託時）。回報缺必要欄位（價格、數量、
 * 買賣別、代碼）回 null，交給重新查詢。拒單（New 失敗）也建一列 Failed，
 * 與台股一致；沒有數量的拒單（SDK 拒單回報可能不帶 quantity）同樣交給重新查詢。
 */
function newRowFromReport(rows: AccountedUsTrade[], report: OrderEventReport, account: Account): AccountedUsTrade[] | null {
    if (report.kind !== 'order' || report.opType !== 'New' || !report.id) return null;
    const body = reportBody(report);
    const order = body?.order as Record<string, unknown> | undefined;
    const contract = body?.contract as Record<string, unknown> | undefined;
    const quantity = decNormalize(report.quantityText);
    const price = decNormalize(report.priceText);
    const code = typeof contract?.code === 'string' ? contract.code.trim().toUpperCase() : '';
    if (!order || !code || !quantity || !decIsPositive(quantity) || price === null
        || (report.action !== 'Buy' && report.action !== 'Sell')) return null;
    const cancelled = '0';
    const status: OrderStatusName = report.failed ? 'Failed' : 'Submitted';
    const session = typeof order.session === 'string' && order.session ? order.session : undefined;
    const row: AccountedUsTrade = {
        account,
        contract: { security_type: typeof contract?.security_type === 'string' ? contract.security_type : 'STK',
            exchange: getUsContractRecord(code)?.exchange ?? null, code, region: 'US',
            currency: typeof contract?.currency === 'string' && contract.currency ? contract.currency : 'USD' },
        order: {
            id: report.id, seqno: report.seqno, ordno: report.ordno, action: report.action, price, quantity,
            ...(report.priceType ? { price_type: report.priceType } : {}),
            ...(report.timeInForce ? { time_in_force: report.timeInForce } : {}),
            ...(typeof order.aon === 'boolean' ? { all_or_none: order.aon } : {}),
            ...(session ? { session } : {}),
            account: { broker_id: account.broker_id, account_id: account.account_id, account_type: 'H' },
        },
        status: {
            id: report.id, status, status_code: report.opCode, msg: report.opMsg,
            ...(report.ts ? { order_ts: report.ts } : {}),
            order_quantity: quantity, deal_quantity: '0', cancel_quantity: cancelled, deals: [],
        },
    };
    return [...rows, row];
}

/** 以 current 為準，只用 base 補 current 缺（undefined／null）的欄位 */
function fillMissing<T extends object>(base: T, current: T): T {
    const out = { ...base } as Record<string, unknown>;
    for (const [k, v] of Object.entries(current)) if (v !== undefined && v !== null) out[k] = v;
    return out as T;
}

/** 下單／刪單回應：把 HTTP Trade 放進列表（較新的回報不被覆蓋） */
export function observeUsTrade(trade: UsTrade, account: Account) {
    if (!trade?.order?.id) return;
    const old = state.trades.find(t => t.order.id === trade.order.id && keyOf(t.account) === keyOf(account));
    if (old) {
        // 回應可能比回報晚：只補缺的欄位
        publish({ trades: state.trades.map(t => t !== old ? t : { ...t,
            contract: fillMissing(trade.contract, t.contract),
            order: fillMissing(trade.order, t.order) }) });
    } else publish({ trades: dropExpiredDayOrders([...state.trades, { ...trade, account }]) });
}

function onUsReport(report: OrderEventReport) {
    if (report.market !== 'us') return;
    const account = accountOfReport(report);
    if (!account) return; // 不是本 App 可交易的 H 帳戶
    duringQuery.get(keyOf(account))?.push(report);
    const projected = projectUsReport(state.trades, report, account);
    if (projected) publish({ trades: projected });
    else scheduleAccountRefetch(account);
    // 成交會改變庫存（美股委託回報只有新單／刪單／減量，不改成交量）
    if (report.kind === 'deal') scheduleDealPositionsRefresh();
}

// 成交後重查庫存：paper 等伺服器在成交回報之後才更新庫存，立刻查會拿到舊值。
// 最後一筆成交後 1.5 秒查一次，5 秒再補一次；連續成交合併成同一組。
export const US_DEAL_POSITIONS_DELAYS_MS = [1500, 5000] as const;
const dealPositionsTimers = new Set<ReturnType<typeof setTimeout>>();
function clearDealPositionsTimers() {
    dealPositionsTimers.forEach(clearTimeout);
    dealPositionsTimers.clear();
}
function scheduleDealPositionsRefresh() {
    clearDealPositionsTimers();
    const base = getApiBase();
    const mode = getServerModeVersion();
    for (const delay of US_DEAL_POSITIONS_DELAYS_MS) {
        const timer = setTimeout(() => {
            dealPositionsTimers.delete(timer);
            // 換了伺服器／模式：由模式切換的重查負責，不用舊環境的排程
            if (base !== getApiBase() || mode !== getServerModeVersion()) { clearDealPositionsTimers(); return; }
            if (!usAccounts().length || state.positionsStatus === 'unsupported') return;
            void refreshUsPositions().catch(() => undefined);
        }, delay);
        dealPositionsTimers.add(timer);
    }
}

// ---- 庫存（feat/intl-portfolio；能力未確認前要能降級） ----

export type UsCapability = 'yes' | 'no' | 'unknown';
let positionsCapability: Promise<UsCapability> | null = null;
let capabilityBase = '';

/**
 * sidecar 的 OpenAPI 有美股帳務（list_dividends 或 IntlPosition）才查庫存。
 * 讀不到 OpenAPI（sidecar 剛啟動、暫時錯誤）是 unknown，不快取、下次再問；
 * 只有讀到文件且確定沒有才是 no。
 */
export function hasUsPortfolioCapability(): Promise<UsCapability> {
    const base = getApiBase();
    if (base !== capabilityBase) { capabilityBase = base; positionsCapability = null; }
    if (positionsCapability) return positionsCapability;
    const run: Promise<UsCapability> = apiGet<{ paths?: Record<string, unknown>; components?: { schemas?: Record<string, unknown> } }>('/openapi.json')
        .then(doc => {
            if (!doc || typeof doc !== 'object' || (!doc.paths && !doc.components)) return 'unknown' as const;
            return doc.paths?.['/api/v1/portfolio/list_dividends'] || doc.components?.schemas?.IntlPosition ? 'yes' as const : 'no' as const;
        })
        .catch(() => 'unknown' as const)
        .then(result => {
            if (result === 'unknown' && positionsCapability === run) positionsCapability = null;
            return result;
        });
    positionsCapability = run;
    return run;
}

/** 回應是不是 IntlPosition[]（台股形狀或錯誤形狀一律當不支援） */
export function parseIntlPositions(value: unknown): IntlPosition[] | null {
    if (!Array.isArray(value)) return null;
    for (const row of value) {
        if (!row || typeof row !== 'object') return null;
        const r = row as Record<string, unknown>;
        if (typeof r.code !== 'string' || !('quantity' in r) || !('price' in r)) return null;
        // 台股 StockPosition 有 last_price、沒有 currency：不是美股形狀
        if (!('currency' in r) && !('cost_basis' in r)) return null;
    }
    return value as IntlPosition[];
}

const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

// 查詢期間伺服器或模式剛變（啟動時常見）：結果作廢，稍後重查一次，
// 不要讓狀態一直停在「查詢中」
let positionsRetry: ReturnType<typeof setTimeout> | null = null;
function retryPositionsSoon() {
    if (positionsRetry) return;
    positionsRetry = setTimeout(() => {
        positionsRetry = null;
        if (state.positionsStatus === 'loading') void refreshUsPositions();
    }, 1000);
}

// 庫存查詢可能重疊（分頁切換、成交後排程、更新鍵）：只採用最後發出的那次
let positionsSeq = 0;

export async function refreshUsPositions(): Promise<void> {
    const seq = ++positionsSeq;
    const accounts = usAccounts();
    if (!accounts.length) { publish({ positions: [], positionsStatus: 'idle', positionsError: null }); syncPositionQuotes(); return; }
    const base = getApiBase();
    const mode = getServerModeVersion();
    const superseded = () => seq !== positionsSeq;
    const stale = () => base !== getApiBase() || mode !== getServerModeVersion();
    publish({ positionsStatus: state.positionsStatus === 'ready' ? 'ready' : 'loading' });
    const capability = await hasUsPortfolioCapability();
    if (superseded()) return;
    if (stale()) { retryPositionsSoon(); return; }
    if (capability === 'no') {
        publish({ positions: [], positionsStatus: 'unsupported', positionsError: null });
        syncPositionQuotes();
        return;
    }
    if (capability === 'unknown') {
        publish({ positionsStatus: 'error', positionsError: '暫時無法確認美股庫存功能，請按更新重試' });
        return;
    }
    const results = await Promise.allSettled(accounts.map(a => fetchUsPositions(a)));
    if (superseded()) return;
    if (stale()) { retryPositionsSoon(); return; }
    const rows: (IntlPosition & { account: Account })[] = [];
    for (const [i, r] of results.entries()) {
        if (r.status === 'rejected') {
            publish({ positionsStatus: 'error', positionsError: `美股庫存查詢失敗，請按更新重試（${errorText(r.reason)}）` });
            return;
        }
        const parsed = parseIntlPositions(r.value);
        if (!parsed) {
            publish({ positionsStatus: 'error', positionsError: '美股庫存回應格式不符，請按更新重試' });
            return;
        }
        rows.push(...parsed.map(p => ({ ...p, account: accounts[i]! })));
    }
    // 查詢回來的 market_price 是後端參考價（不一定是最後成交）：有夠新的即時成交就用它重算
    publish({ positions: rows.map(markWithFreshTick), positionsStatus: 'ready', positionsError: null, positionsVersion: state.positionsVersion + 1 });
    syncPositionQuotes();
}

// ---- 庫存即時損益 ----
//
// 與台股 trading-state 同一套機制：持倉代碼以 retainQuote(contract, 'Tick') 訂閱，
// onAnyTick 收到成交就重算該代碼的市值與未實現損益（台股 markPosition）。
// 美股差異（刻意）：價格／數量／成本都是 decimal 字串，以 decimal 精算，不轉浮點；
// 損益以 SDK 相同公式：market_value＝價×股數、pnl＝market_value − cost_basis、
// pnl_pct＝pnl ÷ cost_basis × 100（兩位小數）。盤前／盤中／盤後的成交都會更新
// （與報價面板的最新成交價一致）。

/** 與台股 TICK_MARK_MAX_AGE_MS 相同：庫存重查後只沿用 60 秒內的即時成交 */
export const US_TICK_MARK_MAX_AGE_MS = 60_000;
/** 最新即時成交（key：美股代碼大寫） */
const lastUsTicks = new Map<string, { price: string; at: number }>();

/**
 * 以即時價重算一列美股庫存（純函式）。價格、股數不合法或沒有成本時原樣回傳。
 * 只有多方（H 帳戶不能放空）；保險起見空方以 成本 − 市值 計。
 */
export function markUsPosition<T extends IntlPosition>(p: T, price: UsAmount): T {
    const px = decNormalize(price);
    const qty = decNormalize(p.quantity);
    if (!px || !decIsPositive(px) || !qty || !decIsPositive(qty)) return p;
    const cost = p.cost_basis !== undefined && p.cost_basis !== null && decNormalize(p.cost_basis) !== null
        ? decNormalize(p.cost_basis)! : decMul(p.price, qty);
    const value = decMul(px, qty);
    if (cost === null || value === null) return p;
    const pnl = p.direction === 'Sell' ? decSub(cost, value) : decSub(value, cost);
    if (pnl === null) return p;
    const pct = decIsPositive(cost) ? decDivRound(decMul(pnl, '100')!, cost, 2) : null;
    if (p.market_price !== undefined && p.market_price !== null && decCompare(p.market_price, px) === 0
        && p.pnl !== undefined && p.pnl !== null && decCompare(p.pnl, pnl) === 0) return p;
    return { ...p, market_price: px, market_value: value, pnl, pnl_pct: pct };
}

function markWithFreshTick<T extends IntlPosition>(p: T): T {
    const t = lastUsTicks.get(p.code.trim().toUpperCase());
    return t && Date.now() - t.at <= US_TICK_MARK_MAX_AGE_MS ? markUsPosition(p, t.price) : p;
}

/** 即時成交（onAnyTick）：更新持有該代碼的庫存列 */
export function onUsPositionTick(tick: { code: string; close: string; simtrade?: boolean }) {
    if (tick.simtrade || !tick.code.startsWith('US:')) return;
    const code = tick.code.slice(3).toUpperCase();
    const price = decNormalize(tick.close);
    if (!price || !decIsPositive(price)) return;
    if (lastUsTicks.size >= 2000 && !lastUsTicks.has(code)) lastUsTicks.clear();
    lastUsTicks.set(code, { price, at: Date.now() });
    let changed = false;
    const positions = state.positions.map(p => {
        if (p.code.trim().toUpperCase() !== code) return p;
        const next = markUsPosition(p, price);
        changed ||= next !== p;
        return next;
    });
    if (changed) publish({ positions });
}

/** 持倉代碼的 Tick 訂閱（引用計數由 quote-ownership 管；不再持有就釋放） */
const positionQuotes = new Map<string, { release?: () => void }>();
function syncPositionQuotes() {
    const codes = new Set(state.positions.filter(p => decIsPositive(p.quantity)).map(p => p.code.trim().toUpperCase()));
    for (const [code, entry] of positionQuotes) {
        if (codes.has(code)) continue;
        entry.release?.();
        positionQuotes.delete(code);
        lastUsTicks.delete(code);
    }
    for (const code of codes) {
        if (positionQuotes.has(code)) continue;
        const entry: { release?: () => void } = {};
        positionQuotes.set(code, entry);
        void resolveUsContract(code).then(contract => {
            if (positionQuotes.get(code) === entry) entry.release = retainQuote(contract, 'Tick');
        }).catch(() => { if (positionQuotes.get(code) === entry) positionQuotes.delete(code); });
    }
}
function releasePositionQuotes() {
    positionQuotes.forEach(e => e.release?.());
    positionQuotes.clear();
    lastUsTicks.clear();
}

// ---- 啟動與重連 ----

let started = false;
let wasLive = false;
let hadDown = false;

export function startUsTradingState() {
    if (started) return;
    started = true;
    const stopEvents = onOrderEvent(onUsReport);
    const stopTicks = onAnyTick(onUsPositionTick);
    const gapTimers = new Set<ReturnType<typeof setTimeout>>();
    const stopGaps = usReportLedger.onGap((base, opened) => {
        // 晚到的序號仍可能補上：等一下再確認
        const timer = setTimeout(() => {
            gapTimers.delete(timer);
            if (base !== getApiBase() || !usReportLedger.takeGaps(base, opened).size) return;
            raiseHint();
            void refreshUsTrades().catch(() => undefined);
        }, 1500);
        gapTimers.add(timer);
    });
    const statusChanged = () => {
        const live = getStreamStatus() === 'live';
        if (live && !wasLive) {
            wasLive = true;
            // 第一次連上或重連：回報不重播，H 帳戶一律重查
            if (hadDown) raiseHint();
            void refreshUsTrades().catch(() => undefined);
        } else if (!live && wasLive) {
            wasLive = false;
            hadDown = true;
            lastUsTicks.clear(); // 與台股相同：斷線期間的成交可能漏收
        }
    };
    const stopStatus = subscribeStatusStore(statusChanged);
    // 帳戶清單晚到（或模式切換後）也要查一次
    let knownKeys = usAccounts().map(keyOf).join('|');
    const stopAccounts = subscribeAccounts(() => {
        const next = usAccounts().map(keyOf).join('|');
        if (next === knownKeys) return;
        knownKeys = next;
        if (wasLive) void refreshUsTrades().catch(() => undefined);
    });
    // 伺服器或模式變了（冷啟動第一次得知模式、模擬↔正式）：舊查詢作廢，穩定後重查
    let knownMode = getServerModeVersion();
    let knownBase = getApiBase();
    let modeTimer: ReturnType<typeof setTimeout> | null = null;
    const stopServerInfo = subscribeServerInfo(() => {
        const mode = getServerModeVersion();
        const base = getApiBase();
        if (mode === knownMode && base === knownBase) return;
        knownMode = mode; knownBase = base;
        if (modeTimer) clearTimeout(modeTimer);
        modeTimer = setTimeout(() => {
            modeTimer = null;
            void refreshUsTrades().catch(() => undefined);
            void refreshUsPositions().catch(() => undefined);
        }, 300);
    });
    // 美東換日：清掉過期委託並重查
    let today = nyDate();
    const dayTimer = setInterval(() => {
        const now = nyDate();
        if (now === today) return;
        today = now;
        publish({ trades: dropBeforeNyDate(state.trades, now) });
        void refreshUsTrades().catch(() => undefined);
        void refreshUsPositions().catch(() => undefined);
    }, 60_000);
    import.meta.hot?.dispose(() => {
        stopServerInfo(); clearInterval(dayTimer); if (modeTimer) clearTimeout(modeTimer);
        stopEvents(); stopTicks(); stopGaps(); stopStatus(); stopAccounts(); gapTimers.forEach(clearTimeout);
        releasePositionQuotes();
        refetchTimers.forEach(clearTimeout); refetchTimers.clear();
        clearDealPositionsTimers();
        if (positionsRetry) { clearTimeout(positionsRetry); positionsRetry = null; }
        started = false;
    });
    ensureStream();
    statusChanged();
}

/**
 * App 層呼叫：有可交易的 H 帳戶就啟動美股交易狀態（委託／回報／庫存），
 * 不等任何美股面板打開；帳戶清單晚到也會在出現 H 帳戶時啟動。回傳取消監看。
 */
export function watchUsTradingState(): () => void {
    if (usAccounts().length) { startUsTradingState(); return () => undefined; }
    let stop: (() => void) | null = null;
    stop = subscribeAccounts(() => {
        if (!usAccounts().length) return;
        startUsTradingState();
        stop?.(); stop = null;
    });
    return () => { stop?.(); stop = null; };
}

export function useUsTradingState(): UsTradingState {
    useEffect(startUsTradingState, []);
    return useSyncExternalStore(subscribeUsTradingState, getUsTradingState);
}

/** 測試用 */
export function resetUsTradingStateForTest(next: Partial<UsTradingState> = {}) {
    state = { ...initial(), ...next };
    accountInFlight.clear();
    accountQueued.clear();
    duringQuery.clear();
    allInFlight = null;
    allQueued = null;
    refetchTimers.forEach(clearTimeout);
    refetchTimers.clear();
    clearDealPositionsTimers();
    pendingReconcile.clear();
    hintCheck = null;
    recomputeOwed = false;
    positionsCapability = null;
    capabilityBase = '';
    releasePositionQuotes();
    listeners.forEach(l => l());
}

/** 委託列的整數數量（整股）；非整數回 null */
export function usWholeShares(v: UsAmount | null | undefined): number | null {
    return decToInt(v ?? null);
}
