// src/components/server-manager.tsx — desktop-only shioaji server控制台:
// status, start/stop/restart, API-key settings, simulation/production mode.

import { useCallback, useEffect, useState } from 'react';
import { usePoll } from '../hooks/use-poll';
import { fetchHealth } from '../lib/shioaji';
import {
    isTauri,
    loadDesktopSettings,
    saveDesktopSettings,
    serverStart,
    serverStatus,
    serverStop,
    checkForUpdates,
    type DesktopSettings,
    type ServerStatus,
} from '../lib/tauri';
import { notify } from '../lib/trade';
import type { Health } from '../lib/types/health';
import * as styles from './hud-header.css';

export function ServerManager({
    open,
    onToggle,
}: {
    open: boolean;
    onToggle: (open: boolean) => void;
}) {
    const [settings, setSettings] = useState<DesktopSettings>({
        apiKey: '',
        secretKey: '',
        production: false,
        autoStart: true,
    });
    const [busy, setBusy] = useState(false);
    const [lastOutput, setLastOutput] = useState('');

    const { data: status, refresh } = usePoll<ServerStatus | null>(
        useCallback(() => serverStatus(), []),
        8000,
    );
    const { data: health } = usePoll<Health | null>(
        useCallback(() => fetchHealth().catch(() => null), []),
        15000,
    );

    useEffect(() => {
        loadDesktopSettings().then(setSettings);
    }, []);

    const persist = (next: Partial<DesktopSettings>) => {
        const merged = { ...settings, ...next };
        setSettings(merged);
        void saveDesktopSettings(merged);
    };

    const doStart = async () => {
        if (!settings.apiKey || !settings.secretKey) {
            notify({
                kind: 'err',
                title: '缺少 API 金鑰',
                body: '請先填入 SJ_API_KEY / SJ_SEC_KEY 並儲存',
            });
            return;
        }
        setBusy(true);
        try {
            const res = await serverStart(settings);
            setLastOutput(res.output.slice(0, 400));
            notify({
                kind: res.ok ? 'ok' : 'err',
                title: res.ok ? '🟢 伺服器啟動指令已送出' : '伺服器啟動失敗',
                body: res.ok
                    ? `模式：${settings.production ? '⚠ 正式環境' : '模擬環境'}`
                    : res.output.slice(0, 120),
            });
        } finally {
            setBusy(false);
            setTimeout(refresh, 1500);
        }
    };

    const doStop = async () => {
        setBusy(true);
        try {
            const res = await serverStop();
            setLastOutput(res.output.slice(0, 400));
            notify({
                kind: res.ok ? 'ok' : 'err',
                title: res.ok ? '🔴 伺服器已停止' : '停止失敗',
                body: res.ok ? '' : res.output.slice(0, 120),
            });
        } finally {
            setBusy(false);
            setTimeout(refresh, 1000);
        }
    };

    const doRestart = async () => {
        setBusy(true);
        try {
            await serverStop();
            await new Promise((r) => setTimeout(r, 1200));
            await doStart();
        } finally {
            setBusy(false);
        }
    };

    if (!isTauri) return null;

    const running = status?.running && status.healthy;

    return (
        <div className={styles.settingsWrap}>
            <button
                className={styles.resetBtn}
                onClick={() => onToggle(!open)}
            >
                {running ? '🟢' : '🔴'} 伺服器
            </button>
            {open && (
                <>
                    <div
                        className={styles.popoverBackdrop}
                        onClick={() => onToggle(false)}
                    />
                    <div className={styles.popover} style={{ width: '19rem' }}>
                        <span className={styles.settingLabel}>
                            Shioaji Server 狀態
                        </span>
                        <span className={styles.emptyHint}>
                            {status?.running
                                ? `運行中 · PID ${status.pid} · :${status.port} · ${
                                      status.simulation
                                          ? '模擬環境'
                                          : '⚠ 正式環境'
                                  } · ${status.healthy ? '健康' : '不健康'}`
                                : '未運行'}
                            {health && (
                                <>
                                    <br />
                                    token 剩餘{' '}
                                    {Math.round(
                                        health.token_expires_in_seconds /
                                            3600,
                                    )}
                                    h · 合約 {health.contract_count}
                                </>
                            )}
                        </span>
                        <div className={styles.settingGroup}>
                            <button
                                className={styles.opt.off}
                                disabled={busy}
                                onClick={doStart}
                            >
                                啟動
                            </button>
                            <button
                                className={styles.opt.off}
                                disabled={busy}
                                onClick={doRestart}
                            >
                                重啟
                            </button>
                            <button
                                className={styles.opt.off}
                                disabled={busy}
                                onClick={doStop}
                            >
                                停止
                            </button>
                        </div>

                        <span className={styles.settingLabel}>
                            API 金鑰（儲存在本機 App 資料夾）
                        </span>
                        <input
                            className={styles.saveInput}
                            type='password'
                            placeholder='SJ_API_KEY'
                            value={settings.apiKey}
                            onChange={(e) =>
                                persist({ apiKey: e.target.value })
                            }
                        />
                        <input
                            className={styles.saveInput}
                            type='password'
                            placeholder='SJ_SEC_KEY'
                            value={settings.secretKey}
                            onChange={(e) =>
                                persist({ secretKey: e.target.value })
                            }
                        />

                        <span className={styles.settingLabel}>環境</span>
                        <div className={styles.settingGroup}>
                            <button
                                className={
                                    styles.opt[
                                        settings.production ? 'off' : 'on'
                                    ]
                                }
                                onClick={() =>
                                    persist({ production: false })
                                }
                            >
                                模擬
                            </button>
                            <button
                                className={
                                    styles.opt[
                                        settings.production ? 'on' : 'off'
                                    ]
                                }
                                onClick={() => persist({ production: true })}
                            >
                                ⚠ 正式
                            </button>
                        </div>
                        {settings.production && (
                            <span
                                className={styles.emptyHint}
                                style={{ color: 'var(--danger, #f23645)' }}
                            >
                                正式環境下單動用真實資金，重啟後生效
                            </span>
                        )}

                        <button
                            className={
                                styles.opt[settings.autoStart ? 'on' : 'off']
                            }
                            onClick={() =>
                                persist({ autoStart: !settings.autoStart })
                            }
                        >
                            {settings.autoStart
                                ? '✓ App 啟動時自動啟動伺服器'
                                : 'App 啟動時自動啟動伺服器'}
                        </button>
                        <button
                            className={styles.updateBtn}
                            onClick={() => checkForUpdates(false)}
                        >
                            <svg
                                width='14'
                                height='14'
                                viewBox='0 0 24 24'
                                fill='none'
                                stroke='currentColor'
                                strokeWidth='2'
                                strokeLinecap='round'
                                strokeLinejoin='round'
                            >
                                <path d='M21 12a9 9 0 1 1-2.64-6.36' />
                                <polyline points='21 3 21 9 15 9' />
                            </svg>
                            檢查 App 更新
                        </button>
                        {lastOutput && (
                            <span className={styles.emptyHint}>
                                {lastOutput}
                            </span>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
