// src/lib/dock-events.ts — ask the bottom dock to show a tab from elsewhere
// in the main window (e.g. 待確認卡「開啟委託查詢」, #201 ③).

import { useEffect, useRef } from 'react';

export const OPEN_ORDERS_TAB_EVENT = 'shioaji:open-orders-tab';

/** Asks a mounted bottom dock for its orders tab (all statuses, all
 * accounts, refreshed). false = no dock answered (none in this layout). */
export function requestOpenOrdersTab(): boolean {
    if (typeof window === 'undefined') return false;
    const event = new Event(OPEN_ORDERS_TAB_EVENT, { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
}

/** Runs `onOpen` whenever something asks for the orders tab. */
export function useOpenOrdersTabRequest(onOpen: () => void): void {
    const latest = useRef(onOpen);
    latest.current = onOpen;
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const handler = (event: Event) => {
            event.preventDefault(); // tells the requester a dock answered
            latest.current();
        };
        window.addEventListener(OPEN_ORDERS_TAB_EVENT, handler);
        return () => window.removeEventListener(OPEN_ORDERS_TAB_EVENT, handler);
    }, []);
}
