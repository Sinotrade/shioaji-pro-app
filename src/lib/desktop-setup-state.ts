// src/lib/desktop-setup-state.ts — the ONE non-secret fact child windows
// need from settings.json: whether first-run setup is done. The main window
// derives it from the credentials it loads/saves and publishes only this
// boolean through localStorage (same origin for every app WebView, like the
// API port and the Agent Harness flag). The keys themselves never leave the
// main window.

const STORAGE_KEY = 'sj-desktop-configured';
const CHANGE_EVENT = 'sj-desktop-configured-changed';

/** true / false as published by the main window; null = not yet known. */
export function readDesktopConfigured(): boolean | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw === 'true' ? true : raw === 'false' ? false : null;
    } catch {
        return null;
    }
}

export function cacheDesktopConfigured(configured: boolean): void {
    try {
        if (localStorage.getItem(STORAGE_KEY) === String(configured)) return;
        localStorage.setItem(STORAGE_KEY, String(configured));
    } catch {
        return;
    }
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event(CHANGE_EVENT));
    }
}

/**
 * Fires in this window (custom event), in other windows (`storage`), and
 * whenever this window regains focus or becomes visible. The tray panel is
 * hidden and reused, never reloaded, so a re-read on show does not depend on
 * the cross-window `storage` event reaching a hidden WebView.
 */
export function subscribeDesktopConfigured(listener: () => void): () => void {
    if (typeof window === 'undefined') return () => undefined;
    const onStorage = (event: StorageEvent) => {
        if (event.key === STORAGE_KEY || event.key === null) listener();
    };
    const onVisibility = () => {
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
            listener();
        }
    };
    window.addEventListener(CHANGE_EVENT, listener);
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', listener);
    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisibility);
    }
    return () => {
        window.removeEventListener(CHANGE_EVENT, listener);
        window.removeEventListener('storage', onStorage);
        window.removeEventListener('focus', listener);
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', onVisibility);
        }
    };
}
