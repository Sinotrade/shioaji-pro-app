import { useEffect, useState, type ReactNode } from 'react';
import { getApiBase, isTauri } from '../lib/runtime';
import { useMonitorResource } from '../hooks/use-monitor-resource';
import { completionWindows, monitorWarnings, parseMetrics, parseSubscriptions, parseUsage, quotaState, type MetricsReport } from '../lib/server-monitor';
import * as styles from './server-monitor.css';

const mib = (n: number) => `${(n / 1_048_576).toLocaleString('zh-TW', { maximumFractionDigits: 1 })} MiB`;
const metricPath = (category = '') => `/api/v1/monitor/metrics?source=backend&origin=all&window=5m${category ? `&category=${category}` : ''}`;
function Card({ label, value, children, tone = 'normal' }: { label: string; value: ReactNode; children?: ReactNode; tone?: string }) {
    return <div className={styles.card} data-tone={tone}><span className={styles.label}>{label}</span><strong className={styles.number}>{value}</strong>{children}</div>;
}
function RateCard({ report, label, seconds }: { report: MetricsReport | null; label: string; seconds: number }) {
    const values = report ? completionWindows(report, seconds) : { latest: null, peak: null };
    return <Card label={label} value={<>{values.latest ?? '—'} <small>次 / {seconds} 秒</small></>}>
        <span className={styles.caption}>近 5 分鐘完整短窗尖峰 {values.peak ?? '—'} 次</span>
    </Card>;
}

export function ServerMonitor() {
    const [paused, setPaused] = useState(false);
    const [visible, setVisible] = useState(document.visibilityState === 'visible');
    const [dashboard, setDashboard] = useState(false);
    const [ownedOrigin, setOwnedOrigin] = useState<string | null>(null);
    const base = getApiBase();
    const enabled = visible && !paused;
    useEffect(() => {
        const changed = () => setVisible(document.visibilityState === 'visible');
        document.addEventListener('visibilitychange', changed);
        return () => document.removeEventListener('visibilitychange', changed);
    }, []);
    const usage = useMonitorResource('/api/v1/auth/usage', enabled, 60_000, parseUsage);
    const metrics = useMonitorResource(metricPath(), enabled, 10_000, parseMetrics);
    const data = useMonitorResource(metricPath('data'), enabled, 10_000, parseMetrics);
    const portfolio = useMonitorResource(metricPath('portfolio'), enabled, 10_000, parseMetrics);
    const orders = useMonitorResource(metricPath('order'), enabled, 10_000, parseMetrics);
    const subscriptions = useMonitorResource('/api/v1/monitor/subscriptions?limit=1', enabled, 30_000, parseSubscriptions);
    useEffect(() => {
        setOwnedOrigin(null);
        if (!isTauri || !enabled) return;
        let url: URL;
        try { url = new URL(base); } catch { return; }
        if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== '127.0.0.1') return;
        let active = true;
        let timer: ReturnType<typeof setTimeout>;
        const check = async () => {
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                const owned = await invoke<boolean>('agent_harness_sidecar_owned', { port: Number(url.port) });
                if (active) setOwnedOrigin(owned ? url.origin : null);
            } catch { if (active) setOwnedOrigin(null); }
            finally { if (active) timer = setTimeout(check, 15_000); }
        };
        void check();
        return () => { active = false; clearTimeout(timer); };
    }, [base, enabled, dashboard]);

    const quota = quotaState(usage.data);
    const report = metrics.data;
    const warnings = [...new Set([report, data.data, portfolio.data, orders.data].flatMap(r => r ? monitorWarnings(r) : []))];
    const endpoints = report?.endpoints ?? [];
    const total = endpoints.reduce((n, e) => n + e.count, 0);
    const errors = endpoints.reduce((n, e) => n + e.errors, 0);
    const timeouts = endpoints.reduce((n, e) => n + e.timeouts, 0);
    const inflight = endpoints.reduce((n, e) => n + e.in_flight, 0);
    const sub = subscriptions.data;
    const failures = [usage, metrics, data, portfolio, orders, subscriptions].filter(r => r.error);
    return <section className={styles.wrap} aria-label="用量與 API 監控">
        <header className={styles.header}><div><h2 className={styles.title}>用量與 API 監控</h2><p className={styles.caption}>先看額度，再查請求來源與異常</p></div>
            <button className={styles.button} onClick={() => setPaused(v => !v)}>{paused ? '繼續更新' : '暫停監控'}</button></header>
        <div className={styles.status} role="status">{!enabled ? '已暫停 · 以下為上次觀測' : metrics.updated ? `監控更新 ${new Date(metrics.updated).toLocaleTimeString('zh-TW', { hour12: false })}` : metrics.error ? '監控無法取得' : '監控讀取中…'}<span>監控 10 秒 · 額度 60 秒更新</span></div>
        {failures.length > 0 && <div className={styles.warning} role="status">部分資料無法取得，對應數值顯示未知。{failures.map(r => r.error).filter((s, i, a) => a.indexOf(s) === i).join('；')}</div>}
        <div className={styles.cards}>
            <Card label="每日歷史行情流量 · 券商回報" value={quota.percent === null ? '—' : `${quota.percent.toFixed(1)}%`} tone={quota.tone}>
                <span className={styles.caption}>{quota.label}</span>
                <div className={styles.track} role="meter" aria-label="每日流量使用率" aria-valuemin={0} aria-valuemax={100} aria-valuenow={quota.percent === null ? undefined : Math.min(100, quota.percent)}><div style={{ width: `${Math.min(100, quota.percent ?? 0)}%` }} /></div>
                <span className={styles.caption}>已用 {usage.data ? mib(usage.data.bytes) : '—'} / {usage.data ? mib(usage.data.limit_bytes) : '—'}<br />剩餘 {usage.data ? mib(usage.data.remaining_bytes) : '—'} · {usage.updated ? new Date(usage.updated).toLocaleTimeString('zh-TW', { hour12: false }) : '尚未取得'}</span>
            </Card>
            <Card label="API 回報連線" value={usage.data?.connections ?? '—'} tone={usage.data && usage.data.connections >= 4 ? 'warning' : 'normal'}>
                <span className={styles.caption}>Shioaji 限制：每人身分證最多 5 條登入連線。<br />SSE 用戶端與訂閱數不等於登入連線數。</span>
                <span className={styles.caption}>每日登入限制 1,000 次；目前累計未提供。</span>
            </Card>
        </div>
        <p className={styles.note}>80% 為 App 提醒門檻。額度耗盡時 ticks／snapshots／kbars 可能回空；即時訂閱不消耗這項流量，不能用額度判定 SSE 是否正常。</p>
        <h3 className={styles.subtitle}>查詢壓力 · 本 Server</h3>
        <p className={styles.caption}>backend · 所有來源（使用者／背景／Dashboard）· 最近 5 分鐘。只計完成量，與 incoming／gateway 不相加。</p>
        <div className={styles.cards}>
            <RateCard report={data.data} label="行情類 data · 含 scanner" seconds={5} />
            <RateCard report={portfolio.data} label="帳務類 portfolio · 含模擬路徑" seconds={5} />
            <RateCard report={orders.data} label="委託類 order · 含狀態查詢" seconds={10} />
        </div>
        <div className={styles.note}><strong>限制參考</strong> 行情查詢 50 次 / 5 秒；帳務查詢 25 次 / 5 秒；委託操作 250 次 / 10 秒。<br />上方是監控分類，並非券商限流桶；完成時間也不等於送出時間，不能換算剩餘次數或證明未限流。其他 Server／Python 行程不在此觀測範圍。</div>
        {warnings.length > 0 && <div className={styles.warning}>{warnings.join('；')}。沒有觀測到不等於沒有發生。</div>}
        <div className={styles.summary}><span>5 分鐘完成 <b>{report ? total : '—'}</b></span><span>錯誤 / 逾時 <b>{report ? `${errors} / ${timeouts}` : '—'}</b></span><span>現在進行中 <b>{report ? inflight : '—'}</b></span></div>
        <details className={styles.details}>
            <summary>請求熱點與異常 · {endpoints.length} 個端點來源</summary>
            <p className={styles.caption}>依錯誤、完成次數排序。P95 為各端點 histogram 估值，非全域百分位。</p>
            {endpoints.length === 0 && <p className={styles.caption}>{report ? '此區間沒有端點觀測；請先確認收集與缺口。' : '端點資料尚未取得。'}</p>}
            {[...endpoints].sort((a, b) => (b.errors + b.timeouts) - (a.errors + a.timeouts) || b.count - a.count).slice(0, 12).map(e => <div className={styles.endpoint} key={`${e.plane}:${e.origin}:${e.method}:${e.endpoint}`}><code>{e.endpoint}</code><span>{e.origin} · {e.plane}</span><span>{e.count} 次 · 錯誤 {e.errors} · 逾時 {e.timeouts} · P95 {(e.p95_us / 1000).toFixed(1)} ms</span></div>)}
        </details>
        <div className={styles.note}><strong>是否已觸發限流？</strong> Monitor 不提供限流原因，錯誤／逾時不能直接視為限流。若 API 明確回報「操作異常，請1分鐘後再重新登入」，停止重試並至少等待一分鐘；檢查輪詢、重連與登入迴圈。單獨 503 也可能是版本被拒絕。</div>
        <details className={styles.details}><summary>訂閱與收集狀態</summary>
            <div className={styles.summary}><span>行情訂閱 <b>{sub && !sub.unavailable ? sub.market_data : '—'}</b></span><span>帳戶訂閱 <b>{sub && !sub.unavailable ? sub.trade_accounts : '—'}</b></span></div>
            <p className={styles.caption}>{sub && !sub.unavailable ? Object.entries(sub.by_type).map(([type, count]) => `${type} ${count}`).join(' · ') : '訂閱資料未知'}{sub?.partial ? ' · 分布不完整' : ''}</p>
            <p className={styles.caption}>請求摘要：{report ? report.settings.capture.requests ? '已啟用' : '未開啟，無明細不代表沒有請求' : '未知'}<br />串流統計：{report ? report.settings.capture.streams === 'auto' ? '按需；展開官方 Dashboard 的連線詳情才收集' : '已停用' : '未知'}<br />歷史最後儲存：{report?.last_saved_ms ? new Date(report.last_saved_ms).toLocaleTimeString('zh-TW', { hour12: false }) : '尚無紀錄'}</p>
        </details>
        {ownedOrigin && <button className={styles.button} aria-expanded={dashboard} onClick={() => setDashboard(v => !v)}>{dashboard ? '收合' : '開啟'}官方 Server Dashboard</button>}
        {dashboard && enabled && ownedOrigin && <iframe className={styles.frame} title="Shioaji 1.7.5 Server Dashboard" src={`${ownedOrigin}/?monitor.source=backend&monitor.origin=all&monitor.window=5m`} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" />}
        {dashboard && <p className={styles.caption}>收合、暫停或隱藏本頁會卸載 Dashboard，釋放自己的收集 session；不影響行情訂閱。完整 Dashboard 建議放大面板查看。</p>}
    </section>;
}
