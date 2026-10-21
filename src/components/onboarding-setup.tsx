import { Bot } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { registerOnboardingAppStateHost } from '../lib/agent-app-command';
import { agentModule } from '../lib/features';
import { validateDesktopSettings } from '../lib/server-diagnostics';
import { isTauri, loadDesktopSettings, saveCredentialProfile, selectCredentialProfile, deleteCredentialProfile, logoutCredentialProfile, serverStop, serverStart, reloadWhenHealthy, EMPTY_DESKTOP_SETTINGS, type CredentialDraft, type DesktopSettings } from '../lib/tauri';
import { clearStoredSpawnKeyHash } from '../lib/spawn-keys';
import { FeatureGate } from './feature-gate';
import { CredentialProfiles } from './credential-profiles';
import { timedOnboarding } from '../lib/server-actions';
import * as styles from './onboarding-setup.css';
import * as dialog from './server-settings-dialog.css';

const AGENT_STARTER_PROMPT = '我是第一次使用，還沒有永豐 Shioaji API Key，可以引導我怎麼申請嗎？';
export function OnboardingSetup() {
    const [settings, setSettings] = useState<DesktopSettings>(EMPTY_DESKTOP_SETTINGS);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [loaded, setLoaded] = useState(false);
    const [confirmLogout, setConfirmLogout] = useState(false);
    const logoutInFlight = useRef(false);
    const stopForChange = async () => {
        const result = await serverStop({ stopAgents: true, ownedOnly: true });
        if (!result.ok) throw new Error(result.output || '無法停止伺服器，尚未變更帳號。');
    };
    const logout = async () => {
        if (busy || logoutInFlight.current) return;
        if (!confirmLogout) { setConfirmLogout(true); return; }
        logoutInFlight.current = true; setBusy(true); setError(''); setConfirmLogout(false);
        try {
            await stopForChange();
            setSettings(await logoutCredentialProfile());
            clearStoredSpawnKeyHash();
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { logoutInFlight.current = false; setBusy(false); }
    };
    useEffect(() => {
        let active = true;
        loadDesktopSettings().then(value => { if (active) { setSettings(value); setLoaded(true); } }).catch(() => { if (active) setError('無法讀取本機設定，請重新開啟 App 後重試。'); });
        const off = isTauri ? registerOnboardingAppStateHost(window) : undefined;
        return () => { active = false; off?.(); };
    }, []);
    const save = async (draft: CredentialDraft, apply: boolean) => {
        if (logoutInFlight.current) throw new Error('正在登出，請等待完成。');
        setBusy(true); setError('');
        let next: DesktopSettings;
        try {
            next = await saveCredentialProfile(draft);
            const id = draft.id ?? next.profiles.at(-1)?.id;
            setSettings(next);
            if (apply) {
                const target = next.profiles.find(profile => profile.id === id);
                const invalid = validateDesktopSettings({ ...next,
                    configured: target?.secretState === 'stored',
                    production: target?.environment === 'production',
                    caPath: target?.caPath ?? '',
                    hasCaPassword: target?.hasCaPassword ?? (id === next.activeProfileId && next.hasCaPassword),
                });
                if (invalid) throw new Error(invalid.body);
                await stopForChange();
                if (id && id !== next.activeProfileId) { next = await selectCredentialProfile(id); setSettings(next); }
            }
        } finally { setBusy(false); }
        if (apply) await launch(next);
        return next;
    };
    // 以目前使用中的帳號啟動；成功後等伺服器健康再重新載入
    const launch = async (target: DesktopSettings) => {
        const invalid = validateDesktopSettings(target);
        if (invalid) { setError(invalid.body); return; }
        setBusy(true); setError('');
        try {
            const result = await timedOnboarding({ save: async () => {}, start: () => serverStart(target), reloadWhenHealthy });
            if (!result.ok) { setError('伺服器啟動失敗，請確認帳號設定、網路與憑證後重試。'); setBusy(false); }
        } catch { setError('伺服器啟動失敗，請重試。'); setBusy(false); }
    };
    const start = async () => {
        if (logoutInFlight.current) throw new Error('正在登出，請等待完成。');
        await launch(settings);
    };
    const action = async (kind: 'select' | 'delete', id: string) => {
        if (logoutInFlight.current) throw new Error('正在登出，請等待完成。');
        setBusy(true);
        try {
            if (kind === 'select' || id === settings.activeProfileId) await stopForChange();
            const next = kind === 'select' ? await selectCredentialProfile(id) : await deleteCredentialProfile(id);
            setSettings(next); return next;
        } finally { setBusy(false); }
    };
    const AgentPanel = agentModule?.Panel;
    agentModule?.ensureDefaultProvider('codex');
    return (<div className={styles.shell}><div className={styles.layout}>
        <div className={styles.card}>
            <div><div className={styles.logo}>Shioaji Pro</div><div className={styles.subtitle}>設定或選擇帳號以啟動交易伺服器</div></div>
            {error && <p className={styles.errorText} role="alert">{error}</p>}
            {loaded && <CredentialProfiles settings={settings} busy={busy} running={false} onSave={save} onAction={action} onImported={setSettings} onStart={start} onBusyChange={setBusy} />}
            {loaded && settings.migrationError && <div className={styles.logoutBox}>
                <p className={styles.hint}>無法轉移時可以登出重來：會停止本 App 的 Agent 與伺服器，並清除舊金鑰、CA 密碼與使用中帳號的金鑰。</p>
                <div className={styles.logoutActions}>
                    {confirmLogout && <button className={dialog.smallButton} disabled={busy} onClick={() => setConfirmLogout(false)}>取消</button>}
                    <button className={confirmLogout ? dialog.confirmDanger : dialog.smallButton} disabled={busy} onClick={() => void logout()}>{confirmLogout ? '確認登出並清除' : '登出並清除'}</button>
                </div>
            </div>}
            {busy && <p className={styles.hint}>啟動中 — 登入與載入合約約需 10–30 秒…</p>}
            <p className={styles.hint}>金鑰只存在這台電腦的系統憑證庫。還沒有 API Key？可以請 AI 助理引導申請。</p>
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
                                    onboarding
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
