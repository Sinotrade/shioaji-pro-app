import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getApiBase } from '../lib/runtime';
import { createAccountQuery } from '../lib/account-query';
import type { Account } from '../lib/types/portfolio';

interface Result<T> { data?: T; error: string | null; loading: boolean; updatedAt: number | null }
interface Entry { result: Result<unknown>; listeners: Set<() => void>; pending?: Promise<void>; attempted: boolean; nextAt: number }
const cache = new Map<string, Entry>();
function entryFor(key: string) {
    let entry = cache.get(key);
    if (!entry) {
        entry = { result: { error: null, loading: false, updatedAt: null }, listeners: new Set(), attempted: false, nextAt: 0 };
        cache.set(key, entry);
    }
    return entry;
}
const empty: Result<unknown> = { error: null, loading: false, updatedAt: null };

/** Session snapshot shared by scope; only first use and manual refresh query.
 * No focus/reconnect/timer refresh, no queued clicks, and failed refreshes keep data.
 */
export function useQuery<T>(fetcher: () => Promise<T>, key: string, enabled = true, accounts?: readonly Account[]) {
    const accountScope = accounts?.map(a => `${a.account_type}:${a.broker_id}:${a.account_id}`).join('|');
    const entry = entryFor(`${getApiBase()}:${key}`);
    const result = useSyncExternalStore(useCallback((listener: () => void) => {
        entry.listeners.add(listener);
        return () => { entry.listeners.delete(listener); };
    }, [entry]), () => enabled ? entry.result : empty) as Result<T>;
    const refresh = useCallback((): Promise<void> => {
        if (!enabled) return Promise.resolve();
        if (entry.pending) return entry.pending;
        if (Date.now() < entry.nextAt) return Promise.resolve();
        entry.attempted = true;
        const emit = () => entry.listeners.forEach(l => l());
        entry.result = { ...entry.result, error: null, loading: true };
        emit();
        // Start on a microtask so synchronous throws also reach the error path.
        const query = accounts && createAccountQuery();
        const assertCurrent = () => {
            query?.assertCurrent();
            for (const account of accounts ?? []) query!.account(account.account_type as 'S' | 'F', account);
        };
        entry.pending = Promise.resolve().then(() => {
            assertCurrent();
            return fetcher();
        }).then(data => {
            assertCurrent();
            entry.result = { data, error: null, loading: false, updatedAt: Date.now() };
        }).catch(error => {
            entry.result = { ...entry.result, loading: false, error: error instanceof Error ? error.message : String(error) };
        }).finally(() => { entry.pending = undefined; entry.nextAt = Date.now() + 1500; emit(); });
        return entry.pending;
    }, [entry, enabled, fetcher, accountScope]);
    useEffect(() => { if (enabled && !entry.attempted) void refresh(); }, [entry, enabled, refresh]);
    return { ...result, refresh };
}
