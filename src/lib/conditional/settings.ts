// src/lib/conditional/settings.ts — 條件單設定 (#226). Per machine
// (localStorage), shared by every window. Defaults for new conditional
// orders, notifications, 全部暫停 and the bracket rules the background
// engine will take (自動重新啟用／晚到成交自動保護 stay off until it can).

import { useSyncExternalStore } from 'react';

export interface ConditionalSettings {
    /** 新增條件單預設有效期 */
    defaultValidity: 'session' | 'today';
    /** 觸價成立後的預設送出方式（期貨選擇權；股票一律市價） */
    defaultSend: 'MKP' | 'LMT';
    /** 二擇一／停損停利的另一邊 */
    ocoMode: 'trigger' | 'fill';
    /** 觸發、送出、成交跳通知（錯誤與待確認一律通知） */
    notify: boolean;
    /** 新增表單的快速口數 */
    quickQty: number[];
    /** unused: the bracket rules live in the background engine (bracket-policy.ts) */
    autoRearm: boolean;
    /** unused: see bracket-policy.ts */
    autoProtectLateFill: boolean;
    /** 全部暫停時停損停利也暫停（預設只停新進場）— mirrors the engine's BracketPolicy */
    pauseStopsExits: boolean;
}

export const DEFAULT_SETTINGS: ConditionalSettings = {
    defaultValidity: 'today',
    defaultSend: 'MKP',
    ocoMode: 'trigger',
    notify: true,
    quickQty: [1, 5, 10],
    autoRearm: false,
    autoProtectLateFill: false,
    pauseStopsExits: false,
};

const KEY = 'sj-pro-conditional-settings';

function sanitize(raw: unknown): ConditionalSettings {
    const o = raw && typeof raw === 'object' ? raw as Partial<ConditionalSettings> : {};
    const qty = Array.isArray(o.quickQty) ? o.quickQty.filter(n => Number.isSafeInteger(n) && n > 0 && n <= 9999).slice(0, 6) : [];
    return {
        defaultValidity: o.defaultValidity === 'session' ? 'session' : 'today',
        defaultSend: o.defaultSend === 'LMT' ? 'LMT' : 'MKP',
        ocoMode: o.ocoMode === 'fill' ? 'fill' : 'trigger',
        notify: o.notify !== false,
        quickQty: qty.length ? qty : DEFAULT_SETTINGS.quickQty,
        // not supported by any engine yet: always the safe default
        autoRearm: false,
        autoProtectLateFill: false,
        pauseStopsExits: o.pauseStopsExits === true,
    };
}

/** What is stored: pauseStopsExits is never persisted here — it mirrors the
 * engine's policy once read (off until then). */
function stored(s: ConditionalSettings): ConditionalSettings {
    return { ...s, pauseStopsExits: false };
}

function load(): ConditionalSettings {
    try {
        const raw = globalThis.localStorage?.getItem(KEY);
        return raw ? stored(sanitize(JSON.parse(raw))) : DEFAULT_SETTINGS;
    } catch {
        return DEFAULT_SETTINGS;
    }
}

let settings = load();
const listeners = new Set<() => void>();

export function getConditionalSettings(): ConditionalSettings {
    return settings;
}

export function setConditionalSettings(patch: Partial<ConditionalSettings>): void {
    settings = sanitize({ ...settings, ...patch });
    try { globalThis.localStorage?.setItem(KEY, JSON.stringify(stored(settings))); } catch { /* quota / private mode */ }
    listeners.forEach(l => l());
}

export function useConditionalSettings(): ConditionalSettings {
    return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; }, getConditionalSettings);
}

// other windows: the same settings
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('storage', e => {
        if (e.key !== KEY && e.key !== null) return;
        settings = { ...load(), pauseStopsExits: settings.pauseStopsExits };
        listeners.forEach(l => l());
    });
}
