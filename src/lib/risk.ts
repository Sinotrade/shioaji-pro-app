// src/lib/risk.ts — kill-switch risk controls. Every order path calls
// checkOrderAllowed() before sending; breaching the daily-loss limit or
// flipping the manual lock blocks all order entries.

import { useSyncExternalStore } from 'react';
import { isOddLot, riskLots } from './odd-lot';
import { secretMoney } from './privacy';
import type { StockOrderLot } from './types/order';

export interface RiskSettings {
    enabled: boolean; // master switch for the rules below
    maxQty: number; // per-order quantity cap (0 = unlimited)
    maxDailyLoss: number; // positive number, TWD (0 = unlimited)
    locked: boolean; // manual kill switch — blocks ALL orders
    escCancelAll: boolean; // Esc×2 cancels all working orders — opt-in
    confirmManualOrders: boolean; // 手動下單前跳可視化委託確認 — opt-in
    orderLineLock: boolean; // 圖上委託線鎖定：不能拖曳改價 — opt-in
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
                confirmManualOrders: !!s.confirmManualOrders,
                orderLineLock: !!s.orderLineLock,
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
        confirmManualOrders: false,
        orderLineLock: false,
    };
}

let settings = load();
let dailyPnl = 0; // fed by App from position/margin polling
let dailyPnlKnown = false; // the App has read positions and margin at least once
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
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
        // 配額滿時本視窗照樣生效，只是重開後不保留。
    }
    emit();
}

/** `known`: computed from positions and margin the App has actually read (0 before that is not a PnL). */
export function reportDailyPnl(pnl: number, known = true) {
    if (pnl !== dailyPnl || known !== dailyPnlKnown) {
        dailyPnl = pnl;
        dailyPnlKnown = known;
        emit();
    }
}

export function getDailyPnlKnown(): boolean {
    return dailyPnlKnown;
}

/** Every change of the settings or the daily PnL (also from other windows). */
export function subscribeRiskSettings(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function getRiskSettings(): RiskSettings {
    return settings;
}

export function getDailyPnl(): number {
    return dailyPnl;
}

export function useRiskSettings(): RiskSettings {
    return useSyncExternalStore(subscribeRiskSettings, getRiskSettings);
}

// returns an error message when the order must be blocked, null when OK.
// maxQty is set in 張／口; odd lots (股) are compared as a fraction of 張.
export function checkOrderAllowed(quantity: number, orderLot?: StockOrderLot | string | null): string | null {
    if (settings.locked) {
        return '風控鎖啟動中 — 所有下單已封鎖';
    }
    if (!settings.enabled) return null;
    if (settings.maxQty > 0 && riskLots(quantity, orderLot) > settings.maxQty) {
        return isOddLot(orderLot)
            ? `超過單筆上限 ${settings.maxQty} 張（本筆 ${quantity} 股）`
            : `超過單筆上限 ${settings.maxQty}（本筆 ${quantity}）`;
    }
    if (settings.maxDailyLoss > 0 && dailyPnl <= -settings.maxDailyLoss) {
        // 這段文字會進 toast 與通知中心：開啟遮金額時不顯示金額，之後才開也會重遮（#268）
        return `當日虧損 ${secretMoney(Math.round(dailyPnl))} 已達上限 -${secretMoney(settings.maxDailyLoss)}，下單封鎖`;
    }
    return null;
}
