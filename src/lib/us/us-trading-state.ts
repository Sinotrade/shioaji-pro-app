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
}

const initial = (): UsTradingState => ({
    trades: [], loading: false, updatedAt: null, error: null, hint: null,
    positions: [], positionsStatus: 'idle', positionsError: null,
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
let allInFlight: Promise<void> | null = null;

function mergeAccount(account: Account, rows: UsTrade[]) {
    const k = keyOf(account);
    const incoming = rows
        .filter(t => !t.order.account || (t.order.account.broker_id === account.broker_id && t.order.account.account_id === account.account_id
            && (!t.order.account.account_type || t.order.account.account_type === 'H')))
        .map(t => ({ ...t, account }));
    return dropExpiredDayOrders([...state.trades.filter(t => keyOf(t.account) !== k), ...incoming]);
}

/** 一個 H 帳戶的權威委託查詢（update_status）；同帳戶同時只跑一次 */
export function refreshUsAccount(account: Account): Promise<void> {
    const k = keyOf(account);
    const existing = accountInFlight.get(k);
    if (existing) return existing;
    const base = getApiBase();
    const run = fetchUsTrades(account, true).then(rows => {
        if (base !== getApiBase()) return;
        publish({ trades: mergeAccount(account, Array.isArray(rows) ? rows : []), updatedAt: Date.now(), error: null });
    }).finally(() => { accountInFlight.delete(k); });
    accountInFlight.set(k, run);
    return run;
}

/** 所有 H 帳戶重新查詢；成功後檢查回報快取健康度決定是否保留提示 */
export function refreshUsTrades(): Promise<void> {
    if (allInFlight) return allInFlight;
    const accounts = usAccounts();
    if (!accounts.length) {
        publish({ trades: [], loading: false });
        return Promise.resolve();
    }
    publish({ loading: true });
    allInFlight = (async () => {
        const results = await Promise.allSettled(accounts.map(refreshUsAccount));
        const failed = results.filter(r => r.status === 'rejected');
        if (failed.length) {
            const reason = (failed[0] as PromiseRejectedResult).reason;
            publish({ loading: false, error: `美股委託查詢失敗，保留上次資料：${reason instanceof Error ? reason.message : String(reason)}` });
            return;
        }
        publish({ loading: false, hint: (await anyDealUnhealthy(accounts)) ? US_DEAL_UNHEALTHY_HINT : null });
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
            } else if (cut !== null) {
                cancelled = decAdd(cancelled, cut) ?? cancelled;
            } else if (after !== null && !decIsPositive(deals)) {
                cancelled = decSub(old.order.quantity, after) ?? cancelled;
            } else return null;
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
    const projected = projectUsReport(state.trades, report, account);
    if (projected) publish({ trades: projected });
    else scheduleAccountRefetch(account);
}

// ---- 庫存（feat/intl-portfolio；能力未確認前要能降級） ----

let positionsCapability: Promise<boolean> | null = null;
let capabilityBase = '';

/** sidecar 的 OpenAPI 有美股帳務（list_dividends 或 IntlPosition）才查庫存 */
export function hasUsPortfolioCapability(): Promise<boolean> {
    const base = getApiBase();
    if (base !== capabilityBase) { capabilityBase = base; positionsCapability = null; }
    positionsCapability ??= apiGet<{ paths?: Record<string, unknown>; components?: { schemas?: Record<string, unknown> } }>('/openapi.json')
        .then(doc => !!(doc?.paths?.['/api/v1/portfolio/list_dividends'] || doc?.components?.schemas?.IntlPosition))
        .catch(() => false);
    return positionsCapability;
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

export async function refreshUsPositions(): Promise<void> {
    const accounts = usAccounts();
    if (!accounts.length) { publish({ positions: [], positionsStatus: 'idle' }); return; }
    publish({ positionsStatus: state.positionsStatus === 'ready' ? 'ready' : 'loading' });
    if (!(await hasUsPortfolioCapability())) {
        publish({ positions: [], positionsStatus: 'unsupported', positionsError: null });
        return;
    }
    const results = await Promise.allSettled(accounts.map(a => fetchUsPositions(a)));
    const rows: (IntlPosition & { account: Account })[] = [];
    for (const [i, r] of results.entries()) {
        const parsed = r.status === 'fulfilled' ? parseIntlPositions(r.value) : null;
        if (!parsed) {
            publish({ positions: [], positionsStatus: 'unsupported', positionsError: null });
            return;
        }
        rows.push(...parsed.map(p => ({ ...p, account: accounts[i]! })));
    }
    publish({ positions: rows, positionsStatus: 'ready', positionsError: null });
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
            publish({ hint: US_DEAL_UNHEALTHY_HINT });
            void refreshUsTrades().catch(() => undefined);
        }, 1500);
        gapTimers.add(timer);
    });
    const statusChanged = () => {
        const live = getStreamStatus() === 'live';
        if (live && !wasLive) {
            wasLive = true;
            // 第一次連上或重連：回報不重播，H 帳戶一律重查
            if (hadDown) publish({ hint: US_DEAL_UNHEALTHY_HINT });
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
    import.meta.hot?.dispose(() => {
        stopEvents(); stopGaps(); stopStatus(); stopAccounts(); gapTimers.forEach(clearTimeout);
        refetchTimers.forEach(clearTimeout); refetchTimers.clear();
        started = false;
    });
    ensureStream();
    statusChanged();
}

export function useUsTradingState(): UsTradingState {
    useEffect(startUsTradingState, []);
    return useSyncExternalStore(subscribeUsTradingState, getUsTradingState);
}

/** 測試用 */
export function resetUsTradingStateForTest(next: Partial<UsTradingState> = {}) {
    state = { ...initial(), ...next };
    accountInFlight.clear();
    allInFlight = null;
    refetchTimers.forEach(clearTimeout);
    refetchTimers.clear();
    positionsCapability = null;
    capabilityBase = '';
    listeners.forEach(l => l());
}

/** 委託列的整數數量（整股）；非整數回 null */
export function usWholeShares(v: UsAmount | null | undefined): number | null {
    return decToInt(v ?? null);
}
