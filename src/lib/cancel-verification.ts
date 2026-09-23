// Cancel confirmation (#120 / #116). An HTTP 200 from /order/cancel_order is
// not a broker cancellation: the returned Trade is usually still Submitted
// with cancel_quantity 0 (1.7.6 simulation, verified). Shioaji 1.7.6 projects
// active reports into the sidecar Trade cache before SSE delivery, so the
// confirmation reads that cache (`refresh:false`, no broker call) for a short
// window, then does exactly one authoritative `refresh:true` read.
//
// Rules (fail closed):
// - Confirmed only by a row with the same order.id and account, status
//   Cancelled, and cumulative cancel_quantity covering the quantity that was
//   remaining when the cancel started (original order.quantity minus filled).
//   status.order_quantity is never used: 1.7.6 HTTP rows report it as 0.
// - An order missing from the cache is NOT a cancellation, and no Cancelled
//   Trade is ever synthesized from local data.
// - Anything else throws CANCEL_UNCONFIRMED (mutationOutcomeUnknown). The
//   caller must reconcile; nothing here resends the cancel.
//
// Shioaji#234 (still open upstream): simulation reduce-then-cancel can leave
// HTTP rows Submitted after an SSE Cancel. Simulation results here are
// regression evidence only, not production proof.
import type { Trade, TradeCacheHealth } from './types/order';

export interface CancelAccountRef {
    account_type: string;
    broker_id: string;
    account_id: string;
}

export interface CancelVerificationDeps {
    /** POST /order/trades for the order's own account. */
    readTrades(refresh: boolean): Promise<Trade[]>;
    /** POST /order/trade_cache_health for the order's own account. */
    readHealth(): Promise<TradeCacheHealth>;
    /** Throws when the server/account the cancel was sent to is gone. */
    guard?(): void;
    /** False when the sidecar cache has no continuous baseline for this App
     *  (never reconciled on this sidecar, restart suspected, stream down):
     *  cache rows are then skipped and the single refresh:true read decides. */
    cacheTrusted?(): boolean;
    /** Local projection already shows this order Cancelled (from reports).
     *  Only used to time the authoritative read when the cache is not
     *  trusted; it never confirms by itself. */
    locallyCancelled?(): boolean;
    /** Isolates shared in-flight reads (normally the API base). */
    scope?: string;
    sleep?(ms: number): Promise<void>;
    now?(): number;
}

export interface CancelVerificationOptions {
    /** Delay between cache reads. */
    intervalMs?: number;
    /** Cache-read window measured from the first read. */
    windowMs?: number;
}

export type CancelConfirmationSource = 'cache' | 'refresh';

export interface CancelVerified {
    trade: Trade;
    source: CancelConfirmationSource;
    cacheReads: number;
}

export const CANCEL_CACHE_INTERVAL_MS = 300;
export const CANCEL_CACHE_WINDOW_MS = 3_000;

export interface CancelUnconfirmedDetails {
    tradeId: string;
    requiredCancelQuantity: number;
    observedStatus: string | null;
    observedCancelQuantity: number | null;
    observedDealQuantity: number | null;
    /** No row with this id/account in the last successful read. */
    missing: boolean;
    health: TradeCacheHealth | null;
    readError: string | null;
    refreshed: boolean;
}

export class CancelUnconfirmedError extends Error {
    readonly code = 'CANCEL_UNCONFIRMED' as const;
    /** The cancel request was sent; its broker effect is unknown. */
    readonly mutationOutcomeUnknown = true as const;
    readonly reconcileRequired = true as const;
    readonly tradeId: string;
    readonly details: CancelUnconfirmedDetails;
    constructor(details: CancelUnconfirmedDetails) {
        const observed = details.missing
            ? '回讀找不到此委託'
            : details.observedStatus
              ? `最後狀態 ${details.observedStatus}、取消 ${details.observedCancelQuantity ?? '?'}／需 ${details.requiredCancelQuantity}`
              : '無法回讀委託';
        const health = details.health && details.health.state !== 'Healthy'
            ? `；回報快取 ${details.health.state}`
            : '';
        const failed = details.readError ? `；回讀失敗：${details.readError}` : '';
        super(`刪單已送出但未確認取消（${observed}${health}${failed}）；請手動更新委託核對，勿重送`);
        this.name = 'CancelUnconfirmedError';
        this.tradeId = details.tradeId;
        this.details = details;
    }
}

export function isCancelUnconfirmed(error: unknown): error is CancelUnconfirmedError {
    return typeof error === 'object' && error !== null
        && (error as { code?: unknown }).code === 'CANCEL_UNCONFIRMED';
}

const sameAccount = (a: CancelAccountRef, b: CancelAccountRef) =>
    a.account_type === b.account_type && a.broker_id === b.broker_id && a.account_id === b.account_id;

/** Quantity the cancel has to account for: original quantity minus fills at
 *  the start. cancel_quantity is cumulative (an earlier reduce counts). */
export function requiredCancelQuantity(before: Trade): number {
    return Math.max(0, before.order.quantity - before.status.deal_quantity);
}

/** The single row for this order in an account-scoped read, or null when it
 *  is missing or ambiguous. A row naming a different account never matches. */
export function findOrderRow(rows: Trade[], tradeId: string, account: CancelAccountRef): Trade | null {
    const matches = rows.filter(row => row?.order?.id === tradeId
        && (!row.order.account || sameAccount(row.order.account, account)));
    return matches.length === 1 ? matches[0]! : null;
}

export function isConfirmedCancellation(before: Trade, row: Trade | null): row is Trade {
    if (!row || row.status?.status !== 'Cancelled') return false;
    const { cancel_quantity: cancelled, deal_quantity: dealt } = row.status;
    if (!Number.isFinite(cancelled) || !Number.isFinite(dealt)) return false;
    // A cache row behind the local projection is not evidence.
    if (dealt < before.status.deal_quantity) return false;
    return cancelled >= requiredCancelQuantity(before);
}

// Concurrent cancels on one account (flash cancel-all) share an in-flight
// read instead of multiplying HTTP calls — refresh:true costs accounting
// quota (25/5s). A read is only joined when it started after this cancel's
// request settled, so no cancel is judged by an older observation.
const inFlight = new Map<string, { startedAt: number; promise: Promise<Trade[]> }>();
function sharedRead(key: string, notBefore: number, now: () => number, read: () => Promise<Trade[]>) {
    const current = inFlight.get(key);
    if (current && current.startedAt >= notBefore) return current.promise;
    const startedAt = now();
    const promise = read().finally(() => {
        if (inFlight.get(key)?.promise === promise) inFlight.delete(key);
    });
    inFlight.set(key, { startedAt, promise });
    return promise;
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => { globalThis.setTimeout(resolve, ms); });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Call only after the cancel request itself resolved. */
export async function verifyCancellation(
    before: Trade,
    account: CancelAccountRef,
    deps: CancelVerificationDeps,
    options: CancelVerificationOptions = {},
): Promise<CancelVerified> {
    const tradeId = before.order.id;
    const interval = options.intervalMs ?? CANCEL_CACHE_INTERVAL_MS;
    const windowMs = options.windowMs ?? CANCEL_CACHE_WINDOW_MS;
    const sleep = deps.sleep ?? defaultSleep;
    const now = deps.now ?? Date.now;
    const sentAt = now();
    const accountKey = `${deps.scope ?? ''}|${account.account_type}:${account.broker_id}:${account.account_id}`;
    const maxCacheReads = Math.max(1, Math.floor(windowMs / Math.max(1, interval)) + 1);
    let last: Trade | null = null;
    let missing = false;
    let readError: string | null = null;
    let health: TradeCacheHealth | null = null;
    let refreshed = false;
    const unconfirmed = () => new CancelUnconfirmedError({
        tradeId,
        requiredCancelQuantity: requiredCancelQuantity(before),
        observedStatus: missing ? null : last?.status.status ?? null,
        observedCancelQuantity: missing ? null : last?.status.cancel_quantity ?? null,
        observedDealQuantity: missing ? null : last?.status.deal_quantity ?? null,
        missing,
        health,
        readError,
        refreshed,
    });
    // The server or account the cancel went to is gone: stop reading, the
    // outcome stays unknown.
    const guard = () => {
        try { deps.guard?.(); } catch (error) { readError = message(error); throw unconfirmed(); }
    };
    const observe = async (refresh: boolean) => {
        guard();
        let rows: Trade[];
        try {
            rows = await sharedRead(`${accountKey}|${refresh}`, sentAt, now, () => deps.readTrades(refresh));
        } catch (error) {
            readError = message(error);
            return null;
        }
        readError = null;
        const row = findOrderRow(rows, tradeId, account);
        missing = !row;
        if (row) last = row;
        return row;
    };

    let cacheReads = 0;
    if (deps.cacheTrusted && !deps.cacheTrusted()) {
        // No cache reads and no health: go straight to the one authoritative
        // read, timed after the local Cancel report (or the window) so the
        // broker has had a chance to process the request.
        for (let wait = 1; wait < maxCacheReads && !deps.locallyCancelled?.() && now() - sentAt < windowMs; wait += 1) {
            guard();
            await sleep(interval);
        }
        refreshed = true;
        const row = await observe(true);
        if (isConfirmedCancellation(before, row)) return { trade: row, source: 'refresh', cacheReads };
        throw unconfirmed();
    }
    for (let attempt = 0; attempt < maxCacheReads; attempt += 1) {
        if (attempt > 0) {
            if (now() - sentAt >= windowMs) break;
            await sleep(interval);
        }
        cacheReads += 1;
        const row = await observe(false);
        if (isConfirmedCancellation(before, row)) return { trade: row, source: 'cache', cacheReads };
    }

    // Still unconfirmed. Health explains why; it never confirms by itself.
    // Healthy or not, the order is unconfirmed, so exactly one authoritative
    // read follows.
    guard();
    try {
        health = await deps.readHealth();
    } catch {
        health = null; // pre-1.7.6 route or read failure: no information
    }
    refreshed = true;
    const row = await observe(true);
    if (isConfirmedCancellation(before, row)) return { trade: row, source: 'refresh', cacheReads };
    throw unconfirmed();
}
