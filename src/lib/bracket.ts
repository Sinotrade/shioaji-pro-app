// src/lib/bracket.ts — bracket orders (括號單): after an entry order fills,
// an OCO stop-loss + take-profit trigger pair protects the FILLED quantity.
//
// #102 — event driven, no polling:
// - the main window alone tracks plans; other windows register / reconcile
//   through the ACKed command bus and display a mirrored snapshot;
// - entry fills come from de-duplicated order/deal reports (full event_id,
//   then `<orderId>:<exchange_seq>`), matched to the plan's FIXED account,
//   product and side, and accumulate across partial fills — protection grows
//   with every new fill instead of stopping at the first one;
// - one-shot cache-only lookups (`/order/trades refresh:false`) cover fills
//   that arrived before registration, after a reload or across a reconnect;
// - disconnects, sequence gaps, untrackable IDs and non-Healthy trade cache
//   mark protection NOT confirmed; only an explicit user reconciliation
//   (`refresh:true`, update_status) followed by a Healthy cache clears them;
// - unknown exit outcomes and unprotected quantity stay visible; nothing is
//   resent automatically.

import { useSyncExternalStore } from 'react';
import { createAccountQuery } from './account-query';
import { reportLedger } from './report-ledger';
import { cancelVerifiedOrder, fetchTradeCacheHealth, fetchTrades } from './shioaji';
import { checkTradeCacheHealth, tradeCacheContinuous } from './trading-state';
import {
    accountRefKey,
    addIssue,
    applyEntryFill,
    applyEntryOrderReport,
    applyEntryTrade,
    bracketPhase,
    isLive,
    matchDeal,
    protectionQuantity,
    tradeMatchesPlan,
    entryTradeIdentity,
    entryReportIdentity,
    sameEntryScope,
    sameEntryPartition,
    unprotectedQuantity,
    workingEntryAfterExit,
    type AccountRef,
    type BracketPlan,
} from './bracket-core';
import { onTrackedReport, recentReportsFor, type TrackedReportInfo } from './bracket-reports';
import { claimExecutor, CommandNotAcknowledged, createCommandBus, isExecutor, isMainWindow } from './main-window-commands';
import type { OrderEventReport } from './order-report';
import {
    currentProtectionEnv,
    envBase,
    onProtectionEnvChange,
    refreshProtectionEnv,
    reportEnvMatches,
} from './protection-env';
import {
    acknowledgeNativeUnknown,
    confirmNativeEntry,
    createNativeProgram,
    ensureNativeHost,
    getNativePrograms,
    getNativeOwnerGeneration,
    nativeOwnsNew,
    removeNativeProgram,
    sendNativeCommand,
    subscribeNative,
} from './execution/native';
import { bracketPlansFromPrograms, programForNewBracket, type NativeBracketPlan } from './execution/native-view';
import { externalIdentity } from './broker-identity';
import { currentReportContext, getProtectionContextVersion } from './protection-context';
import { getApiBase } from './runtime';
import { getStreamStatus, subscribeStatusStore } from './stream';
import { notify } from './trade';
import {
    acknowledgeExit,
    applyBracketExitTrades,
    armBracketGroup,
    disarmBracketGroup,
    dropBracketTriggers,
    resumeWasRestore,
    EXECUTOR_LOCK,
    getExits,
    onBecomeExecutor,
    onExitUpdate,
    type ExitRecord,
} from './trigger-engine';
import type { Action, FuturesOCType, StockOrderCond, StockOrderLot, TradeCacheHealth } from './types/order';

export type { BracketPlan } from './bracket-core';

export interface BracketSpec {
    env: string;
    account: AccountRef;
    orderId: string;
    seqno: string;
    ordno?: string;
    quoteCode: string;
    orderCode: string;
    securityType: 'STK' | 'FUT' | 'OPT';
    exchange: string;
    action: Action;
    quantity: number; // 張／口；盤中零股為股數
    orderLot?: StockOrderLot; // stocks: Common (default) or IntradayOdd (#204)
    stopPrice: number | null;
    takePrice: number | null;
}

// ---- pre-order validation (runs BEFORE the entry order is sent) ----

export interface BracketRequest {
    isFutures: boolean;
    action: Action;
    referencePrice: number | null; // limit price, or last trade for market entries
    stopPrice: number | null;
    takePrice: number | null;
    orderLot?: StockOrderLot;
    orderCond?: StockOrderCond;
    octype?: FuturesOCType;
}

export function validateBracketRequest(r: BracketRequest): string | null {
    if (r.stopPrice === null && r.takePrice === null) return '括號單需要停損價或停利價';
    for (const p of [r.stopPrice, r.takePrice]) {
        if (p !== null && (!Number.isFinite(p) || p <= 0)) return '停損／停利價必須是正數';
    }
    if (r.isFutures) {
        if (r.octype && r.octype !== 'Auto' && r.octype !== 'New') return '括號單僅支援期貨新倉（Auto／New）進場，出場固定以平倉（Cover）送出';
    } else if ((r.orderCond ?? 'Cash') !== 'Cash') {
        return '股票括號單僅支援現股（整股或盤中零股）；融資券與借券條件請手動設定出場';
    } else if (r.orderLot === 'Odd') {
        return '盤後零股是收盤後一次撮合，無法即時停損停利；請改用盤中零股或整股';
    } else if ((r.orderLot ?? 'Common') !== 'Common' && r.orderLot !== 'IntradayOdd') {
        return '股票括號單僅支援整股與盤中零股';
    }
    const ref = r.referencePrice;
    if (ref === null || !Number.isFinite(ref) || ref <= 0) return '沒有有效的參考價（限價或即時成交價），無法確認停損停利方向';
    const long = r.action === 'Buy';
    if (r.stopPrice !== null && (long ? r.stopPrice >= ref : r.stopPrice <= ref)) {
        return `${long ? '買進' : '賣出'}的停損價必須${long ? '低於' : '高於'}參考價 ${ref}`;
    }
    if (r.takePrice !== null && (long ? r.takePrice <= ref : r.takePrice >= ref)) {
        return `${long ? '買進' : '賣出'}的停利價必須${long ? '高於' : '低於'}參考價 ${ref}`;
    }
    return null;
}

// ---- state ----

const STORAGE_KEY = 'sj-pro-brackets';
export const SNAPSHOT_HEARTBEAT_MS = 5000;
export const SNAPSHOT_STALE_MS = 15000;
const KEEP_DONE_MS = 24 * 3600 * 1000;
const main = isMainWindow();

function loadPlans(): BracketPlan[] {
    try {
        const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
        const arr: unknown = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(arr)) return [];
        // A cancel still 'sending' when the app went away has an unknown
        // outcome: show 刪單待確認 · 對帳, never a stuck 處理中 (and never resend).
        return (arr as BracketPlan[]).filter(p => p && typeof p.id === 'string' && p.account)
            .map(p => ({ ...p, identityConfirmed: false, ...(p.entryCancel === 'sending' ? { entryCancel: 'unconfirmed' as const } : {}) }));
    } catch {
        return [];
    }
}

// Loaded and written only by the executing main window (see run()).
let plans: BracketPlan[] = [];
let executing = false;
let decideRole!: () => void;
const roleDecided = new Promise<void>(resolve => { decideRole = resolve; });
if (!main) decideRole();
let snapshot: BracketPlan[] = plans;
const listeners = new Set<() => void>();
const exitIds = new Map<string, string>(); // plan id → exit record id

type Command =
    | { op: 'ping' }
    | { op: 'register'; spec: BracketSpec; hostId?: string }
    | { op: 'reconcile'; id: string }
    | { op: 'dismiss'; id: string }
    | { op: 'ack-exit'; id: string }
    | { op: 'cancel-entry'; id: string };

const bus = createCommandBus<Command, BracketPlan[] | { hostId: string; plans: BracketPlan[] }>({
    channel: typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`sj-brackets:${getApiBase()}`) : null,
    main: () => executing,
    ready: roleDecided,
    heartbeatMs: SNAPSHOT_HEARTBEAT_MS,
    handle: cmd => handle(cmd),
    snapshot: () => ({ hostId, plans: snapshot }),
    onState: state => {
        if (Array.isArray(state)) {
            mirrorHostId = null; // old state has no trustworthy owner generation
            snapshot = state;
        } else if (state && typeof state.hostId === 'string' && Array.isArray(state.plans)) {
            mirrorHostId = state.hostId;
            snapshot = state.plans;
        } else return;
        listeners.forEach(l => l());
    },
});

function commit() {
    if (!executing) return; // mirrors never write shared state
    const now = Date.now();
    plans = plans.filter(p => !p.dismissed && (isLive(p) || now - p.updatedAt < KEEP_DONE_MS));
    try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(plans)); } catch { /* quota */ }
    plans = plans.map(p => ({ ...p, identityConfirmed: !!p.reportContext && p.reportContext === currentReportContext() }));
    snapshot = plans;
    listeners.forEach(l => l());
    bus.publish();
}

const planId = (env: string, account: AccountRef, orderId: string) => `${env}|${accountRefKey(account)}|${orderId}`;

function describeProtection(p: Pick<BracketPlan, 'stopPrice' | 'takePrice'>) {
    return `${p.stopPrice !== null ? ` 停損@${p.stopPrice}` : ''}${p.takePrice !== null ? ` 停利@${p.takePrice}` : ''}`;
}

// True while applying fills recovered after a (re)start (startup cache
// lookup, buffered reports replayed once the mode is known): exits armed then
// may already be past their price, so their first tick decides (#144).
let restoring = false;
function restoringDo(on: boolean, fn: () => void) {
    const prev = restoring;
    restoring = on || prev;
    try { fn(); } finally { restoring = prev; }
}

function arm(p: BracketPlan) {
    const qty = protectionQuantity(p);
    if (p.dismissed || qty <= 0 || p.env !== currentProtectionEnv() || p.reportContext !== currentReportContext()) return;
    armBracketGroup({
        restore: restoring,
        group: p.group, bracketId: p.id, env: p.env, account: p.account, code: p.quoteCode,
        orderCode: p.orderCode, entryAction: p.action, octype: p.market === 'futures' ? 'Cover' : undefined,
        orderLot: p.market === 'stock' && p.orderLot === 'IntradayOdd' ? 'IntradayOdd' : undefined,
        stopPrice: p.stopPrice, takePrice: p.takePrice, quantity: qty,
    });
}

/** Arm/resize protection for the filled quantity; notify once per change. */
function syncProtection(before: BracketPlan | undefined, p: BracketPlan) {
    if (p.dismissed) return; // the user removed this plan and its protection
    const qty = protectionQuantity(p);
    arm(p);
    const prevQty = before ? protectionQuantity(before) : 0;
    if (qty > prevQty) {
        notify({ kind: 'ok', title: qty < p.quantity ? '括號單部分成交已保護' : '括號單已啟動',
            body: `${p.quoteCode} 已成交 ${Math.min(p.filled, p.quantity)}/${p.quantity} → OCO${describeProtection(p)} 保護 ${qty}` });
    }
    const late = unprotectedQuantity(p) - (before ? unprotectedQuantity(before) : 0);
    if (late > 0) {
        notify({ kind: 'err', title: '括號單有未保護部位',
            body: `${p.quoteCode} ${unprotectedQuantity(p)} 可能未受保護（待確認）；請先按「對帳」確認實際成交再決定，勿直接另下出場單；系統不會自動重送` });
    }
    if (before && bracketPhase(before) === 'waiting' && bracketPhase(p) === 'closed') {
        notify({ kind: 'info', title: '括號單取消', body: `${p.quoteCode} 進場單未成交即結束，保護單不掛` });
    }
}

function update(id: string, fn: (p: BracketPlan) => BracketPlan) {
    const before = plans.find(p => p.id === id);
    if (!before) return;
    const after = fn(before);
    if (after === before) return;
    plans = plans.map(p => p === before ? after : p);
    syncProtection(before, after);
    commit();
}

function applyReport(p: BracketPlan, report: OrderEventReport, now: number, context = currentReportContext()): BracketPlan {
    const identity = entryReportIdentity(p, report);
    if (identity === 'different') return p;
    if (identity === 'unknown' || !context || p.reportContext !== context) {
        return addIssue(p, 'report-mismatch', '回報委託身分或連線代次尚未確認，未計入成交或結束狀態；請對帳', now);
    }
    if (report.kind === 'order') return applyEntryOrderReport(p, report, now);
    const m = matchDeal(report, p.orderId, p.account, p.market, p.orderCode, p.action, p);
    if (m.kind === 'fill') return applyEntryFill(p, m.fill, now);
    if (m.kind === 'mismatch') return addIssue(p, 'report-mismatch', m.detail, now);
    return p;
}

function onReport(report: OrderEventReport, info: TrackedReportInfo, base: string) {
    const now = Date.now();
    for (const p of plans.slice()) {
        if (!isLive(p) || !reportEnvMatches(p.env, base)) continue;
        let next = p;
        if (info.untrackable && report.market === p.market) {
            next = addIssue(next, 'untrackable', '收到沒有可追蹤事件 ID 的回報，無法確認是否漏回報', now);
        }
        next = applyReport(next, report, now, info.context);
        if (next !== p) update(p.id, () => next);
    }
}

function onExit(rec: ExitRecord) {
    if (!rec.bracketId) return;
    exitIds.set(rec.bracketId, rec.id);
    update(rec.bracketId, p => {
        const next: BracketPlan = { ...p, exit: {
            status: rec.status, kind: rec.kind, quantity: rec.quantity, filled: rec.filled, fills: rec.fills,
            fillTs: rec.fillTs, fillConflict: rec.fillConflict, orderId: rec.orderId, acknowledged: rec.acknowledged,
            detail: rec.acknowledged ? `${rec.detail ?? ''}（使用者已確認處理）` : rec.detail, at: rec.at,
        }, updatedAt: Date.now() };
        return rec.fillConflict
            ? addIssue(next, 'report-mismatch', '出場成交回報與委託快取無法對應為同一筆（可能重複計算）；請對帳', Date.now())
            : next;
    });
}

// ---- cache-only lookups / health (no polling) ----

const inflight = new Map<string, Promise<void>>();

function plansFor(account: AccountRef, env: string) {
    return plans.filter(p => p.env === env && accountRefKey(p.account) === accountRefKey(account) && isLive(p));
}

function applyHealth(account: AccountRef, env: string, health: TradeCacheHealth, now: number) {
    const codes = health.reasons.map(r => `${r.event_type}:${r.reason}`).join('、');
    for (const p of plansFor(account, env)) {
        if (health.state === 'Degraded') {
            update(p.id, x => addIssue(x, 'cache-degraded', `伺服器委託快取狀態 Degraded（${codes}）`, now));
        } else if (health.reasons.some(r => r.reason === 'NotSubscribed')) {
            update(p.id, x => addIssue(x, 'not-subscribed', '此帳戶未訂閱主動回報，成交不會即時推送', now));
        }
    }
}

async function checkHealth(account: AccountRef, env: string, query = createAccountQuery()) {
    const health = await query.read(account.account_type, account, current => fetchTradeCacheHealth(account.account_type, current));
    query.assertCurrent();
    if (health.reasons.some(r => r.reason === 'NotSubscribed')) {
        // Never subscribe here: trading-state owns (re)subscription and its
        // single-flight health check coalesces with a reconnect already in
        // progress, so each account is subscribed once. The plan stays
        // unconfirmed (not-subscribed) until an explicit reconcile.
        void checkTradeCacheHealth('manual');
    }
    if (currentProtectionEnv() === env) applyHealth(account, env, health, Date.now());
    return health;
}

/** A possible sequence gap (shared report ledger, #128) on this API base:
 * any plan there may have missed a fill — conservative, not per market. */
function onGap(base: string) {
    const now = Date.now();
    for (const p of plans.slice()) {
        if (!isLive(p) || !reportEnvMatches(p.env, base)) continue;
        update(p.id, x => addIssue(x, 'gap', '回報序號跳號，可能漏收成交；請對帳', now));
    }
}

/** One-shot cache-only lookup + health for an account's live plans. */
function lookup(account: AccountRef, env: string, restore = false): Promise<void> {
    const key = `lookup|${env}|${accountRefKey(account)}`;
    const running = inflight.get(key);
    if (running) return running;
    const task = (async () => {
        const now = Date.now();
        const query = createAccountQuery();
        const context = currentReportContext();
        try {
            // Cache-only continuity is proven only by trading-state's
            // authoritative baseline on this sidecar instance (#128).
            const continuous = tradeCacheContinuous();
            const trades = await query.read(account.account_type, account, current => fetchTrades(account.account_type, current, { refresh: false }));
            query.assertCurrent();
            if (currentProtectionEnv() !== env || !context || context !== currentReportContext()) return;
            restoringDo(restore, () => {
                for (const p of plansFor(account, env)) {
                    if (!continuous) update(p.id, x => addIssue(x, 'no-baseline', '委託快取尚無連續基準（未完成權威查詢或串流曾中斷）；請對帳', now));
                    const candidates = trades.filter(t => tradeMatchesPlan(t, p));
                    const trade = candidates.length === 1 ? candidates[0] : undefined;
                    if (continuous && trade) update(p.id, x => applyEntryTrade({ ...x, reportContext: context }, trade, now));
                    else update(p.id, x => addIssue(x, 'lookup-failed', '伺服器委託快取找不到此進場單（可能伺服器重啟）；請對帳', now));
                }
            });
            if (continuous) applyBracketExitTrades(trades);
        } catch (e) {
            for (const p of plansFor(account, env)) {
                update(p.id, x => addIssue(x, 'lookup-failed', `委託快取查詢失敗：${e instanceof Error ? e.message : String(e)}`, now));
            }
        }
        try { await checkHealth(account, env, query); } catch (e) {
            for (const p of plansFor(account, env)) {
                update(p.id, x => addIssue(x, 'lookup-failed', `回報健康狀態查詢失敗：${e instanceof Error ? e.message : String(e)}`, now));
            }
        }
    })().finally(() => inflight.delete(key));
    inflight.set(key, task);
    return task;
}

function lookupLiveAccounts(restore = false) {
    const env = currentProtectionEnv();
    if (!env) return;
    const seen = new Map<string, AccountRef>();
    for (const p of plans) if (p.env === env && isLive(p)) seen.set(accountRefKey(p.account), p.account);
    for (const account of seen.values()) void lookup(account, env, restore);
}

/** Explicit, authoritative reconciliation (update_status). User action only. */
async function reconcile(id: string): Promise<{ health: TradeCacheHealth['state'] }> {
    const plan = plans.find(p => p.id === id);
    if (!plan) throw new Error('找不到此括號單');
    if (plan.env !== currentProtectionEnv()) throw new Error('此括號單屬於其他伺服器或模擬／正式模式，請切回原環境後對帳');
    const key = `reconcile|${plan.env}|${accountRefKey(plan.account)}`;
    if (inflight.has(key)) throw new Error('對帳進行中');
    let result: TradeCacheHealth['state'] = 'Unknown';
    const task = (async () => {
        const env = plan.env;
        const query = createAccountQuery();
        const context = currentReportContext();
        const trades = await query.read(plan.account.account_type, plan.account, current => fetchTrades(plan.account.account_type, current, { refresh: true }));
        query.assertCurrent();
        if (context !== currentReportContext()) throw new Error('對帳期間連線已變更，請重新核對');
        const now = Date.now();
        for (const p of plansFor(plan.account, env)) {
            const candidates = trades.filter(t => tradeMatchesPlan(t, p));
            const trade = candidates.length === 1 ? candidates[0] : undefined;
            if (context && trade) update(p.id, x => {
                const next = applyEntryTrade({ ...x, reportContext: context }, trade, now);
                return next.entryClosed && next.entryCancel ? { ...next, entryCancel: undefined } : next;
            });

        }
        if (context) applyBracketExitTrades(trades);
        const health = await checkHealth(plan.account, env, query);
        query.assertCurrent();
        result = health.state;
        if (getStreamStatus() !== 'live') {
            // Reconciled a snapshot, but reports/ticks are not arriving now.
            for (const p of plansFor(plan.account, env)) update(p.id, x => addIssue(x, 'disconnect', '回報串流仍未連線；對帳結果之後的成交不會即時收到', now));
            return;
        }
        if (health.state === 'Healthy') {
            for (const p of plansFor(plan.account, env)) {
                if (trades.filter(t => tradeMatchesPlan(t, p)).length === 1) {
                    update(p.id, x => ({ ...x, updatedAt: now, issues: x.issues.filter(i => i.code === 'overfill') }));
                } else {
                    update(p.id, x => addIssue(x, 'lookup-failed', '對帳結果仍找不到此進場單；請至委託分頁確認', now));
                }
            }
        }
    })().finally(() => inflight.delete(key));
    inflight.set(key, task);
    await task;
    return { health: result };
}

function register(spec: BracketSpec): BracketPlan {
    if (!spec.env || spec.env !== currentProtectionEnv()) throw new Error('伺服器或模擬／正式模式已切換或未確認，括號單未登記');
    if (!spec.orderId || !spec.account?.broker_id || !spec.account?.account_id) throw new Error('進場單缺少委託或帳戶識別，括號單未登記');
    if (!Number.isSafeInteger(spec.quantity) || spec.quantity <= 0) throw new Error('進場數量無效');
    if (spec.orderLot && spec.orderLot !== 'Common' && (spec.account.account_type !== 'S' || spec.orderLot !== 'IntradayOdd')) {
        throw new Error('括號單僅支援整股與盤中零股，未登記');
    }
    const context = currentReportContext();
    if (!context || !(spec.seqno?.trim() || spec.ordno?.trim())) throw new Error('進場單身分或連線尚未確認，保護登記待確認；請核對委託，勿重送');
    const candidates = plans.filter(p => sameEntryPartition(p, spec) && !p.dismissed);
    for (const p of candidates) {
        const identity = externalIdentity({ ...p, confirmed: false }, { ...spec, confirmed: false });
        if (identity === 'unknown') throw new Error('進場單身分可能與既有保護重複，請先對帳，保護登記待確認');
        if (identity === 'same') {
            if (!sameEntryScope(p, spec)) throw new Error('進場單身分相同但方向或原量不一致，保護登記待確認；請對帳，勿重複保護');
            if (p.reportContext !== context) throw new Error('既有進場單連線代次尚未確認，請先對帳，保護登記待確認');
            return p;
        }
    }
    const baseId = planId(spec.env, spec.account, spec.orderId);
    const id = plans.some(p => p.id === baseId) ? `${baseId}|identity:${encodeURIComponent(spec.seqno)}:${encodeURIComponent(spec.ordno ?? '')}:${plans.length}` : baseId;
    const now = Date.now();
    let plan: BracketPlan = {
        ...spec, id, reportContext: context, identityConfirmed: true, market: spec.account.account_type === 'S' ? 'stock' : 'futures',
        group: `bracket:${spec.orderId}:${now.toString(36)}`, fills: {}, filled: 0,
        entryClosed: false, exit: null, issues: [], createdAt: now, updatedAt: now,
    };
    if (getStreamStatus() !== 'live') plan = addIssue(plan, 'disconnect', '登記時行情／回報串流未連線', now);
    // Reports that reached this window before the registration command.
    for (const report of recentReportsFor(envBase(spec.env), spec.orderId, now, spec)) plan = applyReport(plan, report, now);
    plans = [...plans, plan];
    notify({ kind: 'info', title: '括號單待命',
        body: `${plan.quoteCode} 成交後依成交量自動掛${describeProtection(plan)}` });
    syncProtection(undefined, plan);
    commit();
    void lookup(plan.account, plan.env);
    return plan;
}

function handle(cmd: Command): unknown {
    switch (cmd.op) {
        case 'ping': return hostId;
        case 'register':
            if (cmd.hostId && cmd.hostId !== hostId) throw new Error('主視窗已重新載入，保護登記待確認');
            return register(cmd.spec);
        case 'reconcile': return reconcile(cmd.id);
        case 'dismiss': {
            const p = plans.find(x => x.id === cmd.id);
            if (!p) { dropBracketTriggers(cmd.id); return true; } // orphaned protection
            disarmBracketGroup(p.env, p.group);
            update(p.id, x => ({ ...x, dismissed: true, updatedAt: Date.now() }));
            return true;
        }
        case 'cancel-entry': return cancelEntry(cmd.id);
        case 'ack-exit': {
            const exitId = exitIds.get(cmd.id) ?? getExits().find(e => e.bracketId === cmd.id)?.id;
            if (!exitId) throw new Error('找不到此括號單的出場紀錄');
            return acknowledgeExit(exitId);
        }
    }
    throw new Error('未知指令');
}

// ---- public API (any window) ----

/** One preflight admission for this entry. Ownership is never reselected after dispatch. */
export interface BracketAdmission {
    readonly owner: 'window' | 'native';
    readonly env: string;
    readonly orderLot: StockOrderLot;
    readonly contextGeneration: number;
    readonly ownerGeneration: number;
    readonly hostId: string | null;
}
const hostId = `host-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let mirrorHostId: string | null = null;
const ADMISSION_CHANGED = '保護執行環境已變更，未送出進場單，請重新確認';
export async function ensureBracketHost(opts: { orderLot?: StockOrderLot } = {}): Promise<BracketAdmission> {
    const env = currentProtectionEnv();
    if (!env) throw new Error('伺服器模式尚未確認，括號單未送出');
    const admission: BracketAdmission = {
        owner: nativeBracket(opts.orderLot) ? 'native' : 'window', env,
        orderLot: opts.orderLot ?? 'Common', contextGeneration: getProtectionContextVersion(),
        ownerGeneration: getNativeOwnerGeneration(), hostId: null,
    };
    let ready: BracketAdmission;
    if (admission.owner === 'native') {
        ensureNativeHost(env);
        ready = admission;
    } else {
        const id = await bus.send({ op: 'ping' });
        if (typeof id !== 'string') throw new Error('主視窗尚未確認，括號單未送出');
        ready = { ...admission, hostId: id };
    }
    assertBracketAdmission(ready);
    return Object.freeze(ready);
}
/** Synchronous send-time gate, called again by the actual order dispatch. */
export function assertBracketAdmission(admission: BracketAdmission): void {
    if (admission.env !== currentProtectionEnv() || admission.contextGeneration !== getProtectionContextVersion()
        || (admission.orderLot === 'Common' && admission.ownerGeneration !== getNativeOwnerGeneration())) {
        throw new Error(ADMISSION_CHANGED);
    }
    if (admission.owner === 'native') ensureNativeHost(admission.env);
    else if (admission.hostId !== (executing ? hostId : mirrorHostId) || bracketSnapshotStale()) throw new Error(ADMISSION_CHANGED);
}

/** A sent entry is persisted before registration; failed/late ACKs retain its identity.
 * These rows never enter either executor's plans and never submit any order. */
const PENDING_REGISTRATION_KEY = 'sj-pro-bracket-registrations';
function loadPendingRegistrations(): BracketPlan[] {
    try {
        const data: unknown = JSON.parse(globalThis.localStorage?.getItem(PENDING_REGISTRATION_KEY) ?? '[]');
        return Array.isArray(data) ? data.filter((p: BracketPlan) => p?.registrationPending && p.account && p.orderId) : [];
    } catch { return []; }
}
let pendingRegistrations = loadPendingRegistrations();
function savePendingRegistration(plan: BracketPlan | null, id: string): void {
    const latest = loadPendingRegistrations().filter(p => p.id !== id);
    pendingRegistrations = plan ? [...latest, plan] : latest;
    try { globalThis.localStorage?.setItem(PENDING_REGISTRATION_KEY, JSON.stringify(pendingRegistrations)); } catch {
        // Keep the in-memory row and make the persistence limitation visible.
        if (plan?.registrationPending) plan.registrationPending.detail += '；此紀錄無法保存，請立即核對委託';
    }
    listeners.forEach(l => l());
}
if (typeof window !== 'undefined') window.addEventListener?.('storage', e => {
    if (e.key === PENDING_REGISTRATION_KEY) {
        pendingRegistrations = loadPendingRegistrations();
        listeners.forEach(l => l());
    }
});
function pendingRegistration(spec: BracketSpec, admission: BracketAdmission, detail: string): BracketPlan {
    const now = Date.now();
    return { ...spec, id: `registration:${admission.owner}:${planId(spec.env, spec.account, spec.orderId)}:${encodeURIComponent(spec.seqno)}:${encodeURIComponent(spec.ordno ?? '')}:${spec.action}:${spec.quantity}:${spec.orderLot ?? 'Common'}${spec.seqno?.trim() || spec.ordno?.trim() ? '' : `:${now}:${Math.random().toString(36).slice(2)}`}`,
        market: spec.account.account_type === 'S' ? 'stock' : 'futures', group: '', fills: {}, filled: 0,
        entryClosed: false, exit: null, issues: [], createdAt: now, updatedAt: now,
        registrationPending: { owner: admission.owner, detail } };
}

export const REGISTER_TIMEOUT_MS = 60_000;
function assertRegistrationOwner(spec: BracketSpec, owner: BracketAdmission['owner']): void {
    const foreign = owner === 'native' ? [...snapshot, ...pendingRegistrations.filter(p => p.registrationPending?.owner === 'window')]
        : [...nativePlans(), ...pendingRegistrations.filter(p => p.registrationPending?.owner === 'native')];
    if (foreign.some(p => p.env === spec.env && accountRefKey(p.account) === accountRefKey(spec.account)
        && sameEntryPartition(p, spec) && !p.dismissed
        && externalIdentity({ ...p, confirmed: false }, { ...spec, confirmed: false }) !== 'different')) {
        throw new Error('此進場單可能已由其他執行器追蹤，請先核對保護紀錄，未重複登記');
    }
}
export async function registerBracket(spec: BracketSpec, admission?: BracketAdmission): Promise<BracketPlan> {
    // Legacy direct registration chooses an owner once here; the ticket always supplies its preflight admission.
    if (!admission) {
        admission = await ensureBracketHost({ orderLot: spec.orderLot });
    }
    const record = pendingRegistration(spec, admission, '進場單已送出，保護登記尚未確認；請核對委託與保護紀錄，勿重送進場或另掛重複出場單');
    savePendingRegistration(record, record.id);
    try {
        assertRegistrationOwner(spec, admission.owner);
        if (spec.env !== admission.env || spec.env !== currentProtectionEnv()
            || (spec.orderLot ?? 'Common') !== admission.orderLot || admission.contextGeneration !== getProtectionContextVersion()) {
            throw new Error('進場送出後環境已變更，保護登記待確認；請切回原環境核對');
        }
        // A disabled native host must not create anew. Retain the pending record instead of migrating owners.
        if (admission.owner === 'native') ensureNativeHost(admission.env);
        const plan = admission.owner === 'native' ? await registerNativeBracket(spec)
            : await bus.send({ op: 'register', spec, hostId: admission.hostId ?? undefined }, REGISTER_TIMEOUT_MS) as BracketPlan;
        if (!sameEntryScope(plan, spec) || externalIdentity({ ...plan, confirmed: false }, { ...spec, confirmed: false }) !== 'same') {
            throw new Error('保護登記回覆的委託身分尚未確認；請核對紀錄，勿重送');
        }
        if (admission.env !== currentProtectionEnv() || admission.contextGeneration !== getProtectionContextVersion()
            || (admission.owner === 'window' && admission.hostId !== (executing ? hostId : mirrorHostId))) {
            throw new Error('保護登記回覆前連線或執行視窗已變更，登記仍待確認；請核對原委託與保護紀錄，勿重送');
        }
        savePendingRegistration(null, record.id);
        return plan;
    } catch (e) {
        record.registrationPending!.detail = `${record.registrationPending!.detail}；${e instanceof Error ? e.message : String(e)}`;
        savePendingRegistration(record, record.id);
        throw e;
    }
}

/** Native owns new whole-lot / futures brackets; odd-lot brackets (#204:
 * quantities in shares, odd-lot exits) are not expressible in execution-v1
 * yet and stay in the TS runtime. */
function nativeBracket(orderLot: StockOrderLot | undefined): boolean {
    return (orderLot ?? 'Common') === 'Common' && nativeOwnsNew();
}

async function registerNativeBracket(spec: BracketSpec): Promise<BracketPlan> {
    if (!spec.env || spec.env !== currentProtectionEnv()) throw new Error('伺服器或模擬／正式模式已切換或未確認，括號單未登記');
    if (!spec.orderId || !spec.account?.broker_id || !spec.account?.account_id) throw new Error('進場單缺少委託或帳戶識別，括號單未登記');
    if (!Number.isSafeInteger(spec.quantity) || spec.quantity <= 0) throw new Error('進場數量無效');
    // idempotent: an entry order has at most one live bracket (the engine
    // refuses a second one too: both would send a full-size exit)
    const existingFor = () => {
        const candidates = nativePlans().filter(p => p.native.status !== 'stopped' && p.env === spec.env
            && p.orderCode === spec.orderCode && p.securityType === spec.securityType
            && accountRefKey(p.account) === accountRefKey(spec.account));
        for (const p of candidates) {
            const identity = externalIdentity({ ...p, confirmed: !p.native.entryUnconfirmed }, spec);
            if (identity === 'same') return p;
            if (identity === 'unknown') throw new Error('進場單身分尚未確認，請先核對委託與成交；括號單未登記');
        }
        return undefined;
    };
    const existing = existingFor();
    if (existing) return existing;
    const now = Date.now();
    const program = programForNewBracket(spec, `nb-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`, now);
    if (!program) throw new Error('伺服器模式未確認，括號單未登記');
    try {
        await createNativeProgram(program);
    } catch (e) {
        // registered meanwhile (another window): that one is the bracket
        const again = existingFor();
        if (again) return again;
        throw e;
    }
    notify({ kind: 'info', title: '括號單待命', body: `${spec.quoteCode} 成交後依成交量自動掛${describeProtection(spec)}` });
    return nativePlans().find(p => p.id === program.id) ?? bracketPlansFromPrograms([program])[0]!;
}

// ---- native brackets (#201) as plans, display + commands ----

let nativeCache: { programs: unknown; plans: NativeBracketPlan[] } = { programs: null, plans: [] };
function nativePlans(): NativeBracketPlan[] {
    const programs = getNativePrograms();
    if (nativeCache.programs !== programs) nativeCache = { programs, plans: bracketPlansFromPrograms(programs) };
    return nativeCache.plans;
}

function nativePlan(id: string): NativeBracketPlan | undefined {
    return nativePlans().find(p => p.id === id);
}

export function isNativeBracket(p: BracketPlan): p is NativeBracketPlan {
    return 'native' in p && !!(p as NativeBracketPlan).native;
}

/** What to tell the user when registering after the entry was sent failed.
 * Never suggests adding a manual stop: an unacknowledged registration may
 * still apply, and a second exit (futures manual triggers are Auto) could
 * open a reverse position. */
export function registrationFailureText(error: unknown): string {
    if (error instanceof CommandNotAcknowledged) {
        return '保護單登記結果未確認（主視窗未回應）。請先查看下單面板的括號單狀態清單確認是否已登記；確認前不要另外設定停損或出場單';
    }
    const why = error instanceof Error ? error.message : String(error);
    return `保護單未登記（${why}）。請先查看括號單狀態清單並至委託／持倉確認，再決定是否自行處理出場；系統不會自動補送`;
}

export function reconcileBracket(id: string) {
    if (nativePlan(id)) return Promise.reject(new Error('括號單由執行引擎自動對帳'));
    // update_status can take a while; a short ACK timeout would misreport it.
    return bus.send({ op: 'reconcile', id }, 60_000) as Promise<{ health: TradeCacheHealth['state'] }>;
}

export function dismissBracket(id: string) {
    const native = nativePlan(id);
    if (native) return removeNativeProgram(native.native.programId);
    return bus.send({ op: 'dismiss', id });
}

/** Native bracket whose entry stayed open across a trade-id epoch: the
 * user's total fill quantity (from the orders / deals query). Sends no order. */
export function confirmBracketEntry(id: string, filled: number, noRemainder: boolean) {
    const native = nativePlan(id);
    if (!native) throw new Error('找不到此括號單');
    return confirmNativeEntry(native.native.programId, native.native.levelId, filled, noRemainder);
}

export function acknowledgeBracketExit(id: string) {
    const native = nativePlan(id);
    if (native) return acknowledgeNativeUnknown(native.native.programId, native.native.levelId);
    return bus.send({ op: 'ack-exit', id });
}

/** A mirror's copy is stale when the executing main window stopped
 * publishing (closed / crashed / not yet started). The executor is never stale. */
export function bracketSnapshotStale(now = Date.now()): boolean {
    if (executing) return false;
    const at = bus.lastStateAt();
    return at === 0 || now - at > SNAPSHOT_STALE_MS;
}

/** User-initiated cancel of an entry that is still working after its exit
 * fired. One request, no retry; the Cancel report closes the entry. */
export function cancelRemainingEntry(plan: BracketPlan) {
    // native: stopping the program cancels its working entry (the exit has
    // already fired when this is offered)
    if (isNativeBracket(plan)) return sendNativeCommand({ op: 'stop', programId: plan.native.programId, version: plan.native.version });
    return bus.send({ op: 'cancel-entry', id: plan.id }, REGISTER_TIMEOUT_MS);
}

/** Main window: one cancel request, never retried or resent. The entry is
 * closed only by a read-back-confirmed Cancelled trade (#129's cancelOrder)
 * or the Cancel report; anything else leaves 刪單待確認 for an explicit 對帳. */
async function cancelEntry(id: string): Promise<'cancelled' | 'unconfirmed'> {
    const plan = plans.find(p => p.id === id);
    if (!plan) throw new Error('找不到此括號單');
    if (plan.entryCancel) throw new Error(plan.entryCancel === 'sending' ? '刪單處理中' : '刪單待確認，請先對帳，勿重送');
    if (workingEntryAfterExit(plan) <= 0) throw new Error('進場單已無剩餘委託');
    if (plan.env !== currentProtectionEnv()) throw new Error('此括號單屬於其他伺服器或模式，未送出刪單');
    update(id, p => ({ ...p, entryCancel: 'sending', updatedAt: Date.now() }));
    try {
        const query = createAccountQuery();
        const context = currentReportContext();
        const rows = await query.read(plan.account.account_type, plan.account, current => fetchTrades(plan.account.account_type, current, { refresh: !tradeCacheContinuous() }));
        query.assertCurrent();
        const candidates = rows.filter(t => entryTradeIdentity(t, plan) === 'same');
        if (!context || context !== currentReportContext() || candidates.length !== 1) {
            throw Object.assign(new Error('進場委託身分或連線尚未確認，未送出刪單；請先對帳'), { mutationNotStarted: true });
        }
        const row = candidates[0]!;
        const trade = await query.read(plan.account.account_type, plan.account, current => cancelVerifiedOrder(row, current, {
            beforeSend: () => {
                query.assertCurrent();
                if (context !== currentReportContext()) throw new Error('刪單前連線已變更，未送出刪單');
            },
        }));
        const confirmed = context === currentReportContext() && trade && entryTradeIdentity(trade, plan) === 'same' && trade.status?.status === 'Cancelled';
        update(id, p => {
            if (!confirmed) return { ...p, entryCancel: 'unconfirmed', updatedAt: Date.now() };
            const next = applyEntryTrade({ ...p, entryCancel: undefined }, trade, Date.now());
            return { ...next, entryClosed: true };
        });
        return confirmed ? 'cancelled' : 'unconfirmed';
    } catch (error) {
        if ((error as { mutationNotStarted?: boolean })?.mutationNotStarted) {
            update(id, p => ({ ...p, entryCancel: undefined, updatedAt: Date.now() }));
            throw error;
        }
        // CANCEL_UNCONFIRMED (#129) or any ambiguous failure: outcome unknown.
        update(id, p => ({ ...p, entryCancel: 'unconfirmed', updatedAt: Date.now() }));
        return 'unconfirmed';
    }
}

export function getBrackets(): BracketPlan[] {
    return snapshot;
}

function subscribe(l: () => void) {
    listeners.add(l);
    return () => { listeners.delete(l); };
}

let mergedCache: { ts: BracketPlan[]; native: NativeBracketPlan[]; pending: BracketPlan[]; all: BracketPlan[] } = { ts: [], native: [], pending: [], all: [] };
/** TS plans followed by native bracket programs (marked `native`). */
export function getDisplayBrackets(): BracketPlan[] {
    const native = nativePlans();
    if (mergedCache.ts !== snapshot || mergedCache.native !== native || mergedCache.pending !== pendingRegistrations) {
        const pending = pendingRegistrations;
        mergedCache = { ts: snapshot, native, pending: pendingRegistrations, all: [...snapshot, ...native, ...pending] };
    }
    return mergedCache.all;
}

export function useBrackets(): BracketPlan[] {
    return useSyncExternalStore(l => {
        const a = subscribe(l);
        const b = subscribeNative(l);
        return () => { a(); b(); };
    }, getDisplayBrackets);
}

// ---- main-window runtime ----

let started = false;
export function startBracketRuntime() {
    if (started || !main) return;
    started = true;
    void claimExecutor(EXECUTOR_LOCK).settled.then(() => {
        if (isExecutor()) return;
        decideRole(); // standby mirror until the executor leaves
        bus.hello();
    });
    onBecomeExecutor(run);
}

function run() {
    plans = loadPlans();
    executing = true;
    decideRole();
    const base = getApiBase();
    const now = Date.now();
    plans = plans.map(p => envBase(p.env) !== base || !isLive(p) ? p
        : addIssue(p, 'reload', 'App 重新載入，期間的回報可能未收到', now));
    commit();
    onTrackedReport(onReport);
    reportLedger.onGap(base => onGap(base));
    onExitUpdate(onExit);
    for (const rec of getExits()) if (rec.bracketId) onExit(rec);
    // Once the server mode is known: replay buffered reports and look up.
    let knownEnv = currentProtectionEnv();
    onProtectionEnvChange(() => {
        const env = currentProtectionEnv();
        commit();
        if (env === knownEnv) return;
        knownEnv = env;
        if (!env) return;
        // restart / other environment / long outage (#144); the engine
        // latches this decision, so listener order does not matter
        const restore = resumeWasRestore();
        restoringDo(restore, () => {
            for (const p of plans.slice()) {
                if (p.env !== env || !isLive(p)) continue;
                const at = Date.now();
                let next = p;
                for (const report of recentReportsFor(envBase(env), p.orderId, at, p)) next = applyReport(next, report, at);
                if (next !== p) update(p.id, () => next);
                else arm(p); // re-arm (idempotent) once the mode is known
            }
        });
        lookupLiveAccounts(restore);
    });
    let wasLive = getStreamStatus() === 'live';
    subscribeStatusStore(() => {
        const live = getStreamStatus() === 'live';
        if (live === wasLive) return;
        wasLive = live;
        commit();
        const at = Date.now();
        if (!live) {
            for (const p of plans.slice()) {
                if (envBase(p.env) === getApiBase() && isLive(p)) update(p.id, x => addIssue(x, 'disconnect', '回報串流中斷，期間的成交可能未收到', at));
            }
        } else {
            void refreshProtectionEnv();
            // cache-only; issues stay until explicit reconcile. After a long
            // outage, fills found now may already be past their exits (#144).
            if (currentProtectionEnv()) lookupLiveAccounts(resumeWasRestore());
        }
    });
    void refreshProtectionEnv();
    if (wasLive) lookupLiveAccounts(true);
}
