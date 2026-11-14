// src/lib/shortcuts/guards.ts — 快捷鍵觸發前的共用判斷
//
// - 輸入中：焦點在輸入框、下拉選單、可編輯區或正在用輸入法組字時，單鍵不觸發
// - 視窗角色：主視窗或彈出視窗（交易鍵只在主視窗）
// - 「Esc 由啟用中的面板接手」：閃電下單／整零價差啟用中時，Esc 只解除它們，
//   不算全部刪單的第一下
// - 目前選取的面板：最後一次點擊或聚焦所在的 grid 格（data-block-id）

type ElementLike = { tagName?: string; isContentEditable?: boolean } | null;

export function isTypingElement(el: ElementLike | EventTarget | null | undefined): boolean {
    const e = el as ElementLike;
    if (!e || typeof e.tagName !== 'string') return false;
    const tag = e.tagName.toUpperCase();
    // 所有 input（含勾選框）都算：保守起見，焦點在任何表單控制項上單鍵都不觸發
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.isContentEditable === true;
}

export function isTypingNow(e?: Pick<KeyboardEvent, 'isComposing' | 'keyCode' | 'target'>): boolean {
    // 輸入法組字中（注音、倉頡…）一律不觸發
    if (e && (e.isComposing || e.keyCode === 229)) return true;
    if (e && isTypingElement(e.target)) return true;
    return typeof document !== 'undefined' && isTypingElement(document.activeElement);
}

// ---- 視窗角色 ----

export type WindowRole = 'main' | 'popout';

export function windowRoleOf(search: string): WindowRole {
    return new URLSearchParams(search).has('popout') ? 'popout' : 'main';
}

export function currentWindowRole(): WindowRole {
    return typeof location === 'undefined' ? 'main' : windowRoleOf(location.search);
}

// ---- Esc 由啟用中的面板接手 ----

let escDisarmHolders = 0;

// 面板啟用（閃電下單、整零價差 armed）期間持有；回傳釋放函式
export function holdEscForDisarm(): () => void {
    escDisarmHolders += 1;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        escDisarmHolders -= 1;
    };
}

export const escTakenByArmedPanel = () => escDisarmHolders > 0;

// ---- 目前選取的面板 ----

export interface PanelFocus {
    id: string;
    type: string | null;
}

let focused: PanelFocus | null = null;
const focusListeners = new Set<() => void>();

export const getFocusedPanel = () => focused;

export function subscribeFocusedPanel(l: () => void) {
    focusListeners.add(l);
    return () => {
        focusListeners.delete(l);
    };
}

export function setFocusedPanel(next: PanelFocus | null) {
    if (next?.id === focused?.id && next?.type === focused?.type) return;
    focused = next;
    for (const l of focusListeners) l();
}

type ClosestLike = { closest?: (sel: string) => { getAttribute(n: string): string | null } | null };

export function panelOfTarget(target: EventTarget | null): PanelFocus | null | undefined {
    const el = target as ClosestLike | null;
    if (!el || typeof el.closest !== 'function') return undefined;
    const cell = el.closest('[data-block-id]');
    // 點在 grid 以外（頂欄、對話框）不改變選取，回 undefined
    if (!cell) return undefined;
    const id = cell.getAttribute('data-block-id');
    return id ? { id, type: cell.getAttribute('data-block-type') } : null;
}

// 在主視窗安裝：pointerdown／focusin 時記下所在的面板
export function trackPanelFocus(): () => void {
    const onEvent = (e: Event) => {
        const p = panelOfTarget(e.target);
        if (p !== undefined) setFocusedPanel(p);
    };
    window.addEventListener('pointerdown', onEvent, true);
    window.addEventListener('focusin', onEvent, true);
    return () => {
        window.removeEventListener('pointerdown', onEvent, true);
        window.removeEventListener('focusin', onEvent, true);
    };
}

// 元件判斷自己是不是在某個面板裡
export function isInsidePanel(el: ClosestLike | null | undefined, panelId: string): boolean {
    if (!el || typeof el.closest !== 'function') return false;
    return el.closest('[data-block-id]')?.getAttribute('data-block-id') === panelId;
}

// ---- 鍵盤暫時被接手（錄製新按鍵、提示頁開著）----
// 持有期間：設定對話框不因 Esc 關閉、⌘/ 不重複開關提示頁

let keyboardHolders = 0;

export function holdKeyboard(): () => void {
    keyboardHolders += 1;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        keyboardHolders -= 1;
    };
}

export const keyboardHeld = () => keyboardHolders > 0;
