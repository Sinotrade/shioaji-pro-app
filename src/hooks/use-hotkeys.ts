// src/hooks/use-hotkeys.ts — 主視窗的全域快捷鍵（按鍵定義在 lib/shortcuts/registry）
// B/S：切換「目前選取」的下單面板方向 · Esc Esc：全部刪單（設定開啟才有，
// 不開放改鍵）· ⌘K／Ctrl+K：商品搜尋 · ⌘,：設定 · ⌘J：頂欄 Agent（保留）。
// 單鍵在輸入框內不觸發；只在主視窗掛載（彈出視窗不處理交易鍵）。

import { useEffect } from 'react';
import { noteEscPress, resetEscCancelArm } from '../lib/esc-cancel-arm';
import { getRiskSettings } from '../lib/risk';
import { escTakenByArmedPanel, getFocusedPanel, isTypingNow } from '../lib/shortcuts/guards';
import { emitShortcut, matchShortcut } from '../lib/shortcuts/match';
import { cancelAllOrders, notify } from '../lib/trade';

export const TICKET_ACTION_EVENT = 'sj-ticket-action';

export interface TicketActionDetail {
    action: 'Buy' | 'Sell';
    // 只有這個面板（grid 的 data-block-id）要切換
    blockId: string;
}

// B／S 的對象：下單面板與組合單
const TICKET_PANELS = new Set(['ticket', 'combo']);

// Esc 的判斷沿用舊規則：焦點在任何表單控制項（含勾選框）都不算一下
function isFormControlFocused(): boolean {
    const el = typeof document === 'undefined' ? null : document.activeElement;
    return (
        !!el &&
        (el.tagName === 'INPUT' ||
            el.tagName === 'TEXTAREA' ||
            el.tagName === 'SELECT' ||
            (el as HTMLElement).isContentEditable === true)
    );
}

let ticketHintShown = false;
export function __resetTicketHintForTests() {
    ticketHintShown = false;
}

export function useHotkeys({
    onOpenPalette,
    onAfterCancelAll,
}: {
    onOpenPalette: () => void;
    onAfterCancelAll: () => void;
}) {
    useEffect(() => {
        // 每個 Esc 一個序號；countedSeq＝最近一次被算成 Esc×2 一下的序號
        let seq = 0;
        let countedSeq = 0;
        // armedTaken：capture 階段（任何面板處理這一下之前）是否有啟用中的閃電
        // 下單／整零價差。要在 capture 記下 — 面板自己的 Esc listener 解除後，
        // React 可能在 listener 之間就同步跑完 cleanup、釋放持有
        let current: { e: KeyboardEvent; n: number; armedTaken: boolean } | null = null;
        // 保險：任何元件都可能在 Esc 上 stopPropagation（例如價格輸入框的
        // 「還原輸入」），這一下就到不了下面的 bubble handler，也就沒機會
        // 清掉等待中的第一下。window 的 capture listener 一定最先收到事件、
        // 擋不掉；等整個派送結束（setTimeout 0 — microtask 會在每個 listener
        // 之間就跑掉，太早）還沒被算成一下的 Esc，一律清除武裝。
        const onEscCapture = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            // 先同步結清上一個 Esc：它沒被算成一下（被元件吃掉、擋下）就清除
            // 武裝 — 不能只靠下面的計時器，連續按鍵時下一個 keydown 可能比
            // 計時器先到
            if (current && countedSeq < current.n) resetEscCancelArm();
            const n = ++seq;
            current = { e, n, armedTaken: escTakenByArmedPanel() };
            // 次要的清理：之後沒有再按 Esc 時，也別讓這一下留下的武裝一直掛著
            setTimeout(() => {
                // 這一下沒被算，而且之後也沒有新的一下被算 → 清除武裝
                if (countedSeq < n) resetEscCancelArm();
            }, 0);
        };
        const onKey = (e: KeyboardEvent) => {
            // OS key auto-repeat must never count — holding Esc a beat too
            // long would otherwise arm AND fire cancel-all in one press
            if (e.repeat) return;
            if (e.key === 'Escape') {
                // 只有「沒被任何介面用掉、也不是在輸入框／勾選框等控制項上」
                // 的 Esc 才算一下。其他 Esc（對話框／畫圖工具 preventDefault
                // 的、焦點在樣式面板勾選框上的…）一律清掉等待中的第一下 —
                // Esc、介面 Esc、Esc 不能湊成 Esc×2 全部刪單
                if (e.defaultPrevented || isFormControlFocused()) {
                    resetEscCancelArm();
                    return;
                }
                // 閃電下單／整零價差啟用中：這一下 Esc 只解除它們（產品決定
                // 2026-11-06），不算全部刪單的第一下
                if (current?.e === e ? current.armedTaken : escTakenByArmedPanel()) {
                    resetEscCancelArm();
                    return;
                }
                if (!getRiskSettings().escCancelAll) return;
                if (current?.e === e) countedSeq = current.n;
                if (noteEscPress(performance.now())) {
                    void cancelAllOrders().then(onAfterCancelAll);
                } else {
                    notify({
                        kind: 'info',
                        title: '再按一次 Esc 全部刪單',
                        body: '0.6 秒內連按兩次 Esc 撤銷所有未成交委託',
                    });
                }
                return;
            }
            // 帶修飾鍵的全域鍵：輸入框內也能用
            const global = matchShortcut(['palette.open', 'settings.open', 'agent.toggle'], e);
            if (global) {
                e.preventDefault();
                if (global === 'palette.open') onOpenPalette();
                else emitShortcut({ id: global });
                return;
            }
            if (isTypingNow(e)) return;
            const side = matchShortcut(['ticket.buy', 'ticket.sell'], e);
            if (!side) return;
            const panel = getFocusedPanel();
            if (!panel || !panel.type || !TICKET_PANELS.has(panel.type)) {
                // 舊版 B／S 會切換所有下單面板；改版後第一次落空時說明一次
                if (!ticketHintShown) {
                    ticketHintShown = true;
                    notify({
                        kind: 'info',
                        title: 'B／S 只作用在選取的下單面板',
                        body: '先點一下要切換的下單面板或組合單，再按 B／S',
                    });
                }
                return;
            }
            e.preventDefault();
            window.dispatchEvent(
                new CustomEvent<TicketActionDetail>(TICKET_ACTION_EVENT, {
                    detail: { action: side === 'ticket.buy' ? 'Buy' : 'Sell', blockId: panel.id },
                }),
            );
        };
        window.addEventListener('keydown', onEscCapture, true);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('keydown', onEscCapture, true);
            window.removeEventListener('keydown', onKey);
        };
    }, [onOpenPalette, onAfterCancelAll]);
}
