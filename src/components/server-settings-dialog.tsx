import { Eye, EyeOff, FileUp, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { pickCaFile, pickEnvFile, type DesktopSettings, type ServerStatus } from '../lib/tauri';
import * as s from './server-settings-dialog.css';

export type ServerConnectionSettings = Pick<DesktopSettings, 'apiKey' | 'secretKey' | 'production' | 'caPath' | 'caPasswd'>;
export const connectionSettings = (settings: DesktopSettings): ServerConnectionSettings => ({
    apiKey: settings.apiKey, secretKey: settings.secretKey, production: settings.production,
    caPath: settings.caPath, caPasswd: settings.caPasswd,
});

export function ServerSettingsDialog({ settings, status, busy, onSave, onClose, children }: {
    settings: DesktopSettings; status: ServerStatus | null | undefined; busy: boolean;
    onSave: (draft: ServerConnectionSettings, apply: boolean) => Promise<void>;
    onClose: () => void; children?: ReactNode;
}) {
    const [draft, setDraft] = useState(() => connectionSettings(settings));
    const [showPassword, setShowPassword] = useState(false);
    const [pending, setPending] = useState(false);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const active = useRef(false);
    const dialog = useRef<HTMLDivElement>(null);
    const close = useRef(onClose); close.current = onClose;
    const locked = busy || pending;
    const lockedRef = useRef(locked); lockedRef.current = locked;
    const dirty = JSON.stringify(draft) !== JSON.stringify(connectionSettings(settings));
    const change = (values: Partial<ServerConnectionSettings>) => {
        setDraft(current => ({ ...current, ...values })); setMessage(''); setError('');
    };
    useEffect(() => {
        const node = dialog.current;
        if (!node) return;
        const previous = document.activeElement as HTMLElement | null;
        node.focus();
        const keydown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault(); event.stopPropagation();
                if (!lockedRef.current) close.current();
            }
            if (event.key !== 'Tab') return;
            const nodes = Array.from(node.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], summary, [tabindex="0"]')).filter(el => el.getClientRects().length);
            const first = nodes[0], last = nodes.at(-1);
            if (!first || !last) { event.preventDefault(); node.focus(); return; }
            if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && (document.activeElement === last || document.activeElement === node)) { event.preventDefault(); first.focus(); }
        };
        node.addEventListener('keydown', keydown);
        return () => { node.removeEventListener('keydown', keydown); if (previous?.isConnected) previous.focus(); };
    }, []);
    const submit = async (apply: boolean) => {
        if (active.current || busy) return;
        active.current = true; setPending(true); setError(''); setMessage('');
        try {
            await onSave(draft, apply);
            setMessage(apply ? '設定已儲存，正在等待伺服器連線。' : '設定已儲存，下次啟動或重啟伺服器時套用。');
        } catch (e) { setError(e instanceof Error ? e.message : '儲存失敗，請重試。'); }
        finally { active.current = false; setPending(false); }
    };
    const chooseFile = async (kind: 'env' | 'ca') => {
        if (active.current) return;
        active.current = true; setPending(true); setError('');
        try {
            if (kind === 'ca') { const path = await pickCaFile(); if (path) change({ caPath: path }); }
            else {
                const found = await pickEnvFile();
                if (found?.error) setError(found.error);
                else if (found) {
                    change({ ...(found.apiKey !== undefined ? { apiKey: found.apiKey } : {}), ...(found.secretKey !== undefined ? { secretKey: found.secretKey } : {}) });
                    setMessage('已讀取金鑰到表單，尚未儲存。');
                }
            }
        } catch (e) { setError(e instanceof Error ? e.message : '無法讀取檔案。'); }
        finally { active.current = false; setPending(false); }
    };
    const currentMode = status?.simulation === true ? '模擬' : status?.simulation === false ? '正式' : '環境待確認';
    return <>
        <div className={s.backdrop} />
        <div ref={dialog} className={s.dialog} role="dialog" aria-modal="true" aria-labelledby="server-settings-title" aria-describedby="server-settings-description" tabIndex={-1}>
            <header className={s.header}>
                <div><h2 id="server-settings-title" className={s.title}>伺服器設定</h2>
                    <p className={s.hint}>目前{status?.running ? `運行：${currentMode} · ${(status.scheme ?? 'http').toUpperCase()}` : status ? '未啟動' : '狀態讀取中'}</p>
                </div>
                <button className={s.button} aria-label="關閉伺服器設定" disabled={locked} onClick={onClose}><X size={16} /></button>
            </header>
            <div className={s.body}><fieldset className={s.fields} disabled={locked}>
                <p id="server-settings-description" className={s.hint}>編輯不會立即影響連線。儲存後，下次啟動時套用；也可儲存並立即重啟。</p>
                <section className={s.section} aria-labelledby="server-keys-title">
                    <h3 id="server-keys-title" className={s.heading}>API 金鑰</h3>
                    <label className={s.field}><span className={s.label}>API Key</span><input className={s.input} type="password" autoComplete="off" value={draft.apiKey} disabled={locked} onChange={e => change({ apiKey: e.target.value })} /></label>
                    <label className={s.field}><span className={s.label}>Secret Key</span><input className={s.input} type="password" autoComplete="off" value={draft.secretKey} disabled={locked} onChange={e => change({ secretKey: e.target.value })} /></label>
                    <div className={s.row}><button className={s.button} disabled={locked} onClick={() => void chooseFile('env')}><FileUp size={14} />從 .env 匯入</button><span className={s.hint}>選擇包含 .env 的資料夾</span></div>
                    <p className={s.hint}>金鑰儲存在本機 App 資料夾。</p>
                </section>
                <section className={s.section} aria-labelledby="server-environment-title">
                    <h3 id="server-environment-title" className={s.heading}>下次啟動環境</h3>
                    <div className={s.row} role="group" aria-label="下次啟動環境">
                        <button className={draft.production ? s.button : s.selected} aria-pressed={!draft.production} disabled={locked} onClick={() => change({ production: false })}>模擬環境</button>
                        <button className={draft.production ? s.selected : s.button} aria-pressed={draft.production} disabled={locked} onClick={() => change({ production: true })}>正式環境</button>
                    </div>
                    <p className={draft.production ? s.warning : s.hint}>{draft.production ? '正式環境的委託會動用真實資金，請核對金鑰與憑證。' : '模擬環境不需要 CA 憑證。既有憑證設定會保留。'}</p>
                    {draft.production && <>
                        <span className={s.label}>CA 憑證（Sinopac.pfx）</span>
                        <div className={s.row}><button className={s.button} disabled={locked} onClick={() => void chooseFile('ca')}>{draft.caPath ? draft.caPath.split(/[/\\]/).pop() : '選擇憑證檔…'}</button>
                            {draft.caPath && <button className={s.button} disabled={locked} onClick={() => change({ caPath: '', caPasswd: '' })}>清除憑證設定</button>}</div>
                        <div className={s.field}><label className={s.label} htmlFor="server-ca-password">憑證密碼</label><span className={s.row}><input id="server-ca-password" className={s.input} style={{ flex: 1 }} type={showPassword ? 'text' : 'password'} autoComplete="off" value={draft.caPasswd} disabled={locked} onChange={e => change({ caPasswd: e.target.value })} /><button className={s.button} aria-label={showPassword ? '隱藏憑證密碼' : '顯示憑證密碼'} disabled={locked} onClick={() => setShowPassword(v => !v)}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></span></div>
                    </>}
                </section>
                {children}
            </fieldset></div>
            <footer className={s.footer}>
                {error && <div className={s.warning} role="alert">{error}</div>}
                <p className={s.hint} role="status">{message || (dirty ? '有尚未儲存的變更' : '目前沒有未儲存的變更')}</p>
                <div className={s.actions}>
                    <button className={s.button} disabled={locked} onClick={onClose}>{dirty ? '取消變更' : '關閉'}</button>
                    <button className={s.button} disabled={locked || !dirty} onClick={() => void submit(false)}>僅儲存</button>
                    <button className={s.primary} disabled={locked || !status} onClick={() => void submit(true)}>{pending ? '處理中…' : status?.running ? '儲存並重啟' : '儲存並啟動'}</button>
                </div>
                <p className={s.hint}>重啟會暫時中斷行情與 Agent 連線；既有委託不會因此撤銷。</p>
            </footer>
        </div>
    </>;
}
