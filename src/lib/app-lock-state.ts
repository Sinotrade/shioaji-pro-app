// src/lib/app-lock-state.ts — 應用程式鎖的型別、常數、狀態存取與純函式小工具。

import { useSyncExternalStore } from 'react';
import { resetEscCancelArm } from './esc-cancel-arm';

export interface AppLockState {
    salt: string;
    hash: string; // PBKDF2-SHA256(解鎖密碼)，base64；不存原文
    iterations: number;
    locked: boolean;
    failures: number; // 連續輸錯次數，和鎖定狀態存在一起，重開不歸零
    system: boolean; // 也允許 Touch ID／Windows Hello 解鎖
    wakeMs: number; // 電腦睡眠超過這麼久，喚醒時上鎖（WAKE_OPTIONS 其中一個）
    hint: string; // 密碼提示，鎖定畫面按了才顯示；旁人也看得到
    forgot: boolean; // 鎖定畫面按了「忘記密碼」：和錯滿 10 次一樣登出
}
// missing＝網頁版，或原生還沒有 app_lock_system_auth 指令
export type SystemAuthResult = 'ok' | 'cancelled' | 'unavailable' | 'missing';

export const KEY = 'sj-pro-app-lock';
export const LOGGED_OUT_KEY = 'sj-pro-app-lock-logged-out'; // 登出後給登入畫面的說明：'1' 錯滿 10 次、'forgot' 忘記密碼
export const HINT_MAX = 10; // 密碼提示字數上限（以字元計）
export const MIN_PASSWORD_LENGTH = 6;
export const LOGOUT_AFTER = 10;
// 確認委託之後、送出之前被鎖住時的說明（下單匣、分倉、鋪單、零股拆單與 trade.ts 共用）
export const APP_LOCKED_MESSAGE = '應用程式已鎖定，這筆沒有送出';
export const ITERATIONS = 600_000; // OWASP 2023 對 PBKDF2-HMAC-SHA256 的建議值；WebKit 解鎖約 150 ms
// 睡眠喚醒：計時器停了一大段又醒來就上鎖（同 stream.ts 的 RESUME_GAP_MS 做法），門檻在設定頁選。
// 最短 90 秒：要比背景節流（最慢約一分鐘一次）長，最小化的視窗才不會被誤判。
// ponytail: 睡不到門檻不會上鎖；要即時請原生在睡眠前上鎖（docs/design/app-lock.md）
export const WAKE_GAP_MS = 90_000; // 預設值
export const WAKE_OPTIONS: readonly (readonly [ms: number, label: string])[] =
    [[WAKE_GAP_MS, '90 秒'], [300_000, '5 分鐘'], [900_000, '15 分鐘'], [1_800_000, '30 分鐘'], [3_600_000, '1 小時']];

export const clampHint = (hint: string) => Array.from(hint).slice(0, HINT_MAX).join('');

export function load(): AppLockState | null {
    try {
        const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<AppLockState> | null;
        return s && typeof s.salt === 'string' && typeof s.hash === 'string' ? {
            salt: s.salt, hash: s.hash, iterations: Number(s.iterations) || ITERATIONS,
            locked: !!s.locked, failures: Number(s.failures) || 0, system: !!s.system,
            wakeMs: WAKE_OPTIONS.some(([ms]) => ms === s.wakeMs) ? s.wakeMs! : WAKE_GAP_MS, // 舊紀錄沒有這欄
            hint: typeof s.hint === 'string' ? clampHint(s.hint) : '', forgot: !!s.forgot,
        } : null;
    } catch {
        return null;
    }
}

let state = load();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
export function syncState(next: AppLockState | null) {
    state = next;
    emit();
}
export function save(next: AppLockState | null) {
    state = next;
    try {
        if (next) localStorage.setItem(KEY, JSON.stringify(next));
        else localStorage.removeItem(KEY);
    } catch { /* storage 不能用：只在這個視窗生效 */ }
    emit(); // 寫入的視窗收不到自己的 storage 事件
}
// 寫入時和存檔合併，鎖定與錯誤次數取比較嚴的那邊：別的視窗剛上鎖或剛輸錯（storage 事件還沒送到），
// 或這個視窗之前寫不進存檔（記憶體鎖著、存檔沒鎖），都不能被這次寫入蓋成沒鎖、次數變少。
// 解鎖與歸零只能由 patch 明確給
export const update = (patch: Partial<AppLockState>) => {
    if (!state) return;
    const saved = load() ?? state;
    save({ ...saved, locked: saved.locked || state.locked, failures: Math.max(saved.failures, state.failures), ...patch });
};
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const getAppLock = () => state;
export const useAppLock = () => useSyncExternalStore(subscribe, getAppLock);
export const isAppAccessBlocked = () => state?.locked === true; // 每次按鍵都會呼叫：只讀模組變數

export const isMac = () => typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);
export const lockShortcutLabel = () => (isMac() ? '⇧⌘L' : 'Ctrl+Shift+L');
export const systemAuthLabel = () => (isMac() ? 'Touch ID 或 Mac 登入密碼' : 'Windows Hello');
export const passwordTooShort = (password: string) => Array.from(password).length < MIN_PASSWORD_LENGTH;
// 第 5 次是「再錯 5 次」、第 8 次是「再錯 2 次」
export const failureText = (failures: number) =>
    failures >= 5 ? `解鎖密碼不正確。再錯 ${LOGOUT_AFTER - failures} 次將會登出。` : '解鎖密碼不正確。';

export function lockApp() {
    if (!state || state.locked) return;
    resetEscCancelArm(); // 鎖定前的 Esc 第一下不能和解鎖後的湊成 Esc×2
    update({ locked: true });
}
