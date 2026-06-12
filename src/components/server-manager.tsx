// src/components/server-manager.tsx — desktop-only shioaji server控制台:
// status, start/stop/restart, API-key settings, simulation/production mode.

import {
    Clipboard,
    Eye,
    EyeOff,
    Play,
    RefreshCw,
    RotateCcw,
    ShieldCheck,
    Square,
    X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { usePoll } from '../hooks/use-poll';
import { useStreamStatus } from '../hooks/use-stream';
import {
    fetchAccounts,
    fetchCaExpire,
    fetchHealth,
    fetchInfo,
} from '../lib/shioaji';
import {
    appVersion,
    isTauri,
    loadDesktopSettings,
    pickCaFile,
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

// translate known server-start failures into something a user can act on
// (the raw log buries the ERROR line below INFO noise — see the
// "msg receiver error: Closed" support case)
function diagnoseOutput(output: string): string | null {
    if (/not exist/i.test(output))
        return 'API Key 不存在或已失效 — 請至永豐「API 管理頁」確認或重建金鑰後重新填入';
    if (/invalid (secret_key|api_key)|base58/i.test(output))
        return '金鑰格式錯誤 — 請確認 API Key／Secret Key 完整貼上（沒有多餘空白或漏字）';
    if (/ca.*(password|passwd)|pfx/i.test(output))
        return '憑證載入失敗 — 請確認 Sinopac.pfx 與憑證密碼';
    if (/Authentication failed|login validation error|LOGINING/i.test(output))
        return '登入失敗 — 請檢查金鑰是否正確、API 約定書是否已完成簽署、同帳號連線是否已達上限（5 條）';
    return null;
}

function errorLines(output: string): string {
    return [
        ...new Set(
            output
                .split('\n')
                .filter((l) => /\bERROR\b|^Error:/i.test(l))
                .map((l) =>
                    l.replace(/^.*\bERROR\b\S*\s*/, '').replace(/^Error:\s*/, ''),
                )
                .filter(Boolean),
        ),
    ]
        .slice(0, 2)
        .join('\n');
}

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
        caPath: '',
        caPasswd: '',
    });
    const [busy, setBusy] = useState(false);
    const [lastOutput, setLastOutput] = useState('');
    const [ver, setVer] = useState('');
    const [checking, setChecking] = useState(false);
    const [readyLines, setReadyLines] = useState<string[]>([]);
    const [showPw, setShowPw] = useState(false);

    // human-readable CA activation failure pulled from the latest start log
    // (the server starts even when CA fails, so this is how the user learns
    // why production orders will 400)
    const caError = (() => {
        const m =
            /Failed to activate CA certificate:\s*([^\n]+)/i.exec(lastOutput) ||
            /CA 未啟用（([^）]+)）/.exec(lastOutput);
        if (!m || !m[1]) return '';
        const raw = m[1].trim();
        if (/expired/i.test(raw))
            return 'CA 憑證已過期 — 請至 API 管理頁重新下載 Sinopac.pfx';
        if (/password/i.test(raw))
            return 'CA 憑證密碼錯誤 — 請確認下載憑證時設定的密碼';
        return `CA 未啟用：${raw}`;
    })();

    // diagnose why production orders 400: which accounts are signed + CA
    // validity (issue #1 support — "加了 CA 還是 400")
    const runReadyCheck = async () => {
        setChecking(true);
        setReadyLines([]);
        const out: string[] = [];
        try {
            const info = await fetchInfo().catch(() => null);
            out.push(
                info?.simulation
                    ? '環境：模擬（下單不需 CA）'
                    : '環境：⚠ 正式（下單需 CA＋已簽署帳戶）',
            );
            const accounts = await fetchAccounts();
            for (const a of accounts) {
                const kind =
                    a.account_type === 'S'
                        ? '證券'
                        : a.account_type === 'F'
                          ? '期貨'
                          : a.account_type;
                out.push(
                    `${a.signed ? '✓' : '✗'} ${kind} ${a.broker_id}-${a.account_id}` +
                        `${a.signed ? ' 已簽署' : ' 未簽署 API 約定書（無法下單）'}`,
                );
            }
            const pid = accounts[0]?.person_id;
            if (pid && info && !info.simulation) {
                try {
                    const ca = await fetchCaExpire(pid);
                    const exp = new Date(ca.expire_time);
                    const ok = exp.getTime() > Date.now();
                    out.push(
                        `${ok ? '✓' : '✗'} CA 憑證${ok ? '有效' : '已過期'}，到期 ${ca.expire_time.slice(0, 10)}`,
                    );
                } catch (e) {
                    out.push(
                        `✗ CA 未啟用或查詢失敗：${e instanceof Error ? e.message : String(e)}`,
                    );
                }
            }
            out.push('— 下單若仍 400，請把以上內容回報 —');
        } catch (e) {
            out.push(`✗ 檢查失敗：${e instanceof Error ? e.message : String(e)}`);
        }
        setReadyLines(out);
        setChecking(false);
    };

    useEffect(() => {
        appVersion().then(setVer);
    }, []);

    // safety net: never let a stuck sidecar promise pin 啟動中 / disable the
    // buttons forever — auto-clear busy after 75s (a production login + CA +
    // contract load is well under that)
    useEffect(() => {
        if (!busy) return;
        const t = setTimeout(() => setBusy(false), 75_000);
        return () => clearTimeout(t);
    }, [busy]);

    const stream = useStreamStatus();
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

    // after a (re)start the upstream subscriptions are gone — reload the UI
    // once the server reports healthy so every panel bootstraps cleanly
    // (issue #2: charts/watchlist froze after restart until manual reload)
    const reloadWhenHealthy = () => {
        const deadline = Date.now() + 90_000;
        const t = setInterval(async () => {
            if (Date.now() > deadline) {
                clearInterval(t);
                return;
            }
            try {
                await fetchHealth();
                clearInterval(t);
                window.location.reload();
            } catch {
                // not up yet
            }
        }, 2000);
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
        if (settings.production && !settings.caPath) {
            notify({
                kind: 'err',
                title: '缺少憑證',
                body: '正式環境下單需要 Sinopac.pfx 憑證，請先選擇憑證檔',
            });
            return;
        }
        setBusy(true);
        try {
            const res = await serverStart(settings);
            // keep the tail — start failures put the ERROR line last
            setLastOutput(res.output.slice(-600));
            notify({
                kind: res.ok ? 'ok' : 'err',
                title: res.ok
                    ? res.attached
                        ? '🔗 已連接既有伺服器'
                        : '🟢 伺服器啟動指令已送出'
                    : '伺服器啟動失敗',
                body: res.ok
                    ? `port ${res.port} · 模式：${settings.production ? '⚠ 正式環境' : '模擬環境'}`
                    : diagnoseOutput(res.output) ||
                      errorLines(res.output) ||
                      res.output.slice(-120),
            });
            if (res.ok) {
                // reload once healthy (or immediately when the port moved)
                if (res.portChanged) {
                    setTimeout(() => window.location.reload(), 1800);
                } else if (!res.attached) {
                    reloadWhenHealthy();
                }
            }
        } finally {
            setBusy(false);
            setTimeout(refresh, 1500);
        }
    };

    const doStop = async () => {
        setBusy(true);
        try {
            const res = await serverStop();
            setLastOutput(res.output.slice(-600));
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
    // explicit lifecycle so starting/connecting never looks stuck. A LIVE
    // quote stream means the server is up and serving — that must beat a
    // still-pending `busy` (the sidecar `server start` can stay awaited well
    // after the daemon is live), otherwise it sticks on 啟動中 forever.
    const phase: 'starting' | 'connecting' | 'ok' | 'down' =
        running && stream === 'live'
            ? 'ok'
            : stream === 'live'
              ? 'connecting' // data flowing, health not confirmed yet
              : busy
                ? 'starting'
                : status?.running || stream === 'connecting'
                  ? 'connecting'
                  : 'down';
    const phaseLabel =
        phase === 'starting'
            ? '啟動中…'
            : phase === 'connecting'
              ? '連線中…'
              : '伺服器';

    return (
        <div className={styles.settingsWrap}>
            <button
                className={styles.resetBtn}
                style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                }}
                onClick={() => onToggle(!open)}
            >
                {phase === 'starting' || phase === 'connecting' ? (
                    <span className={styles.spinner} />
                ) : (
                    <span
                        className={styles.led[phase === 'ok' ? 'live' : 'down']}
                    />
                )}
                {phaseLabel}
            </button>
            {open && (
                <>
                    <div
                        className={styles.popoverBackdrop}
                        onClick={() => onToggle(false)}
                    />
                    <div className={styles.popover} style={{ width: '19rem' }}>
                        <span
                            className={styles.settingLabel}
                            style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'baseline',
                            }}
                        >
                            Shioaji Server 狀態
                            {ver && (
                                <span
                                    style={{
                                        fontFamily: 'var(--font-mono, monospace)',
                                        opacity: 0.75,
                                        fontWeight: 400,
                                    }}
                                >
                                    App v{ver}
                                </span>
                            )}
                        </span>
                        <span className={styles.emptyHint}>
                            {phase === 'starting' &&
                                '啟動中 — 登入與載入合約約需 10–30 秒…'}
                            {phase === 'connecting' &&
                                status?.running &&
                                '已啟動，等待行情連線…'}
                            {(phase === 'ok' ||
                                (status?.running && phase !== 'starting')) && (
                                <>
                                    {phase === 'connecting' && <br />}
                                    {`運行中 · PID ${status?.pid} · :${status?.port} · ${
                                        status?.simulation
                                            ? '模擬環境'
                                            : '⚠ 正式環境'
                                    } · ${status?.healthy ? '健康' : '不健康'}`}
                                </>
                            )}
                            {!status?.running && phase !== 'starting' && '未運行'}
                        </span>
                        {(phase === 'starting' ||
                            (phase === 'connecting' && status?.running)) && (
                            <span className={styles.progressTrack}>
                                <span className={styles.progressGlider} />
                            </span>
                        )}
                        {status?.running &&
                            status.simulation === settings.production && (
                                <span
                                    className={styles.emptyHint}
                                    style={{
                                        color: 'var(--danger, #f23645)',
                                    }}
                                >
                                    ⚠ 伺服器目前為
                                    {status.simulation ? '模擬' : '正式'}
                                    環境，與設定（
                                    {settings.production ? '正式' : '模擬'}
                                    ）不符 — 按「重啟」套用
                                </span>
                            )}
                        {status?.running && status.healthy === false && (
                            <span
                                className={styles.emptyHint}
                                style={{ color: 'var(--danger, #f23645)' }}
                            >
                                ⚠ 伺服器不健康：正式環境需要憑證與已簽署的
                                API 金鑰；或切回模擬後按「重啟」
                            </span>
                        )}
                        {health && (
                            <span className={styles.emptyHint}>
                                token 剩餘{' '}
                                {Math.round(
                                    health.token_expires_in_seconds / 3600,
                                )}
                                h · 合約 {health.contract_count}
                            </span>
                        )}
                        <div className={styles.settingGroup}>
                            <button
                                className={styles.opt.off}
                                disabled={busy}
                                onClick={doStart}
                            >
                                <Play size={11} style={{ verticalAlign: '-1px' }} />{' '}
                                啟動
                            </button>
                            <button
                                className={styles.opt.off}
                                disabled={busy}
                                onClick={doRestart}
                            >
                                <RotateCcw size={11} style={{ verticalAlign: '-1px' }} />{' '}
                                重啟
                            </button>
                            <button
                                className={styles.opt.off}
                                disabled={busy}
                                onClick={doStop}
                            >
                                <Square size={10} style={{ verticalAlign: '-1px' }} />{' '}
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

                        <span className={styles.settingLabel}>
                            憑證（正式環境下單必要，模擬不需要）
                        </span>
                        <div className={styles.saveRow}>
                            <button
                                className={styles.resetBtn}
                                style={{ flex: 1, minWidth: 0 }}
                                title={
                                    settings.caPath ||
                                    '從 API 管理頁下載的 Sinopac.pfx'
                                }
                                onClick={async () => {
                                    const path = await pickCaFile();
                                    if (path) persist({ caPath: path });
                                }}
                            >
                                {settings.caPath
                                    ? `✓ ${settings.caPath.split(/[/\\]/).pop()}`
                                    : '選擇 Sinopac.pfx…'}
                            </button>
                            {settings.caPath && (
                                <button
                                    className={styles.profileDelete}
                                    title='清除憑證設定'
                                    onClick={() =>
                                        persist({ caPath: '', caPasswd: '' })
                                    }
                                >
                                    <X size={10} />
                                </button>
                            )}
                        </div>
                        {settings.caPath && (
                            <div
                                className={styles.saveRow}
                                style={{ position: 'relative' }}
                            >
                                <input
                                    className={styles.saveInput}
                                    style={{ flex: 1, paddingRight: '30px' }}
                                    type={showPw ? 'text' : 'password'}
                                    placeholder='憑證密碼（下載時設定）'
                                    value={settings.caPasswd}
                                    onChange={(e) =>
                                        persist({ caPasswd: e.target.value })
                                    }
                                />
                                <button
                                    className={styles.resetBtn}
                                    style={{
                                        position: 'absolute',
                                        right: '4px',
                                        top: '50%',
                                        transform: 'translateY(-50%)',
                                        padding: '2px 6px',
                                        border: 'none',
                                        background: 'transparent',
                                    }}
                                    title={showPw ? '隱藏密碼' : '顯示密碼'}
                                    onClick={() => setShowPw((v) => !v)}
                                >
                                    {showPw ? (
                                        <EyeOff size={13} />
                                    ) : (
                                        <Eye size={13} />
                                    )}
                                </button>
                            </div>
                        )}
                        {caError && (
                            <span
                                className={styles.emptyHint}
                                style={{
                                    color: 'var(--danger, #f23645)',
                                    fontWeight: 600,
                                }}
                            >
                                ⚠ {caError}
                            </span>
                        )}
                        {settings.production && !settings.caPath && (
                            <span
                                className={styles.emptyHint}
                                style={{ color: 'var(--danger, #f23645)' }}
                            >
                                尚未設定憑證 — 正式環境無法下單。請至
                                sinotrade.com.tw API 管理頁下載 Sinopac.pfx
                            </span>
                        )}

                        <button
                            className={styles.updateBtn}
                            onClick={runReadyCheck}
                            disabled={checking}
                        >
                            <ShieldCheck size={13} />
                            {checking ? '檢查中…' : '下單就緒檢查（CA／帳戶）'}
                        </button>
                        {readyLines.length > 0 && (
                            <div
                                className={styles.emptyHint}
                                style={{
                                    fontFamily: 'var(--font-mono, monospace)',
                                    lineHeight: 1.6,
                                    whiteSpace: 'pre-wrap',
                                }}
                            >
                                {readyLines.map((l, i) => (
                                    <div
                                        key={i}
                                        style={
                                            l.startsWith('✗') || l.startsWith('⚠')
                                                ? { color: 'var(--danger, #f23645)' }
                                                : undefined
                                        }
                                    >
                                        {l}
                                    </div>
                                ))}
                            </div>
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
                            <RefreshCw size={13} />
                            檢查 App 更新
                        </button>
                        {lastOutput && diagnoseOutput(lastOutput) && (
                            <span
                                className={styles.emptyHint}
                                style={{
                                    color: 'var(--danger, #f23645)',
                                    fontWeight: 600,
                                }}
                            >
                                ⚠ {diagnoseOutput(lastOutput)}
                            </span>
                        )}
                        {lastOutput && errorLines(lastOutput) && (
                            <span
                                className={styles.emptyHint}
                                style={{ color: 'var(--danger, #f23645)' }}
                            >
                                {errorLines(lastOutput)}
                            </span>
                        )}
                        {lastOutput && (
                            <span className={styles.emptyHint}>
                                {lastOutput}
                            </span>
                        )}
                        <button
                            className={styles.updateBtn}
                            onClick={async () => {
                                const lines = [
                                    `Shioaji Pro v${ver || '?'} · ${navigator.platform}`,
                                    `server: ${
                                        status?.running
                                            ? `running pid=${status.pid} port=${status.port} ${
                                                  status.simulation
                                                      ? 'sim'
                                                      : 'prod'
                                              } healthy=${status.healthy}`
                                            : 'not running'
                                    }`,
                                    `stream: ${stream} · mode setting: ${
                                        settings.production ? 'prod' : 'sim'
                                    } · ca: ${settings.caPath ? 'set' : 'none'}`,
                                    lastOutput ? `--- log ---\n${lastOutput}` : '',
                                ].filter(Boolean);
                                try {
                                    await navigator.clipboard.writeText(
                                        lines.join('\n'),
                                    );
                                    notify({
                                        kind: 'ok',
                                        title: '已複製診斷資訊',
                                        body: '回報問題時直接貼上即可',
                                    });
                                } catch {
                                    notify({
                                        kind: 'err',
                                        title: '複製失敗',
                                        body: '請手動截圖面板內容',
                                    });
                                }
                            }}
                        >
                            <Clipboard size={13} />
                            複製診斷資訊
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}
