// src/components/notice-center.tsx — 通知中心: persistent log of every
// in-app notice and order event (toasts disappear; this keeps history).

import { Check, Dot, X } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import {
    clearNoticeLog,
    getNoticeLog,
    subscribeNoticeLog,
} from '../lib/trade';
import { useRevealText } from '../lib/privacy-text';
import * as dock from './bottom-dock.css';
import * as styles from './notice-center.css';

type Filter = 'all' | 'ok' | 'err' | 'info';

const FILTERS: { key: Filter; label: string }[] = [
    { key: 'all', label: '全部' },
    { key: 'ok', label: '成功' },
    { key: 'err', label: '錯誤' },
    { key: 'info', label: '訊息' },
];

const KIND_ICON = {
    ok: <Check size={11} />,
    err: <X size={11} />,
    info: <Dot size={13} />,
} as const;

export function NoticeCenter() {
    const log = useSyncExternalStore(subscribeNoticeLog, getNoticeLog);
    const [filter, setFilter] = useState<Filter>('all');
    // 通知保留產生當下的文字：渲染時依目前隱私／遮金額開關重新遮蔽（#268）
    const reveal = useRevealText();
    const rows = [...log]
        .reverse()
        .filter((n) => filter === 'all' || n.kind === filter);

    return (
        <div className={styles.wrap}>
            <div className={styles.toolbar}>
                {FILTERS.map((f) => (
                    <button
                        key={f.key}
                        className={styles.filter[filter === f.key ? 'on' : 'off']}
                        onClick={() => setFilter(f.key)}
                    >
                        {f.label}
                    </button>
                ))}
                <span style={{ flex: 1 }} />
                <button
                    className={styles.clearBtn}
                    disabled={log.length === 0}
                    onClick={clearNoticeLog}
                >
                    清除
                </button>
            </div>
            <div className={styles.list}>
                {rows.length === 0 && (
                    <div className={dock.emptyState}>沒有通知</div>
                )}
                {rows.map((n) => (
                    <div key={n.ts + n.title} className={styles.row}>
                        <span className={styles.icon[n.kind]}>
                            {KIND_ICON[n.kind]}
                        </span>
                        <span className={styles.time}>
                            {new Date(n.ts).toLocaleTimeString('en-GB')}
                        </span>
                        <span className={styles.rowBody}>
                            <span className={styles.title}>{reveal(n.title)}</span>
                            {n.body && (
                                <span className={styles.body}>{reveal(n.body)}</span>
                            )}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}
