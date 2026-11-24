// src/lib/us/us-tick-prefs.ts — 美股成交資料（逐筆訂閱種類）偏好，persisted.
//
// 預設（產品決定）：一般成交 `Tick`（TICL）＝正規盤會更新最新價的成交，加上盤前、
// 盤後、夜盤的整股成交（延長時段 updates_last=false，價格是 ext_close）。
// 「完整成交」`TickFull`：另外包含碎股與特殊條件成交的每一筆，資料量較大。
// 切換後由 stream.ts 對目前訂閱中的美股逐筆即時改訂，不必重新啟動。
// 與 us-pnl-prefs 同一套機制：localStorage＋storage 事件同步其他視窗。

import { useSyncExternalStore } from 'react';

export const US_TICK_DETAIL_KEY = 'sj-pro-us-tick-detail';
export type UsTickDetail = 'Tick' | 'TickFull';

function readStored(): UsTickDetail {
    try {
        return localStorage.getItem(US_TICK_DETAIL_KEY) === 'TickFull' ? 'TickFull' : 'Tick';
    } catch {
        return 'Tick';
    }
}

let mode = readStored();
const listeners = new Set<() => void>();

function emit() {
    listeners.forEach((l) => l());
}

try {
    window.addEventListener('storage', (e) => {
        if (e.key !== US_TICK_DETAIL_KEY && e.key !== null) return;
        const next = readStored();
        if (next !== mode) {
            mode = next;
            emit();
        }
    });
} catch {
    // non-browser environment
}

export function getUsTickDetail(): UsTickDetail {
    return mode;
}

export function setUsTickDetail(v: UsTickDetail) {
    if (v === mode) return;
    mode = v;
    try {
        localStorage.setItem(US_TICK_DETAIL_KEY, v);
    } catch {
        // session only
    }
    emit();
}

export function subscribeUsTickDetail(l: () => void): () => void {
    listeners.add(l);
    return () => {
        listeners.delete(l);
    };
}

export function useUsTickDetail(): UsTickDetail {
    return useSyncExternalStore(subscribeUsTickDetail, getUsTickDetail);
}
