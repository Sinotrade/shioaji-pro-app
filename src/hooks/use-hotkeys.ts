// src/hooks/use-hotkeys.ts — global trading hotkeys.
// B/S: switch order tickets to buy/sell · Esc Esc: cancel all orders
// (opt-in via 風控 settings, default off) · Cmd/Ctrl+K: symbol palette.
// Ignored while typing in form fields.

import { useEffect } from 'react';
import { noteEscPress, resetEscCancelArm } from '../lib/esc-cancel-arm';
import { getRiskSettings } from '../lib/risk';
import { cancelAllOrders, notify } from '../lib/trade';

export const TICKET_ACTION_EVENT = 'sj-ticket-action';

function isTyping(): boolean {
    const el = document.activeElement;
    return (
        !!el &&
        (el.tagName === 'INPUT' ||
            el.tagName === 'TEXTAREA' ||
            el.tagName === 'SELECT' ||
            (el as HTMLElement).isContentEditable === true)
    );
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
        let current: { e: KeyboardEvent; n: number } | null = null;
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
            current = { e, n };
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
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                onOpenPalette();
                return;
            }
            if (e.key === 'Escape') {
                // 只有「沒被任何介面用掉、也不是在輸入框／勾選框等控制項上」
                // 的 Esc 才算一下。其他 Esc（對話框／畫圖工具 preventDefault
                // 的、焦點在樣式面板勾選框上的…）一律清掉等待中的第一下 —
                // Esc、介面 Esc、Esc 不能湊成 Esc×2 全部刪單
                if (e.defaultPrevented || isTyping()) {
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
            if (isTyping()) return;
            const k = e.key.toLowerCase();
            if (k === 'b' || k === 's') {
                window.dispatchEvent(
                    new CustomEvent(TICKET_ACTION_EVENT, {
                        detail: { action: k === 'b' ? 'Buy' : 'Sell' },
                    }),
                );
            }
        };
        window.addEventListener('keydown', onEscCapture, true);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('keydown', onEscCapture, true);
            window.removeEventListener('keydown', onKey);
        };
    }, [onOpenPalette, onAfterCancelAll]);
}
