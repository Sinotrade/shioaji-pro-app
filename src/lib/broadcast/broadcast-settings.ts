// src/lib/broadcast/broadcast-settings.ts — 語音播報的全域設定。
//
// 設定是「全域」的（所有語音播報面板共用），但每個面板各自指定要播報
// 哪些商品（存在 block 上，隨版面一起存檔）。
//
// 沿用 repo 既有的 useSyncExternalStore 寫法（見 toast-prefs.ts / privacy.ts）。

import { useSyncExternalStore } from 'react';

export interface BroadcastSettings {
    /** 總開關 */
    enabled: boolean;
    /** 語速，-10 ~ 10（沿用 WPF 的刻度，0 = 正常） */
    rate: number;
    /** 冷卻秒數，0 ~ 60；只對「沒有狀態詞」的一般播報生效 */
    cooldownSec: number;
    /** 指定語音 uri；空字串 = 自動挑中文語音 */
    voiceUri: string;
}

const KEY = 'sj-pro-broadcast';

export const DEFAULT_SETTINGS: BroadcastSettings = {
    // 預設關閉：語音播報是使用者明確要開的功能，不要幫他開
    enabled: false,
    rate: 4,
    cooldownSec: 4,
    voiceUri: '',
};

export const RATE_MIN = -10;
export const RATE_MAX = 10;
export const COOLDOWN_MIN = 0;
export const COOLDOWN_MAX = 60;

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

function sanitize(raw: Partial<BroadcastSettings> | null): BroadcastSettings {
    if (!raw) return { ...DEFAULT_SETTINGS };
    return {
        enabled:
            typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_SETTINGS.enabled,
        rate: clamp(
            Math.round(Number(raw.rate ?? DEFAULT_SETTINGS.rate)),
            RATE_MIN,
            RATE_MAX,
        ),
        cooldownSec: clamp(
            Math.round(Number(raw.cooldownSec ?? DEFAULT_SETTINGS.cooldownSec)),
            COOLDOWN_MIN,
            COOLDOWN_MAX,
        ),
        voiceUri:
            typeof raw.voiceUri === 'string' ? raw.voiceUri : DEFAULT_SETTINGS.voiceUri,
    };
}

let settings: BroadcastSettings = { ...DEFAULT_SETTINGS };
try {
    const stored = localStorage.getItem(KEY);
    if (stored) settings = sanitize(JSON.parse(stored));
} catch {
    // 讀不到就用預設值（session only）
}

const listeners = new Set<() => void>();

export function getBroadcastSettings(): BroadcastSettings {
    return settings;
}

export function setBroadcastSettings(patch: Partial<BroadcastSettings>) {
    settings = sanitize({ ...settings, ...patch });
    try {
        localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
        // 存不了就只留在記憶體
    }
    listeners.forEach((l) => l());
}

export function useBroadcastSettings(): BroadcastSettings {
    return useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => {
                listeners.delete(l);
            };
        },
        getBroadcastSettings,
    );
}

/**
 * WPF 語速刻度（-10~10）→ Web Speech 語速倍率（1 = 正常）。
 * WPF 的 SpeechSynthesizer.Rate 每格約 10%，這裡採同樣的近似比例。
 */
export function rateToSpeed(rate: number): number {
    const normalized = clamp(rate, RATE_MIN, RATE_MAX);
    return clamp(1 + normalized * 0.1, 0.1, 3);
}
