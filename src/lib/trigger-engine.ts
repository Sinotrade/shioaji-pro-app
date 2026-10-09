import { canTrade } from './account-tradable';
import { createAccountQuery } from './account-query';
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
//   trigger's environment, or protection resumes after it could not evaluate
//   (stream down or server mode unknown) for more than 60 s in a row, or
//   after more than 90 s without any tick or heartbeat (silent stall, sleep),
//   the FIRST tick decides. An order-sending trigger
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
import { ensureContract, getCachedContract } from './contracts-cache';
import { actionLabel, conditionLabel, contractLabel, exitStyleLabel, kindLabel as pendingKindLabel } from './pending-trigger-view';
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
import {
    backgroundOwnerForNew,
    backgroundSupported,
    createBackgroundTrigger,
    getBackgroundPrices,
    getBackgroundPrograms,
    refreshBackground,
    removeBackgroundTrigger,
    resolveBackgroundTrigger,
    subscribeBackground,
} from './execution/background';
import {
    backgroundEligible,
    backgroundRowId,
    isBackgroundId,
    programForNewTrigger,
    triggerRowsFromPrograms,
    type BackgroundTriggerOrder,
} from './execution/background-view';
import { retainQuote } from './quote-ownership';
import { getApiBase } from './runtime';
import { fetchTrades } from './shioaji';
import { getStreamStatus, onAnyTick, onOddLotTick, onStreamEvent, subscribeStatusStore } from './stream';
import { notify, placeQuickOrder } from './trade';
import { getTradingState } from './trading-state';
import { fmtPrice } from './utils/format';
import { isOddLot, ODD_LOT_MAX_SHARES, oddLotMarketablePrice, SHARES_PER_LOT, sharesToUnits, stockQtyUnit } from './odd-lot';
import type { ContractBase } from './types/contract';
import type { Account } from './types/portfolio';
import type { Action, FuturesOCType, StockOrderLot, Trade } from './types/order';

/** Why protection resumed with a first-tick check (#144). */
/** `rearm`: a background trigger turned back on in a new session (#201). */
export type RestoreReason = 'restart' | 'disconnect' | 'env' | 'rearm';

export const RESTORE_REASON_TEXT: Record<RestoreReason, string> = {
    restart: 'App 關閉、重新載入或切換主視窗期間已穿價',
    disconnect: '行情連線中斷（或伺服器模式未確認）超過 1 分鐘期間已穿價',
    env: '先前不在此伺服器環境執行，切回時已穿價',
    rearm: '在新盤別重新啟用時價格已穿過觸發價',
};

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
    // stocks: IntradayOdd → quantity in shares, sent as a LIMIT at the price
    // limit (零股沒有市價單, #204); absent = Common lots (張)
    orderLot?: StockOrderLot;
    bracketId?: string;
    suspended?: string; // reason this trigger will not execute
    createdAt?: number;
    requestId?: string; // sender-generated; a re-applied add returns the same trigger
    pending?: { price: number; at: number; reason?: RestoreReason }; // 待確認: already past when protection resumed (#144)
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
    orderLot?: StockOrderLot; // IntradayOdd → quantities in shares
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
    sending?: string[]; // 待確認 triggers whose 送出 is in progress (e.g. confirm dialog open)
}
let executing = false; // this window holds the executor lock
const feedMissing = new Set<string>(); // trigger codes without a tick subscription
let snapshot: Snapshot = { triggers, exits, feedMissing: [], executing: false, prices: {}, sending: [] };
// Executor only: triggers whose first tick after a (re)start decides between
// normal operation and 待確認; the latest tick per code since the stream /
// environment last changed; and the last stream activity (tick or heartbeat)
// seen while protection could evaluate — null until the first one after a
// start / environment switch (the restore window is open until then).
const restoreCheck = new Map<string, RestoreReason>();
let lastRestoreReason: RestoreReason = 'restart';
const lastPrices = new Map<string, number>();

// 價格來源（#204）：盤中零股停損停利／觸價單以「零股成交價」判斷 — 零股
// 出場單送進零股市場撮合，零股與整股分開撮合、價格可能不同，觸發條件要看
// 實際成交的那個市場。整股單與價格警示仍看整股成交價。零股成交較稀疏，
// 觸發時點以零股實際成交為準。lastPrices／待確認價格以 priceKey 區分兩者。
const ODD_PRICE_SUFFIX = '#odd';
function feedKey(code: string, oddLot: boolean): string {
    return oddLot ? `${code}${ODD_PRICE_SUFFIX}` : code;
}
/** Key of the price feed a trigger is evaluated on (see usePendingPrices). */
export function priceKeyOf(t: Pick<TriggerOrder, 'code' | 'orderLot' | 'kind'>): string {
    return feedKey(t.code, usesOddFeed(t));
}
function usesOddFeed(t: Pick<TriggerOrder, 'orderLot' | 'kind'>): boolean {
    return t.kind !== 'alert' && t.orderLot === 'IntradayOdd';
}


export type PendingChoice = 'send' | 'cancel' | 'keep';

type Command =
    | { op: 'add'; trigger: NewTrigger }
    | { op: 'remove'; id: string }
    | { op: 'ack-exit'; id: string }
    | { op: 'resolve-pending'; id: string; choice: PendingChoice; allowUnpast?: boolean }
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
        // keep unchanged parts by reference: a price-only update must not
        // re-render every useTriggers / useTriggerExits consumer
        snapshot = {
            ...state,
            triggers: same(state.triggers, snapshot.triggers),
            exits: same(state.exits, snapshot.exits),
            feedMissing: same(state.feedMissing, snapshot.feedMissing),
            prices: same(state.prices, snapshot.prices),
            sending: same(state.sending, snapshot.sending),
        };
        listeners.forEach(l => l());
    },
});

function same<T>(next: T, prev: T): T {
    return next === prev || JSON.stringify(next) === JSON.stringify(prev) ? prev : next;
}

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
    snapshot = { triggers, exits, feedMissing: [...feedMissing], executing, prices: pendingPrices(), sending: [...userSending] };
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

function qtyText(t: Pick<TriggerOrder, 'quantity' | 'orderLot'>, quantity = t.quantity): string {
    return isOddLot(t.orderLot) ? `${quantity} 股` : `${quantity}`;
}

function describe(t: TriggerOrder) {
    return t.kind === 'alert'
        ? `${t.code} 觸價 ${t.condition === 'below' ? '≤' : '≥'} ${t.price} 時通知`
        : `${t.code} 觸價 ${t.condition === 'below' ? '≤' : '≥'} ${t.price} → ${exitStyleLabel(t)}${t.action === 'Buy' ? '買' : '賣'} ${qtyText(t)}${t.group ? '（OCO）' : ''}`;
}

/** Odd-lot triggers: stocks only, 盤中零股 only, 1–999 shares. */
function oddLotTriggerProblem(t: Pick<TriggerOrder, 'kind' | 'orderLot' | 'quantity' | 'account'>): string | null {
    if (t.kind === 'alert' || !t.orderLot || t.orderLot === 'Common') return null;
    if (t.account?.account_type !== 'S') return '零股觸價單僅支援股票';
    if (t.orderLot !== 'IntradayOdd') return '觸價單僅支援整股與盤中零股；盤後零股為收盤後一次撮合，無法即時觸價';
    if (!Number.isSafeInteger(t.quantity) || t.quantity < 1 || t.quantity > ODD_LOT_MAX_SHARES) return `零股觸價單數量須為 1～${ODD_LOT_MAX_SHARES} 股`;
    return null;
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
        const oddProblem = oddLotTriggerProblem(t);
        if (oddProblem) throw new Error(oddProblem);
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
    if (cmd.op === 'resolve-pending') return resolvePending(cmd.id, cmd.choice, cmd.allowUnpast);
    if (cmd.op === 'publish-prices') { publishPrices(); return true; }
    throw new Error('未知指令');
}

/** Capture the fixed execution context for a manual stop/take trigger. */
/** `account`: a panel's own account (chart order settings, #204) instead of
 * the app-wide selection — it must still be a tradable account of the market. */
function withContext(t: NewTrigger, contract?: ContractBase, account?: Account): NewTrigger | string {
    if (t.kind === 'alert' || (t.env && t.account && t.orderCode)) return t;
    if (!contract) return '缺少商品資訊，無法固定下單帳戶';
    const futures = contract.security_type === 'FUT' || contract.security_type === 'OPT';
    if (!futures && contract.security_type !== 'STK') return '此商品不支援觸價下單';
    if (futures && t.orderLot && t.orderLot !== 'Common') return '期貨選擇權沒有零股，觸價單未建立';
    const s = getAccountState();
    const selected = account
        ? s.accounts.find(a => canTrade(a) && a.account_type === account.account_type
            && a.broker_id === account.broker_id && a.account_id === account.account_id)
        : futures ? s.selectedFutures : s.selectedStock;
    if (account && !selected) return '指定的下單帳戶已不可用，觸價單未建立';
    if (!selected || !canTrade(selected) || selected.account_type !== (futures ? 'F' : 'S')) return '沒有可用的下單帳戶，觸價單未建立';
    const env = currentProtectionEnv();
    if (!env) return '伺服器模式（模擬／正式）尚未確認，觸價單未建立';
    return { ...t, env,
        account: { account_type: futures ? 'F' : 'S', broker_id: selected.broker_id, account_id: selected.account_id },
        orderCode: contract.target_code || contract.code };
}

/** Add a trigger from any window. Stop/take bind the currently selected
 * account for the contract's market; the main window executes it. */
export async function addTrigger(t: NewTrigger, contract?: ContractBase, opts?: { account?: Account }): Promise<TriggerOrder | null> {
    const prepared = withContext(t, contract, opts?.account);
    if (typeof prepared === 'string') {
        notify({ kind: 'err', title: '觸價單未建立', body: prepared });
        return null;
    }
    // #201: with 「背景持續執行」 on, a new futures / options stop or take
    // runs in the background engine and never enters this engine (one owner)
    if (backgroundSupported() && backgroundEligible(prepared, contract)) {
        const owner = await backgroundOwnerForNew();
        if (owner === 'background') return addBackgroundTrigger(prepared, contract!);
        if (owner !== 'window') {
            // on (or unknown) but unusable: never a silent switch to this window
            notify({ kind: 'err', title: '觸價單未建立', body: owner.refused });
            return null;
        }
    }
    const requestId = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : newId();
    try {
        return await bus.send({ op: 'add', trigger: { ...prepared, requestId } }) as TriggerOrder;
    } catch (e) {
        notify({ kind: 'err', title: '觸價單未確認', body: e instanceof Error ? e.message : String(e) });
        return null;
    }
}

async function addBackgroundTrigger(prepared: NewTrigger, contract: ContractBase): Promise<TriggerOrder | null> {
    const t: TriggerOrder = { ...prepared, id: newId(), createdAt: Date.now() };
    delete t.requestId;
    const program = programForNewTrigger(t, contract);
    if (!program) {
        notify({ kind: 'err', title: '觸價單未建立', body: '背景執行：觸價單缺少帳戶或伺服器資訊' });
        return null;
    }
    const result = await createBackgroundTrigger(program);
    if (result !== 'created') {
        if ('refused' in result) notify({ kind: 'err', title: '觸價單未建立', body: `背景執行：${result.refused}` });
        // never "not created": a retry could make a second trigger that also sends
        else notify({ kind: 'err', title: '觸價單建立結果未確認', body: `背景執行：${result.unconfirmed}；請先看觸價單清單是否已有這張，不要直接重掛` });
        return null;
    }
    notify({ kind: 'info', title: `${kindLabel(t)}（背景執行）`, body: describe(t) });
    return backgroundRows().find(r => r.background.programId === program.id) ?? { ...t, id: backgroundRowId(program.id, t.id) };
}

function backgroundRow(id: string): BackgroundTriggerOrder | undefined {
    return backgroundRows().find(r => r.id === id);
}

export async function removeTrigger(id: string): Promise<void> {
    if (isBackgroundId(id)) {
        try {
            const row = backgroundRow(id);
            if (row) await removeBackgroundTrigger(row.background.programId);
        } catch (e) {
            notify({ kind: 'err', title: '觸價單移除未確認', body: e instanceof Error ? e.message : String(e) });
        }
        return;
    }
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
export function resolvePendingTrigger(id: string, choice: PendingChoice, opts: { allowUnpast?: boolean } = {}): Promise<unknown> {
    if (isBackgroundId(id)) {
        const row = backgroundRow(id);
        if (!row) return Promise.reject(new Error('找不到這張觸價單'));
        return resolveBackgroundTrigger(row.background.programId, row.background.levelId, choice, !!opts.allowUnpast);
    }
    return bus.send({ op: 'resolve-pending', id, choice, allowUnpast: opts.allowUnpast });
}

/** Price is back on the non-trigger side: 送出 needs an extra confirmation. */
export function isPendingUnpast(t: Pick<TriggerOrder, 'condition' | 'price'>, price: number): boolean {
    return !isPast(t, price);
}

/** Ask the executor to publish the latest prices of 待確認 codes now. */
export function requestPendingPrices(): Promise<unknown> {
    void refreshBackground();
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

// ---- background triggers as rows (#201) ----
// Display and commands only: this engine never sees them (they are not in
// `triggers`) and never evaluates or sends them.

let bgCache: { programs: unknown; rows: BackgroundTriggerOrder[] } = { programs: null, rows: [] };
function backgroundRows(): BackgroundTriggerOrder[] {
    const programs = getBackgroundPrograms();
    if (bgCache.programs !== programs) bgCache = { programs, rows: triggerRowsFromPrograms(programs) };
    return bgCache.rows;
}

let mergedCache: { ts: TriggerOrder[]; bg: BackgroundTriggerOrder[]; all: TriggerOrder[] } = { ts: [], bg: [], all: [] };
/** This engine's triggers, then the background ones (none: the same array). */
export function getDisplayTriggers(): TriggerOrder[] {
    const ts = snapshot.triggers;
    const bg = backgroundRows();
    if (mergedCache.ts !== ts || mergedCache.bg !== bg) mergedCache = { ts, bg, all: bg.length ? [...ts, ...bg] : ts };
    return mergedCache.all;
}

function subscribeAll(l: () => void) {
    const a = subscribe(l);
    const b = subscribeBackground(l);
    return () => { a(); b(); };
}

export function useTriggers(): TriggerOrder[] {
    return useSyncExternalStore(subscribeAll, getDisplayTriggers);
}

const NO_SENDING: string[] = [];
/** Ids of 待確認 triggers whose 送出 is still in progress. */
export function useSendingTriggers(): string[] {
    return useSyncExternalStore(subscribe, () => snapshot.sending ?? NO_SENDING);
}

const NO_PRICES: Record<string, number> = {};
/** Latest tick price of every code that has a 待確認 trigger. */
let pricesCache: { ts: unknown; bg: unknown; rows: unknown; all: Record<string, number> } = { ts: null, bg: null, rows: null, all: NO_PRICES };
function pendingPricesNow(): Record<string, number> {
    const ts = snapshot.prices ?? NO_PRICES;
    const bg = getBackgroundPrices();
    const rows = backgroundRows();
    if (pricesCache.ts !== ts || pricesCache.bg !== bg || pricesCache.rows !== rows) {
        const extra: Record<string, number> = {};
        for (const r of rows) if (r.pending && bg[r.code] !== undefined) extra[r.code] = bg[r.code]!;
        pricesCache = { ts, bg, rows, all: Object.keys(extra).length ? { ...ts, ...extra } : ts };
    }
    return pricesCache.all;
}
export function usePendingPrices(): Record<string, number> {
    return useSyncExternalStore(subscribeAll, pendingPricesNow);
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
    orderLot?: StockOrderLot; // IntradayOdd → quantity in shares
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
        account: arm.account, orderCode: arm.orderCode, octype: arm.octype, bracketId: arm.bracketId, createdAt: Date.now(),
        ...(arm.orderLot && isOddLot(arm.orderLot) ? { orderLot: arm.orderLot } : {}) };
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
    // Armed from a fill recovered after a (re)start (cache lookup, buffered
    // reports) or while the restore window is open: the first tick decides
    // (#144). Exits armed from live fills fire as usual.
    if (arm.restore || restoreWindowOpen()) {
        const reason: RestoreReason = arm.restore ? lastRestoreReason : startRestore ? 'restart' : 'disconnect';
        for (const t of added) restoreCheck.set(t.id, reason);
    }
    triggers = [...triggers, ...added];
    commit();
    return true;
}

/** Remove every trigger of a bracket whose plan no longer exists (#144:
 * a 待確認 exit must stay removable). Main window only. */
export function dropBracketTriggers(bracketId: string) {
    if (!main) return;
    const before = triggers.length;
    triggers = triggers.filter(t => t.bracketId !== bracketId);
    if (triggers.length !== before) commit();
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

/** Stock reservations in SHARES: whole-lot and odd-lot exits of the same
 * stock and side draw on the same holding (#204). */
function reservedShares(key: string): number {
    return exits.filter(e => e.reserveKey === key && !isResolved(e))
        .reduce((s, e) => s + Math.max(0, e.quantity - e.filled) * (isOddLot(e.orderLot) ? 1 : SHARES_PER_LOT), 0);
}

/** Known position that `action` would close — shares for stocks, contracts
 * for futures — or null when the shared position view is not a confirmed
 * snapshot. */
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
    // stock positions are held in shares
    return rows.reduce((s, p) => s + p.quantity, 0);
}

/** Decide the exit quantity for a firing trigger.
 * - manual triggers keep their own sizing (they may be entries);
 * - futures bracket exits are Cover orders: the broker rejects closing more
 *   than the open position, and a lagging position snapshot must not block
 *   a stop — so they are never reduced here, only annotated;
 * - stock bracket exits are Cash sells that could otherwise open a day-trade
 *   short: capped by the confirmed Cash position minus reserved exits, and
 *   refused while the position is unknown and another exit is unresolved. */
export function planExitQuantity(t: Pick<TriggerOrder, 'quantity' | 'bracketId' | 'account' | 'orderLot'>, reserved: number,
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
        if (free < t.quantity) {
            const unit = stockQtyUnit(t.orderLot);
            return { quantity: free, detail: `可賣出現股僅 ${free} ${unit}，其餘 ${t.quantity - free} ${unit}未保護` };
        }
        return { quantity: t.quantity };
    }
    if (reserved > 0) return { quantity: 0, detail: '持倉未確認且另有出場委託未完成；為避免超賣未送出' };
    return { quantity: t.quantity, detail: '持倉未確認，依保護量送出' };
}

// ---- firing ----

/** The synchronous part of firing: OCO siblings removed, group recorded,
 * exit reserved and shown. Nothing interleaves between the OCO check and the
 * reservation. Returns the exit to send, or null when nothing is sent. */
function reserve(t: TriggerOrder, lastPrice: number): { rec: ExitRecord; siblings: TriggerOrder[]; gk: string | null } | null {
    const gk = t.group ? groupKey(t.env, t.group) : null;
    if (gk && processedGroups[gk]) {
        triggers = triggers.filter(x => !(x.group === t.group && x.env === t.env));
        commit();
        return null;
    }
    const siblings = t.group ? triggers.filter(x => x.group === t.group && x.env === t.env && x.id !== t.id) : [];
    triggers = triggers.filter(x => x.id !== t.id && !siblings.includes(x));
    if (gk) processedGroups[gk] = Date.now();
    if (t.kind === 'alert') {
        commit();
        notify({ kind: 'info', title: '到價警示',
            body: `${t.code} 現價 ${lastPrice} 已${t.condition === 'below' ? '跌破' : '突破'} ${t.price}` });
        return null;
    }
    const account = t.account!;
    const env = t.env!;
    const orderCode = t.orderCode!;
    const reserveKey = reserveKeyOf(env, account, orderCode, t.action);
    const plan = planFor(t);
    const rec: ExitRecord = {
        id: `ex-${t.id}`, triggerId: t.id, bracketId: t.bracketId, env, account,
        market: account.account_type === 'S' ? 'stock' : 'futures', orderCode, action: t.action,
        reserveKey, requested: t.quantity, kind: t.kind, quantity: plan.quantity,
        ...(isOddLot(t.orderLot) ? { orderLot: t.orderLot } : {}),
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
        return null;
    }
    return { rec, siblings, gk };
}

function planFor(t: TriggerOrder) {
    const reserveKey = reserveKeyOf(t.env!, t.account!, t.orderCode!, t.action);
    const closable = t.bracketId ? closablePosition(t.account!, t.orderCode!, t.action) : null;
    if (t.account?.account_type !== 'S') return planExitQuantity(t, reservedQuantity(reserveKey), closable);
    // Stocks: holdings and reservations are compared in shares, then expressed
    // in this exit's unit (whole lots for 整股, shares for 零股).
    const resShares = reservedShares(reserveKey);
    const reserved = isOddLot(t.orderLot) ? resShares : Math.ceil(resShares / SHARES_PER_LOT);
    return planExitQuantity(t, reserved,
        closable === null ? null : reserved + sharesToUnits(Math.max(0, closable - resShares), t.orderLot));
}

/** Limit price of an odd-lot exit (none for whole lots / futures). */
function exitPrice(t: TriggerOrder, contract: ContractBase): number | null | 'missing' {
    if (!isOddLot(t.orderLot)) return null;
    return oddLotMarketablePrice(contract as ContractBase & { limit_up?: number; limit_down?: number }, t.action) ?? 'missing';
}
const ODD_PRICE_MISSING = '零股需要有效漲跌停價作為限價，未送出';

function fire(t: TriggerOrder, lastPrice: number) {
    const r = reserve(t, lastPrice);
    if (r) void dispatch(t, r.rec, lastPrice);
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

/** Contract, environment and account of a trigger, re-checked before sending. */
async function sendContext(t: TriggerOrder, env: string): Promise<{ contract: ContractBase; account: Account } | string> {
    let contract: ContractBase;
    try {
        contract = await ensureContract(t.code);
    } catch {
        return '商品資料取得失敗';
    }
    if (currentProtectionEnv() !== env) return '伺服器或模擬／正式模式已切換';
    if ((contract.target_code || contract.code) !== t.orderCode) {
        return `商品已換為 ${contract.target_code || contract.code}，與建立時 ${t.orderCode} 不同`;
    }
    const account = getAccountState().accounts.find(a => canTrade(a) && a.account_type === t.account?.account_type
        && a.broker_id === t.account?.broker_id && a.account_id === t.account?.account_id);
    if (!account) return '建立時的帳戶已不可用';
    return { contract, account };
}

const notSentExit = (t: TriggerOrder, rec: ExitRecord, detail: string) => {
    updateExit(rec.id, e => ({ ...e, status: 'not-sent', detail, at: Date.now() }));
    notify({ kind: 'err', title: '觸價單未送出', body: `${t.code} ${detail}（不會自動重送）` });
};

function exitSent(t: TriggerOrder, rec: ExitRecord, trade: Trade, lastPrice: number) {
    const orderId = trade.order.id;
    const odd = isOddLot(t.orderLot);
    updateExit(rec.id, e => ({ ...e, status: e.filled >= e.quantity ? 'filled' : 'working', orderId, at: Date.now(),
        // odd-lot exits are ROD limits at the price limit: the rest keeps
        // working until filled or cancelled (reports / 對帳), no IOC settle
        ...(odd && e.filled < e.quantity ? { detail: `${e.detail ? `${e.detail}；` : ''}零股以漲跌停價限價 ROD 送出，依成交回報更新` } : {}) }));
    for (const report of recentReportsFor(envBase(rec.env), orderId)) applyExitReport(report, envBase(rec.env));
    if (!odd) scheduleIocCheck(rec.id);
    notify({ kind: 'ok', title: t.kind === 'stop' ? '停損觸發' : '停利觸發',
        body: `${t.code} @${lastPrice} → ${exitStyleLabel(t)}${t.action === 'Buy' ? '買' : '賣'} ${qtyText(t, rec.quantity)} (${trade.status.status})` });
}

function exitUnknown(t: TriggerOrder, rec: ExitRecord, message: string) {
    updateExit(rec.id, x => ({ ...x, status: 'unknown', detail: `送單結果未知：${message}`, at: Date.now() }));
    notify({ kind: 'err', title: '觸價單結果未知',
        body: `${t.code} ${message} — 請至委託／持倉手動對帳；系統不會自動重送` });
}

const notStarted = (e: unknown) => !!(e as { mutationNotStarted?: boolean })?.mutationNotStarted;

async function dispatch(t: TriggerOrder, rec: ExitRecord, lastPrice: number) {
    const ctx = await sendContext(t, rec.env);
    if (typeof ctx === 'string') { notSentExit(t, rec, ctx); return; }
    const price = exitPrice(t, ctx.contract);
    if (price === 'missing') { notSentExit(t, rec, ODD_PRICE_MISSING); return; }
    try {
        const trade = await placeQuickOrder(ctx.contract, t.action, price, rec.quantity, {
            bypassRisk: true, // protective exit — never blocked by kill switch
            source: 'auto', // 使用者可能不在場，不彈確認
            account: ctx.account,
            ocType: t.octype,
            orderLot: isOddLot(t.orderLot) ? t.orderLot : undefined,
        });
        exitSent(t, rec, trade, lastPrice);
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (notStarted(e)) notSentExit(t, rec, message);
        else exitUnknown(t, rec, message);
    }
}

// ---- user 送出 of a 待確認 trigger (#144) ----

const userSending = new Set<string>();

/** Everything that can refuse — contract, environment, account, the manual
 * order confirmation, kill switch and risk checks — runs BEFORE the trigger
 * fires: meanwhile it stays 待確認 and its OCO siblings stay armed. The
 * firing (OCO, reservation) happens synchronously right before sending, and
 * only if the trigger is still 待確認 then. */
async function userSend(id: string, allowUnpast: boolean) {
    try {
        await sendPending(id, allowUnpast);
    } finally {
        userSending.delete(id);
        publishPrices();
    }
}

async function sendPending(id: string, allowUnpast: boolean) {
    const first = triggers.find(x => x.id === id);
    if (!first?.pending) return;
    const refused = (reason: string) => {
        const still = triggers.some(x => x.id === id && x.pending);
        notify({ kind: 'err', title: still ? '觸價單未送出（仍待確認）' : '觸價單未送出', body: `${first.code} ${reason}` });
    };
    const ctx = await sendContext(first, first.env!);
    if (typeof ctx === 'string') { refused(ctx); return; }
    const planned = planFor(first);
    if (planned.quantity <= 0) { refused(planned.detail ?? '沒有可送出的數量'); return; }
    const price = exitPrice(first, ctx.contract);
    if (price === 'missing') { refused(ODD_PRICE_MISSING); return; }
    // A manual trigger may be an entry: it is a user order (risk checks,
    // manual confirm). Bracket exits stay protective.
    const userOrder = !first.bracketId;
    const box: { fired: { t: TriggerOrder; rec: ExitRecord; siblings: TriggerOrder[]; gk: string | null; price: number } | null } = { fired: null };
    try {
        const trade = await placeQuickOrder(ctx.contract, first.action, price, planned.quantity, {
            bypassRisk: !userOrder,
            source: userOrder ? 'manual' : 'auto',
            account: ctx.account,
            ocType: first.octype,
            orderLot: isOddLot(first.orderLot) ? first.orderLot : undefined,
            confirmLivePriceCode: userOrder ? priceKeyOf(first) : undefined,
            beforeSend: () => {
                const cur = triggers.find(x => x.id === id);
                if (!cur?.pending) throw new Error('已不在待確認（OCO 另一邊可能已觸發或已被處理），未送出');
                if (currentProtectionEnv() !== cur.env) throw new Error('伺服器或模擬／正式模式已切換，未送出');
                if (cur.group && processedGroups[groupKey(cur.env, cur.group)]) throw new Error('此 OCO 群組已觸發，未送出');
                const price = lastPrices.get(priceKeyOf(cur));
                if (getStreamStatus() !== 'live' || price === undefined) throw new Error('行情中斷，未送出');
                // The manual order dialog can stay open while the price crosses
                // back. An earlier confirmation of a crossed price does not
                // authorize sending after it is no longer crossed.
                if (!isPast(cur, price) && !allowUnpast) {
                    throw new Error(`目前已未穿價（目前價 ${price}），未送出；如仍要送出請再確認`);
                }
                const next = { ...cur, pending: undefined };
                if (planFor(next).quantity !== planned.quantity) throw new Error('可送出數量已變動，請重新確認');
                triggers = triggers.map(x => x.id === id ? next : x);
                const r = reserve(next, price);
                if (!r) throw new Error('未送出');
                box.fired = { t: next, ...r, price };
            },
        });
        if (box.fired) exitSent(box.fired.t, box.fired.rec, trade, box.fired.price);
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const f = box.fired;
        if (!f) { refused(message); return; } // nothing fired: still 待確認 (if it was)
        if (!notStarted(e)) { exitUnknown(f.t, f.rec, message); return; }
        if (f.t.bracketId) { notSentExit(f.t, f.rec, message); return; }
        // refused after firing, nothing sent: back to 待確認; the siblings are
        // re-armed and re-evaluated against the latest price
        exits = exits.filter(x => x.id !== f.rec.id);
        if (f.gk) delete processedGroups[f.gk];
        const back = [{ ...f.t, pending: first.pending }, ...f.siblings].filter(x => !triggers.some(y => y.id === x.id));
        triggers = [...triggers, ...back];
        commit();
        notify({ kind: 'err', title: '觸價單未送出（仍待確認）', body: `${f.t.code} ${message}` });
        const latest = lastPrices.get(priceKeyOf(f.t));
        if (latest !== undefined) evaluateTick(f.t.code, latest, usesOddFeed(f.t));
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
        const query = createAccountQuery();
        void query.read(rec.account.account_type, rec.account, current => fetchTrades(rec.account.account_type, current, { refresh: false })).then(rows => {
            query.assertCurrent();
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

/** `oddLot`: a 盤中零股 trade — evaluates only odd-lot triggers of `code`;
 * a regular-lot trade evaluates everything else (#204). */
export function evaluateTick(code: string, price: number, oddLot = false) {
    if (!main || !executing || !Number.isFinite(price) || price <= 0) return;
    const key = feedKey(code, oddLot);
    const previous = lastPrices.get(key);
    lastPrices.set(key, price);
    if (triggers.length === 0) return;
    const env = currentProtectionEnv(); // null → only alerts may fire
    let rearmed = false;
    const held: { t: TriggerOrder; reason: RestoreReason }[] = [];
    for (const t of triggers.slice()) {
        if (t.code !== code || usesOddFeed(t) !== oddLot || t.suspended || t.pending) continue;
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
        const reason = restoreCheck.get(t.id);
        if (reason && restoreCheck.delete(t.id) && past && t.kind !== 'alert') {
            held.push({ t, reason });
            continue;
        }
        if (!past) continue;
        // an earlier trigger on this tick may have removed it (OCO)
        if (!triggers.some(x => x.id === t.id)) continue;
        fire(t, price);
    }
    // an OCO sibling fired on this same tick may have removed a held one
    const stillHeld = held.filter(h => triggers.some(x => x.id === h.t.id));
    if (stillHeld.length) holdPending(stillHeld, price);
    else if (rearmed) commit();
    else if (previous !== price && triggers.some(t => t.pending && priceKeyOf(t) === key)) schedulePricePublish();
}

// ---- restore confirmation (#144) ----

// Protection "can evaluate" while this window executes, the stream is live
// and the server mode is known. Resuming is a restore (first tick decides)
// when it is the first time since start, the environment differs from the
// one last evaluated, protection could not evaluate for more than
// LONG_DISCONNECT_MS in a row, or the stream was silent (no tick nor
// heartbeat) for more than SILENT_STALL_MS. While evaluating, a silence over
// SILENT_STALL_MS (stall or sleep with the status still live) is one too.
let evaluating = false;
let startRestore = true;
let lastEvalEnv: string | null = null;
let notEvaluatingSince: number | null = null;
let lastActivityAt: number | null = null;
let lastResumeWasRestore = false;

/** Idempotent state update; any caller (engine or bracket listeners, in any
 * order) sees the same resume decision. Returns whether it can evaluate. */
function refreshEvaluation(): boolean {
    if (!executing) return false;
    const now = Date.now();
    const env = getStreamStatus() === 'live' ? currentProtectionEnv() : null;
    if (!env) {
        if (evaluating) { evaluating = false; notEvaluatingSince = now; dropPrices(); }
        return false;
    }
    if (evaluating && env === lastEvalEnv) return true;
    const reason: RestoreReason | null = startRestore ? 'restart' : env !== lastEvalEnv ? 'env'
        : (notEvaluatingSince !== null && now - notEvaluatingSince > LONG_DISCONNECT_MS)
            || (lastActivityAt !== null && now - lastActivityAt > SILENT_STALL_MS) ? 'disconnect' : null;
    const restore = reason !== null;
    if (evaluating) dropPrices(); // switched environment while live
    evaluating = true;
    startRestore = false;
    lastEvalEnv = env;
    notEvaluatingSince = null;
    lastActivityAt = now; // resuming counts as activity
    lastResumeWasRestore = restore;
    if (reason) { lastRestoreReason = reason; markRestore(reason, env); }
    return true;
}

/** Bracket exits armed now are restore-checked: before protection resumes
 * after a start / environment switch / long gap, or during a silent stall. */
export function restoreWindowOpen(): boolean {
    const now = Date.now();
    if (refreshEvaluation()) return lastActivityAt !== null && now - lastActivityAt > SILENT_STALL_MS;
    return startRestore || (notEvaluatingSince !== null && now - notEvaluatingSince > LONG_DISCONNECT_MS);
}

/** Whether the latest resume of protection was a restore (latched). Bracket
 * lookups / replays started when protection resumes use it. */
export function resumeWasRestore(): boolean {
    return refreshEvaluation() ? lastResumeWasRestore : restoreWindowOpen();
}

/** Stream activity (any tick incl. 試撮, heartbeat). Runs before the tick is
 * evaluated, so after a silent stall this tick is the first one. */
function noteActivity() {
    if (!refreshEvaluation()) return;
    const now = Date.now();
    if (lastActivityAt !== null && now - lastActivityAt > SILENT_STALL_MS) {
        lastRestoreReason = 'disconnect';
        markRestore('disconnect', lastEvalEnv ?? undefined);
        lastResumeWasRestore = true;
    }
    lastActivityAt = now;
}

function pendingPrices(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const t of triggers) {
        const key = priceKeyOf(t);
        const p = t.pending ? lastPrices.get(key) : undefined;
        if (p !== undefined) out[key] = p;
    }
    return out;
}

function publishPrices() {
    if (!executing) return;
    snapshot = { ...snapshot, prices: pendingPrices(), sending: [...userSending] };
    listeners.forEach(l => l());
    bus.publish();
}

// Prices of 待確認 codes reach mirrors at most once a second.
let priceTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePricePublish() {
    if (priceTimer) return;
    priceTimer = setTimeout(() => {
        priceTimer = null;
        publishPrices();
    }, 1000);
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
    return `${t.code} ${acct}${t.kind === 'stop' ? '停損' : '停利'} ${exitStyleLabel(t)}${t.action === 'Buy' ? '買' : '賣'} ${qtyText(t)}`
        + ` 觸價 ${t.condition === 'below' ? '≤' : '≥'} ${t.price} · ${now}`;
}

function pendingName(t: TriggerOrder): string {
    return contractLabel(t.code, getCachedContract(t.code));
}

function holdPending(held: { t: TriggerOrder; reason: RestoreReason }[], price: number) {
    const at = Date.now();
    const why = new Map(held.map(h => [h.t.id, h.reason]));
    triggers = triggers.map(t => why.has(t.id) ? { ...t, pending: { price, at, reason: why.get(t.id) } } : t);
    commit();
    for (const { t, reason } of held) {
        notify({ kind: 'err', title: '觸價單待確認（未自動送出）',
            body: `${pendingName(t)}　${pendingKindLabel(t)}・${exitStyleLabel(t)}${actionLabel(t)}。`
                + `價格已${conditionLabel(t)}（偵測時 ${fmtPrice(price)}），沒有自動送單，請到畫面下方的待確認面板處理。` });
    }
}

/** Every order-sending trigger of `env` (all envs when omitted) decides on
 * its next tick whether it is 待確認. */
function markRestore(reason: RestoreReason, env?: string) {
    for (const t of triggers) {
        if (t.kind === 'alert' || t.suspended || t.pending || t.awaitingRecross) continue;
        if (env === undefined || t.env === env) restoreCheck.set(t.id, reason);
    }
}

function resolvePending(id: string, choice: PendingChoice, allowUnpast = false): unknown {
    const t = triggers.find(x => x.id === id);
    if (!t?.pending) throw new Error('此觸價單已不在待確認狀態');
    if (choice === 'keep') {
        triggers = triggers.map(x => x.id === id ? { ...x, pending: undefined, awaitingRecross: true } : x);
        commit();
        notify({ kind: 'info', title: '觸價單保留', body: `${pendingName(t)} ${pendingKindLabel(t)}：價格回到觸發價另一側、再次穿過時才會觸發` });
        return true;
    }
    if (choice === 'cancel') {
        // Same rule as remove: a bracket's pair belongs to its plan.
        if (t.bracketId) throw new Error('括號單保護請在下單面板的括號單狀態中移除追蹤');
        triggers = triggers.filter(x => x.id !== id);
        commit();
        notify({ kind: 'info', title: '觸價單已取消', body: `${pendingName(t)} ${pendingKindLabel(t)} 已刪除，沒有送單` });
        return true;
    }
    if (choice !== 'send') throw new Error('未知選項');
    if (currentProtectionEnv() !== t.env) throw new Error('伺服器或模擬／正式模式與建立時不同，未送出');
    const account = t.account && getAccountState().accounts.find(a => canTrade(a) && a.account_type === t.account!.account_type
        && a.broker_id === t.account!.broker_id && a.account_id === t.account!.account_id);
    if (!account) throw new Error('建立時的帳戶已不可用，未送出');
    const latest = lastPrices.get(priceKeyOf(t));
    if (getStreamStatus() !== 'live' || latest === undefined) throw new Error('行情未連線或連線後尚未收到新成交價，未送出');
    if (!isPast(t, latest) && !allowUnpast) throw new Error(`目前已未穿價（目前價 ${latest}），未送出；如仍要送出請再確認`);
    if (userSending.has(id)) throw new Error('送出處理中');
    userSending.add(id);
    publishPrices(); // mirrors show 送出處理中
    void userSend(id, allowUnpast); // OCO siblings, reservation and unknown-outcome rules apply as usual
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
    // one hold per price feed: 整股 Tick, and 盤中零股 Tick for odd-lot triggers
    const feeds = new Map<string, { code: string; oddLot: boolean }>();
    for (const t of triggers) {
        if (t.suspended || !(t.kind === 'alert' || t.env === env || (!env && t.env?.startsWith(`${base}|`)))) continue;
        feeds.set(priceKeyOf(t), { code: t.code, oddLot: usesOddFeed(t) });
    }
    const codes = new Set([...feeds.values()].map(f => f.code));
    for (const [key, hold] of quoteHolds) {
        if (!feeds.has(key)) { hold.release?.(); quoteHolds.delete(key); }
    }
    let changed = false;
    for (const code of [...feedMissing]) if (!codes.has(code)) { feedMissing.delete(code); changed = true; }
    for (const [key, { code, oddLot }] of feeds) {
        if (quoteHolds.has(key)) continue;
        const hold: { release?: () => void } = {};
        quoteHolds.set(key, hold);
        void ensureContract(code).then(contract => {
            if (quoteHolds.get(key) !== hold) return;
            hold.release = oddLot ? retainQuote(contract, 'Tick', { oddLot: true }) : retainQuote(contract, 'Tick');
            retryDelay = 5000;
            if (feedMissing.delete(code)) publishFeed();
        }).catch(() => {
            if (quoteHolds.get(key) !== hold) return;
            quoteHolds.delete(key);
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
/** Protection unable to evaluate (stream not live or server mode unknown)
 * for longer than this in a row is treated as a restart (#144). */
export const LONG_DISCONNECT_MS = 60_000;
/** No tick nor heartbeat for this long (three heartbeat periods) while
 * nominally live — a silent stall or sleep — is treated as a restart too. */
export const SILENT_STALL_MS = 90_000;
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
    onAnyTick(tick => {
        noteActivity();
        if (!tick.simtrade) evaluateTick(tick.code, Number(tick.close));
    });
    onOddLotTick(tick => {
        noteActivity();
        if (!tick.simtrade) evaluateTick(tick.code, Number(tick.close), true);
    });
    onStreamEvent('heartbeat', () => noteActivity());
    onTrackedReport((report, _info, base) => applyExitReport(report, base));
    markRestore('restart');
    let prevEnv = currentProtectionEnv();
    onProtectionEnvChange(() => {
        const env = currentProtectionEnv();
        if (env !== prevEnv) { prevEnv = env; dropPrices(); }
        refreshEvaluation();
        syncQuotes();
    });
    watchProtectionEnv(); // stream down → mode forgotten → no dispatch until fresh /info
    subscribeStatusStore(() => {
        if (getStreamStatus() !== 'live') dropPrices();
        refreshEvaluation();
        if (getStreamStatus() === 'live') syncQuotes();
    });
    refreshEvaluation();
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
