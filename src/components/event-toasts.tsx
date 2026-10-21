// src/components/event-toasts.tsx — order/deal/notice toasts.
// Prominent, kind-coded cards (成交/委託/錯誤/訊息) with clean formatted
// content instead of raw event dumps; size follows the 通知大小 setting.

import {
    BadgeCheck,
    CircleAlert,
    Info,
    Receipt,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { describeOrderReport } from '../lib/order-report';
import { playAlert, playDeal, playError, playOrder } from '../lib/sounds';
import { onOrderEvent } from '../lib/stream';
import { useRevealText } from '../lib/privacy-text';
import { useToastScale } from '../lib/toast-prefs';
import { onNotice } from '../lib/trade';
import * as styles from './event-toasts.css';

type ToastKind = 'deal' | 'ok' | 'err' | 'info';

interface ToastItem {
    id: number;
    kind: ToastKind;
    title: string;
    lines: { text: string; dir?: 'up' | 'down' }[];
}

const KIND_ICON: Record<ToastKind, React.ReactNode> = {
    deal: <Receipt size={15} />,
    ok: <BadgeCheck size={15} />,
    err: <CircleAlert size={15} />,
    info: <Info size={15} />,
};

export function EventToasts({ onEvent }: { onEvent?: () => void }) {
    const [toasts, setToasts] = useState<ToastItem[]>([]);
    const nextId = useRef(1);
    const onEventRef = useRef(onEvent);
    onEventRef.current = onEvent;
    const scale = useToastScale();
    // toast 顯示期間才打開隱私／遮金額也要立即遮（#268）
    const reveal = useRevealText();

    useEffect(() => {
        const push = (
            kind: ToastKind,
            title: string,
            lines: ToastItem['lines'],
        ) => {
            const id = nextId.current++;
            setToasts((prev) => [...prev.slice(-4), { id, kind, title, lines }]);
            setTimeout(
                () => setToasts((prev) => prev.filter((t) => t.id !== id)),
                kind === 'err' ? 9000 : 6000,
            );
        };
        const offOrder = onOrderEvent((ev) => {
            const d = describeOrderReport(ev);
            push(d.kind, d.title, d.lines);
            if (d.kind === 'deal') playDeal();
            else if (d.kind === 'err') playError();
            else playOrder();
            onEventRef.current?.();
        });
        const offNotice = onNotice((n) => {
            const kind: ToastKind =
                n.kind === 'err' ? 'err' : n.kind === 'ok' ? 'ok' : 'info';
            push(kind, n.title, n.body ? [{ text: n.body }] : []);
            if (n.kind === 'err') playError();
            else if (n.title.includes('警示')) playAlert();
            else if (n.kind === 'ok') playOrder();
            if (n.kind === 'ok') onEventRef.current?.();
        });
        return () => {
            offOrder();
            offNotice();
        };
    }, []);

    return (
        <div
            className={styles.stack}
            style={{
                fontSize: `${scale}rem`,
                width: `${21 * scale}rem`,
            }}
        >
            {toasts.map((t) => (
                <div key={t.id} className={styles.toast[t.kind]}>
                    <span className={styles.icon[t.kind]}>
                        {KIND_ICON[t.kind]}
                    </span>
                    <div className={styles.content}>
                        <div className={styles.title}>{reveal(t.title)}</div>
                        {t.lines.map((l, i) => (
                            <div
                                key={i}
                                className={
                                    l.dir
                                        ? styles.line[l.dir]
                                        : styles.line.plain
                                }
                            >
                                {reveal(l.text)}
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}
