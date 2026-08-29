// src/lib/risk.ts — kill-switch risk controls. Every order path calls
// checkOrderAllowed() before sending; breaching the daily-loss limit or
// flipping the manual lock blocks all order entries.

import { useSyncExternalStore } from 'react';

export interface RiskSettings {
    enabled: boolean; // master switch for the rules below
    maxQty: number; // per-order quantity cap (0 = unlimited)
    maxDailyLoss: number; // positive number, TWD (0 = unlimited)
    locked: boolean; // manual kill switch — blocks ALL orders
    escCancelAll: boolean; // Esc×2 cancels all working orders — opt-in
}

const STORAGE_KEY = 'sj-pro-risk';

function load(): RiskSettings {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const s = JSON.parse(raw) as Partial<RiskSettings>;
            return {
                enabled: !!s.enabled,
                maxQty: Number(s.maxQty) || 0,
                maxDailyLoss: Number(s.maxDailyLoss) || 0,
                locked: !!s.locked,
                escCancelAll: !!s.escCancelAll,
            };
        }
    } catch {
        // defaults
    }
    return {
        enabled: false,
        maxQty: 0,
        maxDailyLoss: 0,
        locked: false,
        escCancelAll: false,
    };
}

let settings = load();
let dailyPnl = 0; // fed by App from position/margin polling
const listeners = new Set<() => void>();

// cross-window sync — popouts share localStorage but not module state;
// without this, toggling the kill switch or the Esc-Esc hotkey in one
// window never reaches already-open popout windows.
window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) {
        settings = load();
        emit();
    }
});

function emit() {
    listeners.forEach((l) => l());
}

export function setRiskSettings(next: Partial<RiskSettings>) {
    settings = { ...settings, ...next };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    emit();
}

export function reportDailyPnl(pnl: number) {
    if (pnl !== dailyPnl) {
        dailyPnl = pnl;
        emit();
    }
}

export function getRiskSettings(): RiskSettings {
    return settings;
}

export function getDailyPnl(): number {
    return dailyPnl;
}

export function useRiskSettings(): RiskSettings {
    return useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => settings,
    );
}

// returns an error message when the order must be blocked, null when OK
export function checkOrderAllowed(quantity: number): string | null {
    if (settings.locked) {
        return '風控鎖啟動中 — 所有下單已封鎖';
    }
    if (!settings.enabled) return null;
    if (settings.maxQty > 0 && quantity > settings.maxQty) {
        return `超過單筆上限 ${settings.maxQty}（本筆 ${quantity}）`;
    }
    if (settings.maxDailyLoss > 0 && dailyPnl <= -settings.maxDailyLoss) {
        return `當日虧損 ${Math.round(dailyPnl)} 已達上限 -${settings.maxDailyLoss}，下單封鎖`;
    }
    return null;
}
