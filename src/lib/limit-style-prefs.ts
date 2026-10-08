// src/lib/limit-style-prefs.ts — 自選清單漲跌停亮燈樣式（全域一個選項）
//
// block：價格＋漲跌兩行包成圓角實心色塊、白字（預設）
// tint ：整列淡漲跌色底＋右緣 4px 實色色條，字維持漲跌色
// solid：整列實心漲跌色、白字
// none ：不標示
// 自選清單可能在彈出視窗、設定在主視窗改 — 以同源 storage 事件同步其他視窗

import { useSyncExternalStore } from 'react';

export type LimitStyle = 'block' | 'tint' | 'solid' | 'none';

export const LIMIT_STYLE_KEY = 'sj-pro-watchlist-limit-style';
export const LIMIT_STYLES: LimitStyle[] = ['block', 'tint', 'solid', 'none'];
const DEFAULT_STYLE: LimitStyle = 'block';

function readStored(): LimitStyle {
    try {
        const v = localStorage.getItem(LIMIT_STYLE_KEY);
        return LIMIT_STYLES.includes(v as LimitStyle) ? (v as LimitStyle) : DEFAULT_STYLE;
    } catch {
        return DEFAULT_STYLE;
    }
}

let current: LimitStyle = readStored();
const listeners = new Set<() => void>();

function emit() {
    listeners.forEach((l) => l());
}

try {
    window.addEventListener('storage', (e) => {
        if (e.key !== LIMIT_STYLE_KEY && e.key !== null) return;
        const next = readStored();
        if (next !== current) {
            current = next;
            emit();
        }
    });
} catch {
    // non-browser environment
}

export function getLimitStyle(): LimitStyle {
    return current;
}

export function setLimitStyle(v: LimitStyle) {
    current = v;
    try {
        localStorage.setItem(LIMIT_STYLE_KEY, v);
    } catch {
        // session only
    }
    emit();
}

export function subscribeLimitStyle(l: () => void): () => void {
    listeners.add(l);
    return () => {
        listeners.delete(l);
    };
}

export function useLimitStyle(): LimitStyle {
    return useSyncExternalStore(subscribeLimitStyle, getLimitStyle);
}
