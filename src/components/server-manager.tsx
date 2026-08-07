// src/components/server-manager.tsx — desktop-only shioaji server控制台:
// status, start/stop/restart, API-key settings, simulation/production mode.

import {
    Clipboard,
    Download,
    Eye,
    EyeOff,
    ExternalLink,
    FileUp,
    Lock,
    LogOut,
    Play,
    RefreshCw,
    RotateCcw,
    Settings,
    ShieldCheck,
    Square,
    X,
} from 'lucide-react';
import {
    useCallback,
    useEffect,
    useState,
    useSyncExternalStore,
} from 'react';
import { usePoll } from '../hooks/use-poll';
import { useStreamStatus } from '../hooks/use-stream';
import { EXPECTED_SERVER_VERSION } from '../lib/runtime';
import { diagnoseOutput, errorLines, validateDesktopSettings } from '../lib/server-diagnostics';
import { clearStoredSpawnKeyHash } from '../lib/spawn-keys';
import {
    fetchAccounts,
    fetchCaExpire,
    fetchHealth,
    fetchInfo,
} from '../lib/shioaji';
import {
    appVersion,
    checkForUpdates,
    ensureLocalTlsCert,
    getAppUpdateState,
    isTauri,
    loadDesktopSettings,
    openLatestRelease,
    pickCaFile,
    pickEnvFile,
    reloadWhenHealthy,
    restartAndInstallUpdate,
    saveDesktopSettings,
    serverStart,
    serverStatus,
    serverStop,
    subscribeAppUpdateState,
    type DesktopSettings,
    type ServerStatus,
} from '../lib/tauri';
import { notify } from '../lib/trade';
import { Orb } from './orb';
import type { Health } from '../lib/types/health';
import * as styles from './hud-header.css';

// "9h" reads fine but "0h" while the token auto-renews in minutes is
// misleading — show minutes below two hours
function fmtTokenRemaining(seconds: unknown): string {
    if (typeof seconds !== 'number') return '—';
    if (seconds >= 7200) return `${Math.round(seconds / 3600)}h`;
    return `${Math.max(1, Math.round(seconds / 60))}m`;
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
        httpsEnabled: false,
    });
    const [busy, setBusy] = useState(false);
    const [lastOutput, setLastOutput] = useState('');
    const [ver, setVer] = useState('');
    const [checking, setChecking] = useState(false);
    const [readyLines, setReadyLines] = useState<string[]>([]);
    const [showPw, setShowPw] = useState(false);
    const [confirmLogout, setConfirmLogout] = useState(false);
    const [envMsg, setEnvMsg] = useState('');
    const [settingsOpen, setSettingsOpen] = useState(false);
    const updateState = useSyncExternalStore(
        subscribeAppUpdateState,
        getAppUpdateState,
        getAppUpdateState,
    );

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

    // Esc 關閉設定 dialog
    useEffect(() => {
        if (!settingsOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setSettingsOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [settingsOpen]);

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

    const importEnv = async () => {
        const found = await pickEnvFile();
        if (!found) return; // dialog cancelled
        if (found.error) {
            setEnvMsg(found.error);
            return;
        }
        setEnvMsg('');
        persist(found);
    };

    const copyDiagnostics = async () => {
        // the webview's navigator.platform lies ("MacIntel" on Apple
        // Silicon) — ask the Rust side for the real OS/arch
        let host: string = navigator.platform;
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            host = await invoke<string>('host_info');
        } catch {
            // older shell without the command
        }
        const lines = [
            `Shioaji Pro v${ver || '?'} · ${host}`,
            status?.running
                ? `server: running v${status.version ?? '?'} (expected v${
                      EXPECTED_SERVER_VERSION || '—'
                  }) · pid=${status.pid ?? '?'} · ${status.scheme ?? 'http'}://127.0.0.1:${status.port} · ${
                      status.simulation ? 'sim' : 'prod'
                  } · healthy=${status.healthy}`
                : 'server: not running',
            health
                ? `health: token ${fmtTokenRemaining(
                      health.token_expires_in_seconds,
                  )}${health.token_stale ? ' (stale)' : ''}${
                      typeof health.ca_expires_in_days === 'number'
                          ? ` · ca ${
                                health.ca_expired
                                    ? 'EXPIRED'
                                    : `expires in ${health.ca_expires_in_days}d`
                            }`
                          : ''
                  }`
                : 'health: —',
            `stream: ${stream} · mode setting: ${
                settings.production ? 'prod' : 'sim'
            } · ca: ${settings.caPath ? 'set' : 'none'} · https: ${
                settings.httpsEnabled ? 'on' : 'off'
            } · autostart: ${settings.autoStart ? 'on' : 'off'}`,
            lastOutput ? `--- log ---\n${lastOutput}` : '',
        ].filter(Boolean);
        try {
            await navigator.clipboard.writeText(lines.join('\n'));
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
    };

    // clears the saved API Key/Secret so the app falls back to the first-run
    // onboarding screen on next reload — the only way back to it today
    // (two-click confirm mirrors watchlist.tsx's delete-list pattern).
    // Logout also STOPS our own server (issue #16): leaving it running means
    // the next login adopts a server still logged into the OLD credentials.
    // serverStop() without allowExternal never touches a user's own daemon.
    const doLogout = () => {
        if (!confirmLogout) {
            setConfirmLogout(true);
            setTimeout(() => setConfirmLogout(false), 2500);
            return;
        }
        setConfirmLogout(false);
        void (async () => {
            await serverStop().catch(() => undefined);
            clearStoredSpawnKeyHash();
            await saveDesktopSettings({
                ...settings,
                apiKey: '',
                secretKey: '',
            });
            window.location.reload();
        })();
    };

    // after a (re)start the upstream subscriptions are gone — reload the UI
    // once the server reports healthy so every panel bootstraps cleanly
    // (issue #2: charts/watchlist froze after restart until manual reload)
    // cfg override lets 啟用/停用 HTTPS restart with the just-persisted
    // settings instead of the stale closure state
    const doStart = async (cfg: DesktopSettings = settings) => {
        const err = validateDesktopSettings(cfg);
        if (err) {
            notify({ kind: 'err', ...err });
            return;
        }
        setBusy(true);
        try {
            const res = await serverStart(cfg);
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
                    ? `port ${res.port} · 模式：${cfg.production ? '⚠ 正式環境' : '模擬環境'}`
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
            const res = await serverStop({ allowExternal: true });
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

    const doRestart = async (cfg: DesktopSettings = settings) => {
        setBusy(true);
        try {
            await serverStop({ allowExternal: true });
            await new Promise((r) => setTimeout(r, 1200));
            await doStart(cfg);
        } finally {
            setBusy(false);
        }
    };

    // ---- 本機 HTTPS ----
    const [httpsBusy, setHttpsBusy] = useState(false);
    const [httpsMsg, setHttpsMsg] = useState('');

    const enableHttps = async () => {
        setHttpsBusy(true);
        setHttpsMsg('');
        try {
            const res = await ensureLocalTlsCert();
            if (!res.ok) {
                setHttpsMsg(
                    res.output === 'TRUST_DECLINED'
                        ? '未完成憑證信任 — 系統的信任視窗被取消或驗證未通過，再按一次「啟用」可重試。'
                        : res.output === 'LINUX_MANUAL_TRUST'
                          ? 'Linux 需手動信任本機憑證：請在終端機安裝 mkcert 並執行「mkcert -install」後，再按一次「啟用」。'
                          : res.output.startsWith('MKCERT_SIDECAR_MISSING')
                            ? '找不到內建的 mkcert 元件（開發環境請先執行 scripts/fetch-mkcert.sh）。'
                            : `憑證產生失敗：${res.output.slice(-300)}`,
                );
                return;
            }
            setHttpsMsg('');
            const merged = { ...settings, httpsEnabled: true };
            persist({ httpsEnabled: true });
            notify({
                kind: 'ok',
                title: '🔒 本機 HTTPS 憑證就緒',
                body: '重啟伺服器套用中…',
            });
            await doRestart(merged);
        } finally {
            setHttpsBusy(false);
        }
    };

    const disableHttps = async () => {
        setHttpsMsg('');
        const merged = { ...settings, httpsEnabled: false };
        persist({ httpsEnabled: false });
        await doRestart(merged);
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
    const updatePercent =
        updateState.totalBytes && updateState.downloadedBytes !== undefined
            ? Math.min(
                  100,
                  Math.round(
                      (updateState.downloadedBytes /
                          updateState.totalBytes) *
                          100,
                  ),
              )
            : undefined;
    const updateNeedsAttention =
        updateState.phase === 'downloading' ||
        updateState.phase === 'ready' ||
        updateState.phase === 'installing' ||
        updateState.phase === 'external';
    const serverVersion = status?.version ?? health?.version;
    const serverVersionMismatch =
        !!serverVersion &&
        !!EXPECTED_SERVER_VERSION &&
        serverVersion !== EXPECTED_SERVER_VERSION;
    const updateHeaderLabel =
        updateState.phase === 'downloading'
            ? `下載更新${updatePercent === undefined ? '' : ` ${updatePercent}%`}`
            : updateState.phase === 'ready'
              ? `更新 v${updateState.version}`
              : updateState.phase === 'installing'
                ? '正在更新…'
                : updateState.phase === 'external'
                  ? `新版 v${updateState.version}`
                  : phaseLabel;
    const updateBusy =
        updateState.phase === 'checking' ||
        updateState.phase === 'available' ||
        updateState.phase === 'downloading' ||
        updateState.phase === 'installing';
    const runUpdateAction = () => {
        if (updateState.phase === 'ready') {
            void restartAndInstallUpdate();
        } else if (updateState.phase === 'external') {
            void openLatestRelease();
        } else {
            void checkForUpdates(false);
        }
    };

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
                {updateState.phase === 'downloading' ||
                updateState.phase === 'installing' ? (
                    <Orb size={12} variant='sweep' style={{ color: 'var(--amber, #e0a43c)' }} />
                ) : updateState.phase === 'ready' ? (
                    <Download size={11} />
                ) : updateState.phase === 'external' ? (
                    <ExternalLink size={11} />
                ) : phase === 'starting' || phase === 'connecting' ? (
                    <Orb size={12} variant='ring' style={{ color: 'var(--amber, #e0a43c)' }} />
                ) : (
                    <span
                        className={styles.led[phase === 'ok' ? 'live' : 'down']}
                    />
                )}
                {updateNeedsAttention ? updateHeaderLabel : phaseLabel}
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
                                // 塞不下時讓版本「整塊」掉到下一行，而不是
                                // 兩邊各自在字中間斷行（狀/態 被拆開的排版災難)
                                flexWrap: 'wrap',
                                columnGap: '0.5rem',
                            }}
                        >
                            <span style={{ whiteSpace: 'nowrap' }}>
                                Shioaji Server 狀態
                            </span>
                            {(serverVersion || ver) && (
                                <span
                                    style={{
                                        fontFamily: 'var(--font-mono, monospace)',
                                        opacity: 0.75,
                                        fontWeight: 400,
                                        whiteSpace: 'nowrap',
                                        marginLeft: 'auto',
                                    }}
                                >
                                    {serverVersion
                                        ? `Server v${serverVersion}`
                                        : 'Server —'}
                                    {ver && ` · App v${ver}`}
                                </span>
                            )}
                        </span>
                        {serverVersionMismatch && (
                            <span
                                className={styles.emptyHint}
                                style={{ color: 'var(--amber, #e0a43c)' }}
                            >
                                ⚠ Server v{serverVersion} 與本版要求 v
                                {EXPECTED_SERVER_VERSION} 不符
                            </span>
                        )}
                        <div className={styles.srvPhaseRow}>
                            {phase === 'starting' ||
                            phase === 'connecting' ? (
                                <Orb size={12} variant='ring' style={{ color: 'var(--amber, #e0a43c)' }} />
                            ) : (
                                <span
                                    className={
                                        styles.led[
                                            phase === 'ok' ? 'live' : 'down'
                                        ]
                                    }
                                />
                            )}
                            {phase === 'starting'
                                ? '啟動中 — 登入與載入合約約需 10–30 秒'
                                : phase === 'connecting'
                                  ? status?.running
                                      ? '已啟動，等待行情連線'
                                      : '連線中'
                                  : status?.running
                                    ? '運行中'
                                    : '未運行'}
                        </div>
                        {status?.running && (
                            <div className={styles.srvChipRow}>
                                {status.pid !== undefined && (
                                    <span className={styles.srvChip}>
                                        PID {status.pid}
                                    </span>
                                )}
                                <span className={styles.srvChip}>
                                    :{status.port}
                                </span>
                                <span
                                    className={styles.srvChip}
                                    style={
                                        status.simulation
                                            ? {
                                                  color: 'var(--amber, #e0a43c)',
                                              }
                                            : {
                                                  color: 'var(--danger, #f23645)',
                                                  fontWeight: 700,
                                              }
                                    }
                                >
                                    {status.simulation ? '模擬' : '⚠ 正式'}
                                </span>
                                {status.healthy === false && (
                                    <span
                                        className={styles.srvChip}
                                        style={{
                                            color: 'var(--danger, #f23645)',
                                        }}
                                    >
                                        不健康
                                    </span>
                                )}
                                {health &&
                                    typeof health.token_expires_in_seconds ===
                                        'number' && (
                                        <span className={styles.srvChip}>
                                            token{' '}
                                            {fmtTokenRemaining(
                                                health.token_expires_in_seconds,
                                            )}
                                        </span>
                                    )}
                                {health &&
                                    typeof health.ca_expires_in_days ===
                                        'number' && (
                                        <span
                                            className={styles.srvChip}
                                            style={
                                                health.ca_expired
                                                    ? {
                                                          color: 'var(--danger, #f23645)',
                                                      }
                                                    : undefined
                                            }
                                        >
                                            CA{' '}
                                            {health.ca_expired
                                                ? '已過期'
                                                : `${health.ca_expires_in_days}d`}
                                        </span>
                                    )}
                            </div>
                        )}
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
                        <div className={styles.settingGroup}>
                            <button
                                className={styles.opt.off}
                                disabled={busy}
                                onClick={() => doStart()}
                            >
                                <Play size={11} style={{ verticalAlign: '-1px' }} />{' '}
                                啟動
                            </button>
                            <button
                                className={styles.opt.off}
                                disabled={busy}
                                onClick={() => doRestart()}
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

                        <div className={styles.switchRow}>
                            <span className={styles.switchLabel}>
                                <Lock size={12} />
                                本機 HTTPS
                                {settings.httpsEnabled &&
                                    status?.running &&
                                    status.scheme === 'http' && (
                                        <span
                                            style={{
                                                color: 'var(--amber, #e0a43c)',
                                            }}
                                        >
                                            （待重啟套用）
                                        </span>
                                    )}
                            </span>
                            <button
                                className={
                                    styles.switchTrack[
                                        settings.httpsEnabled ? 'on' : 'off'
                                    ]
                                }
                                disabled={busy || httpsBusy}
                                title={
                                    settings.httpsEnabled
                                        ? '停用並改回 HTTP'
                                        : '一鍵產生並信任本機憑證，以 HTTPS＋HTTP/2 連本機伺服器'
                                }
                                onClick={() =>
                                    void (settings.httpsEnabled
                                        ? disableHttps()
                                        : enableHttps())
                                }
                            />
                        </div>
                        {httpsBusy && (
                            <span className={styles.emptyHint}>
                                正在產生憑證…（系統若跳出信任視窗請允許）
                            </span>
                        )}
                        {settings.httpsEnabled && !httpsBusy && (
                            <span className={styles.emptyHint}>
                                🔒 瀏覽器可直接開 https://localhost:
                                {status?.port ?? 21322}
                            </span>
                        )}
                        {httpsMsg && (
                            <span
                                className={styles.emptyHint}
                                style={{ color: 'var(--danger, #f23645)' }}
                            >
                                {httpsMsg}
                            </span>
                        )}
                        <div className={styles.switchRow}>
                            <span className={styles.switchLabel}>
                                App 啟動時自動啟動伺服器
                            </span>
                            <button
                                className={
                                    styles.switchTrack[
                                        settings.autoStart ? 'on' : 'off'
                                    ]
                                }
                                onClick={() =>
                                    persist({
                                        autoStart: !settings.autoStart,
                                    })
                                }
                            />
                        </div>
                        {!settings.apiKey && (
                            <span
                                className={styles.emptyHint}
                                style={{ color: 'var(--amber, #e0a43c)' }}
                            >
                                尚未設定 API 金鑰 — 請開啟設定完成初始化
                            </span>
                        )}
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
                        {updateNeedsAttention && (
                            <button
                                className={styles.updateBtn}
                                onClick={runUpdateAction}
                                disabled={updateBusy}
                            >
                                {updateState.phase === 'ready' ? (
                                    <RotateCcw size={13} />
                                ) : updateState.phase === 'external' ? (
                                    <ExternalLink size={13} />
                                ) : (
                                    <Download size={13} />
                                )}
                                {updateState.phase === 'ready'
                                    ? `重新啟動並更新 v${updateState.version}`
                                    : updateState.phase === 'external'
                                      ? `前往下載 v${updateState.version}`
                                      : updateState.phase === 'installing'
                                        ? '正在安裝更新…'
                                        : `下載中${
                                              updatePercent === undefined
                                                  ? '…'
                                                  : ` ${updatePercent}%`
                                          }`}
                            </button>
                        )}
                        <div className={styles.settingGroup}>
                            <button
                                className={styles.opt.off}
                                onClick={() => void copyDiagnostics()}
                            >
                                <Clipboard
                                    size={11}
                                    style={{ verticalAlign: '-1px' }}
                                />{' '}
                                複製診斷
                            </button>
                            <button
                                className={styles.opt.off}
                                disabled={updateBusy}
                                onClick={runUpdateAction}
                            >
                                {updateState.phase !== 'checking' && (
                                    <>
                                        <RefreshCw
                                            size={11}
                                            style={{
                                                verticalAlign: '-1px',
                                            }}
                                        />{' '}
                                    </>
                                )}
                                {updateState.phase === 'checking' ? (
                                    <>
                                        <Orb
                                            size={10}
                                            variant='ring'
                                            style={{
                                                marginRight: 5,
                                                verticalAlign: '-1px',
                                            }}
                                        />
                                        檢查中…
                                    </>
                                ) : (
                                    '檢查更新'
                                )}
                            </button>
                        </div>
                        <button
                            className={styles.updateBtn}
                            onClick={() => setSettingsOpen(true)}
                        >
                            <Settings size={13} />
                            完整設定…
                        </button>
                    </div>
                    {settingsOpen && (
                        <>
                            <div
                                className={styles.srvDialogBackdrop}
                                onClick={() => setSettingsOpen(false)}
                            />
                            <div className={styles.srvDialog}>
                                <div className={styles.srvDialogTitle}>
                                    伺服器設定
                                    <button
                                        className={styles.profileDelete}
                                        title='關閉（Esc）'
                                        onClick={() => setSettingsOpen(false)}
                                    >
                                        <X size={12} />
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
                        <button className={styles.updateBtn} onClick={importEnv}>
                            <FileUp size={13} />
                            選資料夾自動讀取 .env
                        </button>
                        {envMsg && (
                            <span
                                className={styles.emptyHint}
                                style={{ color: 'var(--danger, #f23645)' }}
                            >
                                {envMsg}
                            </span>
                        )}
                        <div className={styles.srvSection}>
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
                        </div>
                        <div className={styles.srvSection}>
                            <span className={styles.settingLabel}>進階</span>
                        <button
                            className={styles.updateBtn}
                            onClick={runUpdateAction}
                            disabled={updateBusy}
                        >
                            {updateState.phase === 'ready' ? (
                                <RotateCcw size={13} />
                            ) : updateState.phase === 'external' ? (
                                <ExternalLink size={13} />
                            ) : updateState.phase === 'downloading' ? (
                                <Download size={13} />
                            ) : (
                                <RefreshCw size={13} />
                            )}
                            {updateState.phase === 'checking'
                                ? '正在檢查更新…'
                                : updateState.phase === 'available'
                                  ? `找到 v${updateState.version}`
                                  : updateState.phase === 'downloading'
                                    ? `下載 v${updateState.version}${
                                          updatePercent === undefined
                                              ? '…'
                                              : ` · ${updatePercent}%`
                                      }`
                                    : updateState.phase === 'ready'
                                      ? `重新啟動並更新 v${updateState.version}`
                                      : updateState.phase === 'installing'
                                        ? '正在安裝更新…'
                                        : updateState.phase === 'external'
                                          ? `前往下載 v${updateState.version}`
                                          : updateState.phase === 'error'
                                            ? '重試檢查更新'
                                            : '檢查 App 更新'}
                        </button>
                        {updateState.phase === 'downloading' && (
                            <span className={styles.emptyHint}>
                                更新會在背景下載，完成後再由你決定何時重新啟動。
                            </span>
                        )}
                        {updateState.phase === 'ready' && (
                            <span className={styles.emptyHint}>
                                已下載完成；按上方按鈕後才會安裝並重新啟動 App。
                            </span>
                        )}
                        {updateState.phase === 'external' && (
                            <span className={styles.emptyHint}>
                                RPM／DEB 安裝版不會在 App 內要求系統權限，請下載新版套件或由套件管理器更新。
                            </span>
                        )}
                        {updateState.phase === 'error' && updateState.error && (
                            <span
                                className={styles.emptyHint}
                                style={{ color: 'var(--danger, #f23645)' }}
                            >
                                更新失敗：{updateState.error}
                            </span>
                        )}
                        <button
                            className={styles.updateBtn}
                            onClick={() => void copyDiagnostics()}
                        >
                            <Clipboard size={13} />
                            複製診斷資訊
                        </button>
                        </div>
                        <div className={styles.srvDanger}>
                            <span
                                className={styles.settingLabel}
                                style={{ color: 'var(--danger, #f23645)' }}
                            >
                                危險區
                            </span>
                        <button
                            className={
                                confirmLogout
                                    ? styles.killBtnOn
                                    : styles.killBtnOff
                            }
                            onClick={doLogout}
                        >
                            <LogOut size={13} />
                            {confirmLogout ? '再按一次確認登出' : '登出（清除 API 金鑰）'}
                        </button>
                        </div>
                            </div>
                        </>
                    )}
                </>
            )}
        </div>
    );
}
