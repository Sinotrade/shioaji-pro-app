// src/hooks/use-hotkeys.ts — global trading hotkeys.
// B/S: switch order tickets to buy/sell · Esc Esc: cancel all orders
// (opt-in via 風控 settings, default off) · Cmd/Ctrl+K: symbol palette.
// Ignored while typing in form fields.

import { useEffect } from 'react';
import { getRiskSettings } from '../lib/risk';
import { cancelAllOrders, notify } from '../lib/trade';

export const TICKET_ACTION_EVENT = 'sj-ticket-action';

function isTyping(): boolean {
    const el = document.activeElement;
    return (
        !!el &&
        (el.tagName === 'INPUT' ||
            el.tagName === 'TEXTAREA' ||
            el.tagName === 'SELECT')
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
        let lastEsc = 0;
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                onOpenPalette();
                return;
            }
            if (isTyping()) return;
            if (e.key === 'Escape') {
                // dialogs claim their close-Esc via preventDefault — that
                // press must not arm the cancel-all window
                if (e.defaultPrevented) return;
                if (!getRiskSettings().escCancelAll) return;
                const now = performance.now();
                if (now - lastEsc < 600) {
                    lastEsc = 0;
                    void cancelAllOrders().then(onAfterCancelAll);
                } else {
                    lastEsc = now;
                    notify({
                        kind: 'info',
                        title: '再按一次 Esc 全部刪單',
                        body: '0.6 秒內連按兩次 Esc 撤銷所有未成交委託',
                    });
                }
                return;
            }
            const k = e.key.toLowerCase();
            if (k === 'b' || k === 's') {
                window.dispatchEvent(
                    new CustomEvent(TICKET_ACTION_EVENT, {
                        detail: { action: k === 'b' ? 'Buy' : 'Sell' },
                    }),
                );
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onOpenPalette, onAfterCancelAll]);
}
