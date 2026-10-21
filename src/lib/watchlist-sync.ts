// src/lib/watchlist-sync.ts — in-App signal that the server watchlists were
// changed outside the 自選 panel (AI Agent tools, #340). The panel re-reads
// the server lists when it hears this; nothing polls. The private Agent
// overlay dispatches the same event name directly, so the name and detail
// shape are a wire contract: change both sides together.

export const WATCHLIST_CHANGED_EVENT = 'sj-pro:watchlist-changed';

export interface WatchlistChangedDetail {
    /** list id to switch the panel to after the re-read (select / rename) */
    select?: string;
    /** who changed the lists; only used for wording */
    source?: 'agent' | 'user';
}

export function emitWatchlistChanged(detail: WatchlistChangedDetail = {}): void {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    window.dispatchEvent(new CustomEvent<WatchlistChangedDetail>(WATCHLIST_CHANGED_EVENT, { detail }));
}

/** Normalize an untrusted event detail (other code dispatches it by name). */
export function watchlistChangedDetail(value: unknown): WatchlistChangedDetail {
    const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    return {
        ...(typeof raw.select === 'string' && raw.select ? { select: raw.select } : {}),
        ...(raw.source === 'agent' || raw.source === 'user' ? { source: raw.source } : {}),
    };
}

export function onWatchlistChanged(handler: (detail: WatchlistChangedDetail) => void): () => void {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => undefined;
    const listener = (event: Event) => handler(watchlistChangedDetail((event as CustomEvent).detail));
    window.addEventListener(WATCHLIST_CHANGED_EVENT, listener);
    return () => window.removeEventListener(WATCHLIST_CHANGED_EVENT, listener);
}
