import { useCallback, useEffect, useState } from 'react';
import { usePoll } from '../hooks/use-poll';
import { getKgiBackendBase, isKgiMockMode } from '../lib/broker/config';
import { fetchHealth, fetchInfo } from '../lib/kgi';
import { fetchAgentStatus } from '../lib/kgi-agent';
import { appVersion, checkForUpdates } from '../lib/tauri';
import * as styles from './debug-panel.css';

export function KgiStatusPanel() {
    const [version, setVersion] = useState('');
    const [checking, setChecking] = useState(false);

    useEffect(() => {
        appVersion().then(setVersion);
    }, []);

    const { data: health } = usePoll(
        useCallback(() => fetchHealth().catch(() => null), []),
        5000,
    );
    const { data: info } = usePoll(
        useCallback(() => fetchInfo().catch(() => null), []),
        30000,
    );
    const { data: agent } = usePoll(
        useCallback(() => fetchAgentStatus().catch(() => null), []),
        10000,
    );

    const rows = [
        { label: 'App', value: version ? `v${version}` : '-' },
        { label: 'KGI Bridge', value: getKgiBackendBase() },
        { label: '前端模式', value: isKgiMockMode() ? 'Mock' : 'Real' },
        {
            label: '後端模式',
            value: health?.mode ?? '-',
            warn: health?.mode === 'real' && health.connected !== true,
        },
        {
            label: 'KGI 連線',
            value: health?.connected ? 'Connected' : 'Disconnected',
            warn: health?.connected !== true,
        },
        {
            label: 'Bridge 版本',
            value: info ? `${info.version}${info.simulation ? ' Mock' : ' Real'}` : '-',
        },
        {
            label: 'Codex',
            value: agent?.connected
                ? agent.authenticated
                    ? 'Connected'
                    : 'Needs Auth'
                : 'Disconnected',
            warn: agent?.connected !== true || agent.authenticated !== true,
        },
        { label: 'Model', value: agent?.model ?? '-' },
        { label: '交易閘道', value: 'Disabled', warn: true },
        {
            label: '合約更新',
            value: health?.last_maintenance || health?.next_maintenance || '-',
        },
    ];

    async function onCheckUpdates() {
        setChecking(true);
        try {
            await checkForUpdates(false);
        } finally {
            setChecking(false);
        }
    }

    return (
        <div className={styles.wrap}>
            <div className={styles.grid}>
                {rows.map((row) => (
                    <div key={row.label} className={styles.row}>
                        <span className={styles.label}>{row.label}</span>
                        <span className={row.warn ? styles.valueWarn : styles.value}>
                            {row.value}
                        </span>
                    </div>
                ))}
            </div>
            <button
                type="button"
                className={styles.actionButton}
                onClick={onCheckUpdates}
                disabled={checking}
            >
                {checking ? '檢查中' : '檢查更新'}
            </button>
            {health?.message ? (
                <pre className={styles.eventDump}>{health.message}</pre>
            ) : null}
        </div>
    );
}
