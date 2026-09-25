// src/lib/window-role.ts — which WebView is this? Only the `main` window may
// read or write the desktop settings store (settings.json holds the API key,
// secret key and CA password). Popouts (`?popout=<type>`, incl. the tray
// panel `?popout=traypanel`) are child windows; the approval window has its
// own entry (approval.html) and never loads this bundle.

interface TauriWindowMetadata {
    __TAURI_INTERNALS__?: {
        metadata?: { currentWindow?: { label?: unknown } };
    };
}

/** The native window label, or null outside Tauri / before metadata exists. */
export function currentWindowLabel(): string | null {
    if (typeof window === 'undefined') return null;
    try {
        const label = (window as unknown as TauriWindowMetadata)
            .__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
        return typeof label === 'string' ? label : null;
    } catch {
        return null;
    }
}

/**
 * True for every WebView except the main window: anything opened with a
 * `popout` query, and any native window whose label is not `main` (defense
 * in depth for a child window opened without the query).
 */
export function isChildWindow(
    search: string = typeof window === 'undefined' ? '' : (window.location?.search ?? ''),
    label: string | null = currentWindowLabel(),
): boolean {
    if (new URLSearchParams(search).has('popout')) return true;
    return label !== null && label !== 'main';
}

/** Brings the main window to the front (tray / popout helpers). */
export async function focusMainWindow(): Promise<void> {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const main = await WebviewWindow.getByLabel('main');
    await main?.show();
    await main?.unminimize();
    await main?.setFocus();
}
