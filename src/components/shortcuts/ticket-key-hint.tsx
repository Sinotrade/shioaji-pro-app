// src/components/shortcuts/ticket-key-hint.tsx — 下單面板的 B／S 目標提示
//
// B／S 只作用在目前選取的下單面板；被選取的那一個在買進／賣出鈕上顯示鍵帽，
// 讓使用者一眼看出按鍵會切到哪一個面板。

import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react';
import { TICKET_ACTION_EVENT, type TicketActionDetail } from '../../hooks/use-hotkeys';
import { currentWindowRole, getFocusedPanel, isInsidePanel, subscribeFocusedPanel } from '../../lib/shortcuts/guards';
import { primaryKey } from '../../lib/shortcuts/match';
import { useShortcutState } from '../../lib/shortcuts/store';
import { Chord } from './key-caps';
import * as styles from './shortcuts.css';

// 這個面板是不是 B／S 的目標（主視窗、且是最後選取的面板）
export function useIsTicketKeyTarget(rootRef: RefObject<HTMLElement | null>): boolean {
    const focused = useSyncExternalStore(subscribeFocusedPanel, getFocusedPanel, getFocusedPanel);
    const [inside, setInside] = useState(false);
    useEffect(() => {
        setInside(!!focused && currentWindowRole() === 'main' && isInsidePanel(rootRef.current, focused.id));
    }, [focused, rootRef]);
    return inside;
}

// 收 B／S：只處理目標是自己所在面板的事件
export function useTicketAction(rootRef: RefObject<HTMLElement | null>, onAction: (a: 'Buy' | 'Sell') => void) {
    useEffect(() => {
        const l = (e: Event) => {
            const detail = (e as CustomEvent<TicketActionDetail>).detail;
            if (detail?.action !== 'Buy' && detail?.action !== 'Sell') return;
            if (!isInsidePanel(rootRef.current, detail.blockId)) return;
            onAction(detail.action);
        };
        window.addEventListener(TICKET_ACTION_EVENT, l);
        return () => window.removeEventListener(TICKET_ACTION_EVENT, l);
    }, [rootRef, onAction]);
}

export function TicketKeyHint({ side, active }: { side: 'Buy' | 'Sell'; active: boolean }) {
    const { platform } = useShortcutState();
    if (!active) return null;
    const key = primaryKey(side === 'Buy' ? 'ticket.buy' : 'ticket.sell');
    if (!key) return null;
    return (
        <span className={styles.ticketCap} aria-hidden='true'>
            <Chord chord={key} platform={platform} small />
        </span>
    );
}
