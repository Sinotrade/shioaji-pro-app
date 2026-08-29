// src/hooks/use-esc-close.ts — modal 的 Esc 關閉（modal stack）
//
// 兩個保證：
// 1. 只關最上層 — 疊層 modal（指標選單上再開自訂指標編輯器）按一次
//    Esc 只收最上面那層，不會連鎖全關（未存的編輯內容不會被帶走）。
// 2. 一律 preventDefault — use-hotkeys 的 Esc-Esc 全刪單（escCancelAll）
//    以 e.defaultPrevented 判斷「這下 Esc 已被 dialog 吃掉」，關閉
//    dialog 的那一下絕不能武裝刪單視窗（settings-dialog 同一模式）。

import { useEffect, useRef } from 'react';

type Handler = () => void;

const stack: Handler[] = [];
let listener: ((e: KeyboardEvent) => void) | null = null;

function onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || stack.length === 0) return;
    e.preventDefault();
    stack[stack.length - 1]!();
}

// exported for tests（元件一律走 useEscClose）
export function pushEscHandler(h: Handler): () => void {
    if (!listener) {
        listener = onKeydown;
        // capture：搶在 use-hotkeys 的 bubble listener 之前標記
        window.addEventListener('keydown', listener, true);
    }
    stack.push(h);
    return () => {
        const i = stack.lastIndexOf(h);
        if (i >= 0) stack.splice(i, 1);
        if (stack.length === 0 && listener) {
            window.removeEventListener('keydown', listener, true);
            listener = null;
        }
    };
}

// mount 即入栈（modal 都是條件渲染，mount = 開啟）；close callback
// 走 ref，父層 re-render 換新 closure 不用重掛
export function useEscClose(onClose: Handler) {
    const ref = useRef(onClose);
    ref.current = onClose;
    useEffect(() => pushEscHandler(() => ref.current()), []);
}

// 測試用
export function escStackDepth() {
    return stack.length;
}
