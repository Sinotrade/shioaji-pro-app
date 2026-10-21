import { AlertTriangle, ArrowLeft, Check, CheckCircle2, Circle, CircleCheck, FileKey, FileUp, FolderOpen, KeyRound, Loader2, Pencil, Play, Plus, RotateCw, ShieldAlert, ShieldCheck, ShieldOff, Trash2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { importEnvCandidate, loadDesktopSettings, pickCaFile, pickEnvFile, type CredentialDraft, type CredentialProfile, type DesktopSettings, type EnvImportResult, type EnvSelection } from '../lib/tauri';
import * as s from './server-settings-dialog.css';

type Environment = CredentialDraft['environment'];
const emptyDraft = (): CredentialDraft => ({ name: '', environment: 'simulation', caPath: '', apiKey: '', secretKey: '', caPassword: '' });
const editDraft = (profile?: CredentialProfile): CredentialDraft => profile ? {
    id: profile.id, name: profile.name, environment: profile.environment, caPath: profile.caPath,
    apiKey: '', secretKey: '', caPassword: '',
} : emptyDraft();
const fileName = (path: string) => path.split(/[/\\]/).pop() ?? path;
const PROBLEM: Record<CredentialProfile['secretState'], string> = {
    stored: '',
    pending: '儲存未完成，請刪除後重新新增',
    pendingDelete: '刪除未完成，請再刪除一次',
    missing: '找不到金鑰，請刪除後重新新增',
    unavailable: '無法存取系統憑證庫',
};

function EnvBadge({ environment }: { environment: Environment }) {
    return environment === 'production' ? <span className={s.prodBadge}>正式</span> : <span className={s.simBadge}>模擬</span>;
}

function CaStatus({ profile }: { profile: CredentialProfile }) {
    if (profile.hasCA && profile.hasCaPassword === false) return <span className={s.metaWarn}><ShieldAlert size={13} />憑證缺密碼</span>;
    if (profile.hasCA) return <span className={s.metaOk}><ShieldCheck size={13} />已設定憑證</span>;
    if (profile.environment === 'production') return <span className={s.metaWarn}><ShieldAlert size={13} />未設定憑證，無法下單</span>;
    return <span className={s.metaItem}><ShieldOff size={13} />未設定憑證</span>;
}

function Callout({ tone, icon, title, children, actions }: { tone: 'danger' | 'warn'; icon: ReactNode; title?: string; children: ReactNode; actions?: ReactNode }) {
    return <div className={tone === 'danger' ? s.calloutDanger : s.calloutWarn} role="alert">
        <span className={s.calloutIcon}>{icon}</span>
        <div className={s.calloutBody}>
            {title && <p className={s.calloutTitle}>{title}</p>}
            <p className={s.calloutText}>{children}</p>
            {actions && <div className={s.calloutActions}>{actions}</div>}
        </div>
    </div>;
}

export function CredentialProfiles({ settings, busy, running, onSave, onAction, onImported, onStart, onBusyChange, onEditingChange }: {
    settings: DesktopSettings; busy: boolean; running: boolean;
    onSave: (draft: CredentialDraft, apply: boolean) => Promise<DesktopSettings>;
    onAction: (action: 'select' | 'delete', id: string) => Promise<DesktopSettings>;
    onImported: (settings: DesktopSettings) => void;
    // 首次設定畫面沒有頁首的啟動鈕：提供時列表下方顯示「啟動」，用使用中的帳號啟動
    onStart?: () => Promise<void>;
    onBusyChange?: (busy: boolean) => void;
    // 編輯中時讓外層收起其他設定區塊，畫面只留表單
    onEditingChange?: (editing: boolean) => void;
}) {
    const ids = useId();
    const migrating = !!settings.migrationError;
    const [draft, setDraft] = useState(() => editDraft(settings.profiles.find(p => p.id === settings.activeProfileId)));
    // 列表為主，新增或編輯時才展開表單；完全沒有帳號（首次設定）直接進新增
    const [editing, setEditingState] = useState(() => settings.profiles.length === 0 && !settings.migrationError);
    const setEditing = (next: boolean) => { setEditingState(next); onEditingChange?.(next); };
    const [pending, setPending] = useState(false);
    const [confirmation, setConfirmation] = useState('');
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const [selection, setSelection] = useState<EnvSelection | null>(null);
    const inFlight = useRef(false);
    const editingChange = useRef(onEditingChange); editingChange.current = onEditingChange;
    useEffect(() => { editingChange.current?.(editing); return () => editingChange.current?.(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    const locked = busy || pending;

    // 鍵盤焦點：列表與表單互換、確認列出現或收起時，按下的按鈕會被卸載，
    // 焦點掉到 body 後 Escape 就送不到 dialog。依 key 記住節點，渲染後把
    // 焦點移到對應位置；處理中（按鈕停用）時先等，結束後再移。
    const nodes = useRef(new Map<string, HTMLElement>());
    const focusTarget = useRef<{ key: string; fallback: string } | null>(null);
    const opener = useRef('add');
    const confirmOrigin = useRef('');
    const reg = (key: string) => (node: HTMLElement | null) => { if (node) nodes.current.set(key, node); else nodes.current.delete(key); };
    const focusAfterRender = (key: string, fallback = 'add') => { focusTarget.current = { key, fallback }; };
    useEffect(() => {
        const target = focusTarget.current;
        if (!target || locked) return;
        focusTarget.current = null;
        // 使用者已經把焦點移到別處就不搶
        const current = typeof document === 'undefined' ? null : document.activeElement;
        if (current && current !== document.body && current.isConnected) return;
        const usable = (node?: HTMLElement) => node && !(node as HTMLButtonElement).disabled ? node : undefined;
        (usable(nodes.current.get(target.key)) ?? usable(nodes.current.get(target.fallback)))?.focus();
    });

    const ask = (key: string, origin: string) => { confirmOrigin.current = origin; focusAfterRender('confirm-cancel', origin); setConfirmation(key); };
    const cancelConfirmation = () => { focusAfterRender(confirmOrigin.current); confirmOrigin.current = ''; setConfirmation(''); };
    const patch = (values: Partial<CredentialDraft>) => { setDraft(current => ({ ...current, ...values })); setConfirmation(''); setMessage(''); setError(''); };
    // 二次確認：第一次只展開確認列，第二次（確認鈕）才執行
    const confirm = (key: string, origin = key) => {
        if (confirmation === key) { focusAfterRender(confirmOrigin.current || origin); confirmOrigin.current = ''; setConfirmation(''); return true; }
        ask(key, origin); setError(''); setMessage(''); return false;
    };
    const operation = async (action: () => Promise<void>) => {
        if (inFlight.current || busy) return;
        inFlight.current = true; setPending(true); onBusyChange?.(true); setError(''); setMessage('');
        try { await action(); }
        catch (e) { setError(e instanceof Error ? e.message : typeof e === 'string' ? e : '操作未完成，請重試。'); }
        finally {
            // Clear even on partial success (e.g. saved, but restart failed).
            // No submitted secret remains in React state or a hidden input.
            inFlight.current = false; setPending(false); onBusyChange?.(false);
        }
    };
    const toList = (focusKey: string) => { setEditing(false); focusAfterRender(focusKey); };
    const save = (apply: boolean) => {
        if (!draft.name.trim()) { setError('請填入帳號名稱。'); return; }
        if (!draft.id && (!draft.apiKey || !draft.secretKey)) { setError('請填入 API Key 與 Secret Key。'); return; }
        if (!draft.id && !confirm(`save:${apply}`, apply ? 'save-apply' : 'save-only')) return;
        const profileId = draft.id;
        const input: CredentialDraft = { id: draft.id, name: draft.name, environment: draft.environment, caPath: draft.caPath,
            ...(draft.apiKey ? { apiKey: draft.apiKey } : {}), ...(draft.secretKey ? { secretKey: draft.secretKey } : {}),
            ...(draft.caPassword ? { caPassword: draft.caPassword } : {}),
        };
        // Clear the old object too: async event closures can outlive a render.
        // Only the write-only native payload holds values during the IPC.
        draft.apiKey = ''; draft.secretKey = ''; draft.caPassword = '';
        setDraft({ ...draft });
        void operation(async () => {
            // Blank fields preserve existing secrets; never preload secrets.
            let next: DesktopSettings;
            try { next = await onSave(input, apply); }
            finally { delete input.apiKey; delete input.secretKey; delete input.caPassword; }
            const profile = next.profiles.find(p => p.id === profileId) ?? next.profiles.at(-1);
            setDraft(editDraft(profile));
            toList(profile ? `edit:${profile.id}` : opener.current);
            setMessage(apply ? '帳號已儲存，正在等待伺服器連線。' : '帳號已儲存，下次啟動或重啟伺服器時套用。');
        });
    };
    const profileAction = (action: 'select' | 'delete', profile: CredentialProfile) => {
        if (!confirm(`${action}:${profile.id}`)) return;
        void operation(async () => {
            const next = await onAction(action, profile.id);
            setDraft(editDraft(next.profiles.find(p => p.id === next.activeProfileId)));
            focusAfterRender(action === 'select' ? `edit:${profile.id}` : 'add');
            setMessage(action === 'select' ? '已切換使用中的帳號，按「啟動」即可套用。' : '帳號已刪除，金鑰與憑證密碼已一併移除。');
        });
    };
    const handleImport = (found: EnvImportResult | null) => {
        if (!found) return;
        if (found.kind === 'choose') setSelection(found.selection);
        else if (found.kind === 'error') setError(found.error);
        else {
            onImported(found.settings);
            setDraft(editDraft(found.settings.profiles.find(p => p.id === found.profileId)));
            setSelection(null);
            toList(`edit:${found.profileId}`);
            setMessage(`已從 ${found.fileName} 匯入並儲存帳號。`);
        }
    };
    const importFile = (mode: 'file' | 'directory', candidate?: string) => {
        if (!candidate && !confirm(`import:${mode}`, `import-${mode}`)) return;
        void operation(async () => handleImport(candidate && selection
            ? await importEnvCandidate(selection, candidate, draft.environment)
            : await pickEnvFile(mode, draft.environment)));
    };
    const selectedProfile = settings.profiles.find(p => p.id === draft.id);
    const open = (next: CredentialDraft, from: string) => {
        opener.current = from; confirmOrigin.current = '';
        setDraft(next); setEditing(true); setConfirmation(''); setError(''); setMessage(''); setSelection(null);
        focusAfterRender('name');
    };
    const back = () => {
        confirmOrigin.current = '';
        setDraft(editDraft(settings.profiles.find(p => p.id === settings.activeProfileId)));
        setConfirmation(''); setError(''); setSelection(null);
        toList(opener.current);
    };

    const confirmButtons = (label: string, onConfirm: () => void, tone: 'danger' | 'primary', cancelLabel: string) => <div className={s.confirmButtons}>
        <button ref={reg('confirm-cancel')} className={s.smallButton} aria-label={cancelLabel} disabled={locked} onClick={cancelConfirmation}>取消</button>
        <button className={tone === 'danger' ? s.confirmDanger : s.confirmPrimary} disabled={locked} onClick={onConfirm}>{label}</button>
    </div>;

    const profiles = settings.profiles;
    const addButton = (className: string) => <button ref={reg('add')} className={className} disabled={locked || migrating} onClick={() => open(emptyDraft(), 'add')}><Plus size={16} />新增帳號</button>;
    const list = <section className={s.section} aria-labelledby={`${ids}-list`}>
        <div className={s.sectionHead}>
            <h3 id={`${ids}-list`} className={s.sectionTitle}><span className={s.heading}>帳號</span>{profiles.length > 1 && <span className={s.count}>{profiles.length} 組</span>}</h3>
            {profiles.length > 0 && addButton(s.button)}
        </div>
        {profiles.length ? <ul className={s.profileList}>
            {profiles.map(profile => {
                const active = profile.id === settings.activeProfileId;
                const problem = PROBLEM[profile.secretState] ?? '';
                const deleting = confirmation === `delete:${profile.id}`;
                const switching = confirmation === `select:${profile.id}`;
                const production = profile.environment === 'production';
                const itemClass = [s.profileItem, active && s.profileActive, problem && s.profileProblem].filter(Boolean).join(' ');
                return <li className={itemClass} key={profile.id} aria-current={active || undefined}>
                    <div className={s.profileRow}>
                        <span className={active ? s.profileMarkOn : s.profileMark} aria-hidden="true">{active ? <CircleCheck size={18} /> : <Circle size={18} />}</span>
                        <div className={s.profileMain}>
                            <div className={s.profileName}>
                                <span className={s.profileNameText} title={profile.name}>{profile.name}</span>
                                <EnvBadge environment={profile.environment} />
                                {active && <span className={s.activeTag}>使用中</span>}
                            </div>
                            <div className={s.profileMeta}>
                                <span className={s.metaItem} title="API Key"><KeyRound size={13} /><span className={s.mono}>{profile.apiKeyMasked}</span></span>
                                <span className={s.metaDot} aria-hidden="true" />
                                <CaStatus profile={profile} />
                            </div>
                            {problem && <div className={s.profileMeta}><span className={s.metaDanger}><AlertTriangle size={13} />{problem}</span></div>}
                        </div>
                        {!deleting && !switching && <div className={s.profileActions}>
                            {!active && <button ref={reg(`select:${profile.id}`)} className={s.smallButton} disabled={locked || profile.secretState !== 'stored'} onClick={() => profileAction('select', profile)}>切換使用</button>}
                            <button ref={reg(`edit:${profile.id}`)} className={s.smallIconButton} aria-label={`編輯 ${profile.name}`} title="編輯" disabled={locked || profile.secretState !== 'stored' || migrating} onClick={() => open(editDraft(profile), `edit:${profile.id}`)}><Pencil size={15} /></button>
                            <button ref={reg(`delete:${profile.id}`)} className={s.smallDangerIcon} aria-label={`刪除 ${profile.name}`} title="刪除" disabled={locked} onClick={() => profileAction('delete', profile)}><Trash2 size={15} /></button>
                        </div>}
                    </div>
                    {deleting && <div className={s.confirmStrip}>
                        <p className={s.confirmText}>刪除「{profile.name}」？金鑰與憑證密碼會從系統憑證庫移除，無法復原。{active && '會先停止伺服器與 Agent。'}</p>
                        {confirmButtons('確認刪除', () => profileAction('delete', profile), 'danger', '取消刪除')}
                    </div>}
                    {switching && <div className={s.confirmStrip}>
                        <p className={s.confirmText}>改用<span className={s.inlineBadge}><EnvBadge environment={profile.environment} /></span>「{profile.name}」？會先停止伺服器與 Agent，再按「啟動」套用。{production && '正式環境的委託會動用真實資金。'}</p>
                        {confirmButtons(production ? '確認切換到正式' : '確認切換', () => profileAction('select', profile), production ? 'danger' : 'primary', '取消切換')}
                    </div>}
                </li>;
            })}
        </ul> : null}
        {profiles.length > 0 && onStart && (() => {
            const activeProfile = profiles.find(p => p.id === settings.activeProfileId);
            const ready = activeProfile?.secretState === 'stored';
            return <div className={s.startBar}>
                <p className={s.startText}>{activeProfile
                    ? <>以<span className={s.inlineBadge}><EnvBadge environment={activeProfile.environment} /></span>「{activeProfile.name}」啟動伺服器{ready ? '' : '；這個帳號需要先修復'}</>
                    : '先選一個帳號，按「切換使用」後再啟動。'}</p>
                <button ref={reg('start')} className={s.primary} disabled={locked || !ready || !!confirmation} onClick={() => void operation(onStart)}><Play size={15} />啟動</button>
            </div>;
        })()}
        {profiles.length ? null : <div className={s.empty}>
            <span className={s.emptyIcon}><KeyRound size={20} /></span>
            <p className={s.emptyTitle}>還沒有帳號</p>
            <p className={s.hint}>新增永豐 API 金鑰後，就能啟動伺服器。</p>
            <div className={s.emptyAction}>{addButton(s.primary)}</div>
        </div>}
    </section>;

    const isNew = !draft.id;
    const firstRun = profiles.length === 0;
    const production = draft.environment === 'production';
    const confirmingSave = confirmation.startsWith('save:');
    const confirmingImport = confirmation.startsWith('import:');
    const importDirectory = confirmation === 'import:directory';
    const applyConfirm = confirmation === 'save:true';
    const editor = <fieldset className={s.fields} disabled={locked || migrating} aria-labelledby={`${ids}-editor`}>
        <div className={s.editorHead}>
            {!firstRun && <button className={s.iconButton} aria-label="返回帳號列表" title="返回帳號列表" onClick={back}><ArrowLeft size={16} /></button>}
            <h3 id={`${ids}-editor`} className={s.editorTitle}>{isNew ? firstRun ? '新增第一個帳號' : '新增帳號' : `編輯「${selectedProfile?.name ?? draft.name}」`}</h3>
        </div>
        <section className={s.card} aria-label="帳號">
            <label className={s.field}><span className={s.label}>帳號名稱</span>
                <input ref={reg('name')} className={s.input} maxLength={60} placeholder="例如：主帳號、模擬測試" value={draft.name} onChange={e => patch({ name: e.target.value })} />
            </label>
            <div className={s.field}><span className={s.label} id={`${ids}-env`}>環境</span>
                <div className={s.segmented} role="group" aria-labelledby={`${ids}-env`}>
                    <button className={production ? s.segment : s.segmentSim} aria-pressed={!production} onClick={() => patch({ environment: 'simulation' })}>{!production && <Check size={14} />}模擬環境</button>
                    <button className={production ? s.segmentProd : s.segment} aria-pressed={production} onClick={() => patch({ environment: 'production' })}>{production && <Check size={14} />}正式環境</button>
                </div>
                {production
                    ? <p className={s.fieldNoteDanger}><AlertTriangle size={14} />正式環境的委託會動用真實資金。</p>
                    : <p className={s.fieldNote}>模擬環境不會動用真實資金，適合先試用。</p>}
            </div>
        </section>
        <section className={s.card} aria-label="API 金鑰">
            <div className={s.cardHead}><h4 className={s.cardTitle}><KeyRound size={14} />API 金鑰</h4>{!isNew && <span className={s.cardAside}>留空則不變更</span>}</div>
            {isNew && <div className={s.importBox}>
                <p className={s.importText}>已有 .env 檔？可直接匯入為{production ? '正式' : '模擬'}帳號。</p>
                <div className={s.importButtons}>
                    <button ref={reg('import-file')} className={s.smallButton} onClick={() => importFile('file')}><FileUp size={14} />從 .env 匯入</button>
                    <button ref={reg('import-directory')} className={s.smallButton} onClick={() => importFile('directory')}><FolderOpen size={14} />選資料夾</button>
                </div>
                {selection && <div className={s.importChoices} role="group" aria-label="選擇要匯入的檔案">
                    {selection.candidates.map(name => <button key={name} className={`${s.smallButton} ${s.mono}`} onClick={() => importFile('directory', name)}>{name}</button>)}
                </div>}
            </div>}
            <label className={s.field}><span className={s.label}>API Key</span>
                <input className={s.input} type="password" autoComplete="off" spellCheck={false} placeholder={selectedProfile ? `${selectedProfile.apiKeyMasked}（留空保留）` : '貼上 API Key'} value={draft.apiKey ?? ''} onChange={e => patch({ apiKey: e.target.value })} />
            </label>
            <label className={s.field}><span className={s.label}>Secret Key</span>
                <input className={s.input} type="password" autoComplete="off" spellCheck={false} placeholder={isNew ? '貼上 Secret Key' : '留空保留'} value={draft.secretKey ?? ''} onChange={e => patch({ secretKey: e.target.value })} />
            </label>
            <p className={s.fieldNote}>{isNew ? '支援 name.env、.env、.env.local；隱藏檔請用「選資料夾」。' : ''}金鑰存進系統憑證庫，儲存後不再顯示。</p>
        </section>
        <section className={s.card} aria-label="憑證">
            <div className={s.cardHead}>
                <h4 className={s.cardTitle}><FileKey size={14} />CA 憑證</h4>
                <span className={production && !draft.caPath ? s.cardAsideWarn : s.cardAside}>正式環境下單需要</span>
            </div>
            <div className={s.fileRow}>
                <span className={draft.caPath ? s.fileNameSet : s.fileName} title={draft.caPath || undefined}>
                    <FileKey size={15} /><span className={s.fileNameText}>{draft.caPath ? fileName(draft.caPath) : '尚未選擇（例如 Sinopac.pfx）'}</span>
                </span>
                <button className={s.button} onClick={() => void operation(async () => { const path = await pickCaFile(); if (path) patch({ caPath: path }); })}>{draft.caPath ? '更換' : '選擇檔案'}</button>
                {draft.caPath && <button className={s.iconButton} aria-label="清除憑證設定" title="清除憑證設定" onClick={() => patch({ caPath: '', caPassword: '' })}><X size={16} /></button>}
            </div>
            {draft.caPath && <label className={s.field}><span className={s.label}>憑證密碼</span>
                <input className={s.input} type="password" autoComplete="off" placeholder={isNew ? '下載憑證時設定的密碼' : '留空保留'} value={draft.caPassword ?? ''} onChange={e => patch({ caPassword: e.target.value })} />
            </label>}
            <p className={s.fieldNote}>憑證檔留在原位置，只記住路徑；密碼存進系統憑證庫。{!isNew && !draft.caPath && selectedProfile?.hasCA ? '儲存後會移除已存的憑證密碼。' : ''}</p>
        </section>
        {confirmingSave || confirmingImport ? <div className={s.saveConfirm}>
            <p className={s.confirmText}>{confirmingImport
                ? <>接下來選擇{importDirectory ? '資料夾' : ' .env 檔'}，金鑰會存進系統憑證庫，並新增為<span className={s.inlineBadge}><EnvBadge environment={draft.environment} /></span>帳號。</>
                : <>新增<span className={s.inlineBadge}><EnvBadge environment={draft.environment} /></span>帳號「{draft.name.trim()}」，金鑰會存進系統憑證庫。{applyConfirm ? running ? '伺服器會重新啟動。' : '接著啟動伺服器。' : ''}</>}
            </p>
            {confirmButtons(
                confirmingImport ? importDirectory ? '確認選資料夾' : '確認匯入' : applyConfirm ? '確認新增並啟動' : '確認新增帳號',
                confirmingImport ? () => importFile(importDirectory ? 'directory' : 'file') : () => save(applyConfirm),
                'primary', '取消確認')}
        </div> : <div className={s.editorActions}>
            {!firstRun && <button className={s.button} onClick={back}>取消</button>}
            <span className={s.actionsSpacer} />
            <button ref={reg('save-only')} className={s.button} onClick={() => save(false)}>僅儲存</button>
            <button ref={reg('save-apply')} className={s.primary} onClick={() => save(true)}>{running ? '儲存並重啟' : '儲存並啟動'}</button>
        </div>}
    </fieldset>;

    return <div className={s.credentials}>
        {settings.migrationError && <Callout tone="warn" icon={<AlertTriangle size={16} />} title="舊的帳號資料尚未轉移完成"
            actions={<button className={s.smallButton} disabled={locked} onClick={() => void operation(async () => onImported(await loadDesktopSettings()))}><RotateCw size={14} />重試遷移</button>}>
            {settings.migrationError}
        </Callout>}
        {settings.credentialBackend === 'plaintext-fallback' && <Callout tone="warn" icon={<ShieldAlert size={16} />} title="金鑰以檔案保存">
            這台電腦沒有可用的系統憑證庫，金鑰與憑證密碼存在 {settings.fallbackPath}（只有你的帳號能讀寫，0600）。同一使用者執行的程式（含 Agent）仍可能讀到這個檔案。
        </Callout>}
        {editing ? editor : list}
        {error && <Callout tone="danger" icon={<AlertTriangle size={16} />}>{error}</Callout>}
        <p className={s.status} role="status">{pending ? <><Loader2 size={14} className={s.spinner} />處理中…</> : message ? <><CheckCircle2 size={14} className={s.statusOk} />{message}</> : null}</p>
    </div>;
}
