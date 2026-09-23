import { getApiBase } from './runtime';
import type { Trade } from './types/order';

export type MutationOutcome = 'confirmed' | 'pending' | 'unknown';
/** A resolved HTTP request alone is not a broker cancellation acknowledgement.
 *  cancelOrder resolves only with a read-back-confirmed Cancelled row (#120). */
export function cancellationOutcome(trade: Trade): MutationOutcome {
    if (trade?.status?.status === 'Cancelled') return 'confirmed';
    if (['Submitted', 'PreSubmitted', 'PendingSubmit', 'PartFilled'].includes(trade?.status?.status)) return 'pending';
    return 'unknown';
}
const flag = (reason: unknown, key: 'mutationNotStarted' | 'mutationOutcomeUnknown') =>
    typeof reason === 'object' && reason !== null && (reason as Record<string, unknown>)[key] === true;
export function cancellationSummary(results: PromiseSettledResult<Trade>[]) {
    let confirmed = 0, unconfirmed = 0, notSent = 0, unknown = 0;
    for (const result of results) {
        if (result.status === 'fulfilled') {
            const outcome = cancellationOutcome(result.value);
            if (outcome === 'confirmed') confirmed++; else if (outcome === 'pending') unconfirmed++; else unknown++;
        } else if (flag(result.reason, 'mutationNotStarted')) notSent++;
        else if (flag(result.reason, 'mutationOutcomeUnknown')) unconfirmed++;
        else unknown++;
    }
    const parts = [`已確認取消 ${confirmed} 筆`];
    if (unconfirmed) parts.push(`已送出未確認 ${unconfirmed} 筆`);
    if (notSent) parts.push(`未送出 ${notSent} 筆`);
    if (unknown) parts.push(`失敗或結果未知 ${unknown} 筆`);
    const unresolved = unconfirmed + unknown;
    return {
        kind: unresolved ? 'err' as const : notSent ? 'info' as const : 'ok' as const,
        body: `${parts.join('；')}。${unresolved ? '未確認項目請手動更新委託核對，勿自動重送。' : ''}`,
    };
}
// Results that cancelOrder read back and confirmed (same id/account, Cancelled,
// cancel_quantity covering the remaining quantity). Only these may overtake
// reports that arrived while the request was in flight.
const confirmedResults = new WeakSet<Trade>();
export function markConfirmedCancellation<T extends Trade>(trade: T): T {
    confirmedResults.add(trade);
    return trade;
}
export interface MutationObservation { token: string; base: string; tradeId: string; phase: 'begin' | 'settled'; trade?: Trade; confirmed?: boolean }
const pendingIds = new Map<string, string>();
const listeners = new Set<(event: MutationObservation) => void>();
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`sj-trade-mutations:${getApiBase()}`) : null;
function emit(event: MutationObservation) {
    if (event.base !== getApiBase()) return;
    for (const listener of listeners) { try { listener(event); } catch { /* display cannot reject an accepted request */ } }
}
channel?.addEventListener('message', event => { if (event.data?.token && event.data?.tradeId && ['begin', 'settled'].includes(event.data.phase)) emit(event.data); });
function publish(event: MutationObservation) { emit(event); try { channel?.postMessage(event); } catch { /* closed window */ } }
function dispatchTradeMutation(tradeId: string, request: () => Promise<Trade>): Promise<Trade> {
    if (pendingIds.has(tradeId)) return Promise.reject(new Error('此委託已有刪單／改單送出，請等待結果再確認'));
    const context = { token: crypto.randomUUID(), base: getApiBase(), tradeId };
    // Remote observations must never own the local dispatch gate: a window may close
    // before publishing settled. Cross-window exclusion belongs to the Web Lock.
    pendingIds.set(tradeId, context.token);
    publish({ ...context, phase: 'begin' });
    let pending: Promise<Trade>;
    try { pending = request(); } catch (error) { pending = Promise.reject(error); }
    return pending.then(trade => {
        publish({ ...context, phase: 'settled', trade, ...(confirmedResults.has(trade) ? { confirmed: true } : {}) }); return trade;
    }, error => { publish({ ...context, phase: 'settled' }); throw error; }).finally(() => {
        if (pendingIds.get(tradeId) === context.token) pendingIds.delete(tradeId);
    });
}
export function onTradeMutation(listener: (event: MutationObservation) => void) {
    listeners.add(listener); return () => { listeners.delete(listener); };
}
import.meta.hot?.dispose(() => channel?.close());

/** Exclusive per-order dispatch, never queue a second mutation. */
export async function observeTradeMutation(tradeId: string, request: () => Promise<Trade>): Promise<Trade> {
    if (typeof navigator === 'undefined' || !navigator.locks) {
        throw new Error('此環境不支援跨視窗委託互斥（Web Locks），未送出刪單／改單；請使用支援的桌面環境');
    }
    const base = getApiBase();
    return await navigator.locks.request(
        `sj-trade-mutation:${base}:${tradeId}`, { ifAvailable: true }, lock => {
            if (!lock) throw new Error('此委託已有刪單／改單送出，請等待結果再確認');
            if (base !== getApiBase()) throw new Error('伺服器已切換，未送出刪單／改單');
            return dispatchTradeMutation(tradeId, request);
        });
}
