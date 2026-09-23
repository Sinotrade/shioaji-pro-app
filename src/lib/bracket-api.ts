// src/lib/bracket-api.ts — Trade-cache endpoints used by bracket tracking
// (Shioaji 1.7.6+). Always sent with an explicit account; never polled.
//
// - `refresh:false` reads only the running server's Trade cache (fed by
//   active reports before SSE delivery) — no upstream call, no accounting
//   quota. Used for one-shot lookups at registration / reload / reconnect.
// - `refresh:true` runs update_status(account): authoritative, costs quota.
//   Used ONLY when the user explicitly asks to reconcile.
// - trade_cache_health is cache-only as well.

import { apiPost } from './api';
import type { AccountRef } from './bracket-core';
import type { Trade } from './types/order';

export type TradeCacheHealthState = 'Healthy' | 'Unknown' | 'Degraded';
export type TradeCacheHealthReasonCode =
    | 'NotSubscribed'
    | 'NoBaseline'
    | 'UntrackableEventId'
    | 'SequenceGap'
    | 'PendingReport'
    | 'ProjectionFailed';

export interface TradeCacheHealth {
    state: TradeCacheHealthState;
    reasons: { event_type: string; reason: TradeCacheHealthReasonCode | string }[];
}

const accountBody = (a: AccountRef) => ({ account_type: a.account_type, broker_id: a.broker_id, account_id: a.account_id });

export function fetchCachedTrades(account: AccountRef): Promise<Trade[]> {
    return apiPost<Trade[]>('/api/v1/order/trades', { ...accountBody(account), refresh: false });
}

export function fetchReconciledTrades(account: AccountRef): Promise<Trade[]> {
    return apiPost<Trade[]>('/api/v1/order/trades', { ...accountBody(account), refresh: true });
}

export function fetchTradeCacheHealth(account: AccountRef): Promise<TradeCacheHealth> {
    return apiPost<TradeCacheHealth>('/api/v1/order/trade_cache_health', accountBody(account));
}
