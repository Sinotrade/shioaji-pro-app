// src/lib/broadcast/broadcast-settings.ts — 語音播報的全域設定。
//
// 設定是「全域」的（所有語音播報面板共用），但每個面板各自指定要播報
// 哪些商品（存在 block 上，隨版面一起存檔）。
//
// 沿用 repo 既有的 useSyncExternalStore 寫法（見 toast-prefs.ts / privacy.ts）。
//
// 註：語速是「抽象刻度 -10~20」，各 engine 自行映射成自己的語意
// （見 lib/tts/web-speech-engine.ts 的 rateToSpeed）。共用層不做映射。

import { useSyncExternalStore } from 'react';

export interface BroadcastSettings {
    /** 總開關 */
    enabled: boolean;
    /**
     * 語速，-10 ~ 20（沿用 WPF 的刻度，0 = 正常，每格約 10%）。
     * 上限從 10 放寬到 20：舊的 ±10 在 Web Speech 只到 2.0 倍，
     * 而 engine 本來就允許到 3.0 倍（見 rateToSpeed）。既有使用者的
     * rate=10 仍然是 2.0 倍，行為不變，只是多了更快的檔位。
     */
    rate: number;
    /** 冷卻秒數，0 ~ 60；只對「沒有狀態詞」的一般播報生效 */
    cooldownSec: number;
    /** 指定語音 uri；空字串 = 自動挑中文語音 */
    voiceUri: string;
    /** 行情狀態播報（創新高／破新低／漲跌停） */
    quoteEnabled: boolean;
    /** 成交／委託回報播報 */
    dealEnabled: boolean;
    /** 通知／條件單觸發播報 */
    noticeEnabled: boolean;
}

const KEY = 'sj-pro-broadcast';

export const DEFAULT_SETTINGS: BroadcastSettings = {
    // 預設關閉：語音播報是使用者明確要開的功能，不要幫他開
    enabled: false,
    rate: 4,
    cooldownSec: 4,
    voiceUri: '',
    // 三類事件全部預設關：一次全開會被轟炸，由使用者逐一開啟
    quoteEnabled: false,
    dealEnabled: false,
    noticeEnabled: false,
};

export const RATE_MIN = -10;
export const RATE_MAX = 20;
export const COOLDOWN_MIN = 0;
export const COOLDOWN_MAX = 60;

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

function bool(raw: unknown, fallback: boolean): boolean {
    return typeof raw === 'boolean' ? raw : fallback;
}

function sanitize(raw: Partial<BroadcastSettings> | null): BroadcastSettings {
    if (!raw) return { ...DEFAULT_SETTINGS };
    return {
        enabled: bool(raw.enabled, DEFAULT_SETTINGS.enabled),
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
        quoteEnabled: bool(raw.quoteEnabled, DEFAULT_SETTINGS.quoteEnabled),
        dealEnabled: bool(raw.dealEnabled, DEFAULT_SETTINGS.dealEnabled),
        noticeEnabled: bool(raw.noticeEnabled, DEFAULT_SETTINGS.noticeEnabled),
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
