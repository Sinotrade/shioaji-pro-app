import { useEffect, useSyncExternalStore } from 'react';
import { getAccountState, refreshAccounts, useAccounts } from './account-store';
import { ensureContract, getCachedContract } from './contracts-cache';
import { getApiBase } from './runtime';
import { subscribeProductionTradeEvents } from './boot';
import { retainQuote } from './quote-ownership';
import { onTradeResponse } from './trade-observations';
import { fetchAccountBalance, fetchMargin, fetchPositions, fetchTrades } from './shioaji';
import { ensureStream, getStreamStatus, onAnyTick, onOrderEvent, subscribeStatusStore } from './stream';
import { applyPositionFill, markPosition, positionFill, reportBody } from './portfolio-projection';
import { projectOrderReport, projectTradeDeal } from './order-projection';
import type { OrderEventReport } from './order-report';
import type { AccountBalance, AccountedPosition, Margin } from './types/portfolio';
import type { AccountedTrade } from './types/order';

export interface TradingState {
    positions: AccountedPosition[];
    trades: AccountedTrade[];
    balance?: AccountBalance;
    margin?: Margin;
    balanceAccount?: string;
    marginAccount?: string;
    updatedAt: number | null;
    loading: boolean;
    needsReconcile: boolean;
    error: string | null;
}
let state: TradingState = { positions: [], trades: [], updatedAt: null, loading: false, needsReconcile: false, error: null };
const listeners = new Set<() => void>();
const isMirror = typeof location !== 'undefined' && new URLSearchParams(location.search).has('popout');
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`sj-trading-state:${getApiBase()}`) : null;
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
    else if (!isMirror && e.data?.kind === 'refresh') void refreshTradingState();
});

let inFlight: Promise<void> | null = null;
const snapshotEnds = new Map<string, number>();
const seenFills = new Set<string>();
const pendingDeals = new Map<string, OrderEventReport>();
const pendingContracts = new Set<string>();
const orderTimes = new Map<string, number>();
let queryEvents: OrderEventReport[] | null = null;
let queryOverflow = false;
let connectionEpoch = 0;
let nextRefreshAt = 0;
let eventSequence = 0;
const accountKey = (a: { broker_id: string; account_id: string; account_type: string }) => `${a.account_type}:${a.broker_id}:${a.account_id}`;

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

/** Explicit reconciliation. Repeated clicks share one operation, never queue. */
export function refreshTradingState(): Promise<void> {
    if (isMirror) { channel?.postMessage({ kind: 'refresh' }); return Promise.resolve(); }
    if (inFlight) return inFlight;
    if (Date.now() < nextRefreshAt) return Promise.resolve();
    inFlight = (async () => {
        const before = eventSequence;
        const connectionBefore = connectionEpoch;
        state = { ...state, loading: true, error: null };
        publish();
        const errors: string[] = [];
        queryEvents = [];
        queryOverflow = false;
        try {
            await subscribeProductionTradeEvents();
            if (!getAccountState().accounts.length) await refreshAccounts();
            const accounts = getAccountState().accounts.filter(a => a.signed && ['S', 'F'].includes(a.account_type));
            if (!accounts.length) throw new Error('尚未取得可查詢帳戶；請連線後按更新');
            // Sequential account reads prevent a multi-account manual refresh
            // from producing an unbounded burst. Keep failed accounts' rows.
            for (const account of accounts) {
                const matches = (a: typeof account | undefined) => a && accountKey(a) === accountKey(account);
                try {
                    const positionStart = eventSequence;
                    const hadSnapshot = snapshotEnds.has(accountKey(account));
                    const positions = await fetchPositions(account.account_type as 'S' | 'F', account);
                    if (positionStart === eventSequence || !hadSnapshot) {
                        snapshotEnds.set(accountKey(account), Date.now() / 1000);
                        state = { ...state, positions: [...state.positions.filter(p => !matches(p.account)), ...positions.map(p => ({ ...p, account }))] };
                    }
                    // No server watermark exists. With an established baseline,
                    // retain the live projection if a report races this query.
                    // Never add a fill on top of a snapshot that may include it.
                    if (positionStart !== eventSequence) errors.push('持倉查詢期間收到回報，保留即時估算；快照邊界待確認');
                } catch { errors.push(`${account.account_type} 持倉查詢失敗，保留上次資料`); }
                try {
                    const trades = await fetchTrades(account.account_type as 'S' | 'F', account);
                    let merged = [...state.trades.filter(t => !matches(t.account)), ...trades
                        .filter(t => !t.order.account || (t.order.account.account_id === account.account_id && t.order.account.broker_id === account.broker_id))
                        .map(t => ({ ...t, account }))];
                    // Reapply reports received during the request. Fill sequence
                    // IDs already present in the snapshot are idempotent.
                    for (const report of queryEvents ?? []) {
                        const projected = report.kind === 'order'
                            ? projectOrderReport(merged, report, accounts) : projectTradeDeal(merged, report);
                        if (projected) merged = projected;
                        else errors.push('委託更新期間有無法銜接的回報，保留本地資料待確認');
                    }
                    // An unresolved event must not be overwritten by an older response.
                    if (!queryOverflow && !errors.some(e => e.includes('無法銜接'))) state = { ...state, trades: merged };
                } catch { errors.push(`${account.account_type} 委託查詢失敗，保留上次資料`); }
            }
            const stock = getAccountState().selectedStock ?? accounts.find(a => a.account_type === 'S');
            const future = getAccountState().selectedFutures ?? accounts.find(a => a.account_type === 'F');
            if (stock) {
                try { state = { ...state, balance: await fetchAccountBalance(stock), balanceAccount: accountKey(stock) }; }
                catch { errors.push('餘額查詢失敗，保留上次資料'); }
            }
            if (future) {
                try { state = { ...state, margin: await fetchMargin(future), marginAccount: accountKey(future) }; }
                catch { errors.push('保證金查詢失敗，保留上次資料'); }
            }
            state = { ...state, updatedAt: Date.now() };
            prepareQuotes();
        } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
        if (queryOverflow) errors.push('更新期间回報過多，已保留即時資料；請稍後手動確認');
        if (connectionBefore !== connectionEpoch || getStreamStatus() !== 'live') errors.push('串流曾中斷，資料可能不完整；請連線後手動確認');
        state = { ...state, loading: false, needsReconcile: errors.length > 0 || before !== eventSequence,
            error: errors.join('；') || (before !== eventSequence ? '更新期間收到回報，快照邊界不明；請確認後手動對帳' : null) };
        publish();
    })().finally(() => { queryEvents = null; nextRefreshAt = Date.now() + 1500; inFlight = null; });
    return inFlight;
}

let started = false;
let hasConnected = false;
function applyDeal(report: OrderEventReport) {
    if (report.kind !== 'deal') return;
    const fill = positionFill(report, getAccountState().accounts, state.trades);
    const trades = projectTradeDeal(state.trades, report);
    if (trades) state = { ...state, trades };
    else if (pendingDeals.size < 500) pendingDeals.set(JSON.stringify(report.raw), report);
    if (fill && seenFills.has(fill.key)) return;
    const cutoff = fill && snapshotEnds.get(accountKey(fill.account));
    const c = fill && getCachedContract(fill.code);
    if (fill?.account.account_type === 'F' && !c) {
        if (pendingDeals.size < 500) pendingDeals.set(JSON.stringify(report.raw), report);
        if (!pendingContracts.has(fill.code)) {
            pendingContracts.add(fill.code);
            // Metadata only: several fills of a new contract share this lookup.
            void ensureContract(fill.code).then(() => {
                for (const [key, pending] of [...pendingDeals]) {
                    if (positionFill(pending, getAccountState().accounts, state.trades)?.code !== fill.code) continue;
                    pendingDeals.delete(key);
                    applyDeal(pending);
                }
                schedulePublish();
            }).catch(() => undefined).finally(() => pendingContracts.delete(fill.code));
        }
    }
    const multiplier = fill?.account.account_type === 'S' ? 1 : c?.multiplier ?? c?.contract_size ?? 0;
    const next = fill && cutoff && fill.ts > cutoff
        ? applyPositionFill(state.positions, fill, multiplier) : null;
    if (next && fill && seenFills.size < 10000) {
        seenFills.add(fill.key);
        state = { ...state, positions: next };
        if (!trades) state = { ...state, needsReconcile: true, error: '成交已反映持倉估算；委託狀態待對帳' };
        prepareQuotes();
    } else {
        state = { ...state, needsReconcile: true, error: '成交資料或快照邊界不足，持倉待手動對帳' };
        // Deal-before-order is documented. Retain a bounded pending set;
        // receiving order metadata later can resolve it without any query.
        if (!fill && pendingDeals.size < 500) pendingDeals.set(JSON.stringify(report.raw), report);
    }
}
function start() {
    if (started) return;
    started = true;
    if (isMirror) { channel?.postMessage({ kind: 'request' }); return; }
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
        // Do not allow an in-flight snapshot to overwrite a response that was
        // received afterwards; the user can explicitly reconcile once settled.
        if (queryEvents) queryOverflow = true;
        for (const [key, deal] of [...pendingDeals]) {
            if (deal.kind === 'deal' && deal.tradeId === trade.order.id) { pendingDeals.delete(key); applyDeal(deal); }
        }
        schedulePublish();
    });
    const stopOrders = onOrderEvent(report => {
        eventSequence++;
        if (queryEvents && queryEvents.length >= 1000) queryOverflow = true;
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
                for (const [key2, deal] of [...pendingDeals]) {
                    if (deal.kind === 'deal' && deal.tradeId === report.id) { pendingDeals.delete(key2); applyDeal(deal); }
                }
            } else state = { ...state, needsReconcile: true, error: '回報已收到；委託快照待手動對帳' };
        }
        schedulePublish();
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
        else if (!live && hasConnected) {
            connectionEpoch++;
            state = { ...state, needsReconcile: true, error: '串流曾中斷；重新連線後請手動對帳' };
            publish();
        }
    };
    const stopStatus = subscribeStatusStore(statusChanged);
    import.meta.hot?.dispose(() => {
        stopResponses(); stopOrders(); stopTicks(); stopStatus(); channel?.close();
        positionQuotes.forEach(entry => entry.release?.());
        if (publishTimer) clearTimeout(publishTimer);
    });
    ensureStream();
    statusChanged();
}

export const getTradingState = () => state;
export function subscribeTradingState(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
// Order actions wait for active reports. They must not fan out accounting reads.
export function tradingActionObserved() { /* reports drive the shared view */ }
export function useTradingState() {
    useEffect(start, []);
    const accounts = useAccounts();
    const current = useSyncExternalStore(subscribeTradingState, getTradingState);
    return { ...current,
        balance: accounts.selectedStock && current.balanceAccount === accountKey(accounts.selectedStock) ? current.balance : undefined,
        margin: accounts.selectedFutures && current.marginAccount === accountKey(accounts.selectedFutures) ? current.margin : undefined,
    };
}
