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
    pauseBackgroundProgram,
    readBackgroundProgram,
    refreshBackground,
    resumeBackgroundProgram,
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
import { sameTradingDay } from './conditional/session';
import { trailStep, type TrailState } from './conditional/trailing';
import { getConditionalSettings } from './conditional/settings';
import { getApiBase } from './runtime';
import { fetchTrades } from './shioaji';
import { getStreamStatus, onAnyBidAsk, onAnyTick, onOddLotTick, onStreamEvent, subscribeStatusStore } from './stream';
import { notify, placeQuickOrder } from './trade';
import { getTradingState } from './trading-state';
import { fmtPrice } from './utils/format';
import { stepPrice } from './utils/ticksize';
import { bandTickFor, prefetchTickBands } from './tick-bands';
import { isOddLot, ODD_LOT_MAX_SHARES, oddLotMarketablePrice, SHARES_PER_LOT, sharesToUnits, stockQtyUnit } from './odd-lot';
import type { ContractBase } from './types/contract';
import type { Account } from './types/portfolio';
import type { Action, FuturesOCType, StockOrderLot, Trade } from './types/order';

/** Why protection resumed with a first-tick check (#144). */
/** `rearm`: a background trigger turned back on in a new session (#201). */
/** `resume`: the user resumed a paused trigger (#226). */
export type RestoreReason = 'restart' | 'disconnect' | 'env' | 'rearm' | 'resume';

export const RESTORE_REASON_TEXT: Record<RestoreReason, string> = {
    restart: 'App 關閉、重新載入或切換主視窗期間已穿價',
    disconnect: '行情連線中斷（或伺服器模式未確認）超過 1 分鐘期間已穿價',
    env: '先前不在此伺服器環境執行，切回時已穿價',
    rearm: '在新盤別重新啟用時價格已穿過觸發價',
    resume: '暫停期間價格已穿過觸發價',
};

/** #226 時間: 指定時間送單, or 收盤前平倉 (全平並取消 of this product /
 * account). Missed by more than TIME_GRACE_MS (App not running) → lapses. */
export type TimeSpec = { kind: 'send'; at: number } | { kind: 'flatten'; at: number; scope: 'code' | 'account' };
export const TIME_GRACE_MS = 60_000;

/** #226 括號單 placed by a trigger: tiers and rules for its protection. */
export interface BracketEntryPlan {
    tiers: { quantity: number; takeTicks: number | null }[];
    stopTicks: number;
    trail: { activateTicks: number; distanceTicks: number; stepTicks: number } | null;
    breakeven: { afterTier: number; offsetTicks: number } | null;
}

/** #226 send style: 市價, 範圍市價 (futures), or 觸價後限價 at the trigger
 * price moved `ticks` price steps (signed; a sell usually − to fill). */
export type TriggerSend = { type: 'MKT' } | { type: 'MKP' } | { type: 'LMT'; ticks: number };

export interface TriggerValidity {
    type: 'session' | 'today' | 'date';
    until: number; // ms epoch
}

/** One line of a conditional order's history (#226 management panel). */
export interface HistoryEntry {
    at: number;
    text: string;
    tone?: 'ok' | 'warn' | 'err';
}

/** A trigger that left the engine today (fired, cancelled, removed by OCO). */
export interface EndedTrigger {
    id: string;
    trigger: TriggerOrder;
    reason: 'fired' | 'cancelled' | 'oco' | 'expired';
    at: number;
    detail?: string;
}

export const HISTORY_LIMIT = 30;

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
    /** #226: 'entry' — a conditional order that opens a position (created in
     * the management panel): risk checks apply when it fires, and 全部暫停
     * pauses it. Absent: a protective stop / take (or an alert). */
    role?: 'entry';
    paused?: boolean; // #226: the user paused it; never evaluated until resumed
    /** #226 上穿／下穿: fires only on a crossing — the price must first be
     * seen on the other side (kept in `awaitingRecross` until then). */
    cross?: boolean;
    /** #226 price the condition watches: last trade (default) or the
     * opposite side of the book (sell → best bid, buy → best ask). */
    source?: 'last' | 'opposite';
    /** #226 how the order goes out when it fires (default market). */
    send?: TriggerSend;
    /** #226 the condition lapses at `until` (本盤／今日／指定日). */
    validity?: TriggerValidity;
    /** #226 OCO sibling handling: 'trigger' (default) removes the others
     * when one fires; 'fill' keeps them and takes away what actually filled. */
    ocoMode?: 'trigger' | 'fill';
    /** 'fill' OCO: the sibling exit this leg waits for (not evaluated meanwhile). */
    ocoLock?: string;
    /** 'fill' OCO: fills of that exit already taken off this leg. */
    ocoApplied?: { exit: string; filled: number };
    /** #226 移動停損 on a bracket stop: moves the price favourably only. */
    trail?: TrailState;
    /** #226 括號單 entry by trigger: the protection registered once the
     * entry order is accepted (see onEntryPlaced). */
    bracketPlan?: BracketEntryPlan;
    /** #226 時間條件: fires at `at` instead of on a price (price unused). */
    time?: TimeSpec;
    history?: HistoryEntry[]; // #226: newest last, capped at HISTORY_LIMIT
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
const ENDED_KEY = 'sj-pro-trigger-ended';
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
let ended: EndedTrigger[] = [];
function loadExecutorState() {
    triggers = loadTriggers();
    processedGroups = readJson<Record<string, number>>(GROUPS_KEY, {});
    // An exit still `sending` when the app went away has an unknown outcome.
    exits = readJson<ExitRecord[]>(EXITS_KEY, []).filter(e => e && typeof e.id === 'string')
        .map(e => e.status === 'sending' ? { ...e, status: 'unknown' as const, detail: '送單期間 App 重新載入，結果未知' } : e);
    const arr = readJson<unknown>(ENDED_KEY, []);
    ended = Array.isArray(arr) ? (arr as EndedTrigger[]).filter(e => e && typeof e.id === 'string' && e.trigger && typeof e.at === 'number') : [];
}
const listeners = new Set<() => void>();
const exitListeners = new Set<(exit: ExitRecord) => void>();

interface Snapshot {
    triggers: TriggerOrder[];
    exits: ExitRecord[];
    ended?: EndedTrigger[]; // #226: today's finished triggers (display)
    feedMissing: string[];
    executing: boolean;
    prices?: Record<string, number>; // latest tick of codes with a 待確認 trigger
    sending?: string[]; // 待確認 triggers whose 送出 is in progress (e.g. confirm dialog open)
}
let executing = false; // this window holds the executor lock
const feedMissing = new Set<string>(); // trigger codes without a tick subscription
let snapshot: Snapshot = { triggers, exits, ended: [], feedMissing: [], executing: false, prices: {}, sending: [] };
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
// #226 對手價: a sell watches the best bid, a buy the best ask.
export type Feed = 'trade' | 'odd' | 'bid' | 'ask';
function feedKey(code: string, feed: Feed | boolean): string {
    const f: Feed = feed === true ? 'odd' : feed === false ? 'trade' : feed;
    return f === 'trade' ? code : `${code}#${f}`;
}
/** Key of the price feed a trigger is evaluated on (see usePendingPrices). */
export function priceKeyOf(t: Pick<TriggerOrder, 'code' | 'orderLot' | 'kind' | 'source' | 'action'>): string {
    return feedKey(t.code, feedOf(t));
}
export function feedOf(t: Pick<TriggerOrder, 'orderLot' | 'kind' | 'source' | 'action'>): Feed {
    if (t.kind === 'alert') return 'trade';
    if (t.orderLot === 'IntradayOdd') return 'odd';
    if (t.source === 'opposite') return t.action === 'Sell' ? 'bid' : 'ask';
    return 'trade';
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
    | { op: 'publish-prices' }
    | { op: 'pause'; id: string }
    | { op: 'resume'; id: string }
    | { op: 'modify'; id: string; patch: TriggerPatch }
    | { op: 'add-group'; triggers: NewTrigger[] }
    // #226 二擇一: every leg in one executor step (no tick in between)
    | { op: 'group'; action: 'pause' | 'resume' | 'remove'; ids: string[] }
    | { op: 'modify-group'; patches: { id: string; patch: TriggerPatch }[] };

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
            ended: same(state.ended, snapshot.ended),
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
    ended = ended.filter(e => sameTradingDay(e.at, now)).slice(-ENDED_LIMIT);
    writeJson(ENDED_KEY, ended);
    snapshot = { triggers, exits, ended, feedMissing: [...feedMissing], executing, prices: pendingPrices(), sending: [...userSending] };
    syncQuotes();
    listeners.forEach(l => l());
    bus.publish();
}

const groupKey = (env: string | undefined, group: string) => `${env ?? ''}|${group}`;

const ENDED_LIMIT = 100;

/** Append a history line (newest last, capped); same text twice in a row
 * is kept once. */
function withHistory(t: TriggerOrder, text: string, tone?: HistoryEntry['tone'], at = Date.now()): TriggerOrder {
    const prev = t.history ?? [];
    if (prev.length && prev[prev.length - 1]!.text === text) return t;
    return { ...t, history: [...prev, { at, text, ...(tone ? { tone } : {}) }].slice(-HISTORY_LIMIT) };
}

function noteHistory(ids: Set<string>, text: string, tone?: HistoryEntry['tone']) {
    let changed = false;
    triggers = triggers.map(t => {
        if (!ids.has(t.id)) return t;
        const next = withHistory(t, text, tone);
        if (next !== t) changed = true;
        return next;
    });
    return changed;
}

/** Remember a finished manual trigger for 已結束（今日）. Bracket legs are
 * shown with their bracket instead. */
function recordEnded(t: TriggerOrder, reason: EndedTrigger['reason'], detail?: string) {
    if (t.bracketId) return;
    const at = Date.now();
    const text = reason === 'fired' ? '觸發送單' : reason === 'oco' ? '另一邊已觸發，自動刪除' : reason === 'expired' ? '有效期已過' : '已取消';
    ended = [...ended.filter(e => e.id !== t.id), { id: t.id, trigger: withHistory(t, detail ? `${text}：${detail}` : text,
        reason === 'fired' ? 'ok' : undefined, at), reason, at, ...(detail ? { detail } : {}) }].slice(-ENDED_LIMIT);
}

function prepareAdd(n: NewTrigger): TriggerOrder {
    const created: TriggerOrder = { ...n, id: newId(), createdAt: Date.now() };
    delete created.suspended;
    delete created.pending;
    delete created.awaitingRecross;
    delete created.paused;
    delete created.history;
    delete created.ocoLock;
    delete created.ocoApplied;
    // 上穿／下穿: the price must first be seen on the other side
    if (created.cross) created.awaitingRecross = true;
    const t = withHistory(created, `建立 · ${describe(created)}`, undefined, created.createdAt);
    if (!hasContext(t)) throw new Error('觸價單缺少帳戶或伺服器資訊，未建立');
    if (t.bracketId) throw new Error('括號單保護只由主視窗建立');
    const oddProblem = oddLotTriggerProblem(t);
    if (oddProblem) throw new Error(oddProblem);
    const optionProblem = triggerOptionsProblem(t);
    if (optionProblem) throw new Error(optionProblem);
    if (t.group && processedGroups[groupKey(t.env, t.group)]) throw new Error('此 OCO 群組已觸發過，不再建立');
    return t;
}

/** #226 options a market / product cannot take, refused when created. */
export function triggerOptionsProblem(t: Pick<TriggerOrder, 'send' | 'source' | 'validity' | 'orderLot' | 'account' | 'kind'> & { time?: TimeSpec }, now = Date.now()): string | null {
    if (t.validity && (!Number.isFinite(t.validity.until) || t.validity.until <= now)) return '有效期已過，未建立';
    if (t.time && (!Number.isFinite(t.time.at) || t.time.at <= now)) return '指定時間已過，未建立';
    if (t.kind === 'alert') return null;
    const odd = isOddLot(t.orderLot);
    if (odd && t.source === 'opposite') return '零股觸價單只支援成交價';
    if (odd && t.send && t.send.type !== 'MKT') return '零股以漲跌停價限價送出，不能另選送出方式';
    if (t.send?.type === 'MKP' && t.account?.account_type !== 'F') return '範圍市價只適用期貨選擇權';
    if (t.send?.type === 'LMT' && (!Number.isSafeInteger(t.send.ticks) || Math.abs(t.send.ticks) > 50)) return '限價檔數須為 −50～50 的整數';
    return null;
}

/** Lapse every manual trigger whose validity ended (true when any did). */
function expireDue(now = Date.now()): boolean {
    const due = triggers.filter(t => !t.bracketId && t.validity && t.validity.until <= now);
    if (!due.length) return false;
    triggers = triggers.filter(t => !due.includes(t));
    for (const t of due) {
        recordEnded(t, 'expired');
        restoreCheck.delete(t.id);
    }
    commit();
    for (const t of due) notify({ kind: 'info', title: '條件單已到期', body: `${describe(t)}：有效期已過，已移除，沒有送單` });
    return true;
}
export const EXPIRY_CHECK_MS = 5000;
export const TIME_CHECK_MS = 1000;

// #226 time orders: run in the executing main window
type TimedFlatten = (t: TriggerOrder) => void;
let timedFlatten: TimedFlatten | null = null;
export function onTimedFlatten(handler: TimedFlatten): void {
    timedFlatten = handler;
}

/** Fire every time order that is due; lapse the ones missed. */
function checkTimed(now = Date.now()) {
    if (!executing) return;
    const env = getStreamStatus() === 'live' ? currentProtectionEnv() : null;
    for (const t of triggers.slice()) {
        if (!t.time || t.paused || t.suspended || t.time.at > now) continue;
        if (!triggers.some(x => x.id === t.id)) continue;
        if (now - t.time.at > TIME_GRACE_MS) {
            triggers = triggers.filter(x => x.id !== t.id);
            recordEnded(t, 'expired', '時間已過（App 當時沒有執行或連線中斷），沒有送出');
            commit();
            notify({ kind: 'err', title: '時間條件單沒有執行', body: `${describe(t)}：時間已過，沒有送出` });
            continue;
        }
        if (t.env !== env) continue; // waits (within the grace) for the stream / environment
        if (t.time.kind === 'flatten') {
            triggers = triggers.filter(x => x.id !== t.id);
            recordEnded(t, 'fired', '時間到，全平並取消');
            commit();
            if (timedFlatten) timedFlatten(t);
            else notify({ kind: 'err', title: '收盤前平倉沒有執行', body: `${describe(t)}：主視窗尚未準備好，請手動處理` });
            continue;
        }
        fire(t, lastPrices.get(priceKeyOf(t)) ?? 0);
    }
}

/** 'fill' OCO: once the exit a leg waits for is final, take what filled off
 * it (removed at zero) and let it watch again; later fills of that exit
 * keep being taken off. */
/** A final exit is trusted for unlocking only after this long: a Cancel
 * report can arrive before the last deal report of the same order. */
export const OCO_SETTLE_MS = 3000;
export const OCO_RECHECK_MS = 10_000;
// exits whose final fills were read back authoritatively (or decided by the user)
const ocoReconciled = new Set<string>();
const ocoReading = new Set<string>();
/** An ended exit (Cancel / IOC remainder) unlocks the other side only after
 * an authoritative read of that order (fills that arrive late are counted);
 * a failed read keeps it locked and tries again. */
async function reconcileOcoExit(id: string, attempt = 1) {
    const rec = exits.find(e => e.id === id);
    if (!rec || !executing || ocoReconciled.has(id)) { ocoReading.delete(id); return; }
    try {
        const query = createAccountQuery();
        const rows = await query.read(rec.account.account_type, rec.account,
            current => fetchTrades(rec.account.account_type, current, { refresh: true }));
        const trade = rows.find(t => t.order.id === rec.orderId);
        if (!trade && rec.orderId) throw new Error('委託清單找不到這筆');
        if (trade) applyExitTrade(trade, { settle: true });
        ocoReconciled.add(id);
        ocoReading.delete(id);
        const cur = exits.find(e => e.id === id);
        if (cur) settleOco(cur);
    } catch {
        ocoReading.delete(id);
        if (attempt === 3 && noteHistory(new Set(triggers.filter(t => t.ocoLock === id).map(t => t.id)),
            '無法確認另一邊實際成交多少，仍暫停；請到委託核對後取消或保留', 'warn')) commit();
        ocoReading.add(id);
        setTimeout(() => void reconcileOcoExit(id, attempt + 1), OCO_RECHECK_MS);
    }
}
function settleOco(rec: ExitRecord) {
    let final = rec.status === 'filled' || rec.status === 'incomplete' || rec.status === 'not-sent'
        || (rec.status === 'unknown' && !!rec.acknowledged);
    const userDecided = rec.status === 'unknown' && !!rec.acknowledged;
    if (final && rec.status !== 'filled' && rec.status !== 'not-sent' && !userDecided && !ocoReconciled.has(rec.id)
        && triggers.some(t => t.ocoLock === rec.id)) {
        if (!ocoReading.has(rec.id)) {
            ocoReading.add(rec.id);
            setTimeout(() => void reconcileOcoExit(rec.id), OCO_SETTLE_MS);
        }
        final = false;
    }
    let changed = false;
    triggers = triggers.flatMap(t => {
        if (t.ocoLock === rec.id) {
            if (!final) return [t];
            changed = true;
            const rem = t.quantity - rec.filled;
            if (rem <= 0) { recordEnded(t, 'oco', `另一邊成交 ${rec.filled}`); return []; }
            if (t.cross) t = { ...t, awaitingRecross: true };
            else restoreCheck.set(t.id, 'resume');
            return [withHistory({ ...t, quantity: rem, ocoLock: undefined, ocoApplied: { exit: rec.id, filled: rec.filled } },
                rec.filled > 0 ? `另一邊成交 ${rec.filled}，剩 ${rem} 繼續盯價` : '另一邊沒有成交，繼續盯價')];
        }
        if (t.ocoApplied?.exit === rec.id && rec.filled > t.ocoApplied.filled) {
            changed = true;
            const delta = rec.filled - t.ocoApplied.filled;
            const rem = t.quantity - delta;
            if (rem <= 0) { recordEnded(t, 'oco', `另一邊成交 ${rec.filled}`); return []; }
            return [withHistory({ ...t, quantity: rem, ocoApplied: { exit: rec.id, filled: rec.filled } }, `另一邊又成交 ${delta}，剩 ${rem}`)];
        }
        return [t];
    });
    if (changed) commit();
}

/** What the panel may change on a manual trigger (#226). */
export interface TriggerPatch {
    price?: number;
    quantity?: number;
    send?: TriggerSend;
    validity?: TriggerValidity | null;
}

function applyModify(id: string, patch: TriggerPatch): TriggerOrder {
    const t = triggers.find(x => x.id === id);
    if (!t) throw new Error('找不到這張觸價單（可能已觸發或已刪除）');
    if (t.bracketId) throw new Error('括號單的停損停利請在括號單列修改');
    if (t.pending) throw new Error('待確認中的觸價單請先處理（送出、保留或取消）');
    const next: TriggerOrder = { ...t };
    const changes: string[] = [];
    if (patch.price !== undefined) {
        if (!Number.isFinite(patch.price) || patch.price <= 0) throw new Error('觸發價必須是正數');
        if (patch.price !== t.price) changes.push(`觸發價 ${fmtPrice(t.price)} → ${fmtPrice(patch.price)}`);
        next.price = patch.price;
    }
    if (patch.quantity !== undefined) {
        if (t.kind === 'alert') throw new Error('價格警示沒有數量');
        if (!Number.isSafeInteger(patch.quantity) || patch.quantity <= 0) throw new Error('數量必須是正整數');
        if (patch.quantity !== t.quantity) changes.push(`數量 ${t.quantity} → ${patch.quantity}`);
        next.quantity = patch.quantity;
        const odd = oddLotTriggerProblem(next);
        if (odd) throw new Error(odd);
    }
    if (patch.send !== undefined && JSON.stringify(patch.send) !== JSON.stringify(t.send ?? { type: 'MKT' })) {
        next.send = patch.send;
        changes.push(`送出方式改為${exitStyleLabel(next)}`);
    }
    if (patch.validity !== undefined && JSON.stringify(patch.validity) !== JSON.stringify(t.validity ?? null)) {
        if (patch.validity) next.validity = patch.validity;
        else delete next.validity;
        changes.push(patch.validity ? '修改有效期' : '有效期改為直到取消');
    }
    const optionProblem = triggerOptionsProblem(next);
    if (optionProblem) throw new Error(optionProblem.replace('，未建立', ''));
    if (!changes.length) return t;
    // A new price may already be crossed: like a restore, the first tick
    // decides (past → 待確認, never sent by the edit itself). A crossing
    // trigger needs a fresh crossing instead.
    if (t.cross) next.awaitingRecross = true;
    else if (t.kind !== 'alert' && !t.paused) restoreCheck.set(id, 'resume');
    const done = withHistory(next, `修改${changes.join('、')}`);
    triggers = triggers.map(x => x.id === id ? done : x);
    commit();
    return done;
}

/** All legs or none: on any refusal the earlier legs are put back. */
function applyGroup(cmd: Extract<Command, { op: 'group' } | { op: 'modify-group' }>): boolean {
    const saved = triggers;
    const savedEnded = ended;
    try {
        if (cmd.op === 'modify-group') {
            for (const { id, patch } of cmd.patches) applyModify(id, patch);
        } else if (cmd.action === 'remove') {
            const gone = triggers.filter(t => cmd.ids.includes(t.id));
            if (gone.some(t => t.bracketId)) throw new Error('括號單保護請在括號單列移除');
            triggers = triggers.filter(t => !cmd.ids.includes(t.id));
            for (const t of gone) recordEnded(t, 'cancelled');
            commit();
        } else {
            for (const id of cmd.ids) pauseTrigger(id, cmd.action === 'pause');
        }
        return true;
    } catch (e) {
        triggers = saved;
        ended = savedEnded;
        commit();
        throw e;
    }
}

/** #226 二擇一: pause / resume / remove both legs together. */
export async function setTriggerGroup(ids: string[], action: 'pause' | 'resume' | 'remove'): Promise<void> {
    await bus.send({ op: 'group', action, ids });
}

/** #226 二擇一: change both legs together (all or none). */
export async function modifyTriggerGroup(patches: { id: string; patch: TriggerPatch }[]): Promise<void> {
    await bus.send({ op: 'modify-group', patches });
}

function pauseTrigger(id: string, on: boolean): TriggerOrder {
    const t = triggers.find(x => x.id === id);
    if (!t) throw new Error('找不到這張觸價單（可能已觸發或已刪除）');
    if (t.bracketId) throw new Error('括號單的停損停利不能單獨暫停');
    if (on) {
        if (t.paused) return t;
        if (t.pending) throw new Error('待確認中的觸價單請先處理（送出、保留或取消）');
        restoreCheck.delete(id);
        const next = withHistory({ ...t, paused: true }, '已暫停，不再盯價', 'warn');
        triggers = triggers.map(x => x.id === id ? next : x);
        commit();
        return next;
    }
    if (!t.paused) return t;
    // resumed: price may have crossed meanwhile — the first tick decides
    // (a crossing trigger waits for a fresh crossing)
    if (t.kind !== 'alert' && !t.cross) restoreCheck.set(id, 'resume');
    const next = withHistory({ ...t, paused: undefined, ...(t.cross ? { awaitingRecross: true } : {}) }, '恢復盯價', 'ok');
    triggers = triggers.map(x => x.id === id ? next : x);
    commit();
    return next;
}

function newId() {
    return `tg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 停損 / 停利, or 觸價單 for an entry (#226). */
export function roleWord(t: Pick<TriggerOrder, 'kind' | 'role'>): string {
    return t.role === 'entry' ? '觸價單' : t.kind === 'stop' ? '停損' : '停利';
}

function kindLabel(t: Pick<TriggerOrder, 'kind' | 'role'>) {
    return t.role === 'entry' ? '觸價單已設' : t.kind === 'stop' ? '停損單已掛' : t.kind === 'take' ? '停利單已掛' : '警示已設';
}

function qtyText(t: Pick<TriggerOrder, 'quantity' | 'orderLot'>, quantity = t.quantity): string {
    return isOddLot(t.orderLot) ? `${quantity} 股` : `${quantity}`;
}

function describe(t: TriggerOrder) {
    if (t.time) {
        const hhmm = new Date(t.time.at + 8 * 3600_000).toISOString().slice(11, 16);
        return t.time.kind === 'flatten'
            ? `${t.code} ${hhmm} 全平並取消（${t.time.scope === 'code' ? '此商品' : '此帳戶'}）`
            : `${t.code} ${hhmm} 送出 ${exitStyleLabel(t)}${t.action === 'Buy' ? '買' : '賣'} ${qtyText(t)}`;
    }
    return t.kind === 'alert'
        ? `${t.code} 觸價 ${t.condition === 'below' ? '≤' : '≥'} ${t.price} 時通知`
        : `${t.code} ${t.source === 'opposite' ? '對手價' : '觸價'} ${t.cross ? (t.condition === 'below' ? '下穿' : '上穿') : t.condition === 'below' ? '≤' : '≥'} ${t.price} → ${exitStyleLabel(t)}${t.action === 'Buy' ? '買' : '賣'} ${qtyText(t)}${t.group ? '（OCO）' : ''}`;
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
        const t = prepareAdd(cmd.trigger);
        triggers = [...triggers, t];
        commit();
        if (getConditionalSettings().notify) notify({ kind: 'info', title: kindLabel(t), body: describe(t) });
        return t;
    }
    if (cmd.op === 'add-group') {
        // #226 二擇一: both legs are checked first, then added together
        const again = cmd.triggers[0]?.requestId && triggers.filter(x => x.requestId && cmd.triggers.some(n => n.requestId === x.requestId));
        if (again && again.length) return again;
        if (cmd.triggers.length < 2) throw new Error('二擇一需要兩邊條件');
        const group = cmd.triggers[0]!.group;
        if (!group || cmd.triggers.some(n => n.group !== group || n.env !== cmd.triggers[0]!.env)) throw new Error('二擇一兩邊必須同一組、同一環境');
        const made = cmd.triggers.map(prepareAdd);
        triggers = [...triggers, ...made];
        commit();
        if (getConditionalSettings().notify) notify({ kind: 'info', title: '二擇一已設', body: made.map(describe).join('；') });
        return made;
    }
    if (cmd.op === 'remove') {
        // A bracket's OCO pair belongs to its plan: removing one side here
        // would leave the plan believing it is protected (and could re-arm).
        if (triggers.some(t => t.id === cmd.id && t.bracketId)) throw new Error('括號單保護請在下單面板的括號單狀態中移除追蹤');
        const gone = triggers.find(t => t.id === cmd.id);
        triggers = triggers.filter(t => t.id !== cmd.id);
        if (gone) recordEnded(gone, 'cancelled');
        commit();
        return true;
    }
    if (cmd.op === 'pause' || cmd.op === 'resume') return pauseTrigger(cmd.id, cmd.op === 'pause');
    if (cmd.op === 'modify') return applyModify(cmd.id, cmd.patch);
    if (cmd.op === 'group' || cmd.op === 'modify-group') return applyGroup(cmd);
    if (cmd.op === 'ack-exit') {
        exits = exits.map(e => e.id === cmd.id && e.status === 'unknown' ? { ...e, acknowledged: true, at: Date.now() } : e);
        const rec = exits.find(e => e.id === cmd.id);
        commit();
        if (rec) { emitExit(rec); settleOco(rec); }
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

/** #226 二擇一: both legs (same `group`) are created together in this
 * window's engine, or neither. */
export async function addTriggerGroup(legs: NewTrigger[], contract: ContractBase, opts?: { account?: Account }): Promise<TriggerOrder[] | null> {
    const prepared: NewTrigger[] = [];
    for (const leg of legs) {
        const p = withContext(leg, contract, opts?.account);
        if (typeof p === 'string') {
            notify({ kind: 'err', title: '二擇一未建立', body: p });
            return null;
        }
        const requestId = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : newId();
        prepared.push({ ...p, requestId });
    }
    try {
        return await bus.send({ op: 'add-group', triggers: prepared }) as TriggerOrder[];
    } catch (e) {
        notify({ kind: 'err', title: '二擇一未確認', body: e instanceof Error ? e.message : String(e) });
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

/** Pause / resume a trigger (#226). A resumed trigger's first tick decides:
 * already past → 待確認, never sent by the resume itself. */
export async function setTriggerPaused(id: string, paused: boolean): Promise<void> {
    if (isBackgroundId(id)) {
        const row = backgroundRow(id);
        if (!row) throw new Error('找不到這張觸價單');
        await (paused ? pauseBackgroundProgram(row.background.programId) : resumeBackgroundProgram(row.background.programId));
        return;
    }
    await bus.send({ op: paused ? 'pause' : 'resume', id });
}

/** Change a manual trigger's price / quantity (#226). Nothing is sent by the
 * edit: when the new price is already crossed, the next tick holds it as
 * 待確認. A background trigger is replaced (paused, re-created with the new
 * values, then removed), so it is never armed twice at the same time. */
export async function modifyTrigger(id: string, patch: TriggerPatch): Promise<void> {
    if (!isBackgroundId(id)) {
        await bus.send({ op: 'modify', id, patch });
        return;
    }
    const row = backgroundRow(id);
    if (!row) throw new Error('找不到這張觸價單');
    if (row.pending) throw new Error('待確認中的觸價單請先處理（送出、保留或取消）');
    if (patch.send !== undefined || patch.validity !== undefined) throw new Error('這張單只能修改觸發價與數量');
    const contract = await ensureContract(row.code);
    const programId = row.background.programId;
    const original = getBackgroundPrograms().find(p => p.id === programId);
    const level = original?.levels.find(lv => lv.id === row.background.levelId);
    if (!original || !level || level.entry.type !== 'touch') throw new Error('找不到這張觸價單');
    const next: TriggerOrder = { ...row, ...(patch.price !== undefined ? { price: patch.price } : {}),
        ...(patch.quantity !== undefined ? { quantity: patch.quantity } : {}), id: newId(), createdAt: Date.now() };
    delete (next as Partial<BackgroundTriggerOrder>).background;
    delete next.awaitingRecross;
    // never armed already crossed: refused here, and the new program's first
    // tick decides like a restore (already past → 待確認)
    const latest = getBackgroundPrices()[row.code] ?? lastPrices.get(row.code);
    if (latest !== undefined && isPast(next, latest)) throw new Error(`新的觸發價已穿過目前價格（${latest}），沒有修改`);
    const made = programForNewTrigger(next, contract);
    if (!made) throw new Error('背景執行：這張單無法修改，請取消後重新建立');
    // keep the original order (e.g. a closing-only Cover stays Cover)
    const program = { ...made, levels: made.levels.map(lv => lv.entry.type === 'touch'
        ? { ...lv, check: 'resume' as const, entry: { ...lv.entry, order: level.entry.type === 'touch' ? level.entry.order : lv.entry.order } } : lv) };
    try {
        await pauseBackgroundProgram(programId);
    } catch (e) {
        throw new Error(`背景執行中的單目前不能直接修改（${e instanceof Error ? e.message : String(e)}），請取消後重新建立`);
    }
    // it may have fired while this was on its way: replace it only when it is
    // still an untouched, armed condition
    let fresh: Awaited<ReturnType<typeof readBackgroundProgram>>;
    try {
        fresh = await readBackgroundProgram(programId);
    } catch (e) {
        // cannot be sure it did not fire: leave it paused for the user to check
        throw new Error(`修改沒有完成：無法確認原本的單狀態（${e instanceof Error ? e.message : String(e)}）。原本的單已暫停，請確認後按恢復或取消`);
    }
    const now = fresh?.status === 'paused' ? fresh.levels.find(lv => lv.id === row.background.levelId) : undefined;
    if (!now || now.phase !== 'idle' || now.pending || now.orders.length > 0 || now.position > 0) {
        await resumeBackgroundProgram(programId).catch(() => undefined);
        throw new Error('這張觸價單在修改期間已觸發或狀態已變，沒有修改；請看清單與委託');
    }
    const result = await createBackgroundTrigger(program);
    if (result !== 'created') {
        // the old one stays paused: tell the user instead of resuming blindly
        throw new Error('refused' in result
            ? `修改未完成：${result.refused}。原本的單已暫停，請確認後按恢復或取消`
            : `修改結果未確認：${result.unconfirmed}。原本的單已暫停；請先看清單是否已有新單，不要重複建立`);
    }
    await removeBackgroundTrigger(programId);
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

const NO_ENDED: EndedTrigger[] = [];
/** Today's finished manual triggers (newest last). */
export function useEndedTriggers(): EndedTrigger[] {
    return useSyncExternalStore(subscribe, () => snapshot.ended ?? NO_ENDED);
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
    /** #226: the user changed the prices — the first tick decides (already
     * past → 待確認), like a restore. */
    edited?: boolean;
    /** #226 移動停損 for the stop leg (state kept across resizes). */
    trail?: TrailState;
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
            condition: arm.entryAction === 'Buy' ? 'below' : 'above', ...(arm.trail ? { trail: arm.trail } : {}) });
    }
    if (arm.takePrice !== null) {
        added.push({ ...base, id: newId(), kind: 'take', price: arm.takePrice,
            condition: arm.entryAction === 'Buy' ? 'above' : 'below' });
    }
    if (!added.length) return false;
    // Armed from a fill recovered after a (re)start (cache lookup, buffered
    // reports) or while the restore window is open: the first tick decides
    // (#144). Exits armed from live fills fire as usual.
    if (arm.edited) {
        for (const t of added) restoreCheck.set(t.id, 'resume');
    } else if (arm.restore || restoreWindowOpen()) {
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
    // 'fill' OCO (#226): the other side stays (locked) and later loses what fills
    const fillMode = !!t.group && t.ocoMode === 'fill';
    const siblings = t.group && !fillMode ? triggers.filter(x => x.group === t.group && x.env === t.env && x.id !== t.id) : [];
    triggers = triggers.filter(x => x.id !== t.id && !siblings.includes(x));
    if (gk && !fillMode) processedGroups[gk] = Date.now();
    recordEnded(t, 'fired', t.time ? '時間到' : `現價 ${fmtPrice(lastPrice)}`);
    for (const x of siblings) recordEnded(x, 'oco');
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
    if (fillMode && plan.quantity > 0) {
        triggers = triggers.map(x => x.group === t.group && x.env === t.env
            ? withHistory({ ...x, ocoLock: rec.id }, '另一邊已觸發，等它成交後扣掉對應口數', 'warn') : x);
    }
    commit();
    if (siblings.length) {
        notify({ kind: 'info', title: 'OCO 互斥撤銷', body: `${t.code} 另一邊觸價單已自動移除` });
    }
    emitExit(rec);
    if (plan.quantity <= 0) {
        notify({ kind: 'err', title: `${roleWord(t)}未送出`, body: `${t.code} ${plan.detail ?? ''}` });
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

/** How a firing trigger's order goes out: price (null = market), MKP and
 * the time in force. A string: refused, nothing is sent. */
export interface OrderPlan {
    price: number | null;
    futuresPriceType?: 'MKP';
    orderType?: 'ROD' | 'IOC';
}
export function orderPlanFor(t: Pick<TriggerOrder, 'orderLot' | 'action' | 'price' | 'send' | 'ocoMode' | 'group'>,
    contract: ContractBase & { limit_up?: number; limit_down?: number }): OrderPlan | string {
    if (isOddLot(t.orderLot)) {
        const p = oddLotMarketablePrice(contract, t.action);
        return p === null || p === undefined ? ODD_PRICE_MISSING : { price: p };
    }
    const send = t.send ?? { type: 'MKT' as const };
    if (send.type === 'MKT') return { price: null };
    if (send.type === 'MKP') {
        if (contract.security_type !== 'FUT' && contract.security_type !== 'OPT') return '範圍市價只適用期貨選擇權，未送出';
        return { price: null, futuresPriceType: 'MKP' };
    }
    // 觸價後限價: the trigger price moved `ticks` legal price steps — on the
    // exchange's band table when the product has one (never a guessed tick)
    const rule = (contract as { tick_rule?: string }).tick_rule;
    if (rule && send.ticks !== 0 && bandTickFor(rule, t.price) === undefined) {
        if (contract.security_type === 'FUT' || contract.security_type === 'OPT') prefetchTickBands(rule, contract.security_type);
        return '跳動點級距尚未載入，限價未送出';
    }
    const price = send.ticks === 0 ? t.price : stepPrice(contract, t.price, send.ticks);
    if (!Number.isFinite(price) || price <= 0) return '限價計算結果無效，未送出';
    const up = Number(contract.limit_up);
    const down = Number(contract.limit_down);
    if ((up > 0 && price > up) || (down > 0 && price < down)) return `限價 ${price} 超出漲跌停（${down}～${up}），未送出`;
    // a 'fill' OCO takes off what filled: the order must end (IOC), not rest
    return { price, orderType: t.group && t.ocoMode === 'fill' ? 'IOC' : 'ROD' };
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
        settleOco(changed);
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

function exitSent(t: TriggerOrder, rec: ExitRecord, trade: Trade, lastPrice: number, op?: OrderPlan) {
    const orderId = trade.order.id;
    const odd = isOddLot(t.orderLot);
    const resting = !odd && op?.price !== null && op?.price !== undefined && op.orderType === 'ROD';
    updateExit(rec.id, e => ({ ...e, status: e.filled >= e.quantity ? 'filled' : 'working', orderId, at: Date.now(),
        // odd-lot exits are ROD limits at the price limit: the rest keeps
        // working until filled or cancelled (reports / 對帳), no IOC settle
        ...(odd && e.filled < e.quantity ? { detail: `${e.detail ? `${e.detail}；` : ''}零股以漲跌停價限價 ROD 送出，依成交回報更新` } : {}) }));
    for (const report of recentReportsFor(envBase(rec.env), orderId)) applyExitReport(report, envBase(rec.env));
    // a resting 觸價後限價 (ROD) settles by its reports / 對帳, not the IOC check
    if (!odd && !resting) scheduleIocCheck(rec.id);
    if (t.bracketPlan) {
        try { entryPlaced?.(t, trade); } catch (e) {
            notify({ kind: 'err', title: '括號單保護未登記', body: `${t.code} 進場單已送出；${e instanceof Error ? e.message : String(e)}。請到委託／持倉確認後自行處理出場` });
        }
    }
    if (getConditionalSettings().notify) notify({ kind: 'ok', title: `${roleWord(t)}觸發`,
        body: `${t.code} ${t.time ? '時間到' : `@${lastPrice}`} → ${exitStyleLabel(t)}${t.action === 'Buy' ? '買' : '賣'} ${qtyText(t, rec.quantity)} (${trade.status.status})` });
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
    const op = orderPlanFor(t, ctx.contract);
    if (typeof op === 'string') { notSentExit(t, rec, op); return; }
    // the condition may have lapsed while the contract was being checked
    if (t.validity && Date.now() >= t.validity.until) { notSentExit(t, rec, '有效期已過，未送出'); return; }
    try {
        const trade = await placeQuickOrder(ctx.contract, t.action, op.price, rec.quantity, {
            // protective exit — never blocked by kill switch; an entry is a
            // new position: kill switch and loss limits apply
            bypassRisk: t.role !== 'entry',
            source: 'auto', // 使用者可能不在場，不彈確認
            account: ctx.account,
            ocType: t.octype,
            orderLot: isOddLot(t.orderLot) ? t.orderLot : undefined,
            ...(op.futuresPriceType ? { futuresPriceType: op.futuresPriceType } : {}),
            ...(op.orderType && op.price !== null ? { orderType: op.orderType } : {}),
            beforeSend: () => {
                if (t.validity && Date.now() >= t.validity.until) throw new Error('有效期已過，未送出');
            },
        });
        exitSent(t, rec, trade, lastPrice, op);
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
    const op = orderPlanFor(first, ctx.contract);
    if (typeof op === 'string') { refused(op); return; }
    // A manual trigger may be an entry: it is a user order (risk checks,
    // manual confirm). Bracket exits stay protective.
    const userOrder = !first.bracketId;
    const box: { fired: { t: TriggerOrder; rec: ExitRecord; siblings: TriggerOrder[]; gk: string | null; price: number } | null } = { fired: null };
    try {
        const trade = await placeQuickOrder(ctx.contract, first.action, op.price, planned.quantity, {
            bypassRisk: !userOrder,
            source: userOrder ? 'manual' : 'auto',
            account: ctx.account,
            ocType: first.octype,
            orderLot: isOddLot(first.orderLot) ? first.orderLot : undefined,
            ...(op.futuresPriceType ? { futuresPriceType: op.futuresPriceType } : {}),
            ...(op.orderType && op.price !== null ? { orderType: op.orderType } : {}),
            confirmLivePriceCode: userOrder ? priceKeyOf(first) : undefined,
            beforeSend: () => {
                const cur = triggers.find(x => x.id === id);
                if (!cur?.pending) throw new Error('已不在待確認（OCO 另一邊可能已觸發或已被處理），未送出');
                if (currentProtectionEnv() !== cur.env) throw new Error('伺服器或模擬／正式模式已切換，未送出');
                if (cur.group && processedGroups[groupKey(cur.env, cur.group)]) throw new Error('此 OCO 群組已觸發，未送出');
                if (cur.ocoLock) throw new Error('二擇一另一邊的委託還在處理，未送出');
                if (cur.validity && Date.now() >= cur.validity.until) throw new Error('有效期已過，未送出');
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
        if (box.fired) exitSent(box.fired.t, box.fired.rec, trade, box.fired.price, op);
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
        // a 'fill' OCO sibling locked on this (never sent) order watches again
        triggers = triggers.map(x => {
            if (x.ocoLock !== f.rec.id) return x;
            if (!x.cross) restoreCheck.set(x.id, 'resume');
            return { ...x, ocoLock: undefined, ...(x.cross ? { awaitingRecross: true } : {}) };
        });
        const back = [{ ...f.t, pending: first.pending }, ...f.siblings].filter(x => !triggers.some(y => y.id === x.id));
        triggers = [...triggers, ...back];
        commit();
        notify({ kind: 'err', title: '觸價單未送出（仍待確認）', body: `${f.t.code} ${message}` });
        const latest = lastPrices.get(priceKeyOf(f.t));
        if (latest !== undefined) evaluateFeed(f.t.code, latest, feedOf(f.t));
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

/** A stop with 移動停損 after one price: the moved trigger, or null when
 * nothing changed. The state (extreme / anchor) is kept even when the stop
 * does not move. */
function trailed(t: TriggerOrder, price: number): TriggerOrder | null {
    const contract = getCachedContract(t.code);
    if (!contract || !t.trail) return null;
    const long = t.condition === 'below'; // a long position's stop sells below
    const r = trailStep(long, t.price, t.trail, price, (p, n) => stepPrice(contract, p, n));
    if (r.stop === t.price && JSON.stringify(r.state) === JSON.stringify(t.trail)) return null;
    const next: TriggerOrder = { ...t, trail: r.state };
    if (r.stop === t.price) return next;
    // never against the position
    if (long ? r.stop < t.price : r.stop > t.price) return next;
    next.price = r.stop;
    return withHistory(next, `移動停損${long ? '上移' : '下移'}至 ${fmtPrice(r.stop)}${!t.trail.active ? '（已啟動）' : ''}`, 'ok');
}

/** 保本 and other one-way moves of a bracket's stop (main window only):
 * applied only when it is in the position's favour. */
export function tightenBracketStop(env: string, group: string, price: number, why: string): boolean {
    if (!main || !Number.isFinite(price) || price <= 0) return false;
    const stop = triggers.find(t => t.group === group && t.env === env && t.kind === 'stop' && t.bracketId);
    if (!stop) return false;
    const long = stop.condition === 'below';
    if (long ? price <= stop.price : price >= stop.price) return false;
    const next = withHistory({ ...stop, price }, `${why}：停損 ${fmtPrice(stop.price)} → ${fmtPrice(price)}`, 'ok');
    triggers = triggers.map(t => t.id === stop.id ? next : t);
    // the new stop may already be crossed: the first tick decides
    restoreCheck.set(stop.id, 'resume');
    commit();
    return true;
}

// #226: a trigger-placed 括號單 entry registers its protection here
type EntryPlaced = (t: TriggerOrder, trade: Trade) => void;
let entryPlaced: EntryPlaced | null = null;
export function onEntryPlaced(handler: EntryPlaced): void {
    entryPlaced = handler;
}

const isPast = (t: Pick<TriggerOrder, 'condition' | 'price'>, price: number) =>
    (t.condition === 'below' && price <= t.price) || (t.condition === 'above' && price >= t.price);

/** `oddLot`: a 盤中零股 trade — evaluates only odd-lot triggers of `code`;
 * a regular-lot trade evaluates everything else (#204). */
export function evaluateTick(code: string, price: number, oddLot = false) {
    evaluateFeed(code, price, oddLot ? 'odd' : 'trade');
}

/** #226: one price of one feed (trade, odd-lot trade, best bid / ask). */
export function evaluateFeed(code: string, price: number, feed: Feed) {
    if (!main || !executing || !Number.isFinite(price) || price <= 0) return;
    expireDue();
    const key = feedKey(code, feed);
    const previous = lastPrices.get(key);
    lastPrices.set(key, price);
    if (triggers.length === 0) return;
    const env = currentProtectionEnv(); // null → only alerts may fire
    let rearmed = false;
    const held: { t: TriggerOrder; reason: RestoreReason }[] = [];
    for (const t of triggers.slice()) {
        if (t.code !== code || feedOf(t) !== feed || t.suspended || t.pending || t.paused || t.ocoLock || t.time) continue;
        if (t.kind !== 'alert' && t.env !== env) continue;
        const past = isPast(t, price);
        if (t.awaitingRecross) {
            // kept after 待確認: seeing the non-trigger side arms it again
            if (!past) {
                triggers = triggers.map(x => x.id === t.id ? withHistory({ ...x, awaitingRecross: undefined }, '價格回到另一側，恢復盯價', 'ok') : x);
                rearmed = true;
            }
            continue;
        }
        const reason = restoreCheck.get(t.id);
        if (reason && restoreCheck.delete(t.id) && past && t.kind !== 'alert') {
            held.push({ t, reason });
            continue;
        }
        if (!past) {
            // 移動停損: only after the existing stop was checked; then the new
            // stop is checked against the same price (at most one send)
            const moved = t.trail ? trailed(t, price) : null;
            if (!moved) continue;
            triggers = triggers.map(x => x.id === t.id ? moved : x);
            rearmed = true;
            if (!isPast(moved, price)) continue;
            fire(moved, price);
            continue;
        }
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
    return `${t.code} ${acct}${roleWord(t)} ${exitStyleLabel(t)}${t.action === 'Buy' ? '買' : '賣'} ${qtyText(t)}`
        + ` 觸價 ${t.condition === 'below' ? '≤' : '≥'} ${t.price} · ${now}`;
}

function pendingName(t: TriggerOrder): string {
    return contractLabel(t.code, getCachedContract(t.code));
}

function holdPending(held: { t: TriggerOrder; reason: RestoreReason }[], price: number) {
    const at = Date.now();
    const why = new Map(held.map(h => [h.t.id, h.reason]));
    triggers = triggers.map(t => why.has(t.id)
        ? withHistory({ ...t, pending: { price, at, reason: why.get(t.id) } }, `${RESTORE_REASON_TEXT[why.get(t.id) ?? 'restart']}，未自動送出`, 'err', at)
        : t);
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
    // a crossing trigger is never held: it needs a fresh crossing after a gap
    triggers = triggers.map(t => t.cross && !t.awaitingRecross && !t.pending && (env === undefined || t.env === env)
        ? { ...t, awaitingRecross: true } : t);
    for (const t of triggers) {
        if (t.kind === 'alert' || t.suspended || t.pending || t.awaitingRecross || t.paused || t.time) continue;
        if (env === undefined || t.env === env) restoreCheck.set(t.id, reason);
    }
}

function resolvePending(id: string, choice: PendingChoice, allowUnpast = false): unknown {
    const t = triggers.find(x => x.id === id);
    if (!t?.pending) throw new Error('此觸價單已不在待確認狀態');
    if (choice === 'keep') {
        triggers = triggers.map(x => x.id === id ? withHistory({ ...x, pending: undefined, awaitingRecross: true }, '保留，等價格回到另一側再次穿過') : x);
        commit();
        notify({ kind: 'info', title: '觸價單保留', body: `${pendingName(t)} ${pendingKindLabel(t)}：價格回到觸發價另一側、再次穿過時才會觸發` });
        return true;
    }
    if (choice === 'cancel') {
        // Same rule as remove: a bracket's pair belongs to its plan.
        if (t.bracketId) throw new Error('括號單保護請在下單面板的括號單狀態中移除追蹤');
        triggers = triggers.filter(x => x.id !== id);
        recordEnded(t, 'cancelled', '待確認時取消，沒有送單');
        commit();
        notify({ kind: 'info', title: '觸價單已取消', body: `${pendingName(t)} ${pendingKindLabel(t)} 已刪除，沒有送單` });
        return true;
    }
    if (choice !== 'send') throw new Error('未知選項');
    if (t.validity && Date.now() >= t.validity.until) throw new Error('有效期已過，未送出');
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
    const feeds = new Map<string, { code: string; feed: Feed }>();
    for (const t of triggers) {
        if (t.suspended || !(t.kind === 'alert' || t.env === env || (!env && t.env?.startsWith(`${base}|`)))) continue;
        feeds.set(priceKeyOf(t), { code: t.code, feed: feedOf(t) });
    }
    const codes = new Set([...feeds.values()].map(f => f.code));
    for (const [key, hold] of quoteHolds) {
        if (!feeds.has(key)) { hold.release?.(); quoteHolds.delete(key); }
    }
    let changed = false;
    for (const code of [...feedMissing]) if (!codes.has(code)) { feedMissing.delete(code); changed = true; }
    for (const [key, { code, feed }] of feeds) {
        if (quoteHolds.has(key)) continue;
        const hold: { release?: () => void } = {};
        quoteHolds.set(key, hold);
        void ensureContract(code).then(contract => {
            if (quoteHolds.get(key) !== hold) return;
            hold.release = feed === 'odd' ? retainQuote(contract, 'Tick', { oddLot: true })
                : feed === 'bid' || feed === 'ask' ? retainQuote(contract, 'BidAsk') : retainQuote(contract, 'Tick');
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
    // 'fill' OCO legs locked before a reload: settle them again (an exit that
    // no longer exists sent nothing: the leg watches again, first tick decides)
    triggers = triggers.map(t => {
        if (!t.ocoLock || exits.some(e => e.id === t.ocoLock)) return t;
        restoreCheck.set(t.id, 'resume');
        return { ...t, ocoLock: undefined };
    });
    for (const rec of exits) if (triggers.some(t => t.ocoLock === rec.id)) setTimeout(() => settleOco(rec), 0);
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
    // #226 對手價 triggers: best bid / ask (a missing or zero side is skipped)
    onAnyBidAsk(ba => {
        if (ba.intraday_odd) return;
        noteActivity(); // a stall / sleep is noticed before this update is evaluated
        if (ba.simtrade) return;
        if (!triggers.some(t => t.code === ba.code && (feedOf(t) === 'bid' || feedOf(t) === 'ask'))) return;
        const bid = Number(ba.bid_price?.[0]);
        const ask = Number(ba.ask_price?.[0]);
        if (bid > 0) evaluateFeed(ba.code, bid, 'bid');
        if (ask > 0) evaluateFeed(ba.code, ask, 'ask');
    });
    setInterval(() => { if (expireDue()) commit(); }, EXPIRY_CHECK_MS);
    setInterval(() => checkTimed(), TIME_CHECK_MS);
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
    let wasLive = getStreamStatus() === 'live';
    subscribeStatusStore(() => {
        const live = getStreamStatus() === 'live';
        if (!live) dropPrices();
        refreshEvaluation();
        if (live) syncQuotes();
        if (live !== wasLive) {
            wasLive = live;
            const env = currentProtectionEnv();
            const watched = new Set(triggers.filter(t => !t.paused && !t.suspended && (t.kind === 'alert' || !env || t.env === env)).map(t => t.id));
            if (noteHistory(watched, live ? '重新連線，恢復盯價' : '連線中斷，暫停盯價', live ? 'ok' : 'warn')) commit();
        }
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
