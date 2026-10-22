import { useSyncExternalStore } from 'react';
import { getApiBase } from './runtime';
import { todayStr } from './utils/date';

interface CatalogChange {
    region: string;
    base_changed: boolean;
    info_changed: boolean;
}

const listeners = new Set<() => void>();
let version = 0;
let context: string | undefined;
let notificationPending = false;
let notifiedVersion = 0;
let dayTimer: ReturnType<typeof setTimeout> | undefined;
let detachEnvironment: (() => void) | undefined;

function refreshContext(): boolean {
    const next = JSON.stringify([getApiBase(), todayStr()]);
    if (context === next) return false;
    const changed = context !== undefined;
    context = next;
    if (changed) version++;
    return changed;
}

function notify(): void {
    notificationPending = false;
    if (notifiedVersion === version) return;
    notifiedVersion = version;
    for (const listener of [...listeners]) {
        // A display subscriber must not interrupt the stream's remaining
        // metadata listeners.
        try { listener(); }
        catch { /* isolated */ }
    }
}

function scheduleDayCheck(): void {
    clearTimeout(dayTimer);
    dayTimer = undefined;
    if (listeners.size === 0 || typeof window === 'undefined') return;
    // Taiwan is UTC+8 without daylight saving. One timer per store, not per
    // render or panel, refreshes already-open panels at the calendar boundary.
    const dayMs = 86_400_000;
    const offsetMs = 8 * 3_600_000;
    const nextDay = Math.floor((Date.now() + offsetMs) / dayMs) * dayMs + dayMs - offsetMs;
    dayTimer = setTimeout(() => {
        refreshContext();
        notify();
        scheduleDayCheck();
    }, Math.max(1, nextDay - Date.now()));
}

function checkEnvironment(): void {
    refreshContext();
    notify();
    scheduleDayCheck();
}

function attachEnvironment(): void {
    if (detachEnvironment || typeof window === 'undefined') return;
    const target = window;
    const onStorage = (event: StorageEvent) => {
        if (event.key === null || event.key === 'sj-pro-api-port' || event.key === 'sj-pro-api-scheme') checkEnvironment();
    };
    const onVisibility = () => {
        if (document.visibilityState !== 'hidden') checkEnvironment();
    };
    target.addEventListener('sj-pro-api-base-changed', checkEnvironment);
    target.addEventListener('storage', onStorage);
    target.addEventListener('focus', checkEnvironment);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    detachEnvironment = () => {
        target.removeEventListener('sj-pro-api-base-changed', checkEnvironment);
        target.removeEventListener('storage', onStorage);
        target.removeEventListener('focus', checkEnvironment);
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    };
}

/** A monotonic epoch also distinguishes A→B→A from the first A request. */
export function getProductCatalogVersion(): number {
    attachEnvironment();
    if (refreshContext() && !notificationPending) {
        notificationPending = true;
        // getSnapshot can run while React renders. Never synchronously notify
        // other mounted components from that read; the epoch changes only once.
        queueMicrotask(notify);
    }
    return version;
}

export function subscribeProductCatalog(listener: () => void): () => void {
    getProductCatalogVersion();
    listeners.add(listener);
    scheduleDayCheck();
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
            clearTimeout(dayTimer);
            dayTimer = undefined;
        }
    };
}

/** Called by stream's one-way bridge; importing this store never opens SSE. */
export function invalidateProductCatalog(event: CatalogChange): void {
    if (event.region !== 'TW' || (!event.base_changed && !event.info_changed)) return;
    refreshContext();
    version++;
    notify();
    scheduleDayCheck();
}

export function useProductCatalogVersion(): number {
    return useSyncExternalStore(subscribeProductCatalog, getProductCatalogVersion, () => 0);
}

attachEnvironment();
if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        detachEnvironment?.();
        detachEnvironment = undefined;
        clearTimeout(dayTimer);
        listeners.clear();
    });
}
