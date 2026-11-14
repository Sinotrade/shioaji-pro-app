// src/lib/shortcuts/store.ts — 使用者改鍵（只存與預設不同的項目）
//
// 存在 localStorage（與其他偏好設定相同，跟著這台電腦的 App 設定走），
// 主視窗與彈出視窗透過 storage 事件同步。讀回時一律 sanitize：未知項目、
// 固定鍵、現在已被保留或互相衝突的覆寫都回到預設。

import { useSyncExternalStore } from 'react';
import { detectPlatform, type Platform } from './keys';
import { checkBinding, defById, sanitizeOverrides, type BindingCheck, type Overrides } from './registry';

export const SHORTCUTS_STORAGE_KEY = 'sj-pro-shortcuts';

export interface ShortcutState {
    overrides: Overrides;
    platform: Platform;
}

function read(platform: Platform): Overrides {
    try {
        const raw = localStorage.getItem(SHORTCUTS_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as { v?: number; overrides?: unknown };
        return parsed?.v === 1 ? sanitizeOverrides(parsed.overrides, platform) : {};
    } catch {
        return {};
    }
}

const platform = detectPlatform();
let state: ShortcutState = { overrides: read(platform), platform };
const listeners = new Set<() => void>();

function emit() {
    for (const l of listeners) l();
}

function persist() {
    try {
        if (Object.keys(state.overrides).length) {
            localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify({ v: 1, overrides: state.overrides }));
        } else {
            localStorage.removeItem(SHORTCUTS_STORAGE_KEY);
        }
    } catch {
        // 寫不進去就只留在這次執行
    }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('storage', (e) => {
        if (e.key !== SHORTCUTS_STORAGE_KEY) return;
        state = { ...state, overrides: read(state.platform) };
        emit();
    });
}

export const getShortcutState = () => state;

export function subscribeShortcuts(l: () => void) {
    listeners.add(l);
    return () => {
        listeners.delete(l);
    };
}

export const useShortcutState = () => useSyncExternalStore(subscribeShortcuts, getShortcutState, getShortcutState);

// 套用一個改鍵。replaceId：取代衝突時一併清掉另一項的這個鍵。
// 回傳 false 表示被擋下（UI 應該已經先用 checkBinding 顯示原因）。
export function setBinding(id: string, chord: string, replaceId?: string): boolean {
    const d = defById(id);
    if (!d) return false;
    const next: Record<string, readonly string[]> = { ...state.overrides };
    if (replaceId) {
        const other = defById(replaceId);
        if (!other) return false;
        next[replaceId] = (next[replaceId] ?? other.keys).filter((k) => k !== chord);
    }
    const check = checkBinding(d, chord, next, state.platform);
    if (check.level === 'block' || check.level === 'conflict') return false;
    next[id] = [chord];
    if (sameKeys(next[id]!, d.keys)) delete next[id];
    state = { ...state, overrides: next };
    persist();
    emit();
    return true;
}

// 清空（停用）一個可改的快捷鍵
export function clearBinding(id: string) {
    const d = defById(id);
    if (!d || d.tier === 'fixed') return;
    const next = { ...state.overrides, [id]: [] };
    if (!d.keys.length) delete next[id];
    state = { ...state, overrides: next };
    persist();
    emit();
}

export type ResetResult =
    | { ok: true }
    // 預設鍵現在被別的項目用掉：conflict 可指定 replaceId 取代；block 不能取代
    | { ok: false; chord: string; check: Extract<BindingCheck, { level: 'conflict' | 'block' }> };

// 回復預設前，用與改鍵相同的檢查確認預設鍵沒有被其他項目佔用
export function resetBinding(id: string, replaceId?: string): ResetResult {
    const d = defById(id);
    if (!d || !(id in state.overrides)) return { ok: true };
    const next: Record<string, readonly string[]> = { ...state.overrides };
    delete next[id];
    if (replaceId) {
        const other = defById(replaceId);
        if (other) next[replaceId] = (next[replaceId] ?? other.keys).filter((k) => !d.keys.includes(k));
    }
    for (const chord of d.keys) {
        const check = checkBinding(d, chord, next, state.platform);
        if (check.level === 'conflict' || check.level === 'block') return { ok: false, chord, check };
    }
    state = { ...state, overrides: next };
    persist();
    emit();
    return { ok: true };
}

export function resetAllBindings() {
    state = { ...state, overrides: {} };
    persist();
    emit();
}

function sameKeys(a: readonly string[], b: readonly string[]) {
    return a.length === b.length && a.every((k, i) => k === b[i]);
}

// 測試與截圖用：覆寫平台並重新讀取
// 測試用：直接放入覆寫（不經檢查），驗證執行期的防線
export function __setOverridesForTests(overrides: Overrides) {
    state = { ...state, overrides };
    emit();
}

export function __setShortcutPlatformForTests(p: Platform) {
    state = { overrides: read(p), platform: p };
    emit();
}
