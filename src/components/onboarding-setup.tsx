// src/components/onboarding-setup.tsx — first-run gate: shown instead of
// the dashboard when no API key has been saved yet, so a fresh install
// never lands on a dashboard that only *looks* empty-but-fine while the
// server was never even asked to start (see App.tsx's AppGate).

import { Bot, Eye, EyeOff, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { agentModule } from '../lib/features';
import {
    diagnoseOutput,
    errorLines,
    validateDesktopSettings,
} from '../lib/server-diagnostics';
import {
    pickCaFile,
    reloadWhenHealthy,
    saveDesktopSettings,
    serverStart,
    type DesktopSettings,
} from '../lib/tauri';
import { FeatureGate } from './feature-gate';
import * as headerStyles from './hud-header.css';
import * as styles from './onboarding-setup.css';

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
};

export function OnboardingSetup() {
    const [settings, setSettings] = useState<DesktopSettings>(EMPTY);
    const [showKey, setShowKey] = useState(false);
    const [showSecret, setShowSecret] = useState(false);
    const [showCaPw, setShowCaPw] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const patch = (next: Partial<DesktopSettings>) =>
        setSettings((s) => ({ ...s, ...next }));

    const submit = async () => {
        const err = validateDesktopSettings(settings);
        if (err) {
            setError(err.body);
            return;
        }
        setError('');
        setBusy(true);
        try {
            await saveDesktopSettings(settings);
            const res = await serverStart(settings);
            if (!res.ok) {
                setError(
                    diagnoseOutput(res.output) ||
                        errorLines(res.output) ||
                        res.output.slice(-160) ||
                        '伺服器啟動失敗',
                );
                setBusy(false);
                return;
            }
            // stay busy — reloadWhenHealthy takes over and reloads the page
            // once /health answers, which re-runs boot.ts from scratch
            reloadWhenHealthy();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setBusy(false);
        }
    };

    const AgentPanel = agentModule?.Panel;
    // codex (ChatGPT 訂閱) 比 Anthropic/OpenAI API key 更多人已經有，設成
    // 首次啟動的預設，才不會「為了申請一把 key 又要先申請另一把 key」；
    // 只在使用者從未手動選過 provider 時生效，且必須在 AgentPanel 掛載前
    // （render 階段，不用 useEffect）跑完，否則面板第一次渲染就讀到舊預設
    agentModule?.ensureDefaultProvider('codex');

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
                        <button className={styles.submitBtn} onClick={submit}>
                            <KeyRound size={15} />
                            啟動並開始使用
                        </button>
                    )}

                    <span className={styles.hint}>
                        金鑰僅儲存在本機 App 資料夾，不會上傳。還沒有 API
                        Key？請至永豐 API
                        管理頁申請。稍後仍可從右上角「伺服器」面板調整。
                    </span>
                </div>

                {AgentPanel && (
                    <div className={styles.agentCard}>
                        <div className={styles.agentHeader}>
                            <Bot size={14} />
                            AI 助理 — 引導申請 API Key
                        </div>
                        <div className={styles.agentBody}>
                            <FeatureGate feature='agent'>
                                <AgentPanel
                                    initialPrompt={AGENT_STARTER_PROMPT}
                                    visibleTabs={['chat', 'settings']}
                                />
                            </FeatureGate>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
