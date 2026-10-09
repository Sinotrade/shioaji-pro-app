// src/components/conditional-ui.tsx — small pieces shared by the 條件單
// management panel and its dialogs (#226).

import { X } from 'lucide-react';
import { useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useEscClose } from '../hooks/use-esc-close';
import { getQuote, subscribeQuoteStore } from '../lib/stream';
import { conditionalDemoActive, DEMO_PRICES } from '../lib/conditional/demo';
import * as styles from './conditional-panel.css';

/** Latest trade price of a code from the shared quote store (no request). */
export function useLastPrice(code: string): number | undefined {
    const close = useSyncExternalStore(
        l => subscribeQuoteStore(code, l),
        () => getQuote(code)?.tick?.close,
    );
    if (conditionalDemoActive() && DEMO_PRICES[code] !== undefined) return DEMO_PRICES[code];
    const n = Number(close);
    return close === undefined || !Number.isFinite(n) || n <= 0 ? undefined : n;
}

/** Modal frame shared by the panel's dialogs (Esc / backdrop close). */
export function Dialog({ title, icon, onClose, children, footer, narrow, tone }: {
    title: string;
    icon: ReactNode;
    onClose: () => void;
    children: ReactNode;
    footer?: ReactNode;
    narrow?: boolean;
    tone?: 'danger';
}) {
    useEscClose(onClose);
    // a portal: grid panels are transformed, which would trap a fixed overlay inside the panel
    const node = (
        <div className={styles.overlay} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
            <div className={narrow ? styles.dialogNarrow : styles.dialog} role='dialog' aria-modal='true' aria-label={title}>
                <div className={styles.header}>
                    <span className={`${styles.title} ${tone === 'danger' ? styles.tone.err : ''}`}>{icon}{title}</span>
                    <span className={styles.grow} />
                    <button type='button' className={styles.closeButton} aria-label='關閉' onClick={onClose}><X size={14} aria-hidden /></button>
                </div>
                <div className={styles.dialogBody}>{children}</div>
                {footer && <div className={styles.dialogFoot}>{footer}</div>}
            </div>
        </div>
    );
    return typeof document !== 'undefined' ? createPortal(node, document.body) : node;
}
