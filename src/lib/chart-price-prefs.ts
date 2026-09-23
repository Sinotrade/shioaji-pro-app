// src/lib/chart-price-prefs.ts — 圖表「游標移動帶價」偏好（#58），persisted.
//
// 開啟：K 線圖上移動十字線即把價位帶入同商品的下單面板（舊行為）。
// 關閉（預設）：只有點擊圖表或手動輸入才改變下單價格；移動游標只顯示
// 十字線價位。被動的滑鼠移動不應改寫已填好的委託價 — 這是誤掛單的
// 安全問題，因此預設關閉，需要懸停帶價的使用者可在設定中開啟。

import { useSyncExternalStore } from 'react';

export const CHART_HOVER_PRICE_KEY = 'sj-pro-chart-hover-price';

function readStored(): boolean {
    try {
        return localStorage.getItem(CHART_HOVER_PRICE_KEY) === '1';
    } catch {
        return false;
    }
}

let hoverPick = readStored();
const listeners = new Set<() => void>();

function emit() {
    listeners.forEach((l) => l());
}

// 圖表可能在彈出視窗，設定在主視窗改 — 同源 storage 事件同步其他視窗
try {
    window.addEventListener('storage', (e) => {
        if (e.key !== CHART_HOVER_PRICE_KEY && e.key !== null) return;
        const next = readStored();
        if (next !== hoverPick) {
            hoverPick = next;
            emit();
        }
    });
} catch {
    // non-browser environment
}

export function getChartHoverPricePick(): boolean {
    return hoverPick;
}

export function setChartHoverPricePick(v: boolean) {
    hoverPick = v;
    try {
        localStorage.setItem(CHART_HOVER_PRICE_KEY, v ? '1' : '0');
    } catch {
        // session only
    }
    emit();
}

// module-level so useSyncExternalStore doesn't resubscribe every render
function subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => {
        listeners.delete(l);
    };
}

export function useChartHoverPricePick(): boolean {
    return useSyncExternalStore(subscribe, getChartHoverPricePick);
}

/** test-only: re-read storage as a fresh window would at module load */
export function __reloadChartPricePrefsForTest() {
    hoverPick = readStored();
    emit();
}
