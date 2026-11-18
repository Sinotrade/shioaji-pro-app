// src/lib/us/us-account-events.ts — 美股帳務刷新事件（不依賴其他美股模組，避免循環 import）

const refreshListeners = new Set<() => void>();

/** dock「更新帳務」、美股下單／刪單／減量後：重查美股餘額與交割 */
export function requestUsAccountRefresh() {
    refreshListeners.forEach(l => l());
}

export function onUsAccountRefresh(listener: () => void) {
    refreshListeners.add(listener);
    return () => { refreshListeners.delete(listener); };
}
