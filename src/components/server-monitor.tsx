import { useEffect, useState } from 'react';
import { apiGet } from '../lib/api';
import { getApiBase, isTauri } from '../lib/runtime';
import * as styles from './debug-panel.css';

interface Usage { connections: number; bytes: number; limit_bytes: number; remaining_bytes: number }
const mib = (value: number) => `${(value / 1_048_576).toLocaleString('zh-TW', { maximumFractionDigits: 1 })} MiB`;

export function ServerMonitor() {
    const [usage, setUsage] = useState<Usage | null>(null);
    const [error, setError] = useState('');
    const [dashboard, setDashboard] = useState(false);
    const [visible, setVisible] = useState(document.visibilityState === 'visible');
    const [ownedOrigin, setOwnedOrigin] = useState<string | null>(null);
    useEffect(() => {
        const changed = () => setVisible(document.visibilityState === 'visible');
        document.addEventListener('visibilitychange', changed);
        return () => document.removeEventListener('visibilitychange', changed);
    }, []);
    useEffect(() => {
        if (!visible) return;
        let active = true;
        let timer: ReturnType<typeof setTimeout>;
        const refresh = async () => {
            try {
                const next = await apiGet<Usage>('/api/v1/auth/usage');
                if (![next.connections, next.bytes, next.limit_bytes, next.remaining_bytes].every(Number.isFinite)) throw new Error('用量格式不相容');
                if (active) { setUsage(next); setError(''); }
            } catch (cause) {
                if (active) { setUsage(null); setError(String(cause)); }
            } finally {
                if (active) timer = setTimeout(refresh, 30_000);
            }
        };
        void refresh();
        return () => { active = false; clearTimeout(timer); };
    }, [visible]);
    useEffect(() => {
        if (!isTauri) return;
        let active = true;
        const origin = getApiBase();
        const url = new URL(origin);
        if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== '127.0.0.1') return;
        void import('@tauri-apps/api/core').then(({ invoke }) => invoke<boolean>('agent_harness_sidecar_owned', { port: Number(url.port) }))
            .then(owned => { if (active && owned) setOwnedOrigin(url.origin); }).catch(() => undefined);
        return () => { active = false; };
    }, []);
    return <>
        <span className={styles.sectionTitle}>API 用量</span>
        {error && <span className={styles.valueWarn} role="status">用量暫時無法取得：{error}</span>}
        <div className={styles.grid}>
            {[
                ['已用流量', usage ? mib(usage.bytes) : '—'],
                ['流量上限', usage ? mib(usage.limit_bytes) : '—'],
                ['剩餘流量', usage ? mib(usage.remaining_bytes) : '—'],
                ['API 回報連線', usage ? String(usage.connections) : '—'],
            ].map(([label, value]) => <div className={styles.row} key={label}><span className={styles.label}>{label}</span><span className={styles.value}>{value}</span></div>)}
        </div>
        <span className={styles.label}>流量額度使用 broker 回報數值；不是從本機訂閱數推估。</span>
        {ownedOrigin && <>
            <button className={styles.monitorButton} onClick={() => setDashboard(open => !open)} aria-expanded={dashboard}>
                {dashboard ? '收合' : '開啟'} Server Dashboard · 請求／訂閱監控
            </button>
            {dashboard && visible && <iframe key={ownedOrigin} className={styles.monitorFrame} title="Shioaji 1.7.5 Server Dashboard" src={`${ownedOrigin}/`} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" />}
            {dashboard && <span className={styles.label}>使用內建 1.7.5 Dashboard 的 Overview、Activity 與 Subscriptions。展開連線詳情才收集串流統計；收合本區會卸載 Dashboard。歷史缺口、暫停與未收集不代表零流量。</span>}
        </>}
    </>;
}
