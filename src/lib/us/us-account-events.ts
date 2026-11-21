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

const dealListeners = new Set<() => void>();

/**
 * 美股成交回報後（已合併連續成交、延遲到伺服器更新帳務之後）：重查今日已實現損益。
 * 和庫存重查用同一組延遲排程（us-trading-state 的 scheduleDealPositionsRefresh）。
 */
export function notifyUsDealSettled() {
    dealListeners.forEach(l => l());
}

export function onUsDealSettled(listener: () => void) {
    dealListeners.add(listener);
    return () => { dealListeners.delete(listener); };
}
