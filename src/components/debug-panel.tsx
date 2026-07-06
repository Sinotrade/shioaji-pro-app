// src/components/debug-panel.tsx — 診斷面板: connection/runtime internals
// for figuring out "why is nothing updating" without opening devtools.

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePoll } from '../hooks/use-poll';
import { useStreamStatus } from '../hooks/use-stream';
import { getApiBase } from '../lib/runtime';
import { fetchHealth, fetchInfo } from '../lib/shioaji';
import {
    getLastHeartbeat,
    getSubscriptionCount,
    onAnyTick,
    onOrderEvent,
} from '../lib/stream';
import { analyticsEnabled } from '../lib/analytics';
import { useTier } from '../lib/features';
import type { OrderEventReport } from '../lib/order-report';
import { appVersion } from '../lib/tauri';
import * as dockStyles from './bottom-dock.css';
import * as styles from './debug-panel.css';

const STATUS_LABEL = { live: 'LIVE', connecting: 'SYNC', down: 'LOST' };

export function DebugPanel() {
    const stream = useStreamStatus();
    const [, tick] = useState(0);
    // ticks/sec over a sliding 5s window
    const tickTimes = useRef<number[]>([]);
    const [events, setEvents] = useState<
        { ts: number; data: OrderEventReport }[]
    >([]);
    const [ver, setVer] = useState('');

    useEffect(() => {
        appVersion().then(setVer);
    }, []);

    useEffect(() => {
        const offTick = onAnyTick(() => {
            tickTimes.current.push(Date.now());
        });
        const offEv = onOrderEvent((data) => {
            setEvents((prev) => [...prev.slice(-4), { ts: Date.now(), data }]);
        });
        const t = setInterval(() => {
            const cutoff = Date.now() - 5000;
            tickTimes.current = tickTimes.current.filter(
                (ts) => ts > cutoff,
            );
            tick((v) => v + 1); // refresh heartbeat age + rate display
        }, 1000);
        return () => {
            offTick();
            offEv();
            clearInterval(t);
        };
    }, []);

    const { data: health } = usePoll(
        useCallback(() => fetchHealth().catch(() => null), []),
        15000,
    );
    const { data: info } = usePoll(
        useCallback(() => fetchInfo().catch(() => null), []),
        60000,
    );

    const tier = useTier();
    const hb = getLastHeartbeat();
    const hbAge = hb ? Math.round((Date.now() - hb) / 1000) : null;
    const rate = (tickTimes.current.length / 5).toFixed(1);

    const rows: { label: string; value: string; warn?: boolean }[] = [
        { label: 'App 版本', value: ver ? `v${ver}` : '—' },
        { label: '方案', value: tier === 'vip' ? 'VIP' : 'Free' },
        {
            label: 'GA 即時',
            value: analyticsEnabled() ? '已啟用' : '未設定',
        },
        {
            label: 'SSE 行情流',
            value: STATUS_LABEL[stream],
            warn: stream !== 'live',
        },
        {
            label: '心跳',
            value: hbAge === null ? '—' : `${hbAge}s 前`,
            warn: hbAge !== null && hbAge > 15,
        },
        { label: '行情速率', value: `${rate} 筆/秒` },
        { label: '訂閱數', value: String(getSubscriptionCount()) },
        { label: 'API Base', value: getApiBase() || '(同源)' },
        {
            label: '伺服器版本',
            value: info ? `${info.version}${info.simulation ? '（模擬）' : '（⚠ 正式）'}` : '—',
        },
        {
            label: 'Token 有效',
            value: health
                ? `${Math.round(health.token_expires_in_seconds / 3600)}h`
                : '—',
            warn:
                !!health && health.token_expires_in_seconds < 3600,
        },
        {
            label: '合約數',
            value: health ? health.contract_count.toLocaleString() : '—',
        },
    ];

    return (
        <div className={styles.wrap}>
            <div className={styles.grid}>
                {rows.map((r) => (
                    <div key={r.label} className={styles.row}>
                        <span className={styles.label}>{r.label}</span>
                        <span
                            className={r.warn ? styles.valueWarn : styles.value}
                        >
                            {r.value}
                        </span>
                    </div>
                ))}
            </div>
            <span className={styles.sectionTitle}>最近 order_event</span>
            {events.length === 0 && (
                <span className={dockStyles.emptyState}>尚無事件</span>
            )}
            {[...events].reverse().map((e) => (
                <pre key={e.ts} className={styles.eventDump}>
                    {new Date(e.ts).toLocaleTimeString('en-GB')}{' '}
                    {JSON.stringify(e.data.raw ?? e.data).slice(0, 220)}
                </pre>
            ))}
        </div>
    );
}
