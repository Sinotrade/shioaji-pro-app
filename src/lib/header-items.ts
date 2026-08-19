// src/lib/header-items.ts — 頂欄項目自訂：哪些 header 項目要顯示。
// 可開關項＝行情列各 chip、交割水位、LIVE、時鐘、全開、版面。
// 固定不可關（不在此列）＝logo、模擬/正式徽章、伺服器、風控、
// ＋新增面板、設定。Persisted（缺省全開）。

import { useSyncExternalStore } from 'react';

const KEY = 'sj-pro-header-items';

export type HeaderItemKey =
    | 'marketIndex'
    | 'marketBasis'
    // Renamed from 'bankBalance': the value is KGI's securities settlement
    // trial amount (Account.SettleAmtTrial), not a real linked-bank
    // balance — KGI's SDK has no bank-balance field. The old key still
    // safely falls through to the default-on behavior below for anyone
    // with a persisted preference under the previous name.
    | 'settleBalance'
    | 'liveStatus'
    | 'layoutLibrary'
    | 'flashAll'
    | 'clock';

export const HEADER_ITEMS: { key: HeaderItemKey; label: string }[] = [
    { key: 'marketIndex', label: '加權指數' },
    { key: 'marketBasis', label: '期現基差' },
    { key: 'settleBalance', label: '交割水位' },
    { key: 'liveStatus', label: 'LIVE 連線狀態' },
    { key: 'layoutLibrary', label: '版面（版面庫）' },
    { key: 'flashAll', label: '全開（閃電下單）' },
    { key: 'clock', label: '時鐘' },
];

export type HeaderItemsState = Record<HeaderItemKey, boolean>;

const DEFAULTS: HeaderItemsState = {
    marketIndex: true,
    marketBasis: true,
    settleBalance: true,
    liveStatus: true,
    layoutLibrary: true,
    flashAll: true,
    clock: true,
};

function load(): HeaderItemsState {
    try {
        const raw = localStorage.getItem(KEY);
        if (raw) {
            const parsed: unknown = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                // missing keys default on — new items appear for old prefs
                const next = { ...DEFAULTS };
                for (const { key } of HEADER_ITEMS) {
                    const v = (parsed as Record<string, unknown>)[key];
                    if (typeof v === 'boolean') next[key] = v;
                }
                return next;
            }
        }
    } catch {
        // storage unavailable — defaults
    }
    return { ...DEFAULTS };
}

let state: HeaderItemsState = load();

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function getHeaderItems(): HeaderItemsState {
    return state;
}

export function setHeaderItem(key: HeaderItemKey, on: boolean) {
    state = { ...state, [key]: on };
    try {
        localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
        // session-only
    }
    listeners.forEach((l) => l());
}

export function useHeaderItems(): HeaderItemsState {
    return useSyncExternalStore(subscribe, getHeaderItems);
}
