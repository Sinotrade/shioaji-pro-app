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
import { cancelOrder, fetchTradeCacheHealth, fetchTrades } from './shioaji';
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
    unprotectedQuantity,
    workingEntryAfterExit,
    type AccountRef,
    type BracketPlan,
    type BracketRules,
    allocatedFill,
    averageFillPrice,
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
import { getApiBase } from './runtime';
import { getStreamStatus, subscribeStatusStore } from './stream';
import { notify } from './trade';
import {
    acknowledgeExit,
    applyExitTrade,
    armBracketGroup,
    disarmBracketGroup,
    dropBracketTriggers,
    resumeWasRestore,
    EXECUTOR_LOCK,
    getExits,
    getTriggers,
    onBecomeExecutor,
    onExitUpdate,
    onEntryPlaced,
    tightenBracketStop,
    type BracketEntryPlan,
    type ExitRecord,
    type TriggerOrder,
} from './trigger-engine';
import { ensureContract, getCachedContract } from './contracts-cache';
import type { TrailState } from './conditional/trailing';
import { newTrail } from './conditional/trailing';
import { tierSpecs } from './conditional/bracket-rules';
import { stepPrice } from './utils/ticksize';
import type { Trade } from './types/order';
import type { Action, FuturesOCType, StockOrderCond, StockOrderLot, TradeCacheHealth } from './types/order';

export type { BracketPlan } from './bracket-core';

export interface BracketSpec {
    env: string;
    account: AccountRef;
    orderId: string;
    seqno: string;
    quoteCode: string;
    orderCode: string;
    securityType: 'STK' | 'FUT' | 'OPT';
    exchange: string;
    action: Action;
    quantity: number; // 張／口；盤中零股為股數
    orderLot?: StockOrderLot; // stocks: Common (default) or IntradayOdd (#204)
    stopPrice: number | null;
    takePrice: number | null;
    /** #226 分批停利 tier and tick rules (panel brackets) */
    tier?: BracketPlan['tier'];
    rules?: BracketRules;
    refPrice?: number;
}

export { bracketPlanProblem, tierSpecs } from './conditional/bracket-rules';

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
            .map(p => p.entryCancel === 'sending' ? { ...p, entryCancel: 'unconfirmed' as const } : p);
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
    | { op: 'register'; spec: BracketSpec }
    | { op: 'reconcile'; id: string }
    | { op: 'dismiss'; id: string }
    | { op: 'ack-exit'; id: string }
    | { op: 'cancel-entry'; id: string }
    | { op: 'modify'; id: string; stopPrice: number | null; takePrice: number | null };

const bus = createCommandBus<Command, BracketPlan[]>({
    channel: typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`sj-brackets:${getApiBase()}`) : null,
    main: () => executing,
    ready: roleDecided,
    heartbeatMs: SNAPSHOT_HEARTBEAT_MS,
    handle: cmd => handle(cmd),
    snapshot: () => snapshot,
    onState: state => {
        if (!Array.isArray(state)) return;
        snapshot = state;
        listeners.forEach(l => l());
    },
});

function commit() {
    if (!executing) return; // mirrors never write shared state
    const now = Date.now();
    plans = plans.filter(p => !p.dismissed && (isLive(p) || now - p.updatedAt < KEEP_DONE_MS));
    try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(plans)); } catch { /* quota */ }
    snapshot = plans;
    listeners.forEach(l => l());
    bus.publish();
}

const planId = (env: string, account: AccountRef, orderId: string) => `${env}|${accountRefKey(account)}|${orderId}`;

function describeProtection(p: BracketPlan) {
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

function arm(p: BracketPlan, edited = false, keepTrail?: TrailState) {
    const qty = protectionQuantity(p);
    if (p.dismissed || qty <= 0 || p.env !== currentProtectionEnv()) return;
    armBracketGroup({
        restore: restoring,
        edited,
        group: p.group, bracketId: p.id, env: p.env, account: p.account, code: p.quoteCode,
        orderCode: p.orderCode, entryAction: p.action, octype: p.market === 'futures' ? 'Cover' : undefined,
        orderLot: p.market === 'stock' && p.orderLot === 'IntradayOdd' ? 'IntradayOdd' : undefined,
        stopPrice: p.stopPrice, takePrice: p.takePrice, quantity: qty,
        ...(p.rules?.trail && p.base !== undefined
            ? { trail: keepTrail ?? newTrail(p.base, p.rules.trail.activateTicks, p.rules.trail.distanceTicks, p.rules.trail.stepTicks) } : {}),
    });
}

/** #226: a rules-based plan gets its prices at the first protected fill,
 * from the actual fill price (frozen: later fills never loosen them). */
const contractWaits = new Set<string>();
function withRulePrices(p: BracketPlan): BracketPlan {
    if (!p.rules || allocatedFill(p) <= 0 || p.exit) return p;
    const fillBase = averageFillPrice(p);
    // set once; a basis taken from the order price is replaced by the real fill price
    if (p.base !== undefined && !(p.baseProvisional && fillBase !== null)) return p;
    const now = Date.now();
    const base = fillBase ?? p.refPrice;
    const contract = getCachedContract(p.quoteCode);
    if (!contract && !contractWaits.has(p.id)) {
        // load it and compute again: never left unprotected for lack of metadata
        contractWaits.add(p.id);
        void ensureContract(p.quoteCode).then(() => update(p.id, x => x)).catch(() => undefined).finally(() => contractWaits.delete(p.id));
    }
    if (!base || !contract) {
        return addIssue(p, 'lookup-failed', !base ? '成交回報沒有成交價，無法計算停損停利；請對帳後自行處理' : '商品資料未載入，停損停利尚未建立（載入中）', now);
    }
    const dir = p.action === 'Buy' ? 1 : -1;
    let stopPrice = stepPrice(contract, base, -dir * p.rules.stopTicks);
    const takePrice = p.rules.takeTicks === null ? null : stepPrice(contract, base, dir * p.rules.takeTicks);
    if (p.beArmed && p.rules.breakeven) {
        const be = stepPrice(contract, base, dir * p.rules.breakeven.offsetTicks);
        stopPrice = dir > 0 ? Math.max(stopPrice, be) : Math.min(stopPrice, be);
    }
    if (!(stopPrice > 0) || (takePrice !== null && !(takePrice > 0))) {
        return addIssue(p, 'lookup-failed', `依成交價 ${base} 算出的停損 ${stopPrice}${takePrice !== null ? `／停利 ${takePrice}` : ''} 無效，沒有掛保護；請自行處理`, now);
    }
    return { ...p, base, baseProvisional: fillBase === null, stopPrice, takePrice, updatedAt: now,
        edits: [...(p.edits ?? []), { at: now, text: `${fillBase === null ? '委託價' : '成交價'} ${base} → 停損 ${stopPrice}${takePrice !== null ? `、停利 ${takePrice}` : ''}` }] };
}

/** #226 保本: once tier `afterTier` took its profit, the other tiers' stops
 * move to their cost + N ticks (only in the position's favour). */
function applyBreakeven(done: BracketPlan) {
    const rule = done.rules?.breakeven;
    if (!rule || !done.tier || done.tier.index !== rule.afterTier - 1) return;
    const contract = getCachedContract(done.quoteCode);
    if (!contract) return;
    const dir = done.action === 'Buy' ? 1 : -1;
    for (const sib of plans.slice()) {
        if (sib.id === done.id || sib.orderId !== done.orderId || sib.env !== done.env || !sib.tier || sib.exit || sib.dismissed) continue;
        if (accountRefKey(sib.account) !== accountRefKey(done.account)) continue;
        // not priced yet: 保本 applies as soon as it is
        if (sib.base === undefined) { update(sib.id, x => ({ ...x, beArmed: true })); continue; }
        const target = stepPrice(contract, sib.base, dir * rule.offsetTicks);
        if (sib.stopPrice !== null && (dir > 0 ? target <= sib.stopPrice : target >= sib.stopPrice)) continue;
        if (!tightenBracketStop(sib.env, sib.group, target, '保本')) continue;
        update(sib.id, x => ({ ...x, stopPrice: target, updatedAt: Date.now(),
            edits: [...(x.edits ?? []), { at: Date.now(), text: `第 ${rule.afterTier} 層停利成交，停損移到成本 ${target}` }] }));
    }
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
    const after = withRulePrices(fn(before));
    if (after === before) return;
    plans = plans.map(p => p === before ? after : p);
    if (before.base !== undefined && after.base !== before.base) {
        // the real fill price replaced the order price: re-price the pair
        disarmBracketGroup(before.env, before.group);
        arm(after, true);
    }
    syncProtection(before, after);
    commit();
}

function applyReport(p: BracketPlan, report: OrderEventReport, now: number): BracketPlan {
    if (report.kind === 'order') return applyEntryOrderReport(p, report, now);
    const m = matchDeal(report, p.orderId, p.account, p.market, p.orderCode, p.action);
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
        next = applyReport(next, report, now);
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
    const plan = plans.find(p => p.id === rec.bracketId);
    if (plan && rec.kind === 'take' && rec.status === 'filled') applyBreakeven(plan);
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
        try {
            // Cache-only continuity is proven only by trading-state's
            // authoritative baseline on this sidecar instance (#128).
            const continuous = tradeCacheContinuous();
            const trades = await query.read(account.account_type, account, current => fetchTrades(account.account_type, current, { refresh: false }));
            query.assertCurrent();
            if (currentProtectionEnv() !== env) return;
            restoringDo(restore, () => {
                for (const p of plansFor(account, env)) {
                    if (!continuous) update(p.id, x => addIssue(x, 'no-baseline', '委託快取尚無連續基準（未完成權威查詢或串流曾中斷）；請對帳', now));
                    const trade = trades.find(t => tradeMatchesPlan(t, p));
                    if (trade) update(p.id, x => applyEntryTrade(x, trade, now));
                    else update(p.id, x => addIssue(x, 'lookup-failed', '伺服器委託快取找不到此進場單（可能伺服器重啟）；請對帳', now));
                }
            });
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
        const trades = await query.read(plan.account.account_type, plan.account, current => fetchTrades(plan.account.account_type, current, { refresh: true }));
        query.assertCurrent();
        const now = Date.now();
        for (const p of plansFor(plan.account, env)) {
            const trade = trades.find(t => tradeMatchesPlan(t, p));
            if (trade) update(p.id, x => {
                const next = applyEntryTrade(x, trade, now);
                return next.entryClosed && next.entryCancel ? { ...next, entryCancel: undefined } : next;
            });
            const exitTrade = p.exit?.orderId ? trades.find(t => t.order.id === p.exit?.orderId) : undefined;
            if (exitTrade) applyExitTrade(exitTrade);
        }
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
                if (trades.some(t => tradeMatchesPlan(t, p))) {
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
    const id = planId(spec.env, spec.account, spec.orderId) + (spec.tier ? `#t${spec.tier.index}` : '');
    const existing = plans.find(p => p.id === id);
    if (existing) return existing; // idempotent
    const now = Date.now();
    let plan: BracketPlan = {
        ...spec, id, market: spec.account.account_type === 'S' ? 'stock' : 'futures',
        group: `bracket:${spec.orderId}:${now.toString(36)}${spec.tier ? `:t${spec.tier.index}` : ''}`, fills: {}, filled: 0,
        entryClosed: false, exit: null, issues: [], createdAt: now, updatedAt: now,
    };
    if (getStreamStatus() !== 'live') plan = addIssue(plan, 'disconnect', '登記時行情／回報串流未連線', now);
    // Reports that reached this window before the registration command.
    for (const report of recentReportsFor(envBase(spec.env), spec.orderId)) plan = applyReport(plan, report, now);
    plan = withRulePrices(plan);
    plans = [...plans, plan];
    notify({ kind: 'info', title: '括號單待命',
        body: `${plan.quoteCode} 成交後依成交量自動掛${plan.rules ? `停損停利（依成交價計算${plan.tier ? `，第 ${plan.tier.index + 1}/${plan.tier.count} 層` : ''}）` : describeProtection(plan)}` });
    syncProtection(undefined, plan);
    commit();
    void lookup(plan.account, plan.env);
    return plan;
}

function handle(cmd: Command): unknown {
    switch (cmd.op) {
        case 'ping': return true;
        case 'register': return register(cmd.spec);
        case 'reconcile': return reconcile(cmd.id);
        case 'dismiss': {
            const p = plans.find(x => x.id === cmd.id);
            if (!p) { dropBracketTriggers(cmd.id); return true; } // orphaned protection
            disarmBracketGroup(p.env, p.group);
            update(p.id, x => ({ ...x, dismissed: true, updatedAt: Date.now() }));
            return true;
        }
        case 'cancel-entry': return cancelEntry(cmd.id);
        case 'modify': return modifyPlan(cmd.id, cmd.stopPrice, cmd.takePrice);
        case 'ack-exit': {
            const exitId = exitIds.get(cmd.id) ?? getExits().find(e => e.bracketId === cmd.id)?.id;
            if (!exitId) throw new Error('找不到此括號單的出場紀錄');
            return acknowledgeExit(exitId);
        }
    }
    throw new Error('未知指令');
}

/** #226: change a bracket's stop / take. The armed pair is replaced at once
 * (no tick in between); a leg already crossed at the new price waits for the
 * user (待確認) instead of firing. Not while an exit is out. */
function modifyPlan(id: string, stopPrice: number | null, takePrice: number | null): BracketPlan {
    const p = plans.find(x => x.id === id);
    if (!p) throw new Error('找不到此括號單');
    if (!isLive(p) || p.exit) throw new Error('括號單已出場或結束，不能修改');
    if (p.env !== currentProtectionEnv()) throw new Error('此括號單屬於其他伺服器或模式，請切回原環境後修改');
    if (stopPrice === null && takePrice === null) throw new Error('括號單需要停損價或停利價');
    for (const v of [stopPrice, takePrice]) if (v !== null && (!Number.isFinite(v) || v <= 0)) throw new Error('停損／停利價必須是正數');
    const long = p.action === 'Buy';
    if (stopPrice !== null && takePrice !== null && (long ? stopPrice >= takePrice : stopPrice <= takePrice)) {
        throw new Error(`${long ? '買進' : '賣出'}的停損價必須${long ? '低於' : '高於'}停利價`);
    }
    // the armed stop may have moved (移動停損／保本) since the plan was made
    const stopLeg = getTriggers().find(t => t.group === p.group && t.env === p.env && t.kind === 'stop');
    const curStop = stopLeg?.price ?? p.stopPrice;
    if (p.rules?.trail && curStop !== null && (stopPrice === null || (long ? stopPrice < curStop : stopPrice > curStop))) {
        throw new Error(`移動停損中，停損只能收緊（目前 ${curStop}）`);
    }
    if (stopPrice === curStop && takePrice === p.takePrice) return p;
    const at = Date.now();
    const changes = [
        stopPrice !== curStop ? `停損 ${curStop ?? '無'} → ${stopPrice ?? '無'}` : null,
        takePrice !== p.takePrice ? `停利 ${p.takePrice ?? '無'} → ${takePrice ?? '無'}` : null,
    ].filter(Boolean).join('、');
    const next: BracketPlan = { ...p, stopPrice, takePrice, updatedAt: at,
        edits: [...(p.edits ?? []), { at, text: `修改${changes}` }].slice(-20) };
    plans = plans.map(x => x.id === id ? next : x);
    disarmBracketGroup(p.env, p.group);
    arm(next, true, stopLeg?.trail);
    commit();
    return next;
}

/** #226: a 觸價 entry with protection fired and its order was accepted
 * (main window): register its tiers here, at once. */
function registerTriggeredEntry(t: TriggerOrder, trade: Trade) {
    if (!t.bracketPlan || !t.env || !t.account || !t.orderCode) return;
    const securityType = t.account.account_type === 'F' ? (getCachedContract(t.code)?.security_type === 'OPT' ? 'OPT' : 'FUT') : 'STK';
    const specs = tierSpecs({ env: t.env, account: t.account, orderId: trade.order.id, seqno: trade.order.seqno, quoteCode: t.code,
        orderCode: trade.contract?.target_code || trade.contract?.code || t.orderCode, securityType, exchange: trade.contract?.exchange ?? '',
        action: t.action, refPrice: t.price }, t.bracketPlan);
    for (const spec of specs) register(spec);
}

// ---- public API (any window) ----

/** Confirms the main window can track brackets BEFORE an entry is sent. */
export async function ensureBracketHost(): Promise<void> {
    await bus.send({ op: 'ping' });
}

/** Registration may apply late (the main window can be busy); a short ACK
 * timeout would invite a second, manual exit. Same budget as reconcile. */
export const REGISTER_TIMEOUT_MS = 60_000;
export async function registerBracket(spec: BracketSpec): Promise<BracketPlan> {
    return await bus.send({ op: 'register', spec }, REGISTER_TIMEOUT_MS) as BracketPlan;
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
    // update_status can take a while; a short ACK timeout would misreport it.
    return bus.send({ op: 'reconcile', id }, 60_000) as Promise<{ health: TradeCacheHealth['state'] }>;
}

export function dismissBracket(id: string) {
    return bus.send({ op: 'dismiss', id });
}

export function modifyBracket(id: string, stopPrice: number | null, takePrice: number | null) {
    return bus.send({ op: 'modify', id, stopPrice, takePrice });
}

export function acknowledgeBracketExit(id: string) {
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
        const trade = await cancelOrder(plan.orderId);
        const confirmed = trade?.order?.id === plan.orderId && trade.status?.status === 'Cancelled';
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

export function useBrackets(): BracketPlan[] {
    return useSyncExternalStore(subscribe, () => snapshot);
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
    onEntryPlaced(registerTriggeredEntry);
    reportLedger.onGap(base => onGap(base));
    onExitUpdate(onExit);
    for (const rec of getExits()) if (rec.bracketId) onExit(rec);
    // Once the server mode is known: replay buffered reports and look up.
    let knownEnv = currentProtectionEnv();
    onProtectionEnvChange(() => {
        const env = currentProtectionEnv();
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
                for (const report of recentReportsFor(envBase(env), p.orderId)) next = applyReport(next, report, at);
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
