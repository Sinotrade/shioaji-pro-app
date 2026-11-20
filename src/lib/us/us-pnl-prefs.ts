// src/lib/us/us-pnl-prefs.ts — 美股庫存即時損益的計價時段偏好，persisted.
//
// 預設（產品決定）：盤前／盤中／盤後的成交都更新美股庫存的市價與未實現損益。
// 「只用一般盤」：忽略盤前／盤後成交；市價取今天最後一筆一般盤成交，今天
// 一般盤還沒成交時取快照的一般盤收盤（snapshot close）。
// 與 chart-price-prefs 同一套機制：localStorage＋storage 事件同步其他視窗。

import { useSyncExternalStore } from 'react';

export const US_PNL_SESSION_KEY = 'sj-pro-us-pnl-session';
export type UsPnlSession = 'all' | 'regular';

function readStored(): UsPnlSession {
    try {
        return localStorage.getItem(US_PNL_SESSION_KEY) === 'regular' ? 'regular' : 'all';
    } catch {
        return 'all';
    }
}

let mode = readStored();
const listeners = new Set<() => void>();

function emit() {
    listeners.forEach((l) => l());
}

try {
    window.addEventListener('storage', (e) => {
        if (e.key !== US_PNL_SESSION_KEY && e.key !== null) return;
        const next = readStored();
        if (next !== mode) {
            mode = next;
            emit();
        }
    });
} catch {
    // non-browser environment
}

export function getUsPnlSession(): UsPnlSession {
    return mode;
}

export function setUsPnlSession(v: UsPnlSession) {
    if (v === mode) return;
    mode = v;
    try {
        localStorage.setItem(US_PNL_SESSION_KEY, v);
    } catch {
        // session only
    }
    emit();
}

export function subscribeUsPnlSession(l: () => void): () => void {
    listeners.add(l);
    return () => {
        listeners.delete(l);
    };
}

export function useUsPnlSession(): UsPnlSession {
    return useSyncExternalStore(subscribeUsPnlSession, getUsPnlSession);
}

/** test-only: re-read storage as a fresh window would at module load */
export function __reloadUsPnlPrefsForTest() {
    mode = readStored();
    emit();
}
