import { onTradeMutation } from './trade-mutations';
import { useEffect, useSyncExternalStore } from 'react';
import { getAccountState, refreshAccounts, useAccounts } from './account-store';
import { ensureContract, getCachedContract } from './contracts-cache';
import { getApiBase } from './runtime';
import { subscribeTradeReports } from './boot';
import { retainQuote } from './quote-ownership';
import { onTradeResponse } from './trade-observations';
import { fetchAccountBalance, fetchMargin, fetchPositions, fetchTradeCacheHealth, fetchTrades } from './shioaji';
import { ensureStream, getStreamStatus, onAnyTick, onOrderEvent, subscribeStatusStore } from './stream';
import { applyPositionFill, markPosition, positionFill, reportBody } from './portfolio-projection';
import { projectOrderReport, projectTradeDeal } from './order-projection';
import { parseEventId, reportLedger } from './report-ledger';
import type { OrderEventReport } from './order-report';
import type { Account, AccountBalance, AccountedPosition, AccountFunds, Margin } from './types/portfolio';
import type { AccountedTrade, Trade, TradeCacheHealth } from './types/order';

export type TradingQueryScope = 'positions' | 'orders' | 'account';

/** Why a tab needs reconciliation (待對帳). Each reason has one cause and is
 *  cleared only by an action that actually resolves that cause. */
export type ReconcileReason =
    | 'metadata-missing' // report arrived before the order/contract it needs
    | 'unknown-fill' // fill cannot be attributed or applied to a holding
    | 'disconnect' // SSE dropped; reports may have been missed meanwhile
    | 'snapshot-boundary' // reports raced a snapshot that has no watermark
    | 'sequence-gap' // event_id sequence skipped (App ledger or server cache)
    | 'pending-report' // report not yet correlatable to a known order
    | 'projection-failed' // report contradicts / cannot apply to the order
    | 'untrackable-event' // event_id unsupported here or untracked by server
    | 'not-subscribed' // trade report subscription failed or was lost
    | 'mutation-outcome' // cancel/change HTTP result not confirmed by reports
    | 'query-failed' // the last read of this tab failed; data retained
    | 'overflow'; // too many reports during a read to replay safely

export const RECONCILE_REASON_LABELS: Record<ReconcileReason, string> = {
    'metadata-missing': '資料暫缺',
    'unknown-fill': '未知成交',
    disconnect: '串流中斷',
    'snapshot-boundary': '快照邊界',
    'sequence-gap': '回報跳號',
    'pending-report': '待關聯回報',
    'projection-failed': '投影失敗',
    'untrackable-event': '回報無法追蹤',
    'not-subscribed': '回報未訂閱',
    'mutation-outcome': '改刪待確認',
    'query-failed': '查詢失敗',
    overflow: '回報過多',
};

export interface TradingQueryStatus {
    updatedAt: number | null;
    needsReconcile: boolean;
    error: string | null;
    /** Distinct open reasons, oldest first. */
    reasons: ReconcileReason[];
}
const queryScopes: TradingQueryScope[] = ['positions', 'orders', 'account'];
const emptyQuery = (): TradingQueryStatus => ({ updatedAt: null, needsReconcile: false, error: null, reasons: [] });
export interface TradingState {
    queries: Record<TradingQueryScope, TradingQueryStatus>;
    positions: AccountedPosition[];
    trades: AccountedTrade[];
    funds?: AccountFunds[];
    balance?: AccountBalance;
    margin?: Margin;
    balanceAccount?: string;
    marginAccount?: string;
    updatedAt: number | null;
    loading: boolean;
    needsReconcile: boolean;
    error: string | null;
}
let state: TradingState = { queries: { positions: emptyQuery(), orders: emptyQuery(), account: emptyQuery() }, positions: [], trades: [], updatedAt: null, loading: false, needsReconcile: false, error: null };
const listeners = new Set<() => void>();
const isMirror = typeof location !== 'undefined' && new URLSearchParams(location.search).has('popout');
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`sj-trading-state:${getApiBase()}`) : null;

// ---- reconciliation reasons ----
// One reason can have several independent causes (e.g. an App-side unknown
// report and a server-reported PendingReport). Each cause is keyed by its
// message, so resolving one App-side cause never clears another.
type OpenReason = Map<string, number>; // message -> clock when (re)raised
const reasonState: Record<TradingQueryScope, Map<ReconcileReason, OpenReason>> = { positions: new Map(), orders: new Map(), account: new Map() };
let reasonClock = 0;
const latest = (entry: OpenReason) => Math.max(...entry.values());
function syncQuery(scope: TradingQueryScope, patch: Partial<TradingQueryStatus> = {}) {
    const open = [...reasonState[scope].entries()].sort((a, b) => latest(a[1]) - latest(b[1]));
    const queries = { ...state.queries, [scope]: { ...state.queries[scope], ...patch,
        reasons: open.map(([reason]) => reason),
        needsReconcile: open.length > 0,
        error: [...new Set(open.flatMap(([, entry]) => [...entry.keys()]))].join('；') || null } };
    state = { ...state, queries,
        needsReconcile: queryScopes.some(key => queries[key].needsReconcile),
        error: [...new Set(queryScopes.map(key => queries[key].error).filter(Boolean))].join('；') || null,
        updatedAt: Math.max(...queryScopes.map(key => queries[key].updatedAt ?? 0)) || null,
    };
}
function raise(scope: TradingQueryScope, reason: ReconcileReason, message: string) {
    const entry = reasonState[scope].get(reason) ?? new Map<string, number>();
    entry.delete(message); // re-insert so newer causes list last
    entry.set(message, ++reasonClock);
    reasonState[scope].set(reason, entry);
    syncQuery(scope);
}
/** Clear causes of `reasons` raised at or before `through`. With `message`,
 *  clear only that App-side cause (the one the caller just resolved). */
function resolve(scope: TradingQueryScope, reasons: readonly ReconcileReason[], through = Number.POSITIVE_INFINITY, message?: string) {
    let changed = false;
    for (const reason of reasons) {
        const entry = reasonState[scope].get(reason);
        if (!entry) continue;
        for (const [cause, raisedAt] of [...entry]) {
            if (raisedAt <= through && (message === undefined || cause === message)) { entry.delete(cause); changed = true; }
        }
        if (entry.size === 0) {
            reasonState[scope].delete(reason);
            // A full resolution also retires the App-side bookkeeping that
            // would otherwise wait forever for a replay that never comes.
            if (message === undefined && reason === 'metadata-missing') (scope === 'orders' ? orderMetaPending : positionMetaPending).clear();
            if (message === undefined && reason === 'pending-report' && scope === 'orders') pendingReportKeys.clear();
        }
    }
    if (changed) syncQuery(scope);
}
// An authoritative read (update_status / position snapshot) rebuilds the tab
// from the broker. A cache-only resync replaces only the order view with the
// sidecar's report projection, so it cannot confirm an unknown mutation.
const AUTHORITATIVE_RESOLVES: Record<TradingQueryScope, readonly ReconcileReason[]> = {
    orders: ['metadata-missing', 'disconnect', 'snapshot-boundary', 'sequence-gap', 'pending-report', 'projection-failed', 'untrackable-event', 'not-subscribed', 'mutation-outcome', 'query-failed', 'overflow'],
    positions: ['metadata-missing', 'unknown-fill', 'disconnect', 'snapshot-boundary', 'sequence-gap', 'pending-report', 'projection-failed', 'untrackable-event', 'not-subscribed', 'mutation-outcome', 'query-failed'],
    account: ['disconnect', 'query-failed'],
};
const CACHE_RESYNC_RESOLVES: readonly ReconcileReason[] = ['metadata-missing', 'disconnect', 'sequence-gap', 'pending-report', 'projection-failed', 'untrackable-event'];
const MSG = {
    orderMeta: '成交回報缺少委託資料，委託狀態待對帳',
    positionOrderMeta: '成交回報缺少委託資料，持倉暫未套用',
    positionContractMeta: '商品資料載入中，成交暫未套用持倉',
    pendingReport: '回報已收到但尚無對應委託；委託快照待手動對帳',
    untrackable: '回報識別格式不支援，無法偵測漏收；請手動對帳',
};

let publishTimer: ReturnType<typeof setTimeout> | null = null;
function publish() {
    listeners.forEach(l => l());
    if (!isMirror) channel?.postMessage({ kind: 'state', state });
}
function schedulePublish() {
    if (!publishTimer) publishTimer = setTimeout(() => { publishTimer = null; publish(); }, 50);
}
channel?.addEventListener('message', e => {
    if (isMirror && e.data?.kind === 'state' && Array.isArray(e.data.state?.positions)
        && Array.isArray(e.data.state?.trades)) {
        state = e.data.state;
        publish();
    } else if (!isMirror && e.data?.kind === 'request') publish();
    else if (!isMirror && e.data?.kind === 'refresh' && queryScopes.includes(e.data.scope)) void refreshTradingState(e.data.scope);
});

let inFlight: Promise<void> | null = null;
let inFlightResult: Promise<void> | null = null;
let resyncInFlight: Promise<void> | null = null;
const snapshotEnds = new Map<string, number>();
const seenFills = new Set<string>();
const pendingDeals = new Map<string, OrderEventReport>();
const pendingContracts = new Set<string>();
const orderTimes = new Map<string, number>();
const pendingOrders = new Map<string, OrderEventReport>();
// Reports parked because the order (orders tab) or order/contract metadata
// (positions tab) was missing. Replaying all of them clears only that reason.
const orderMetaPending = new Set<string>();
const positionMetaPending = new Set<string>();
const pendingReportKeys = new Set<string>();
let queryEvents: OrderEventReport[] | null = null;
let queryOverflow = false;
let connectionEpoch = 0;
/** An authoritative orders read happened on this sidecar instance; cleared
 *  when a reconnect finds the server's trade subscription gone (restart). */
let ordersBaseline = false;
const nextRefreshAt: Record<TradingQueryScope, number> = { positions: 0, orders: 0, account: 0 };
let eventSequence = 0;
const accountKey = (a: { broker_id: string; account_id: string; account_type: string }) => `${a.account_type}:${a.broker_id}:${a.account_id}`;
const reportKey = (report: OrderEventReport) => report.eventId ? `event:${report.eventId}` : JSON.stringify(report.raw);

const positionQuotes = new Map<string, { release?: () => void }>();
function prepareQuotes() {
    const codes = new Set(state.positions.map(p => p.code));
    for (const [code, entry] of positionQuotes) if (!codes.has(code)) { entry.release?.(); positionQuotes.delete(code); }
    for (const code of codes) if (!positionQuotes.has(code)) {
        const entry: { release?: () => void } = {};
        positionQuotes.set(code, entry);
        void ensureContract(code).then(contract => {
            if (positionQuotes.get(code) === entry) entry.release = retainQuote(contract, 'Tick');
        }).catch(() => { if (positionQuotes.get(code) === entry) positionQuotes.delete(code); });
    }
}

const tradableAccounts = () => getAccountState().accounts.filter(a => a.signed && ['S', 'F'].includes(a.account_type));

type Problem = [ReconcileReason, string];

/** Merge one account's HTTP rows and replay reports received meanwhile.
 *  Returns whether the merge was applied; false keeps the previous view
 *  (a replay could not connect, or too many reports raced the read). */
function mergeOrders(account: Account, trades: Trade[], accounts: Account[], problems: Problem[]) {
    const matches = (a: Account | undefined) => a && accountKey(a) === accountKey(account);
    let merged = [...state.trades.filter(t => !matches(t.account)), ...trades
        .filter(t => !t.order.account || (t.order.account.account_id === account.account_id && t.order.account.broker_id === account.broker_id))
        .map(t => ({ ...t, account }))];
    let replayFailed = false;
    for (const report of queryEvents ?? []) {
        const projected = report.kind === 'order'
            ? projectOrderReport(merged, report, accounts) : projectTradeDeal(merged, report);
        if (projected) merged = projected;
        else replayFailed = true;
    }
    if (replayFailed) problems.push(['projection-failed', '委託更新期間有無法銜接的回報，保留本地資料待確認']);
    const applied = !queryOverflow && !replayFailed;
    if (applied) state = { ...state, trades: merged };
    return applied;
}

/** Initial connection reads all groups; manual actions reconcile only their tab. */
export function refreshTradingState(scope: TradingQueryScope | 'all' = 'all'): Promise<void> {
    if (isMirror) {
        if (scope !== 'all') channel?.postMessage({ kind: 'refresh', scope });
        return Promise.resolve();
    }
    if (inFlight) return inFlightResult ?? inFlight;
    const targets = scope === 'all' ? queryScopes : [scope];
    if (targets.some(key => Date.now() < nextRefreshAt[key])) return Promise.resolve();
    const readPositions = targets.includes('positions');
    const readOrders = targets.includes('orders');
    const readAccount = targets.includes('account');
    let ordersRead = false;
    const run: Promise<void> = inFlight = (async () => {
        if (resyncInFlight) await resyncInFlight;
        const before = eventSequence;
        const connectionBefore = connectionEpoch;
        const clockBefore = reasonClock;
        const ledgerBefore = reportLedger.clock();
        state = { ...state, loading: true };
        publish();
        const problems: Record<TradingQueryScope, Problem[]> = { positions: [], orders: [], account: [] };
        const failed = new Set<TradingQueryScope>();
        queryEvents = readOrders ? [] : null;
        queryOverflow = false;
        try {
            let subscribed = true;
            if (readPositions || readOrders) {
                try { await subscribeTradeReports(); }
                catch (e) {
                    subscribed = false;
                    const message = e instanceof Error ? e.message : String(e);
                    for (const key of targets) { failed.add(key); problems[key].push([key === 'account' ? 'query-failed' : 'not-subscribed', message]); }
                }
            }
            if (subscribed) {
                if (!getAccountState().accounts.length) await refreshAccounts();
                const accounts = tradableAccounts();
                if (!accounts.length) throw new Error('尚未取得可查詢帳戶；請連線後按更新');
                let ordersOk = true;
                for (const account of accounts) {
                    const matches = (a: typeof account | undefined) => a && accountKey(a) === accountKey(account);
                    if (readPositions) try {
                        const positionStart = eventSequence;
                        const hadSnapshot = snapshotEnds.has(accountKey(account));
                        const positions = await fetchPositions(account.account_type as 'S' | 'F', account);
                        if (positionStart === eventSequence || !hadSnapshot) {
                            snapshotEnds.set(accountKey(account), Date.now() / 1000);
                            state = { ...state, positions: [...state.positions.filter(p => !matches(p.account)), ...positions.map(p => ({ ...p, account }))] };
                        }
                        // Without a server watermark, do not add a fill on top of
                        // a snapshot that might already include it (Shioaji#232).
                        if (positionStart !== eventSequence) problems.positions.push(['snapshot-boundary', '持倉查詢期間收到回報，保留即時估算；快照邊界待確認']);
                    } catch {
                        failed.add('positions');
                        problems.positions.push(['query-failed', `${account.account_type} 持倉查詢失敗，保留上次資料`]);
                    }
                    if (readOrders) try {
                        // Initial/manual reconciliation stays authoritative:
                        // refresh:true runs update_status(account) (accounting quota).
                        const trades = await fetchTrades(account.account_type as 'S' | 'F', account, { refresh: true });
                        // A kept (not rebuilt) view resolves nothing.
                        if (!mergeOrders(account, trades, accounts, problems.orders)) { ordersOk = false; failed.add('orders'); }
                    } catch {
                        ordersOk = false;
                        failed.add('orders');
                        problems.orders.push(['query-failed', `${account.account_type} 委託查詢失敗，保留上次資料`]);
                    }
                }
                if (readOrders && ordersOk) ordersRead = true;
                if (readAccount) {
                    const funds: AccountFunds[] = [];
                    for (const account of accounts) {
                        const previous = state.funds?.find(f => accountKey(f.account) === accountKey(account));
                        try {
                            const value = account.account_type === 'S'
                                ? { balance: await fetchAccountBalance(account) }
                                : { margin: await fetchMargin(account) };
                            if (value.balance?.errmsg?.trim()) throw new Error('券商餘額查詢回報錯誤');
                            funds.push({ account, ...value, updatedAt: Date.now() });
                        } catch {
                            const error = `${account.account_type === 'S' ? '餘額' : '保證金'}查詢失敗，保留此帳戶上次資料`;
                            funds.push({ ...previous, account, error });
                            failed.add('account');
                            problems.account.push(['query-failed', error]);
                        }
                    }
                    const stock = getAccountState().selectedStock ?? accounts.find(a => a.account_type === 'S');
                    const future = getAccountState().selectedFutures ?? accounts.find(a => a.account_type === 'F');
                    state = { ...state, funds,
                        balance: funds.find(f => stock && accountKey(f.account) === accountKey(stock))?.balance,
                        margin: funds.find(f => future && accountKey(f.account) === accountKey(future))?.margin,
                        balanceAccount: stock && accountKey(stock), marginAccount: future && accountKey(future) };
                }
                if (readPositions) prepareQuotes();
            }
        } catch (e) {
            for (const key of targets) { failed.add(key); problems[key].push(['query-failed', e instanceof Error ? e.message : String(e)]); }
        }
        if (queryOverflow && readOrders) problems.orders.push(['overflow', '更新期間回報過多，已保留即時資料；請稍後手動確認']);
        for (const key of targets) {
            if (connectionBefore !== connectionEpoch || getStreamStatus() !== 'live') problems[key].push(['disconnect', '串流曾中斷，資料可能不完整；請連線後手動確認']);
            if (before !== eventSequence) problems[key].push(['snapshot-boundary', '更新期間收到回報，快照邊界不明；請確認後手動對帳']);
            // A tab that fully read clears what it resolved before the read
            // started; a failed read keeps every earlier reason.
            if (!failed.has(key)) resolve(key, AUTHORITATIVE_RESOLVES[key], clockBefore);
            for (const [reason, message] of problems[key]) raise(key, reason, message);
            syncQuery(key, problems[key].length === 0 ? { updatedAt: Date.now() } : {});
        }
        // The authoritative read covers event_id gaps detected before it began.
        if (ordersRead) { ordersBaseline = true; reportLedger.takeGaps(getApiBase(), ledgerBefore); }
        state = { ...state, loading: false };
        publish();
    })().finally(() => { queryEvents = null; for (const key of targets) nextRefreshAt[key] = Date.now() + 1500; inFlight = null; });
    // Health is cache-only (no broker call): check it once after an explicit
    // orders reconciliation to surface what the server still cannot track.
    inFlightResult = scope === 'orders' ? run.then(() => { if (ordersRead) return checkTradeCacheHealth('manual'); }) : run;
    return inFlightResult;
}

// ---- Shioaji 1.7.6 trade cache health (event-driven only) ----
export type HealthTrigger = 'reconnect' | 'gap' | 'manual';
let healthInFlight: Promise<void> | null = null;
let healthQueued: HealthTrigger | null = null;
let lastHealthAt = 0;
const HEALTH_MIN_INTERVAL_MS = 3000;
const HEALTH_REASONS: Partial<Record<string, Problem>> = {
    SequenceGap: ['sequence-gap', '伺服器委託快取偵測到回報跳號；請手動對帳'],
    PendingReport: ['pending-report', '伺服器有尚未關聯的回報；請手動對帳'],
    UntrackableEventId: ['untrackable-event', '伺服器無法追蹤部分回報識別；請手動對帳'],
    ProjectionFailed: ['projection-failed', '伺服器無法套用部分回報；請手動對帳'],
};

/** Read trade_cache_health for every signed account. Triggered only by a
 *  reconnect, a detected sequence gap or a manual reconciliation — never by a
 *  timer. When every cache is Healthy on the same sidecar instance, the orders
 *  view is resynced cache-only (refresh:false) without accounting quota. */
export function checkTradeCacheHealth(trigger: HealthTrigger): Promise<void> {
    if (isMirror) return Promise.resolve();
    if (healthInFlight) {
        // Coalesce bursts into one follow-up; a reconnect outranks the rest.
        if (!healthQueued || trigger === 'reconnect') healthQueued = trigger;
        return healthInFlight;
    }
    const wait = trigger === 'gap' ? Math.max(0, lastHealthAt + HEALTH_MIN_INTERVAL_MS - Date.now()) : 0;
    const run: Promise<void> = healthInFlight = (async () => {
        if (wait) await new Promise(r => setTimeout(r, wait));
        lastHealthAt = Date.now();
        const accounts = tradableAccounts();
        if (!accounts.length) return;
        const base = getApiBase();
        const clockBefore = reasonClock;
        const eventsBefore = eventSequence;
        const epochBefore = connectionEpoch;
        const results = await Promise.allSettled(accounts.map(a => fetchTradeCacheHealth(a.account_type as 'S' | 'F', a)));
        if (base !== getApiBase()) return;
        // An older server lacks the route; health only ever adds information,
        // so a failed read leaves every existing reason untouched.
        if (results.some(r => r.status === 'rejected')) {
            if (trigger === 'reconnect') {
                // Continuity after a reconnect is unproven (the sidecar may
                // still be booting after a restart): stop trusting its cache
                // and make sure reports flow again.
                ordersBaseline = false;
                try { await subscribeTradeReports(); }
                catch { for (const key of ['orders', 'positions'] as const) raise(key, 'not-subscribed', '委託回報訂閱失敗；請使用更新圖示重試'); }
                schedulePublish();
            }
            return;
        }
        const healths = results.map(r => (r as PromiseFulfilledResult<TradeCacheHealth>).value);
        let notSubscribed = false;
        for (const health of healths) {
            for (const { event_type, reason } of health?.reasons ?? []) {
                if (reason === 'NotSubscribed') { notSubscribed = true; continue; }
                const mapped = HEALTH_REASONS[reason];
                if (!mapped) continue; // NoBaseline alone is normal after subscribing
                raise('orders', ...mapped);
                if (String(event_type).endsWith('Deal')) raise('positions', ...mapped);
            }
        }
        if (notSubscribed) {
            // A lost subscription means the sidecar restarted or dropped it:
            // its cache no longer continues this App's authoritative baseline.
            ordersBaseline = false;
            try { await subscribeTradeReports(); }
            catch { for (const key of ['orders', 'positions'] as const) raise(key, 'not-subscribed', '委託回報訂閱失敗；請使用更新圖示重試'); }
        }
        const allHealthy = !notSubscribed && healths.every(h => h?.state === 'Healthy');
        if (allHealthy && trigger !== 'manual' && ordersBaseline && !inFlight
            && reasonState.orders.size > 0 && getStreamStatus() === 'live') {
            resyncInFlight = resyncOrdersFromCache(accounts, { clockBefore, eventsBefore, epochBefore });
            await resyncInFlight.finally(() => { resyncInFlight = null; });
        }
        schedulePublish();
    })().finally(() => {
        healthInFlight = null;
        const next = healthQueued;
        healthQueued = null;
        if (next) void checkTradeCacheHealth(next);
    });
    return run;
}

async function resyncOrdersFromCache(accounts: Account[], before: { clockBefore: number; eventsBefore: number; epochBefore: number }) {
    const base = getApiBase();
    queryEvents = [];
    queryOverflow = false;
    try {
        const rows = await Promise.all(accounts.map(a => fetchTrades(a.account_type as 'S' | 'F', a, { refresh: false })));
        if (base !== getApiBase()) return;
        const saved = state.trades;
        const problems: Problem[] = [];
        const merged = accounts.every((account, i) => mergeOrders(account, rows[i]!, accounts, problems));
        // Reports raced the cache read, the stream dropped, or a replay failed:
        // keep the previous view and every reason rather than guess.
        if (!merged || queryOverflow || eventSequence !== before.eventsBefore
            || connectionEpoch !== before.epochBefore || getStreamStatus() !== 'live') {
            state = { ...state, trades: saved };
            return;
        }
        resolve('orders', CACHE_RESYNC_RESOLVES, before.clockBefore);
        for (const [key, deal] of [...pendingDeals]) {
            if (deal.kind === 'deal' && state.trades.some(t => t.order.id === deal.tradeId)) { pendingDeals.delete(key); applyDeal(deal); }
        }
    } catch {
        // A failed cache read keeps existing reasons; the user can reconcile.
    } finally { queryEvents = null; }
}

let started = false;
let hasConnected = false;
let downSinceLive = false;
function park(report: OrderEventReport, set: Set<string>) {
    const key = reportKey(report);
    set.add(key);
    if (pendingDeals.size < 500 || pendingDeals.has(key)) pendingDeals.set(key, report);
}
// The deal no longer waits for order/contract metadata (it applied, was a
// duplicate, or now fails for another, separately raised reason).
function releasePositionMeta(key: string) {
    if (positionMetaPending.delete(key) && positionMetaPending.size === 0) {
        resolve('positions', ['metadata-missing'], undefined, MSG.positionOrderMeta);
        resolve('positions', ['metadata-missing'], undefined, MSG.positionContractMeta);
    }
}
function applyDeal(report: OrderEventReport) {
    if (report.kind !== 'deal') return;
    const key = reportKey(report);
    const knownOrder = state.trades.some(t => t.order.id === report.tradeId);
    const fill = positionFill(report, getAccountState().accounts, state.trades);
    const trades = projectTradeDeal(state.trades, report);
    if (trades) {
        state = { ...state, trades };
        if (orderMetaPending.delete(key) && orderMetaPending.size === 0) resolve('orders', ['metadata-missing'], undefined, MSG.orderMeta);
    } else if (!knownOrder) {
        // Deal-before-order is documented; the order report/response replays it.
        raise('orders', 'metadata-missing', MSG.orderMeta);
        park(report, orderMetaPending);
    } else {
        raise('orders', 'projection-failed', '成交回報無法套用到委託，委託狀態待對帳');
        if (orderMetaPending.delete(key) && orderMetaPending.size === 0) resolve('orders', ['metadata-missing'], undefined, MSG.orderMeta);
    }
    // Fill identity: the complete event_id (Shioaji 1.7.6+) plus the legacy
    // exchange-sequence key. Either one already applied means a duplicate.
    const eventKey = report.eventId ? `event:${getApiBase()}:${report.eventId}` : null;
    if (fill && (seenFills.has(fill.key) || (eventKey && seenFills.has(eventKey)))) {
        releasePositionMeta(key);
        return;
    }
    const cutoff = fill && snapshotEnds.get(accountKey(fill.account));
    const c = fill && getCachedContract(fill.code);
    if (fill?.account.account_type === 'F' && !c) {
        park(report, positionMetaPending);
        raise('positions', 'metadata-missing', MSG.positionContractMeta);
        if (!pendingContracts.has(fill.code)) {
            pendingContracts.add(fill.code);
            // Metadata only: several fills of a new contract share this lookup.
            void ensureContract(fill.code).then(() => {
                for (const [pendingKey, pending] of [...pendingDeals]) {
                    if (positionFill(pending, getAccountState().accounts, state.trades)?.code !== fill.code) continue;
                    pendingDeals.delete(pendingKey);
                    applyDeal(pending);
                }
                schedulePublish();
            }).catch(() => undefined).finally(() => pendingContracts.delete(fill.code));
        }
        return;
    }
    const multiplier = fill?.account.account_type === 'S' ? 1 : c?.multiplier ?? c?.contract_size ?? 0;
    const next = fill && cutoff && fill.ts > cutoff
        ? applyPositionFill(state.positions, fill, multiplier) : null;
    if (next && fill && seenFills.size < 10000) {
        seenFills.add(fill.key);
        if (eventKey) seenFills.add(eventKey);
        state = { ...state, positions: next };
        prepareQuotes();
        releasePositionMeta(key);
    } else if (!fill && !knownOrder) {
        // Futures open/close needs the order; replay once it arrives.
        raise('positions', 'metadata-missing', MSG.positionOrderMeta);
        park(report, positionMetaPending);
    } else if (fill && (!cutoff || fill.ts <= cutoff)) {
        raise('positions', 'snapshot-boundary', '成交可能已含在持倉快照內，持倉待手動對帳');
        releasePositionMeta(key);
    } else {
        raise('positions', 'unknown-fill', '成交無法辨識帳戶／條件或無法確定持倉變化，持倉待手動對帳');
        releasePositionMeta(key);
    }
}
function releasePendingDeals(tradeId: string) {
    for (const [key, deal] of [...pendingDeals]) {
        if (deal.kind === 'deal' && deal.tradeId === tradeId) { pendingDeals.delete(key); applyDeal(deal); }
    }
}
function start() {
    if (started) return;
    started = true;
    if (isMirror) { channel?.postMessage({ kind: 'request' }); return; }
    const mutationBaselines = new Map<string, { trade: AccountedTrade | undefined; sequence: number }>();
    const stopMutations = onTradeMutation(event => {
        if (event.phase === 'begin') {
            const matches = state.trades.filter(t => t.order.id === event.tradeId);
            if (mutationBaselines.size >= 500) mutationBaselines.delete(mutationBaselines.keys().next().value!);
            mutationBaselines.set(event.token, { trade: matches.length === 1 ? matches[0] : undefined, sequence: eventSequence });
            return;
        }
        const baseline = mutationBaselines.get(event.token);
        const old = baseline?.trade;
        mutationBaselines.delete(event.token);
        const trade = event.trade;
        const account = trade?.order?.account;
        // Preserve every newer SSE/snapshot result. Never insert an unknown or
        // ambiguously scoped response, nor turn an old working state into finality.
        const sameAccount = old?.account && account && accountKey(old.account) === accountKey(account);
        if (old && baseline?.sequence === eventSequence && state.trades.includes(old) && sameAccount && trade?.order.id === event.tradeId
            && ['Cancelled', 'Filled'].includes(trade.status.status)
            && trade.status.deal_quantity >= old.status.deal_quantity
            && trade.status.cancel_quantity >= old.status.cancel_quantity) {
            if (trade.status.deal_quantity > old.status.deal_quantity) raise('positions', 'mutation-outcome', '刪單／改單回應包含新增成交；持倉尚待回報或手動對帳');
            state = { ...state, trades: state.trades.map(t => t === old ? { ...trade, account: old.account } : t) };
        } else {
            raise('orders', 'mutation-outcome', '刪單／改單結果待確認；請手動更新委託，不要自動重送');
        }
        if (queryEvents) queryOverflow = true;
        schedulePublish();
    });
    const stopResponses = onTradeResponse(({ trade, account: requestedAccount }) => {
        const ref = trade.order.account ?? requestedAccount;
        const account = getAccountState().accounts.find(a => a.signed && a.account_type === ref?.account_type
            && a.account_id === ref?.account_id && a.broker_id === ref?.broker_id);
        if (!account) return;
        const old = state.trades.find(t => t.order.id === trade.order.id && t.account && accountKey(t.account) === accountKey(account));
        // A response may arrive after newer reports. Keep their quantities,
        // prices/status and only enrich metadata missing from the event schema.
        if (old) {
            state = { ...state, trades: state.trades.map(t => t !== old ? t : { ...t, order: { ...t.order,
                custom_field: t.order.custom_field || trade.order.custom_field,
                price_type: t.order.price_type || trade.order.price_type,
                order_type: t.order.order_type || trade.order.order_type } }) };
        } else state = { ...state, trades: [...state.trades, { ...trade, account }] };
        // A native New event can omit full_code before the HTTP response has
        // supplied canonical metadata. Replay only the same account/id and code.
        const pendingKey = `${account.account_type === 'S' ? 'stock' : 'futures'}:${account.broker_id}:${account.account_id}:${trade.order.id}`;
        const pendingOrder = pendingOrders.get(pendingKey);
        if (pendingOrder && pendingOrder.kind === 'order' && !old
            && ['PendingSubmit', 'PreSubmitted'].includes(trade.status.status)
            && (!pendingOrder.ts || pendingOrder.ts >= (orderTimes.get(pendingKey) ?? 0))) {
            const body = reportBody(pendingOrder);
            const eventContract = body?.contract as { code?: string; full_code?: string } | undefined;
            const canonical = trade.contract.target_code || trade.contract.code;
            if ((eventContract?.full_code || eventContract?.code) === canonical) {
                const projected = projectOrderReport(state.trades, pendingOrder, getAccountState().accounts);
                if (projected) {
                    state = { ...state, trades: projected };
                    if (pendingOrder.ts) orderTimes.set(pendingKey, pendingOrder.ts);
                    pendingOrders.delete(pendingKey);
                    if (pendingReportKeys.delete(pendingKey) && pendingReportKeys.size === 0) resolve('orders', ['pending-report'], undefined, MSG.pendingReport);
                }
            }
        }
        // Do not allow an in-flight snapshot to overwrite a response that was
        // received afterwards; the user can explicitly reconcile once settled.
        if (queryEvents) queryOverflow = true;
        releasePendingDeals(trade.order.id);
        schedulePublish();
    });
    const stopOrders = onOrderEvent(report => {
        eventSequence++;
        if (queryEvents && queryEvents.length >= 1000) queryOverflow = true;
        // A nonempty ID outside the supported v1 format cannot show gaps; keep
        // the report but say so. Empty IDs (pre-1.7.6/history) use legacy paths.
        if (report.eventId && !parseEventId(report.eventId)) {
            raise('orders', 'untrackable-event', MSG.untrackable);
            if (report.kind === 'deal') raise('positions', 'untrackable-event', MSG.untrackable);
        }
        // Events never trigger HTTP accounting queries. Unknown/missing events
        // keep the last view and surface explicit reconciliation instead.
        if (report.kind === 'deal') {
            if (queryEvents && queryEvents.length < 1000) queryEvents.push(report);
            applyDeal(report);
        }
        else {
            const ref = (reportBody(report)?.order as { account?: { broker_id?: string; account_id?: string } })?.account;
            const key = `${report.market}:${ref?.broker_id}:${ref?.account_id}:${report.id}`;
            if (report.ts && report.ts < (orderTimes.get(key) ?? 0)) return;
            if (queryEvents && queryEvents.length < 1000) queryEvents.push(report);
            const trades = projectOrderReport(state.trades, report, getAccountState().accounts);
            if (trades) {
                state = { ...state, trades };
                if (report.ts) orderTimes.set(key, report.ts);
                releasePendingDeals(report.id);
            } else {
                const known = state.trades.some(t => t.order.id === report.id);
                const previous = pendingOrders.get(key);
                if (report.opType === 'New' && (!previous?.ts || (report.ts ?? 0) >= previous.ts)) {
                    if (pendingOrders.size >= 500 && !pendingOrders.has(key)) pendingOrders.delete(pendingOrders.keys().next().value!);
                    pendingOrders.set(key, report);
                }
                if (known) raise('orders', 'projection-failed', '回報與已知委託不一致；委託快照待手動對帳');
                else {
                    if (pendingReportKeys.size < 500) pendingReportKeys.add(key);
                    raise('orders', 'pending-report', MSG.pendingReport);
                }
            }
        }
        schedulePublish();
    });
    // A skipped event_id may still arrive late: surface it (and read the
    // cache-only health) only if it is still missing after a short grace.
    const stopGaps = reportLedger.onGap((base, opened) => {
        setTimeout(() => {
            if (base !== getApiBase()) return;
            const kinds = reportLedger.takeGaps(base, opened);
            if (!kinds.size) return;
            raise('orders', 'sequence-gap', '回報序號跳號，可能漏收；請手動對帳');
            if (kinds.has('deal')) raise('positions', 'sequence-gap', '成交回報序號跳號，可能漏收；持倉待對帳');
            schedulePublish();
            void checkTradeCacheHealth('gap');
        }, 1500);
    });
    const stopTicks = onAnyTick(tick => {
        const price = Number(tick.close);
        if (!Number.isFinite(price) || price <= 0 || tick.simtrade) return;
        let changed = false;
        const positions = state.positions.map(p => {
            if (p.code !== tick.code) return p;
            const c = getCachedContract(p.code);
            const multiplier = p.account?.account_type === 'S' ? 1 : c?.multiplier ?? c?.contract_size ?? 0;
            const next = markPosition(p, price, multiplier);
            changed ||= next !== p;
            return next;
        });
        if (changed) { state = { ...state, positions }; schedulePublish(); }
    });
    const statusChanged = () => {
        const live = getStreamStatus() === 'live';
        if (live && !hasConnected) { hasConnected = true; void refreshTradingState(); }
        else if (live && downSinceLive) {
            downSinceLive = false;
            void checkTradeCacheHealth('reconnect');
        } else if (!live && hasConnected) {
            connectionEpoch++;
            downSinceLive = true;
            for (const key of queryScopes) raise(key, 'disconnect', '串流曾中斷；重新連線後請手動對帳');
            publish();
        }
    };
    const stopStatus = subscribeStatusStore(statusChanged);
    import.meta.hot?.dispose(() => {
        stopMutations(); stopResponses(); stopOrders(); stopGaps(); stopTicks(); stopStatus(); channel?.close();
        positionQuotes.forEach(entry => entry.release?.());
        if (publishTimer) clearTimeout(publishTimer);
    });
    ensureStream();
    statusChanged();
}

export const getTradingState = () => state;
/** Cache-only order reads (refresh:false) are trustworthy only while this App
 *  holds an authoritative baseline on the same sidecar instance and has not
 *  missed reports since; callers must still require every health Healthy. */
export function tradeCacheContinuous() {
    return !isMirror && ordersBaseline && getStreamStatus() === 'live' && !reasonState.orders.has('disconnect');
}
export function subscribeTradingState(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
// Order actions wait for active reports. They must not fan out accounting reads.
export function tradingActionObserved() { /* reports drive the shared view */ }
export function useTradingState() {
    useEffect(start, []);
    const accounts = useAccounts();
    const current = useSyncExternalStore(subscribeTradingState, getTradingState);
    return { ...current,
        balance: current.funds?.find(f => accounts.selectedStock && accountKey(f.account) === accountKey(accounts.selectedStock))?.balance,
        margin: current.funds?.find(f => accounts.selectedFutures && accountKey(f.account) === accountKey(accounts.selectedFutures))?.margin,
    };
}
