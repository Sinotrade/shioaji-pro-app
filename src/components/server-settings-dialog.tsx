import { X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { type CredentialDraft, type DesktopSettings, type ServerStatus } from '../lib/tauri';
import { CredentialProfiles } from './credential-profiles';
import * as s from './server-settings-dialog.css';

export type ServerConnectionSettings = CredentialDraft;
export function ServerSettingsDialog({ settings, status, busy, pendingApply = false, onSave, onProfileAction, onImported, onClose, children }: {
    settings: DesktopSettings; status: ServerStatus | null | undefined; busy: boolean; pendingApply?: boolean;
    onSave: (draft: CredentialDraft, apply: boolean) => Promise<DesktopSettings>;
    onProfileAction: (action: 'select' | 'delete', id: string) => Promise<DesktopSettings>;
    onImported: (settings: DesktopSettings) => void;
    onClose: () => void; children?: ReactNode;
}) {
    const dialog = useRef<HTMLDivElement>(null);
    const [credentialBusy, setCredentialBusy] = useState(false);
    const [editingProfile, setEditingProfile] = useState(false);
    const locked = busy || credentialBusy;
    const close = useRef(onClose); close.current = onClose;
    const lockedRef = useRef(locked); lockedRef.current = locked;
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

    return <>
        <div className={s.backdrop} />
        <div ref={dialog} className={s.dialog} role="dialog" aria-modal="true" aria-labelledby="server-settings-title" tabIndex={-1}>
            <header className={s.header}><div><h2 id="server-settings-title" className={s.title}>伺服器設定</h2><p className={s.hint}>{status?.running ? `伺服器運行中 · ${status.simulation === true ? '模擬環境' : status.simulation === false ? '正式環境' : '環境未知'} · ${status.scheme ?? 'scheme 未知'}` : '伺服器未啟動'}{pendingApply ? ' · 有設定尚未套用' : ''}</p></div><button className={s.iconButton} aria-label="關閉伺服器設定" title="關閉" disabled={locked} onClick={onClose}><X size={16} /></button></header>
            <div className={s.body}>
                <CredentialProfiles settings={settings} busy={busy} running={!!status?.running} onSave={onSave} onAction={onProfileAction} onImported={onImported} onBusyChange={setCredentialBusy} onEditingChange={setEditingProfile} />
                {!editingProfile && <fieldset className={s.fields} disabled={locked}>{children}</fieldset>}
            </div>
            <footer className={s.footer}><p className={s.footerHint}>重啟會停止本 App 的 Agent、撤銷本次 Auto 授權，並暫時中斷行情；既有委託不會因此撤銷。</p><button className={s.button} disabled={locked} onClick={onClose}>關閉</button></footer>
        </div>
    </>;
}
