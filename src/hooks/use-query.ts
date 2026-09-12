import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getApiBase } from '../lib/runtime';

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
export function useQuery<T>(fetcher: () => Promise<T>, key: string, enabled = true) {
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
        entry.pending = Promise.resolve().then(fetcher).then(data => {
            entry.result = { data, error: null, loading: false, updatedAt: Date.now() };
        }, error => {
            entry.result = { ...entry.result, loading: false, error: error instanceof Error ? error.message : String(error) };
        }).finally(() => { entry.pending = undefined; entry.nextAt = Date.now() + 1500; emit(); });
        return entry.pending;
    }, [entry, enabled, fetcher]);
    useEffect(() => { if (enabled && !entry.attempted) void refresh(); }, [entry, enabled, refresh]);
    return { ...result, refresh };
}
