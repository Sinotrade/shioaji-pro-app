import { Bot, ChevronDown, KeyRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { registerOnboardingAppStateHost } from '../lib/agent-app-command';
import { agentModule } from '../lib/features';
import { validateDesktopSettings } from '../lib/server-diagnostics';
import { isTauri, loadDesktopSettings, saveCredentialProfile, selectCredentialProfile, deleteCredentialProfile, logoutCredentialProfile, serverStop, serverStart, reloadWhenHealthy, openServerLogFolder, EMPTY_DESKTOP_SETTINGS, type CredentialDraft, type DesktopSettings } from '../lib/tauri';
import { classifyServerStart, type ServerStartError } from '../lib/server-start-error';
import { ServerStartErrorPanel } from './server-start-error-panel';
import { clearStoredSpawnKeyHash } from '../lib/spawn-keys';
import { FeatureGate } from './feature-gate';
import { CredentialProfiles } from './credential-profiles';
import { timedOnboarding } from '../lib/server-actions';
import { closeApplyWindow } from '../lib/apply-guide-native';
import { ApplyGuide, useApplyGuide } from './apply-guide';
import * as styles from './onboarding-setup.css';
import * as dialog from './server-settings-dialog.css';

const AGENT_STARTER_PROMPT = '我是第一次使用，還沒有永豐 Shioaji API Key，可以引導我怎麼申請嗎？';
export function OnboardingSetup() {
    const [settings, setSettings] = useState<DesktopSettings>(EMPTY_DESKTOP_SETTINGS);
    const [busy, setBusy] = useState(false);
    const [error, setErrorText] = useState('');
    // a failed start, explained by kind (replaces the plain error text)
    const [startError, setStartError] = useState<{ error: ServerStartError; logPath?: string } | null>(null);
    const setError = (text: string) => { setErrorText(text); setStartError(null); };
    const [loaded, setLoaded] = useState(false);
    const [confirmLogout, setConfirmLogout] = useState(false);
    const logoutInFlight = useRef(false);
    // 首次設定預設走申請導覽；已有帳號（或待遷移）時直接顯示帳號設定
    const [mode, setMode] = useState<'guide' | 'manual'>('guide');
    // AI 助理預設展開；申請視窗開著時改放在導覽下方（右側會被申請視窗蓋住）
    const [agentOpen, setAgentOpen] = useState(true);
    const refresh = () => { loadDesktopSettings().then(setSettings).catch(() => undefined); };
    const guide = useApplyGuide(refresh);
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
        loadDesktopSettings().then(value => {
            if (!active) return;
            setSettings(value); setLoaded(true);
            if (value.profiles.length > 0 || value.migrationError) setMode('manual');
        }).catch(() => { if (active) setError('無法讀取本機設定，請重新開啟 App 後重試。'); });
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
        void closeApplyWindow();
        try {
            const result = await timedOnboarding({ save: async () => {}, start: () => serverStart(target), reloadWhenHealthy });
            if (!result.ok) {
                if (result.error) { setErrorText(''); setStartError({ error: result.error, logPath: result.logPath }); }
                else setError('伺服器啟動失敗，請確認帳號設定、網路與憑證後重試。');
                setBusy(false);
            }
        } catch (e) {
            setStartError({ error: classifyServerStart({ output: e instanceof Error ? e.message : String(e), port: 0 }) });
            setErrorText(''); setBusy(false);
        }
    };
    const start = async () => {
        if (logoutInFlight.current) throw new Error('正在登出，請等待完成。');
        await launch(settings);
    };
    // 申請導覽載入的 .env：選成使用中的帳號後啟動（模擬環境）
    const startImported = async (profileId: string) => {
        if (logoutInFlight.current) return;
        setBusy(true); setError('');
        let next: DesktopSettings;
        try {
            next = await loadDesktopSettings();
            // 導覽只啟動模擬環境：匯入後被改成正式環境（或已刪除）就不啟動
            const target = next.profiles.find(profile => profile.id === profileId);
            if (!target) throw new Error('找不到剛載入的帳號，請到帳號設定確認。');
            if (target.environment !== 'simulation') {
                setSettings(next);
                throw new Error(`「${target.name}」已改成正式環境，導覽只會啟動模擬環境。請到帳號設定確認環境與 CA 憑證後再啟動。`);
            }
            if (next.activeProfileId !== profileId) {
                await stopForChange();
                next = await selectCredentialProfile(profileId);
            }
            setSettings(next);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setBusy(false);
            return;
        }
        setBusy(false);
        await launch(next);
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
    const guiding = mode === 'guide' && loaded;
    // 申請視窗蓋住主視窗右側時導覽貼齊左側、AI 助理移到導覽下方；
    // 申請視窗放在主視窗旁邊（寬螢幕）時維持置中
    const docked = guiding && guide.step !== 'start' && guide.windowState === 'open' && guide.placement === 'overlay';
    const showAgent = !!AgentPanel && agentOpen && !docked;
    const agentInColumn = !!AgentPanel && agentOpen && docked;
    const agentPanel = AgentPanel && <FeatureGate feature='agent'>
        <AgentPanel
            onboarding
            initialPrompt={AGENT_STARTER_PROMPT}
            visibleTabs={['chat', 'settings']}
        />
    </FeatureGate>;
    const errors = <>
        {error && <p className={styles.errorText} role="alert">{error}</p>}
        {startError && <ServerStartErrorPanel error={startError.error} logPath={startError.logPath} onOpenLogFolder={isTauri ? openServerLogFolder : undefined} />}
    </>;
    return (<div className={docked ? styles.shellDocked : styles.shell}><div className={docked ? styles.layoutDocked : styles.layout}>
        {guiding ? <div className={styles.guideColumn}>
            <ApplyGuide guide={guide} settings={settings} busy={busy}
                agentAvailable={!!AgentPanel}
                agentOpen={agentOpen}
                onToggleAgent={() => setAgentOpen(open => !open)}
                onManual={() => setMode('manual')}
                onStart={startImported} />
            {(error || startError) && <div className={styles.guideErrors}>{errors}</div>}
            {agentInColumn && <div className={styles.agentCardDocked}>
                <div className={styles.agentHeader}>
                    <Bot size={14} />
                    AI 助理 — 引導申請 API Key
                    <span className={styles.agentHeaderSpacer} />
                    <button className={dialog.smallButton} onClick={() => setAgentOpen(false)}><ChevronDown size={14} />收合</button>
                </div>
                <div className={styles.agentBody}>{agentPanel}</div>
            </div>}
        </div> : <div className={styles.card}>
            <div><div className={styles.logo}>Shioaji Pro</div><div className={styles.subtitle}>設定或選擇帳號以啟動交易伺服器</div></div>
            {errors}
            {loaded && <CredentialProfiles settings={settings} busy={busy} running={false} onSave={save} onAction={action} onImported={setSettings} onStart={start} onBusyChange={setBusy} />}
            {loaded && settings.migrationError && <div className={styles.logoutBox}>
                <p className={styles.hint}>無法轉移時可以登出重來：會停止本 App 的 Agent 與伺服器，並清除舊金鑰、CA 密碼與使用中帳號的金鑰。</p>
                <div className={styles.logoutActions}>
                    {confirmLogout && <button className={dialog.smallButton} disabled={busy} onClick={() => setConfirmLogout(false)}>取消</button>}
                    <button className={confirmLogout ? dialog.confirmDanger : dialog.smallButton} disabled={busy} onClick={() => void logout()}>{confirmLogout ? '確認登出並清除' : '登出並清除'}</button>
                </div>
            </div>}
            {busy && <p className={styles.hint}>啟動中 — 登入與載入合約約需 10–30 秒…</p>}
            <p className={styles.hint}>金鑰只存在這台電腦的系統憑證庫。</p>
            <button className={styles.guideLink} onClick={() => setMode('guide')}><KeyRound size={14} />還沒有 API Key？跟著導覽申請</button>
        </div>}
                {showAgent && AgentPanel && (
                    <div className={styles.agentCard}>
                        <div className={styles.agentHeader}>
                            <Bot size={14} />
                            AI 助理 — 引導申請 API Key
                        </div>
                        <div className={styles.agentBody}>{agentPanel}</div>
                    </div>
                )}
            </div>
        </div>
    );
}
