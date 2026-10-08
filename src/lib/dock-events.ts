// src/lib/dock-events.ts — ask the bottom dock to show a tab from elsewhere
// in the main window (e.g. 待確認卡「開啟委託查詢」, #201 ③).

import { useEffect, useRef } from 'react';

export const OPEN_ORDERS_TAB_EVENT = 'shioaji:open-orders-tab';

export function requestOpenOrdersTab(): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new Event(OPEN_ORDERS_TAB_EVENT));
}

/** Runs `onOpen` whenever something asks for the orders tab. */
export function useOpenOrdersTabRequest(onOpen: () => void): void {
    const latest = useRef(onOpen);
    latest.current = onOpen;
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const handler = () => latest.current();
        window.addEventListener(OPEN_ORDERS_TAB_EVENT, handler);
        return () => window.removeEventListener(OPEN_ORDERS_TAB_EVENT, handler);
    }, []);
}
