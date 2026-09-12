import { getApiBase } from './runtime';
import { marketTime, matchesSnapshot } from './display-book';
import type { ContractBase } from './types/contract';
import type { Snapshot } from './types/market';

const snapshots = new Map<string, Snapshot>();
const pending = new Map<string, Promise<Snapshot[]>>();
const listeners = new Set<() => void>();
const key = (c: ContractBase) => JSON.stringify([getApiBase(), c.security_type, c.exchange, c.target_code || c.code]);
export function getMarketSnapshot(c: ContractBase): Snapshot | undefined { return snapshots.get(key(c)); }
export function pendingMarketSnapshot(c: ContractBase) { return pending.get(key(c)); }
export function subscribeMarketSnapshots(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
/** Observe existing snapshot requests, including watchlist batches. No polling. */
export function observeMarketSnapshots(contracts: ContractBase[], request: Promise<Snapshot[]>) {
    const scoped = contracts.map(c => ({ contract: c, cacheKey: key(c) }));
    for (const { cacheKey } of scoped) pending.set(cacheKey, request);
    void request.then(values => {
        let changed = false;
        for (const { contract: c, cacheKey } of scoped) {
            const snapshot = values.find(s => matchesSnapshot(s, c.code, c.target_code));
            if (!snapshot) continue;
            const previous = snapshots.get(cacheKey);
            if (previous && Number.isFinite(marketTime(previous.datetime)) && (!Number.isFinite(marketTime(snapshot.datetime)) || marketTime(previous.datetime) > marketTime(snapshot.datetime))) continue;
            snapshots.set(cacheKey, snapshot);
            changed = true;
        }
        if (changed) for (const listener of listeners) listener();
    }).catch(() => undefined).finally(() => {
        for (const { cacheKey } of scoped) if (pending.get(cacheKey) === request) pending.delete(cacheKey);
    });
    return request;
}
