// src/components/onboarding-setup.tsx — first-run gate: shown instead of
// the dashboard when no API key has been saved yet, so a fresh install
// never lands on a dashboard that only *looks* empty-but-fine while the
// server was never even asked to start (see App.tsx's AppGate).

import { Bot, Eye, EyeOff, FileUp, KeyRound } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { registerOnboardingAppStateHost } from '../lib/agent-app-command';
import { agentModule } from '../lib/features';
import {
    diagnoseOutput,
    errorLines,
    validateDesktopSettings,
} from '../lib/server-diagnostics';
import {
    pickCaFile,
    isTauri,
    pickEnvFile,
    importEnvCandidate,
    reloadWhenHealthy,
    saveDesktopSettings,
    serverStart,
    type DesktopSettings,
    type EnvImportResult,
    type EnvSelection,
} from '../lib/tauri';
import { timedOnboarding } from '../lib/server-actions';
import { FeatureGate } from './feature-gate';
import * as headerStyles from './hud-header.css';
import * as styles from './onboarding-setup.css';

// DEV-only account/password login: its own chunk, dropped from packaged builds
// (the ternary folds to null there), which keep the upstream screen below
const DevLogin = import.meta.env.DEV ? lazy(() => import('./onboarding/dev-login')) : null;

// first message pre-filled (not auto-sent) into the agent's composer so the
// user just has to hit send — invokes the 申請永豐 API Key builtin skill
const AGENT_STARTER_PROMPT =
    '我是第一次使用，還沒有永豐 Shioaji API Key，可以引導我怎麼申請嗎？';

const EMPTY: DesktopSettings = {
    apiKey: '',
    secretKey: '',
    production: false,
    autoStart: true,
    caPath: '',
    caPasswd: '',
    httpsEnabled: false,
    agentHarnessEnabled: true,
};

export function OnboardingSetup() {
    useEffect(() => {
        if (!isTauri) return;
        return registerOnboardingAppStateHost(window);
    }, []);
    const [settings, setSettings] = useState<DesktopSettings>(EMPTY);
    const [showKey, setShowKey] = useState(false);
    const [showSecret, setShowSecret] = useState(false);
    const [showCaPw, setShowCaPw] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    // 匯入結果顯示在匯入按鈕下方（錯誤不放到最下面的啟動錯誤區）
    const [importMessage, setImportMessage] = useState<{ text: string; error: boolean } | null>(null);
    const [importPending, setImportPending] = useState(false);
    const [envSelection, setEnvSelection] = useState<EnvSelection | null>(null);
    // DEV login tabs only (see DevLogin); the packaged screen has no tabs
    const [mode, setMode] = useState<'account' | 'apikey'>('account');

    const patch = (next: Partial<DesktopSettings>) =>
        setSettings((s) => ({ ...s, ...next }));

    // 對話框取消（null）時畫面保持原狀；有結果才清掉上一次的訊息與候選清單
    const handleEnvResult = (found: EnvImportResult | null, newPick: boolean) => {
        if (!found) return;
        setError('');
        setImportMessage(null);
        if (newPick) setEnvSelection(null);
        if (found.kind === 'choose') {
            setEnvSelection(found.selection);
        } else if (found.kind === 'error') {
            setImportMessage({ text: found.error, error: true });
        } else {
            patch({ ...(found.apiKey !== undefined ? { apiKey: found.apiKey } : {}),
                ...(found.secretKey !== undefined ? { secretKey: found.secretKey } : {}) });
            setEnvSelection(null);
            setImportMessage({ text: `已從 ${found.fileName} 匯入`, error: false });
        }
    };

    // candidate: a file name from the folder's candidate list (envSelection)
    const importEnv = async (mode: 'file' | 'directory', candidate?: string) => {
        setImportPending(true);
        try {
            handleEnvResult(candidate && envSelection
                ? await importEnvCandidate(envSelection, candidate)
                : await pickEnvFile(mode), !candidate);
        } catch {
            setImportMessage({ text: '無法匯入 .env 檔案。', error: true });
        } finally {
            setImportPending(false);
        }
    };

    // true once the server is up (reloadWhenHealthy takes over), false when it failed and the error is shown
    const submit = async (s = settings): Promise<boolean> => {
        const err = validateDesktopSettings(s);
        if (err) {
            setError(err.body);
            return false;
        }
        setError('');
        setBusy(true);
        try {
            // stay busy on success — reloadWhenHealthy takes over and
            // reloads the page once /health answers, which re-runs boot.ts
            const res = await timedOnboarding({
                save: () => saveDesktopSettings(s),
                start: () => serverStart(s),
                reloadWhenHealthy: () => reloadWhenHealthy(),
            });
            if (!res.ok) {
                setError(
                    diagnoseOutput(res.output) ||
                        errorLines(res.output) ||
                        res.output.slice(-160) ||
                        '伺服器啟動失敗',
                );
                setBusy(false);
                return false;
            }
            return true;
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setBusy(false);
            return false;
        }
    };

    // rejecting keeps the wizard's one-time secret (and its retry) on screen
    const startWithKeys = async (
        keys: Pick<DesktopSettings, 'apiKey' | 'secretKey'> | null,
        { saveFailed }: { saveFailed: boolean },
    ) => {
        if (busy) throw new Error('BUSY');
        // plain-browser dev: no sidecar to start; the dev server wrote .env unless saving failed
        if (!isTauri) {
            if (!saveFailed) {
                window.location.assign(window.location.pathname);
                return;
            }
            // .env was not written: carry the keys over so 啟動 can be pressed by hand
            if (keys) {
                patch(keys);
                switchToApiKey();
            }
            return;
        }
        if (!keys) throw new Error('KEYS_UNAVAILABLE');
        const next = { ...settings, ...keys };
        setSettings(next);
        if (!(await submit(next))) {
            switchToApiKey(); // the error is shown under the API Key form
            throw new Error('START_FAILED');
        }
    };

    // the clicked button ends up in the hidden pane, so hand focus to the tab
    const switchToApiKey = () => {
        setMode('apikey');
        globalThis.document?.getElementById('login-tab-apikey')?.focus();
    };

    const AgentPanel = agentModule?.Panel;
    // codex (ChatGPT 訂閱) 比 Anthropic/OpenAI API key 更多人已經有，設成
    // 首次啟動的預設，才不會「為了申請一把 key 又要先申請另一把 key」；
    // 只在使用者從未手動選過 provider 時生效，且必須在 AgentPanel 掛載前
    // （render 階段，不用 useEffect）跑完，否則面板第一次渲染就讀到舊預設
    agentModule?.ensureDefaultProvider('codex');

    const form = (
                    <>
                    <div className={styles.importRow}>
                        <button className={styles.importBtn} type='button' disabled={busy || importPending} onClick={() => void importEnv('file')}><FileUp size={13} />選擇 .env 檔案</button>
                        <button className={styles.importBtn} type='button' disabled={busy || importPending} onClick={() => void importEnv('directory')}>選擇資料夾</button>
                    </div>
                    <span className={styles.hint}>支援 name.env、.env、.env.local；隱藏檔請選資料夾。</span>
                    {envSelection && <div className={styles.fieldGroup}>
                        <span className={styles.hint}>{`資料夾裡有 ${envSelection.candidates.length} 個 .env 檔案，選一個匯入：`}</span>
                        <div className={styles.importRow}>
                            {envSelection.candidates.map(name => <button key={name} className={styles.importChoice} type='button' disabled={busy || importPending} onClick={() => void importEnv('directory', name)}>{name}</button>)}
                        </div>
                    </div>}
                    {importMessage && <span className={styles.importMessage[importMessage.error ? 'error' : 'ok']} role={importMessage.error ? 'alert' : 'status'}>{importMessage.text}</span>}

                    <div className={styles.fieldGroup}>
                        <span className={styles.label}>API KEY</span>
                        <div className={styles.inputRow}>
                            <input
                                className={styles.input}
                                type={showKey ? 'text' : 'password'}
                                autoFocus
                                spellCheck={false}
                                placeholder='SJ_API_KEY'
                                value={settings.apiKey}
                                disabled={busy}
                                onChange={(e) =>
                                    patch({ apiKey: e.target.value })
                                }
                            />
                            <button
                                className={styles.eyeBtn}
                                type='button'
                                onClick={() => setShowKey((v) => !v)}
                            >
                                {showKey ? (
                                    <EyeOff size={14} />
                                ) : (
                                    <Eye size={14} />
                                )}
                            </button>
                        </div>
                    </div>

                    <div className={styles.fieldGroup}>
                        <span className={styles.label}>SECRET KEY</span>
                        <div className={styles.inputRow}>
                            <input
                                className={styles.input}
                                type={showSecret ? 'text' : 'password'}
                                spellCheck={false}
                                placeholder='SJ_SEC_KEY'
                                value={settings.secretKey}
                                disabled={busy}
                                onChange={(e) =>
                                    patch({ secretKey: e.target.value })
                                }
                            />
                            <button
                                className={styles.eyeBtn}
                                type='button'
                                onClick={() => setShowSecret((v) => !v)}
                            >
                                {showSecret ? (
                                    <EyeOff size={14} />
                                ) : (
                                    <Eye size={14} />
                                )}
                            </button>
                        </div>
                    </div>

                    <div className={styles.fieldGroup}>
                        <span className={styles.label}>環境</span>
                        <div className={styles.modeRow}>
                            <button
                                className={
                                    styles.modeBtn[
                                        !settings.production
                                            ? 'sim'
                                            : 'normal'
                                    ]
                                }
                                disabled={busy}
                                onClick={() => patch({ production: false })}
                            >
                                模擬環境
                            </button>
                            <button
                                className={
                                    styles.modeBtn[
                                        settings.production
                                            ? 'prod'
                                            : 'normal'
                                    ]
                                }
                                disabled={busy}
                                onClick={() => patch({ production: true })}
                            >
                                正式環境
                            </button>
                        </div>
                        {settings.production && (
                            <span className={styles.prodWarn}>
                                正式環境下單動用真實資金，且需要 Sinopac.pfx
                                憑證
                            </span>
                        )}
                    </div>

                    {settings.production && (
                        <div className={styles.fieldGroup}>
                            <span className={styles.label}>憑證</span>
                            <div className={styles.caRow}>
                                <button
                                    className={styles.caPickBtn}
                                    disabled={busy}
                                    onClick={async () => {
                                        const path = await pickCaFile();
                                        if (path) patch({ caPath: path });
                                    }}
                                >
                                    {settings.caPath
                                        ? settings.caPath
                                              .split(/[/\\]/)
                                              .pop()
                                        : '選擇 Sinopac.pfx…'}
                                </button>
                            </div>
                            {settings.caPath && (
                                <div className={styles.inputRow}>
                                    <input
                                        className={styles.input}
                                        type={showCaPw ? 'text' : 'password'}
                                        placeholder='憑證密碼（下載時設定）'
                                        value={settings.caPasswd}
                                        disabled={busy}
                                        onChange={(e) =>
                                            patch({
                                                caPasswd: e.target.value,
                                            })
                                        }
                                    />
                                    <button
                                        className={styles.eyeBtn}
                                        type='button'
                                        onClick={() =>
                                            setShowCaPw((v) => !v)
                                        }
                                    >
                                        {showCaPw ? (
                                            <EyeOff size={14} />
                                        ) : (
                                            <Eye size={14} />
                                        )}
                                    </button>
                                </div>
                            )}
                        </div>
                    )}

                    {error && (
                        <span className={styles.errorText}>{error}</span>
                    )}

                    {busy ? (
                        <>
                            <span className={styles.hint}>
                                啟動中 — 登入與載入合約約需 10–30 秒…
                            </span>
                            <span className={headerStyles.progressTrack}>
                                <span
                                    className={headerStyles.progressGlider}
                                />
                            </span>
                        </>
                    ) : (
                        <button className={styles.submitBtn} disabled={importPending} onClick={() => void submit()}>
                            <KeyRound size={15} />
                            啟動並開始使用
                        </button>
                    )}

                    <span className={styles.hint}>
                        金鑰僅儲存在本機 App 資料夾，不會上傳。還沒有 API
                        Key？請至永豐 API
                        管理頁申請。稍後仍可從右上角「伺服器」面板調整。
                    </span>
                    </>
    );

    const agent = (
                    <>
                        <div className={styles.agentHeader}>
                            <Bot size={14} />
                            AI 助理 — 引導申請 API Key
                        </div>
                        <div className={styles.agentBody}>
                            <FeatureGate feature='agent'>
                                {AgentPanel && (
                                    <AgentPanel
                                        onboarding
                                        initialPrompt={AGENT_STARTER_PROMPT}
                                        visibleTabs={['chat', 'settings']}
                                    />
                                )}
                            </FeatureGate>
                        </div>
                    </>
    );

    // DevLogin is null in packaged builds; the env check also lets tests render the packaged screen
    if (DevLogin && import.meta.env.DEV) {
        return (
            <Suspense fallback={null}>
                <DevLogin
                    mode={mode}
                    setMode={setMode}
                    startWithKeys={startWithKeys}
                    switchToApiKey={switchToApiKey}
                    form={form}
                    agent={agent}
                />
            </Suspense>
        );
    }

    return (
        <div className={styles.shell}>
            <div className={styles.layout}>
                <div className={styles.card}>
                    <div>
                        <div className={styles.logo}>Shioaji Pro</div>
                        <div className={styles.subtitle}>
                            填入永豐 API 金鑰以啟動交易伺服器
                        </div>
                    </div>

                    {form}
                </div>

                {AgentPanel && (
                    <div className={styles.agentCard}>{agent}</div>
                )}
            </div>
        </div>
    );
}
