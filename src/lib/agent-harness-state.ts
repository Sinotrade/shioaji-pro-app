const STORAGE_KEY = 'sj-agent-harness-enabled';
const CHANGE_EVENT = 'sj-agent-harness-enabled-changed';

let enabledCache =
    typeof localStorage !== 'undefined' &&
    localStorage.getItem(STORAGE_KEY) === 'true';

export function isAgentHarnessEnabled(): boolean {
    return enabledCache;
}

export function cacheAgentHarnessEnabled(enabled: boolean): void {
    const changed = enabledCache !== enabled;
    enabledCache = enabled;
    if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, String(enabled));
    }
    if (changed && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent<boolean>(CHANGE_EVENT, {
            detail: enabled,
        }));
    }
}

export function subscribeAgentHarnessEnabled(
    listener: (enabled: boolean) => void,
): () => void {
    if (typeof window === 'undefined') return () => undefined;
    const handle = (event: Event) =>
        listener((event as CustomEvent<boolean>).detail);
    window.addEventListener(CHANGE_EVENT, handle);
    return () => window.removeEventListener(CHANGE_EVENT, handle);
}
