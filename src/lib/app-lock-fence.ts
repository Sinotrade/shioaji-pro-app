// src/lib/app-lock-fence.ts — 應用程式鎖的事件攔截、快捷鍵與焦點範圍。

import { resetEscCancelArm } from './esc-cancel-arm';
import { getAppLock, isMac, lockApp } from './app-lock-state';

// ---- 攔截層（fence）：window 擷取階段第一個 listener ----
const SURFACE = '[data-app-lock-surface]';
// 遮蔽層內只放行編輯組合鍵（⌘R／F5 會重啟觸價與括號單執行者，⌘P 會印出內容）；AltGr 打的是字元
const EDIT_CHORD_KEYS = new Set(['a', 'c', 'v', 'x', 'z', 'y']);
// 密碼欄裡的整段刪除與游標移動（⌘⌫、⌘←／→、Ctrl+⌫…）；焦點不在輸入欄時 ⌘←／→ 是上一頁／下一頁
const CARET_KEYS = new Set(['backspace', 'delete', 'arrowleft', 'arrowright', 'home', 'end']);
const isEditChord = (e: KeyboardEvent, key = e.key?.toLowerCase()) =>
    EDIT_CHORD_KEYS.has(key) || (CARET_KEYS.has(key) && (e.target as Element | null)?.tagName === 'INPUT');
const isBrowserShortcut = (e: KeyboardEvent) =>
    !(e.getModifierState?.('AltGraph') || (e.ctrlKey && e.altKey && !e.metaKey && e.key?.length === 1 && !/^[a-z0-9]$/i.test(e.key))) &&
    (((e.metaKey || e.ctrlKey) && !isEditChord(e)) || /^F\d{1,2}$/.test(e.key ?? ''));
// ⇧⌘L（Mac）／Ctrl+Shift+L：code 或 key 任一符合（輸入法作用中 key 可能不是 l）
const isLockChord = (e: KeyboardEvent) => e.shiftKey && !e.altKey && (e.code === 'KeyL' || e.key?.toLowerCase() === 'l') &&
    (isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);
const FENCED_EVENTS = ['keydown', 'pointerdown', 'mousedown', 'click', 'dblclick', 'contextmenu', 'copy', 'cut', 'paste', 'dragstart', 'drop'];

// 其他內容都 inert，Tab 走到遮蔽層頭尾時瀏覽器會把焦點移出整份文件（Shift+Tab 回不來）：自己繞回另一頭
function keepTabInside(e: KeyboardEvent, surface: HTMLElement) {
    const stops = Array.from(surface.querySelectorAll<HTMLElement>('input, button:not(:disabled)'));
    const from = document.activeElement;
    if (!(e.shiftKey ? from === stops[0] || from === surface : from === stops.at(-1) || !stops.length)) return;
    e.preventDefault();
    (e.shiftKey ? stops.at(-1) : stops[0])?.focus();
}

function fenceAppLockEvent(event: Event): void {
    const state = getAppLock();
    const key = event.type === 'keydown' ? event as KeyboardEvent : null;
    if (!state?.locked) {
        // 快捷鍵放這裡：每個入口都最先註冊，popout、系統匣、核可視窗都鎖得了
        if (state && key && isLockChord(key)) {
            event.preventDefault();
            if (!key.repeat) lockApp();
        }
        return;
    }
    const target = event.target as Element | null;
    const surface = typeof target?.closest === 'function' ? target.closest<HTMLElement>(SURFACE) : null;
    const inSurface = surface !== null;
    // 遮蔽層內照常輸入，只擋瀏覽器快捷鍵。Escape 不論在哪都吞掉（底下的委託確認框、Esc×2
    // 全部刪單都不能收到）；右鍵選單有「重新載入」也一律吞掉
    if (inSurface && event.type !== 'contextmenu' && key?.key !== 'Escape' && !(key && isBrowserShortcut(key))) {
        // 按鍵到此為止：打字、Enter 送出等預設行為照常，App 其他的快捷鍵 listener 收不到
        if (key) event.stopImmediatePropagation();
        if (key?.key === 'Tab') keepTabInside(key, surface);
        return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    resetEscCancelArm();
    // 焦點掉到遮蔽層外（例如被聚焦的按鈕剛被移除）時拉回來，鍵盤才不會失效。優先給密碼欄：
    // 給外框（tabIndex=-1）的話，之後打的字不會進任何欄位
    if (key && !inSurface) {
        const cover = document.querySelector<HTMLElement>(SURFACE);
        (cover?.querySelector<HTMLElement>('input') ?? cover)?.focus();
    }
}

export function installFence() {
    // 必須早於 App 其他快捷鍵註冊：同一個 window 擷取階段先註冊先執行
    for (const name of FENCED_EVENTS) window.addEventListener(name, fenceAppLockEvent, true);
}
