// src/lib/apply-guide-reentry.ts — 從 App 裡叫出「申請／下載憑證導覽」。
//
// 入口在「伺服器設定 › 帳號」與「設定 › 帳號」（還沒有正式帳號時的捷徑）；
// 導覽面板由 ServerManager 掛著（它管伺服器設定對話框與帳號清單）。
// task：直接做某件事；null：先選要做的事。

import type { InAppGuideTask } from './apply-guide-config';

type Listener = (task: InAppGuideTask | null) => void;
const listeners = new Set<Listener>();

/** 打開導覽面板；沒有面板可以接（例如網頁版、子視窗）時回傳 false。 */
export function requestApplyGuide(task: InAppGuideTask | null = null): boolean {
    if (listeners.size === 0) return false;
    for (const listener of [...listeners]) listener(task);
    return true;
}

/** 接收開啟導覽的要求（ServerManager 開面板、設定對話框把自己關掉）。 */
export function onApplyGuideRequest(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
