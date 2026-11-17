// src/lib/app-lock-system-auth.ts — 系統驗證與原生指令支援狀態的快取。

import { isTauri } from './runtime';
import type { SystemAuthResult } from './app-lock-state';

// 不在掛載時試呼叫（一呼叫就跳出系統驗證）：第一次真的用到才知道原生有沒有這個指令，
// 結果依 build 記在 localStorage，同一版只需要試一次（換版會再試，原生可能已經補上）
const MISSING_KEY = 'sj-pro-app-lock-system-missing';
const BUILD = typeof __SHIOAJI_BUILD_VERSION__ === 'string' ? __SHIOAJI_BUILD_VERSION__ : '';
let systemMissing = (() => { try { return localStorage.getItem(MISSING_KEY) === BUILD; } catch { return false; } })();
export const systemAuthSupported = () => isTauri && !systemMissing;
export async function systemAuth(): Promise<SystemAuthResult> {
    if (!systemAuthSupported()) return 'missing';
    try {
        const result = await (await import('@tauri-apps/api/core')).invoke<unknown>('app_lock_system_auth');
        return result === 'ok' || result === 'cancelled' ? result : 'unavailable';
    } catch (error) {
        // 舊版原生：Tauri 回「Command app_lock_system_auth not found」（字串或 Error）
        if (!/app_lock_system_auth\s+not found/i.test(String((error as { message?: unknown } | null)?.message ?? error))) return 'unavailable';
        systemMissing = true;
        try { localStorage.setItem(MISSING_KEY, BUILD); } catch { /* 只在這次執行記得 */ }
        return 'missing';
    }
}
