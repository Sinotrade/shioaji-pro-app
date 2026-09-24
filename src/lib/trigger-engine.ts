// src/lib/trigger-engine.ts — client-side stop-loss / take-profit triggers.
//
// Execution model (#102):
// - ONLY the main window evaluates ticks and sends orders. Popouts, flash
//   tiles and the tray mirror a read-only snapshot and send add/remove
//   commands to the main window through an ACKed, id-deduplicated bus.
// - Stop/take triggers carry a FIXED environment (API base + server mode),
//   account and
//   tradable code captured at creation. A trigger without them (older
//   persisted data) is suspended rather than routed to whatever account is
//   selected when it fires.
// - OCO groups are atomic: the first trigger of a group that fires removes
//   its siblings synchronously and records the group as processed (also
//   persisted), so a sibling crossing on the same tick — or after a reload —
//   is never sent.
// - Exits reserve quantity per environment/account/product/side until their
//   reports show them filled or ended; bracket exits are capped by the known
//   position minus that reservation. Unknown outcomes keep their reservation
//   until the user acknowledges them and are never resent.
// - 試撮 (simtrade) ticks never fire a trigger.
// - Restore confirmation (#144): when the executor (re)starts — app launch,
//   main-window reload, executor handover — or protection returns to a
//   trigger's environment, or the stream reconnects after an outage longer
//   than 60 s, the FIRST tick decides. An order-sending trigger
//   already past its price then (it crossed while nobody was watching) is
//   held as 待確認 instead of sent; the user sends, cancels or keeps it. A
//   kept trigger fires only after price is seen on the non-trigger side and
//   crosses again. A shorter reconnect keeps normal firing, and price alerts
//   (notify only) are never held.

import { useSyncExternalStore } from 'react';
import { getAccountState } from './account-store';
import {
    accountRefKey,
    applyExitFill,
    applyExitOrderReport,
    fillsFromTrade,
    matchDeal,
    type AccountRef,
    type BracketExit,
} from './bracket-core';
import { onTrackedReport, recentReportsFor } from './bracket-reports';
import { getPrivacyMode, maskAccountId } from './privacy';
import { ensureContract } from './contracts-cache';
import { claimExecutor, createCommandBus, isExecutor, isMainWindow } from './main-window-commands';
import type { OrderEventReport } from './order-report';
import {
    currentProtectionEnv,
    envBase,
    onProtectionEnvChange,
    refreshProtectionEnv,
    reportEnvMatches,
    watchProtectionEnv,
} from './protection-env';
import { retainQuote } from './quote-ownership';
import { getApiBase } from './runtime';
import { fetchTrades } from './shioaji';
import { getStreamStatus, onAnyTick, subscribeStatusStore } from './stream';
import { notify, placeQuickOrder } from './trade';
import { getTradingState } from './trading-state';
import type { ContractBase } from './types/contract';
import type { Action, FuturesOCType, Trade } from './types/order';

export interface TriggerOrder {
    id: string;
    code: string; // quote-stream code (matches quote-store code)
    condition: 'below' | 'above'; // fire when last <= / >= price
    price: number;
    action: Action;
    quantity: number;
    kind: 'stop' | 'take' | 'alert';
    group?: string; // OCO group — when one fires, siblings are cancelled
    // execution context, fixed at creation (required for stop/take)
    env?: string;
    account?: AccountRef;
    orderCode?: string; // tradable code (target_code || code)
    octype?: FuturesOCType; // futures exits from brackets use Cover
    bracketId?: string;
    suspended?: string; // reason this trigger will not execute
    createdAt?: number;
    requestId?: string; // sender-generated; a re-applied add returns the same trigger
    pending?: { price: number; at: number }; // 待確認: already past when protection resumed (#144)
    awaitingRecross?: boolean; // kept after 待確認: arms once price is seen on the non-trigger side
}

export interface ExitRecord extends BracketExit {
    id: string;
    triggerId: string;
    bracketId?: string;
    env: string;
    account: AccountRef;
    market: 'stock' | 'futures';
    orderCode: string;
    action: Action; // exit direction
    reserveKey: string;
    requested: number;
    acknowledged?: boolean;
}

export type NewTrigger = Omit<TriggerOrder, 'id'>;

const STORAGE_KEY = 'sj-pro-triggers';
const GROUPS_KEY = 'sj-pro-trigger-groups';
const EXITS_KEY = 'sj-pro-trigger-exits';
const GROUP_TTL_MS = 3 * 24 * 3600 * 1000;
export const LEGACY_SUSPENDED = '舊版觸價單未綁定帳戶／伺服器，不會自動送單；請刪除後重新設定';

function readJson<T>(key: string, fallback: T): T {
    try {
        const raw = globalThis.localStorage?.getItem(key);
        return raw ? JSON.parse(raw) as T : fallback;
    } catch {
        return fallback;
    }
}

function writeJson(key: string, value: unknown) {
    try { globalThis.localStorage?.setItem(key, JSON.stringify(value)); } catch { /* quota/private mode */ }
}

function hasContext(t: TriggerOrder): boolean {
    return t.kind === 'alert' || (!!t.env && !!t.orderCode && !!t.account?.broker_id && !!t.account?.account_id
        && (t.account.account_type === 'S' || t.account.account_type === 'F'));
}

function loadTriggers(): TriggerOrder[] {
    const arr = readJson<unknown>(STORAGE_KEY, []);
    if (!Array.isArray(arr)) return [];
    return (arr as TriggerOrder[]).filter(t => t && typeof t.id === 'string' && typeof t.code === 'string')
        .map(t => hasContext(t) || t.suspended ? t : { ...t, suspended: LEGACY_SUSPENDED });
}

const main = isMainWindow();
// Shared persisted state is loaded (and written) ONLY by the executing
// window; every other window/tab is a mirror of its snapshot.
let triggers: TriggerOrder[] = [];
let processedGroups: Record<string, number> = {};
let exits: ExitRecord[] = [];
function loadExecutorState() {
    triggers = loadTriggers();
    processedGroups = readJson<Record<string, number>>(GROUPS_KEY, {});
    // An exit still `sending` when the app went away has an unknown outcome.
    exits = readJson<ExitRecord[]>(EXITS_KEY, []).filter(e => e && typeof e.id === 'string')
        .map(e => e.status === 'sending' ? { ...e, status: 'unknown' as const, detail: '送單期間 App 重新載入，結果未知' } : e);
}
const listeners = new Set<() => void>();
const exitListeners = new Set<(exit: ExitRecord) => void>();

interface Snapshot {
    triggers: TriggerOrder[];
    exits: ExitRecord[];
    feedMissing: string[];
    executing: boolean;
    prices?: Record<string, number>; // latest tick of codes with a 待確認 trigger
}
let executing = false; // this window holds the executor lock
const feedMissing = new Set<string>(); // trigger codes without a tick subscription
let snapshot: Snapshot = { triggers, exits, feedMissing: [], executing: false, prices: {} };
// Executor only: triggers whose first tick after a (re)start decides between
// normal operation and 待確認; codes ticked since that (re)start (bracket
// exits armed before their code's first tick are restore-checked too); and
// the latest tick per code since the stream / environment last changed.
const restoreCheck = new Set<string>();
const tickedSinceRestore = new Set<string>();
const lastPrices = new Map<string, number>();

export type PendingChoice = 'send' | 'cancel' | 'keep';

type Command =
    | { op: 'add'; trigger: NewTrigger }
    | { op: 'remove'; id: string }
    | { op: 'ack-exit'; id: string }
    | { op: 'resolve-pending'; id: string; choice: PendingChoice }
    | { op: 'publish-prices' };

let decideRole!: () => void;
const roleDecided = new Promise<void>(resolve => { decideRole = resolve; });
if (!main) decideRole();

const bus = createCommandBus<Command, Snapshot>({
    channel: typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`sj-triggers:${getApiBase()}`) : null,
    main: () => executing,
    ready: roleDecided,
    handle: cmd => handleCommand(cmd),
    snapshot: () => snapshot,
    onState: state => {
        if (!state || !Array.isArray(state.triggers) || !Array.isArray(state.exits)) return;
        snapshot = state;
        listeners.forEach(l => l());
    },
});

const isResolved = (e: ExitRecord) => e.status === 'filled' || e.status === 'incomplete'
    || e.status === 'not-sent' || (e.status === 'unknown' && !!e.acknowledged);
/** Late fills keep applying to an ended ('incomplete') exit. */
const acceptsFills = (e: ExitRecord) => !!e.orderId && e.status !== 'filled' && e.status !== 'not-sent';

function commit() {
    if (!executing) return; // mirrors never write shared state
    const now = Date.now();
    for (const [key, at] of Object.entries(processedGroups)) {
        if (now - at > GROUP_TTL_MS) delete processedGroups[key];
    }
    // resolved exits only stay for display; unresolved ones hold reservations
    const resolved = exits.filter(e => isResolved(e) && now - e.at < GROUP_TTL_MS).slice(-200);
    exits = exits.filter(e => !isResolved(e) || resolved.includes(e));
    writeJson(STORAGE_KEY, triggers);
    writeJson(GROUPS_KEY, processedGroups);
    writeJson(EXITS_KEY, exits);
    snapshot = { triggers, exits, feedMissing: [...feedMissing], executing, prices: pendingPrices() };
    syncQuotes();
    listeners.forEach(l => l());
    bus.publish();
}

const groupKey = (env: string | undefined, group: string) => `${env ?? ''}|${group}`;

function newId() {
    return `tg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function kindLabel(t: Pick<TriggerOrder, 'kind'>) {
    return t.kind === 'stop' ? '停損單已掛' : t.kind === 'take' ? '停利單已掛' : '警示已設';
}

function describe(t: TriggerOrder) {
    return t.kind === 'alert'
        ? `${t.code} 觸價 ${t.condition === 'below' ? '≤' : '≥'} ${t.price} 時通知`
        : `${t.code} 觸價 ${t.condition === 'below' ? '≤' : '≥'} ${t.price} → 市價${t.action === 'Buy' ? '買' : '賣'} ${t.quantity}${t.group ? '（OCO）' : ''}`;
}

function handleCommand(cmd: Command): unknown {
    if (cmd.op === 'add') {
        const again = cmd.trigger.requestId && triggers.find(x => x.requestId === cmd.trigger.requestId);
        if (again) return again; // resent after a main-window reload
        const t: TriggerOrder = { ...cmd.trigger, id: newId(), createdAt: Date.now() };
        delete t.suspended;
        delete t.pending;
        delete t.awaitingRecross;
        if (!hasContext(t)) throw new Error('觸價單缺少帳戶或伺服器資訊，未建立');
        if (t.bracketId) throw new Error('括號單保護只由主視窗建立');
        if (t.group && processedGroups[groupKey(t.env, t.group)]) throw new Error('此 OCO 群組已觸發過，不再建立');
        triggers = [...triggers, t];
        commit();
        notify({ kind: 'info', title: kindLabel(t), body: describe(t) });
        return t;
    }
    if (cmd.op === 'remove') {
        // A bracket's OCO pair belongs to its plan: removing one side here
        // would leave the plan believing it is protected (and could re-arm).
        if (triggers.some(t => t.id === cmd.id && t.bracketId)) throw new Error('括號單保護請在下單面板的括號單狀態中移除追蹤');
        triggers = triggers.filter(t => t.id !== cmd.id);
        commit();
        return true;
    }
    if (cmd.op === 'ack-exit') {
        exits = exits.map(e => e.id === cmd.id && e.status === 'unknown' ? { ...e, acknowledged: true, at: Date.now() } : e);
        const rec = exits.find(e => e.id === cmd.id);
        commit();
        if (rec) emitExit(rec);
        return true;
    }
    if (cmd.op === 'resolve-pending') return resolvePending(cmd.id, cmd.choice);
    if (cmd.op === 'publish-prices') { publishPrices(); return true; }
    throw new Error('未知指令');
}

/** Capture the fixed execution context for a manual stop/take trigger. */
function withContext(t: NewTrigger, contract?: ContractBase): NewTrigger | string {
    if (t.kind === 'alert' || (t.env && t.account && t.orderCode)) return t;
    if (!contract) return '缺少商品資訊，無法固定下單帳戶';
    const futures = contract.security_type === 'FUT' || contract.security_type === 'OPT';
    if (!futures && contract.security_type !== 'STK') return '此商品不支援觸價下單';
    const s = getAccountState();
    const selected = futures ? s.selectedFutures : s.selectedStock;
    if (!selected?.signed || selected.account_type !== (futures ? 'F' : 'S')) return '沒有可用的已簽署帳戶，觸價單未建立';
    const env = currentProtectionEnv();
    if (!env) return '伺服器模式（模擬／正式）尚未確認，觸價單未建立';
    return { ...t, env,
        account: { account_type: futures ? 'F' : 'S', broker_id: selected.broker_id, account_id: selected.account_id },
        orderCode: contract.target_code || contract.code };
}

/** Add a trigger from any window. Stop/take bind the currently selected
 * account for the contract's market; the main window executes it. */
export async function addTrigger(t: NewTrigger, contract?: ContractBase): Promise<TriggerOrder | null> {
    const prepared = withContext(t, contract);
    if (typeof prepared === 'string') {
        notify({ kind: 'err', title: '觸價單未建立', body: prepared });
        return null;
    }
    const requestId = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : newId();
    try {
        return await bus.send({ op: 'add', trigger: { ...prepared, requestId } }) as TriggerOrder;
    } catch (e) {
        notify({ kind: 'err', title: '觸價單未確認', body: e instanceof Error ? e.message : String(e) });
        return null;
    }
}

export async function removeTrigger(id: string): Promise<void> {
    try {
        await bus.send({ op: 'remove', id });
    } catch (e) {
        notify({ kind: 'err', title: '觸價單移除未確認', body: e instanceof Error ? e.message : String(e) });
    }
}

/** User confirms an unknown-outcome exit was reconciled by hand; releases
 * its reservation. Never resends anything. */
export function acknowledgeExit(id: string): Promise<unknown> {
    return bus.send({ op: 'ack-exit', id });
}

/** Decide a 待確認 trigger (#144). `send` fires it once as configured after
 * re-checking stream, environment, account and that a tick arrived since the
 * last (re)connect. `cancel` removes it (bracket protection is removed from
 * its bracket status instead). `keep` re-arms it for a fresh crossing only. */
export function resolvePendingTrigger(id: string, choice: PendingChoice): Promise<unknown> {
    return bus.send({ op: 'resolve-pending', id, choice });
}

/** Ask the executor to publish the latest prices of 待確認 codes now. */
export function requestPendingPrices(): Promise<unknown> {
    return bus.send({ op: 'publish-prices' });
}

export function getTriggers(): TriggerOrder[] {
    return snapshot.triggers;
}

export function getExits(): ExitRecord[] {
    return snapshot.exits;
}

function subscribe(l: () => void) {
    listeners.add(l);
    return () => { listeners.delete(l); };
}

export function useTriggers(): TriggerOrder[] {
    return useSyncExternalStore(subscribe, () => snapshot.triggers);
}

const NO_PRICES: Record<string, number> = {};
/** Latest tick price of every code that has a 待確認 trigger. */
export function usePendingPrices(): Record<string, number> {
    return useSyncExternalStore(subscribe, () => snapshot.prices ?? NO_PRICES);
}

export function useTriggerExits(): ExitRecord[] {
    return useSyncExternalStore(subscribe, () => snapshot.exits);
}

export function onExitUpdate(listener: (exit: ExitRecord) => void): () => void {
    exitListeners.add(listener);
    return () => { exitListeners.delete(listener); };
}

function emitExit(rec: ExitRecord) {
    for (const l of exitListeners) {
        try { l(rec); } catch { /* display consumer */ }
    }
}

// ---- main-window-only API used by the bracket runtime ----

export function isGroupProcessed(env: string, group: string): boolean {
    return !!processedGroups[groupKey(env, group)];
}

export interface BracketArm {
    group: string;
    bracketId: string;
    env: string;
    account: AccountRef;
    code: string;
    orderCode: string;
    entryAction: Action;
    octype?: FuturesOCType;
    stopPrice: number | null;
    takePrice: number | null;
    quantity: number;
    restore?: boolean; // armed from fills recovered after a (re)start
}

/** Create or resize the OCO pair of a bracket. Returns false when the group
 * already fired (no re-arm) or when called outside the main window. */
export function armBracketGroup(arm: BracketArm): boolean {
    if (!main || arm.quantity <= 0) return false;
    if (processedGroups[groupKey(arm.env, arm.group)]) return false;
    const existing = triggers.filter(t => t.group === arm.group && t.env === arm.env);
    const exit: Action = arm.entryAction === 'Buy' ? 'Sell' : 'Buy';
    if (existing.length) {
        if (existing.every(t => t.quantity === arm.quantity)) return true;
        triggers = triggers.map(t => existing.includes(t) ? { ...t, quantity: arm.quantity } : t);
        commit();
        return true;
    }
    const base = { code: arm.code, action: exit, quantity: arm.quantity, group: arm.group, env: arm.env,
        account: arm.account, orderCode: arm.orderCode, octype: arm.octype, bracketId: arm.bracketId, createdAt: Date.now() };
    const added: TriggerOrder[] = [];
    if (arm.stopPrice !== null) {
        added.push({ ...base, id: newId(), kind: 'stop', price: arm.stopPrice,
            condition: arm.entryAction === 'Buy' ? 'below' : 'above' });
    }
    if (arm.takePrice !== null) {
        added.push({ ...base, id: newId(), kind: 'take', price: arm.takePrice,
            condition: arm.entryAction === 'Buy' ? 'above' : 'below' });
    }
    if (!added.length) return false;
    // Armed from a fill found after a (re)start (cache lookup, buffered
    // reports) before this code ticked: the first tick decides (#144).
    if (arm.restore || !tickedSinceRestore.has(arm.code)) for (const t of added) restoreCheck.add(t.id);
    triggers = [...triggers, ...added];
    commit();
    return true;
}

/** Remove a bracket's pending triggers without marking the group fired. */
export function disarmBracketGroup(env: string, group: string) {
    if (!main) return;
    const before = triggers.length;
    triggers = triggers.filter(t => !(t.group === group && t.env === env));
    if (triggers.length !== before) commit();
}

// ---- reservation ----

const reserveKeyOf = (env: string, account: AccountRef, orderCode: string, action: Action) =>
    `${env}|${accountRefKey(account)}|${orderCode}|${action}`;

export function reservedQuantity(key: string): number {
    return exits.filter(e => e.reserveKey === key && !isResolved(e))
        .reduce((s, e) => s + Math.max(0, e.quantity - e.filled), 0);
}

/** Known position (in exit order units) that `action` would close, or null
 * when the shared position view is not a confirmed snapshot. */
function closablePosition(account: AccountRef, orderCode: string, action: Action): number | null {
    const state = getTradingState();
    const q = state.queries?.positions;
    if (!q || q.updatedAt === null || q.needsReconcile) return null;
    const direction = action === 'Sell' ? 'Buy' : 'Sell';
    const rows = state.positions.filter(p => p.account && p.account.account_type === account.account_type
        && p.account.broker_id === account.broker_id && p.account.account_id === account.account_id
        && p.code === orderCode && p.direction === direction
        // bracket stock exits are Cash sells: margin/short rows are not closable by them
        && (account.account_type !== 'S' || !('cond' in p) || !p.cond || p.cond === 'Cash'));
    const total = rows.reduce((s, p) => s + p.quantity, 0);
    // stock positions are held in shares; bracket exits are Common lots
    return account.account_type === 'S' ? Math.floor(total / 1000) : total;
}

/** Decide the exit quantity for a firing trigger.
 * - manual triggers keep their own sizing (they may be entries);
 * - futures bracket exits are Cover orders: the broker rejects closing more
 *   than the open position, and a lagging position snapshot must not block
 *   a stop — so they are never reduced here, only annotated;
 * - stock bracket exits are Cash sells that could otherwise open a day-trade
 *   short: capped by the confirmed Cash position minus reserved exits, and
 *   refused while the position is unknown and another exit is unresolved. */
export function planExitQuantity(t: Pick<TriggerOrder, 'quantity' | 'bracketId' | 'account'>, reserved: number,
    closable: number | null): { quantity: number; detail?: string } {
    if (!t.bracketId) return { quantity: t.quantity };
    if (t.account?.account_type === 'F') {
        return closable !== null && closable - reserved < t.quantity
            ? { quantity: t.quantity, detail: `持倉顯示可平倉 ${Math.max(0, closable - reserved)}，仍以平倉（Cover）送出由券商檢核` }
            : { quantity: t.quantity };
    }
    if (closable !== null) {
        const free = Math.max(0, closable - reserved);
        if (free <= 0) return { quantity: 0, detail: '現股持倉已被其他出場委託保留或已無部位，未送出' };
        if (free < t.quantity) return { quantity: free, detail: `可賣出現股僅 ${free} 張，其餘 ${t.quantity - free} 張未保護` };
        return { quantity: t.quantity };
    }
    if (reserved > 0) return { quantity: 0, detail: '持倉未確認且另有出場委託未完成；為避免超賣未送出' };
    return { quantity: t.quantity, detail: '持倉未確認，依保護量送出' };
}

// ---- firing ----

function fire(t: TriggerOrder, lastPrice: number, byUser = false) {
    // Everything up to dispatch is synchronous: no sibling or repeated tick
    // can interleave between the OCO check and the reservation.
    const gk = t.group ? groupKey(t.env, t.group) : null;
    if (gk && processedGroups[gk]) {
        triggers = triggers.filter(x => !(x.group === t.group && x.env === t.env));
        commit();
        return;
    }
    const siblings = t.group ? triggers.filter(x => x.group === t.group && x.env === t.env && x.id !== t.id) : [];
    triggers = triggers.filter(x => x.id !== t.id && !siblings.includes(x));
    if (gk) processedGroups[gk] = Date.now();
    if (t.kind === 'alert') {
        commit();
        notify({ kind: 'info', title: '到價警示',
            body: `${t.code} 現價 ${lastPrice} 已${t.condition === 'below' ? '跌破' : '突破'} ${t.price}` });
        return;
    }
    const account = t.account!;
    const env = t.env!;
    const orderCode = t.orderCode!;
    const reserveKey = reserveKeyOf(env, account, orderCode, t.action);
    const plan = planExitQuantity(t, reservedQuantity(reserveKey), t.bracketId ? closablePosition(account, orderCode, t.action) : null);
    const rec: ExitRecord = {
        id: `ex-${t.id}`, triggerId: t.id, bracketId: t.bracketId, env, account,
        market: account.account_type === 'S' ? 'stock' : 'futures', orderCode, action: t.action,
        reserveKey, requested: t.quantity, kind: t.kind, quantity: plan.quantity,
        status: plan.quantity > 0 ? 'sending' : 'not-sent', filled: 0, fills: {}, detail: plan.detail, at: Date.now(),
    };
    exits = [...exits, rec];
    commit();
    if (siblings.length) {
        notify({ kind: 'info', title: 'OCO 互斥撤銷', body: `${t.code} 另一邊觸價單已自動移除` });
    }
    emitExit(rec);
    if (plan.quantity <= 0) {
        notify({ kind: 'err', title: t.kind === 'stop' ? '停損未送出' : '停利未送出', body: `${t.code} ${plan.detail ?? ''}` });
        return;
    }
    void dispatch(t, rec, lastPrice, byUser);
}

function updateExit(id: string, patch: (e: ExitRecord) => ExitRecord) {
    let changed: ExitRecord | undefined;
    exits = exits.map(e => {
        if (e.id !== id) return e;
        const next = patch(e);
        if (next !== e) changed = next;
        return next;
    });
    if (changed) {
        commit();
        emitExit(changed);
    }
    return changed;
}

async function dispatch(t: TriggerOrder, rec: ExitRecord, lastPrice: number, byUser: boolean) {
    const notSent = (detail: string) => {
        updateExit(rec.id, e => ({ ...e, status: 'not-sent', detail, at: Date.now() }));
        notify({ kind: 'err', title: '觸價單未送出', body: `${t.code} ${detail}（不會自動重送）` });
    };
    let contract: ContractBase;
    try {
        contract = await ensureContract(t.code);
    } catch {
        notSent('商品資料取得失敗');
        return;
    }
    if (currentProtectionEnv() !== rec.env) { notSent('伺服器或模擬／正式模式已切換'); return; }
    if ((contract.target_code || contract.code) !== rec.orderCode) {
        notSent(`商品已換為 ${contract.target_code || contract.code}，與建立時 ${rec.orderCode} 不同`);
        return;
    }
    const account = getAccountState().accounts.find(a => a.signed && a.account_type === rec.account.account_type
        && a.broker_id === rec.account.broker_id && a.account_id === rec.account.account_id);
    if (!account) { notSent('建立時的帳戶已不可用'); return; }
    try {
        // A manual trigger the user sends from 待確認 may be an entry: it is a
        // user order (risk checks, manual confirm). Bracket exits stay protective.
        const userOrder = byUser && !t.bracketId;
        const trade = await placeQuickOrder(contract, t.action, null, rec.quantity, {
            bypassRisk: !userOrder, // protective exit — never blocked by kill switch
            source: userOrder ? 'manual' : 'auto', // 自動觸發時使用者可能不在場，不彈確認
            account,
            ocType: t.octype,
        });
        const orderId = trade.order.id;
        updateExit(rec.id, e => ({ ...e, status: e.filled >= e.quantity ? 'filled' : 'working', orderId, at: Date.now() }));
        for (const report of recentReportsFor(envBase(rec.env), orderId)) applyExitReport(report, envBase(rec.env));
        scheduleIocCheck(rec.id);
        notify({ kind: 'ok', title: t.kind === 'stop' ? '停損觸發' : '停利觸發',
            body: `${t.code} @${lastPrice} → 市價${t.action === 'Buy' ? '買' : '賣'} ${rec.quantity} (${trade.status.status})` });
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if ((e as { mutationNotStarted?: boolean })?.mutationNotStarted) {
            notSent(message);
            return;
        }
        updateExit(rec.id, x => ({ ...x, status: 'unknown', detail: `送單結果未知：${message}`, at: Date.now() }));
        notify({ kind: 'err', title: '觸價單結果未知',
            body: `${t.code} ${message} — 請至委託／持倉手動對帳；系統不會自動重送` });
    }
}

/** Exits are market IOC. Their unfilled remainder may never produce a Cancel
 * report, so the exit order is read from the cache only (refresh:false) at
 * most TWICE: a final status (Cancelled/Failed/Inactive/Filled) settles it at
 * once; PartFilled settles only when a second, later read shows the same
 * fills/cancels. Otherwise the remainder stays 待確認 for an explicit 對帳.
 * A row missing from the cache changes nothing (never filled/cancelled).
 * Late fills still apply after settling and shrink the unprotected rest. */
export const IOC_CHECK_MS = 3000;
export const IOC_RECHECK_MS = 5000;
const FINAL = ['Cancelled', 'Failed', 'Inactive', 'Filled'];
const rowSignature = (t: Trade) => `${t.status.status}|${t.status.deal_quantity}|${t.status.cancel_quantity}|${t.status.deals?.length ?? 0}`;
function scheduleIocCheck(id: string, previous?: string) {
    setTimeout(() => {
        const rec = exits.find(e => e.id === id);
        if (!rec || rec.status !== 'working' || !rec.orderId || !executing) return;
        if (currentProtectionEnv() !== rec.env) return;
        void fetchTrades(rec.account.account_type, rec.account, { refresh: false }).then(rows => {
            const trade = rows.find(t => t.order.id === rec.orderId);
            if (!trade) {
                if (previous === undefined) scheduleIocCheck(id, ''); // second (last) read
                return;
            }
            const final = FINAL.includes(trade.status.status);
            const stable = trade.status.status === 'PartFilled' && previous === rowSignature(trade);
            applyExitTrade(trade, { settle: final || stable });
            if (!final && !stable) {
                if (previous === undefined) scheduleIocCheck(id, rowSignature(trade));
                else updateExit(id, e => e.status === 'working'
                    ? { ...e, detail: '出場剩餘量待確認；請按「對帳」確認實際成交', at: Date.now() } : e);
            }
        }).catch(() => undefined);
    }, previous === undefined ? IOC_CHECK_MS : IOC_RECHECK_MS);
}

function applyExitReport(report: OrderEventReport, base: string) {
    const orderId = report.kind === 'deal' ? report.tradeId : report.id;
    for (const rec of exits.slice()) {
        if (rec.orderId !== orderId || !acceptsFills(rec) || !reportEnvMatches(rec.env, base)) continue;
        updateExit(rec.id, e => {
            if (report.kind === 'order') return applyExitOrderReport(e, report, e.account, Date.now());
            const m = matchDeal(report, orderId, e.account, e.market, e.orderCode, e.action);
            return m.kind === 'fill' ? applyExitFill(e, m.fill, Date.now()) : e;
        });
    }
}

/** Apply a Trade row (explicit refresh:true, or the bounded IOC cache check)
 * to an exit order. Fills always apply, also after the exit ended. With
 * `settle`, a PartFilled IOC row ends the exit too (caller proved it stable). */
export function applyExitTrade(trade: Trade, opts: { settle?: boolean } = {}) {
    if (!main) return;
    for (const rec of exits.slice()) {
        if (rec.orderId !== trade.order.id || !acceptsFills(rec)) continue;
        const a = trade.order.account;
        if (a && (a.broker_id !== rec.account.broker_id || a.account_id !== rec.account.account_id)) continue;
        updateExit(rec.id, e => {
            let next = e;
            for (const fill of fillsFromTrade(trade)) next = applyExitFill(next, fill, Date.now());
            const ended = ['Cancelled', 'Failed', 'Inactive'].includes(trade.status.status)
                || (opts.settle && trade.status.status === 'PartFilled');
            if (next.status === 'working' && ended) {
                next = { ...next, status: 'incomplete', at: Date.now(),
                    detail: `出場委託 ${trade.status.status}，剩餘 ${next.quantity - next.filled} 待確認；請按「對帳」確認` };
            }
            return next;
        });
    }
}

const isPast = (t: Pick<TriggerOrder, 'condition' | 'price'>, price: number) =>
    (t.condition === 'below' && price <= t.price) || (t.condition === 'above' && price >= t.price);

export function evaluateTick(code: string, price: number) {
    if (!main || !executing || !Number.isFinite(price) || price <= 0) return;
    const previous = lastPrices.get(code);
    lastPrices.set(code, price);
    if (currentProtectionEnv()) tickedSinceRestore.add(code);
    if (triggers.length === 0) return;
    const env = currentProtectionEnv(); // null → only alerts may fire
    let rearmed = false;
    const held: TriggerOrder[] = [];
    for (const t of triggers.slice()) {
        if (t.code !== code || t.suspended || t.pending) continue;
        if (t.kind !== 'alert' && t.env !== env) continue;
        const past = isPast(t, price);
        if (t.awaitingRecross) {
            // kept after 待確認: seeing the non-trigger side arms it again
            if (!past) {
                triggers = triggers.map(x => x.id === t.id ? { ...x, awaitingRecross: undefined } : x);
                rearmed = true;
            }
            continue;
        }
        if (restoreCheck.delete(t.id) && past && t.kind !== 'alert') {
            held.push(t);
            continue;
        }
        if (!past) continue;
        // an earlier trigger on this tick may have removed it (OCO)
        if (!triggers.some(x => x.id === t.id)) continue;
        fire(t, price);
    }
    // an OCO sibling fired on this same tick may have removed a held one
    const stillHeld = held.filter(t => triggers.some(x => x.id === t.id));
    if (stillHeld.length) holdPending(stillHeld, price);
    else if (rearmed) commit();
    else if (previous !== price && triggers.some(t => t.pending && t.code === code)) schedulePricePublish();
}

// ---- restore confirmation (#144) ----

function pendingPrices(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const t of triggers) {
        const p = t.pending ? lastPrices.get(t.code) : undefined;
        if (p !== undefined) out[t.code] = p;
    }
    return out;
}

function publishPrices() {
    if (!executing) return;
    snapshot = { ...snapshot, prices: pendingPrices() };
    listeners.forEach(l => l());
    bus.publish();
}

// Prices of 待確認 codes reach mirrors at most twice a second.
let priceTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePricePublish() {
    if (priceTimer) return;
    priceTimer = setTimeout(() => {
        priceTimer = null;
        publishPrices();
    }, 500);
}

/** Stream down or environment change: earlier prices no longer prove what
 * the market is now; 送出 waits for a fresh tick. */
function dropPrices() {
    if (lastPrices.size === 0) return;
    lastPrices.clear();
    publishPrices();
}

const fmtDiff = (d: number) => `${d > 0 ? '+' : ''}${Number(d.toFixed(4))}`;

/** One line for notices and the 待確認 list; the account follows privacy mode. */
export function describePending(t: TriggerOrder, price: number | undefined, priv: boolean): string {
    const acct = t.account ? `${t.account.account_type === 'F' ? '[期]' : '[證]'}${maskAccountId(t.account.account_id, priv)} ` : '';
    const now = price === undefined ? '目前價未知' : `目前 ${price}（差 ${fmtDiff(price - t.price)}）`;
    return `${t.code} ${acct}${t.kind === 'stop' ? '停損' : '停利'} 市價${t.action === 'Buy' ? '買' : '賣'} ${t.quantity}`
        + ` 觸價 ${t.condition === 'below' ? '≤' : '≥'} ${t.price} · ${now}`;
}

function holdPending(held: TriggerOrder[], price: number) {
    const at = Date.now();
    const ids = new Set(held.map(t => t.id));
    triggers = triggers.map(t => ids.has(t.id) ? { ...t, pending: { price, at } } : t);
    commit();
    for (const t of held) {
        notify({ kind: 'err', title: '觸價單待確認（未自動送出）',
            body: `${describePending(t, price, getPrivacyMode())} — 離線期間已穿價；請選擇送出、取消或保留` });
    }
}

/** Every order-sending trigger of `env` (all envs when omitted) decides on
 * its next tick whether it is 待確認. */
function markRestore(env?: string) {
    for (const t of triggers) {
        if (t.kind === 'alert' || t.suspended || t.pending || t.awaitingRecross) continue;
        if (env === undefined || t.env === env) restoreCheck.add(t.id);
    }
}

function resolvePending(id: string, choice: PendingChoice): unknown {
    const t = triggers.find(x => x.id === id);
    if (!t?.pending) throw new Error('此觸價單已不在待確認狀態');
    if (choice === 'keep') {
        triggers = triggers.map(x => x.id === id ? { ...x, pending: undefined, awaitingRecross: true } : x);
        commit();
        notify({ kind: 'info', title: '觸價單保留', body: `${t.code} 價格回到觸價另一側後，再次穿價才會觸發` });
        return true;
    }
    if (choice === 'cancel') {
        // Same rule as remove: a bracket's pair belongs to its plan.
        if (t.bracketId) throw new Error('括號單保護請在下單面板的括號單狀態中移除追蹤');
        triggers = triggers.filter(x => x.id !== id);
        commit();
        notify({ kind: 'info', title: '觸價單已取消', body: `${t.code} 待確認觸價單已刪除，未送單` });
        return true;
    }
    if (choice !== 'send') throw new Error('未知選項');
    if (currentProtectionEnv() !== t.env) throw new Error('伺服器或模擬／正式模式與建立時不同，未送出');
    const account = t.account && getAccountState().accounts.find(a => a.signed && a.account_type === t.account!.account_type
        && a.broker_id === t.account!.broker_id && a.account_id === t.account!.account_id);
    if (!account) throw new Error('建立時的帳戶已不可用，未送出');
    const latest = lastPrices.get(t.code);
    if (getStreamStatus() !== 'live' || latest === undefined) throw new Error('行情未連線或連線後尚未收到新成交價，未送出');
    const next = { ...t, pending: undefined };
    triggers = triggers.map(x => x.id === id ? next : x);
    fire(next, latest, true); // OCO siblings, reservation and unknown-outcome rules apply as usual
    return true;
}

// Main window keeps the tick feed of every active trigger subscribed; closing
// the viewing panel must not silently stop protection. A failed contract
// lookup is retried (stream live / server info change / backoff) and the
// code is reported as missing its feed meanwhile.
const quoteHolds = new Map<string, { release?: () => void }>();
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 5000;
function syncQuotes() {
    if (!main || !executing) return;
    const env = currentProtectionEnv();
    const base = getApiBase();
    const codes = new Set(triggers.filter(t => !t.suspended && (t.kind === 'alert' || t.env === env
        || (!env && t.env?.startsWith(`${base}|`)))).map(t => t.code));
    for (const [code, hold] of quoteHolds) {
        if (!codes.has(code)) { hold.release?.(); quoteHolds.delete(code); }
    }
    let changed = false;
    for (const code of [...feedMissing]) if (!codes.has(code)) { feedMissing.delete(code); changed = true; }
    for (const code of codes) {
        if (quoteHolds.has(code)) continue;
        const hold: { release?: () => void } = {};
        quoteHolds.set(code, hold);
        void ensureContract(code).then(contract => {
            if (quoteHolds.get(code) !== hold) return;
            hold.release = retainQuote(contract, 'Tick');
            retryDelay = 5000;
            if (feedMissing.delete(code)) publishFeed();
        }).catch(() => {
            if (quoteHolds.get(code) !== hold) return;
            quoteHolds.delete(code);
            if (!feedMissing.has(code)) {
                feedMissing.add(code);
                publishFeed();
                notify({ kind: 'err', title: '觸價單行情未訂閱', body: `${code} 商品資料取得失敗，保護單暫時收不到成交價；將自動重試` });
            }
            if (!retryTimer) {
                retryTimer = setTimeout(() => { retryTimer = null; syncQuotes(); }, retryDelay);
                retryDelay = Math.min(retryDelay * 2, 60000);
            }
        });
    }
    if (changed) publishFeed();
}

function publishFeed() {
    snapshot = { ...snapshot, feedMissing: [...feedMissing], executing };
    listeners.forEach(l => l());
    bus.publish();
}

export function useTriggerFeed(): { feedMissing: string[]; executing: boolean } {
    return useSyncExternalStore(subscribe, () => snapshot);
}

export const EXECUTOR_LOCK = 'sj-protection-executor';
/** A same-environment stream outage longer than this is treated as a restart (#144). */
export const LONG_DISCONNECT_MS = 60_000;
let engineStarted = false;
export function startTriggerEngine() {
    if (engineStarted || !main) return;
    engineStarted = true;
    const claim = claimExecutor(EXECUTOR_LOCK);
    void claim.settled.then(() => {
        if (isExecutor()) return;
        decideRole(); // standby: act as a mirror until the executor leaves
        bus.hello();
        notify({ kind: 'info', title: '觸價單由其他主視窗執行', body: '另一個主視窗／分頁正在執行停損停利；此頁僅顯示，對方關閉後自動接手' });
    });
    void claim.acquired.then(becomeExecutor);
}

function becomeExecutor() {
    loadExecutorState();
    executing = true;
    decideRole();
    const suspended = triggers.filter(t => t.suspended === LEGACY_SUSPENDED).length;
    if (suspended) {
        notify({ kind: 'err', title: '舊版觸價單已暫停',
            body: `${suspended} 筆停損／停利未綁定帳戶，不會自動送單；請在圖表刪除後重新設定` });
    }
    onAnyTick(tick => { if (!tick.simtrade) evaluateTick(tick.code, Number(tick.close)); });
    onTrackedReport((report, _info, base) => applyExitReport(report, base));
    // Returning to an environment protection was not running in (#144); a
    // reconnect to the same one (mode briefly forgotten) is not a restore.
    let lastEnv = currentProtectionEnv();
    let prevEnv = lastEnv;
    markRestore();
    onProtectionEnvChange(() => {
        const env = currentProtectionEnv();
        if (env === prevEnv) { syncQuotes(); return; }
        prevEnv = env;
        dropPrices();
        if (env && env !== lastEnv) {
            if (lastEnv) {
                markRestore(env);
                tickedSinceRestore.clear();
            }
            lastEnv = env;
        }
        syncQuotes();
    });
    watchProtectionEnv(); // stream down → mode forgotten → no dispatch until fresh /info
    // A disconnect longer than LONG_DISCONNECT_MS counts as a restart: the
    // market may have crossed unseen, so the first tick decides again.
    let downSince: number | null = getStreamStatus() === 'live' ? null : Date.now();
    subscribeStatusStore(() => {
        if (getStreamStatus() === 'live') {
            if (downSince !== null && Date.now() - downSince > LONG_DISCONNECT_MS) {
                markRestore();
                tickedSinceRestore.clear();
            }
            downSince = null;
            syncQuotes();
        } else {
            downSince ??= Date.now();
            dropPrices();
        }
    });
    void refreshProtectionEnv();
    commit();
    for (const l of executorListeners) l();
}

const executorListeners = new Set<() => void>();
/** Runs once this window becomes the protection executor (main window only). */
export function onBecomeExecutor(listener: () => void): void {
    if (executing) listener();
    else executorListeners.add(listener);
}
