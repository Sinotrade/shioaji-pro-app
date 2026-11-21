// src/lib/shortcuts/match.ts — 按鍵事件比對與跨元件通知
//
// matchesShortcut(id, e)：這個事件是不是該項目「目前」的按鍵（含使用者改鍵）。
// 只比對按鍵；輸入中、視窗角色、面板焦點等條件由呼叫端用 guards 判斷，
// 因為各處的焦點規則不同（K 線圖看圖表焦點、B／S 看選取的下單面板）。

import { baseChord, chordFromEvent, type KeyEventLike } from './keys';
import { defById, effectiveKeys, forPlatform } from './registry';
import { getShortcutState } from './store';

// 舊版各處都把 ⌘ 與 Ctrl 視為同一個鍵（macOS 按 Ctrl+K、Windows 按 ⊞+Z 也有效）。
// 為了不打斷既有習慣，比對時另外把「另一個」修飾鍵當成 Mod 試一次 —
// 但只在這個組合沒有被任何項目明確使用時（例如 macOS 上自訂了 ⌃K）。
function lenientChord(e: KeyEventLike, platform: 'mac' | 'win'): string | null {
    if (platform === 'mac' && e.ctrlKey && !e.metaKey) return chordFromEvent({ ...pick(e), ctrlKey: false, metaKey: true }, platform);
    if (platform === 'win' && e.metaKey && !e.ctrlKey) return chordFromEvent({ ...pick(e), ctrlKey: true, metaKey: false }, platform);
    return null;
}

function pick(e: KeyEventLike): KeyEventLike {
    return { code: e.code, key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey };
}

let usedCache: { overrides: unknown; set: Set<string> } | null = null;
function usedChords(): Set<string> {
    const { overrides, platform } = getShortcutState();
    if (usedCache?.overrides === overrides) return usedCache.set;
    const set = new Set<string>();
    for (const d of forPlatform(platform)) for (const k of effectiveKeys(d, overrides)) set.add(baseChord(k));
    usedCache = { overrides, set };
    return set;
}

export function matchesShortcut(id: string, e: KeyEventLike): boolean {
    const d = defById(id);
    if (!d) return false;
    const { overrides, platform } = getShortcutState();
    const keys = effectiveKeys(d, overrides).map(baseChord);
    const chord = chordFromEvent(e, platform);
    if (chord && keys.includes(chord)) return true;
    const loose = lenientChord(e, platform);
    if (!loose || !keys.includes(loose)) return false;
    return !chord || !usedChords().has(chord);
}

// 在一組項目裡找第一個符合的
export function matchShortcut(ids: readonly string[], e: KeyEventLike): string | null {
    for (const id of ids) if (matchesShortcut(id, e)) return id;
    return null;
}

// 目前第一個按鍵（顯示用；未設定回 null）
export function primaryKey(id: string): string | null {
    const d = defById(id);
    if (!d) return null;
    return effectiveKeys(d, getShortcutState().overrides)[0] ?? null;
}

// ---- 通知：use-hotkeys 比對到後廣播，由擁有功能的元件接手 ----
// （例如 ⌘J 由頂欄 Agent 面板接手；面板還沒推出前沒有人聽，按了不會有事）

export const SHORTCUT_EVENT = 'sj-shortcut';

export interface ShortcutEventDetail {
    id: string;
    // 開設定頁時指定分頁
    tab?: string;
}

export function emitShortcut(detail: ShortcutEventDetail) {
    window.dispatchEvent(new CustomEvent<ShortcutEventDetail>(SHORTCUT_EVENT, { detail }));
}

export function onShortcut(id: string, handler: (detail: ShortcutEventDetail) => void): () => void {
    const l = (e: Event) => {
        const detail = (e as CustomEvent<ShortcutEventDetail>).detail;
        if (detail?.id === id) handler(detail);
    };
    window.addEventListener(SHORTCUT_EVENT, l);
    return () => window.removeEventListener(SHORTCUT_EVENT, l);
}
