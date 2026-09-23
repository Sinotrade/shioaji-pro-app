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
import { subscribeTradeEvents } from './shioaji';
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
    type AccountRef,
    type BracketPlan,
} from './bracket-core';
import { fetchCachedTrades, fetchReconciledTrades, fetchTradeCacheHealth, type TradeCacheHealth } from './bracket-api';
import { streamMarket, type EventVerdict } from './bracket-event-ledger';
import { onTrackedReport, recentReportsFor } from './bracket-reports';
import { claimExecutor, createCommandBus, isMainWindow } from './main-window-commands';
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
    getExits,
    onExitUpdate,
    type ExitRecord,
} from './trigger-engine';
import type { Action, FuturesOCType, StockOrderCond, StockOrderLot } from './types/order';

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
    quantity: number;
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
    } else if ((r.orderLot ?? 'Common') !== 'Common' || (r.orderCond ?? 'Cash') !== 'Cash') {
        return '股票括號單僅支援現股整張；零股、融資券與借券條件請手動設定出場';
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
const KEEP_DONE_MS = 24 * 3600 * 1000;
const main = isMainWindow();

function loadPlans(): BracketPlan[] {
    try {
        const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
        const arr: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? (arr as BracketPlan[]).filter(p => p && typeof p.id === 'string' && p.account) : [];
    } catch {
        return [];
    }
}

let plans: BracketPlan[] = main ? loadPlans() : [];
let snapshot: BracketPlan[] = plans;
const listeners = new Set<() => void>();
const exitIds = new Map<string, string>(); // plan id → exit record id

type Command =
    | { op: 'ping' }
    | { op: 'register'; spec: BracketSpec }
    | { op: 'reconcile'; id: string }
    | { op: 'dismiss'; id: string }
    | { op: 'ack-exit'; id: string };

const bus = createCommandBus<Command, BracketPlan[]>({
    channel: typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`sj-brackets:${getApiBase()}`) : null,
    main,
    handle: cmd => handle(cmd),
    snapshot: () => snapshot,
    onState: state => {
        if (!Array.isArray(state)) return;
        snapshot = state;
        listeners.forEach(l => l());
    },
});

function commit() {
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

function arm(p: BracketPlan) {
    const qty = protectionQuantity(p);
    if (p.dismissed || qty <= 0 || p.env !== currentProtectionEnv()) return;
    armBracketGroup({
        group: p.group, bracketId: p.id, env: p.env, account: p.account, code: p.quoteCode,
        orderCode: p.orderCode, entryAction: p.action, octype: p.market === 'futures' ? 'Cover' : undefined,
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
            body: `${p.quoteCode} ${unprotectedQuantity(p)} 未受保護（出場已觸發或未完成）；請手動處理，系統不會自動重送` });
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

function applyReport(p: BracketPlan, report: OrderEventReport, now: number): BracketPlan {
    if (report.kind === 'order') return applyEntryOrderReport(p, report, now);
    const m = matchDeal(report, p.orderId, p.account, p.market, p.orderCode, p.action);
    if (m.kind === 'fill') return applyEntryFill(p, m.fill, now);
    if (m.kind === 'mismatch') return addIssue(p, 'report-mismatch', m.detail, now);
    return p;
}

function onReport(report: OrderEventReport, verdict: EventVerdict, base: string) {
    const now = Date.now();
    for (const p of plans.slice()) {
        if (!isLive(p) || !reportEnvMatches(p.env, base)) continue;
        let next = p;
        if (verdict.kind === 'new' && verdict.gap && streamMarket(verdict.gap.stream) === p.market) {
            next = addIssue(next, 'gap', `回報序號跳號（預期 ${verdict.gap.expected}，收到 ${verdict.gap.received}），可能漏回報`, now);
        }
        if (verdict.kind === 'untrackable' && report.market === p.market) {
            next = addIssue(next, 'untrackable', '收到沒有可追蹤事件 ID 的回報，無法確認是否漏回報', now);
        }
        next = applyReport(next, report, now);
        if (next !== p) update(p.id, () => next);
    }
}

function onExit(rec: ExitRecord) {
    if (!rec.bracketId) return;
    exitIds.set(rec.bracketId, rec.id);
    update(rec.bracketId, p => ({ ...p, exit: {
        status: rec.status, kind: rec.kind, quantity: rec.quantity, filled: rec.filled, fills: rec.fills,
        orderId: rec.orderId, acknowledged: rec.acknowledged,
        detail: rec.acknowledged ? `${rec.detail ?? ''}（使用者已確認處理）` : rec.detail, at: rec.at,
    }, updatedAt: Date.now() }));
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

async function checkHealth(account: AccountRef, env: string) {
    let health = await fetchTradeCacheHealth(account);
    if (health.reasons.some(r => r.reason === 'NotSubscribed')) {
        // Reports are required for protection in both simulation and production.
        try { await subscribeTradeEvents(account); health = await fetchTradeCacheHealth(account); } catch { /* keep first result */ }
    }
    if (currentProtectionEnv() === env) applyHealth(account, env, health, Date.now());
    return health;
}

/** One-shot cache-only lookup + health for an account's live plans. */
function lookup(account: AccountRef, env: string): Promise<void> {
    const key = `lookup|${env}|${accountRefKey(account)}`;
    const running = inflight.get(key);
    if (running) return running;
    const task = (async () => {
        const now = Date.now();
        try {
            const trades = await fetchCachedTrades(account);
            if (currentProtectionEnv() !== env) return;
            for (const p of plansFor(account, env)) {
                const trade = trades.find(t => tradeMatchesPlan(t, p));
                if (trade) update(p.id, x => applyEntryTrade(x, trade, now));
                else update(p.id, x => addIssue(x, 'lookup-failed', '伺服器委託快取找不到此進場單（可能伺服器重啟）；請對帳', now));
            }
        } catch (e) {
            for (const p of plansFor(account, env)) {
                update(p.id, x => addIssue(x, 'lookup-failed', `委託快取查詢失敗：${e instanceof Error ? e.message : String(e)}`, now));
            }
        }
        try { await checkHealth(account, env); } catch (e) {
            for (const p of plansFor(account, env)) {
                update(p.id, x => addIssue(x, 'lookup-failed', `回報健康狀態查詢失敗：${e instanceof Error ? e.message : String(e)}`, now));
            }
        }
    })().finally(() => inflight.delete(key));
    inflight.set(key, task);
    return task;
}

function lookupLiveAccounts() {
    const env = currentProtectionEnv();
    if (!env) return;
    const seen = new Map<string, AccountRef>();
    for (const p of plans) if (p.env === env && isLive(p)) seen.set(accountRefKey(p.account), p.account);
    for (const account of seen.values()) void lookup(account, env);
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
        const trades = await fetchReconciledTrades(plan.account);
        const now = Date.now();
        for (const p of plansFor(plan.account, env)) {
            const trade = trades.find(t => tradeMatchesPlan(t, p));
            if (trade) update(p.id, x => applyEntryTrade(x, trade, now));
            const exitTrade = p.exit?.orderId ? trades.find(t => t.order.id === p.exit?.orderId) : undefined;
            if (exitTrade) applyExitTrade(exitTrade);
        }
        const health = await checkHealth(plan.account, env);
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
    const id = planId(spec.env, spec.account, spec.orderId);
    const existing = plans.find(p => p.id === id);
    if (existing) return existing; // idempotent
    const now = Date.now();
    let plan: BracketPlan = {
        ...spec, id, market: spec.account.account_type === 'S' ? 'stock' : 'futures',
        group: `bracket:${spec.orderId}:${now.toString(36)}`, fills: {}, filled: 0,
        entryClosed: false, exit: null, issues: [], createdAt: now, updatedAt: now,
    };
    if (getStreamStatus() !== 'live') plan = addIssue(plan, 'disconnect', '登記時行情／回報串流未連線', now);
    // Reports that reached this window before the registration command.
    for (const report of recentReportsFor(envBase(spec.env), spec.orderId)) plan = applyReport(plan, report, now);
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
        case 'ping': return true;
        case 'register': return register(cmd.spec);
        case 'reconcile': return reconcile(cmd.id);
        case 'dismiss': {
            const p = plans.find(x => x.id === cmd.id);
            if (!p) return true;
            disarmBracketGroup(p.env, p.group);
            update(p.id, x => ({ ...x, dismissed: true, updatedAt: Date.now() }));
            return true;
        }
        case 'ack-exit': {
            const exitId = exitIds.get(cmd.id) ?? getExits().find(e => e.bracketId === cmd.id)?.id;
            if (!exitId) throw new Error('找不到此括號單的出場紀錄');
            return acknowledgeExit(exitId);
        }
    }
    throw new Error('未知指令');
}

// ---- public API (any window) ----

/** Confirms the main window can track brackets BEFORE an entry is sent. */
export async function ensureBracketHost(): Promise<void> {
    await bus.send({ op: 'ping' });
}

export async function registerBracket(spec: BracketSpec): Promise<BracketPlan> {
    return await bus.send({ op: 'register', spec }) as BracketPlan;
}

export function reconcileBracket(id: string) {
    // update_status can take a while; a short ACK timeout would misreport it.
    return bus.send({ op: 'reconcile', id }, 60_000) as Promise<{ health: TradeCacheHealth['state'] }>;
}

export function dismissBracket(id: string) {
    return bus.send({ op: 'dismiss', id });
}

export function acknowledgeBracketExit(id: string) {
    return bus.send({ op: 'ack-exit', id });
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
    void claimExecutor('sj-protection-executor').then(ok => { if (ok) run(); });
}

function run() {
    const base = getApiBase();
    const now = Date.now();
    let reloaded = false;
    plans = plans.map(p => {
        if (envBase(p.env) !== base || !isLive(p)) return p;
        reloaded = true;
        return addIssue(p, 'reload', 'App 重新載入，期間的回報可能未收到', now);
    });
    if (reloaded) commit();
    onTrackedReport(onReport);
    onExitUpdate(onExit);
    for (const rec of getExits()) if (rec.bracketId) onExit(rec);
    // Once the server mode is known: replay buffered reports and look up.
    let knownEnv = currentProtectionEnv();
    onProtectionEnvChange(() => {
        const env = currentProtectionEnv();
        if (env === knownEnv) return;
        knownEnv = env;
        if (!env) return;
        for (const p of plans.slice()) {
            if (p.env !== env || !isLive(p)) continue;
            const at = Date.now();
            let next = p;
            for (const report of recentReportsFor(envBase(env), p.orderId)) next = applyReport(next, report, at);
            if (next !== p) update(p.id, () => next);
            else arm(p); // re-arm (idempotent) once the mode is known
        }
        lookupLiveAccounts();
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
            lookupLiveAccounts(); // cache-only; issues stay until explicit reconcile
        }
    });
    void refreshProtectionEnv();
    if (wasLive) lookupLiveAccounts();
}
