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
import { ensureStream, getStreamStatus, onOrderEvent, subscribeStatusStore } from '../stream';
import type { Account } from '../types/portfolio';
import type { OrderStatusName } from '../types/order';
import type { AccountedUsTrade, IntlPosition, UsAmount, UsTrade } from '../types/us';
import { decAdd, decCompare, decIsPositive, decNormalize, decSub, decToInt } from './decimal';
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
let hintCheck: Promise<void> | null = null;
/** 所有帳戶都對帳過：依 trade_cache_health 重算提示（Degraded／IntlDeal 有原因才保留） */
function recomputeHint(): Promise<void> {
    if (hintCheck) return hintCheck;
    const base = getApiBase();
    hintCheck = anyDealUnhealthy(usAccounts()).then(unhealthy => {
        // 查詢期間又有新的跳號／重連，或換了伺服器：不採用這次結果
        if (pendingReconcile.size || base !== getApiBase()) return;
        publish({ hint: unhealthy ? US_DEAL_UNHEALTHY_HINT : null });
    }).finally(() => { hintCheck = null; });
    return hintCheck;
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
        if (generation === hintGeneration && pendingReconcile.delete(k) && !pendingReconcile.size && !allInFlight) void recomputeHint().catch(() => undefined);
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
        if (!pendingReconcile.size) await recomputeHint();
    })().finally(() => { allInFlight = null; });
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
        if (!old) return null;
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
    return rows.map(t => t !== old ? t : { ...t, status: { ...t.status, deal_quantity: deals,
        status: statusOf(t, t.order.quantity, deals, t.status.cancel_quantity ?? '0'),
        deals: [...t.status.deals, { seq, ts: report.ts ?? 0, quantity: report.quantityText!, price: report.priceText || String(report.price) }] } });
}

/** 下單／刪單回應：把 HTTP Trade 放進列表（較新的回報不被覆蓋） */
export function observeUsTrade(trade: UsTrade, account: Account) {
    if (!trade?.order?.id) return;
    const old = state.trades.find(t => t.order.id === trade.order.id && keyOf(t.account) === keyOf(account));
    if (old) {
        // 回應可能比回報晚：只補缺的欄位
        publish({ trades: state.trades.map(t => t !== old ? t : { ...t,
            contract: { ...trade.contract, ...t.contract },
            order: { ...trade.order, ...t.order } }) });
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
    if (!accounts.length) { publish({ positions: [], positionsStatus: 'idle', positionsError: null }); return; }
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
    publish({ positions: rows, positionsStatus: 'ready', positionsError: null, positionsVersion: state.positionsVersion + 1 });
}

// ---- 啟動與重連 ----

let started = false;
let wasLive = false;
let hadDown = false;

export function startUsTradingState() {
    if (started) return;
    started = true;
    const stopEvents = onOrderEvent(onUsReport);
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
        stopEvents(); stopGaps(); stopStatus(); stopAccounts(); gapTimers.forEach(clearTimeout);
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
    positionsCapability = null;
    capabilityBase = '';
    listeners.forEach(l => l());
}

/** 委託列的整數數量（整股）；非整數回 null */
export function usWholeShares(v: UsAmount | null | undefined): number | null {
    return decToInt(v ?? null);
}
