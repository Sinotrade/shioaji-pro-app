import { CircleAlert, FileText, FileX2, FolderOpen, KeyRound, Plug, ShieldAlert, SquareTerminal, Timer, UserRoundCog, WifiOff, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { serverStartErrorCopy, type ServerStartError } from '../lib/server-start-error';
import * as styles from './server-start-error-panel.css';

export function serverStartErrorIcon(error: ServerStartError): LucideIcon {
    switch (error.kind) {
        case 'sidecar_missing': return FileX2;
        case 'port_in_use': return Plug;
        case 'sidecar_exited': return SquareTerminal;
        case 'auth_failed': return KeyRound;
        case 'account_setup': return UserRoundCog;
        case 'ca_cert': return ShieldAlert;
        case 'network': return error.timeout ? Timer : WifiOff;
        case 'unknown': return CircleAlert;
    }
}

/** A failed server start, explained by kind, with the log location. */
export function ServerStartErrorPanel({ error, logPath, onOpenLogFolder }: {
    error: ServerStartError;
    logPath?: string;
    onOpenLogFolder?: () => Promise<void>;
}) {
    const copy = serverStartErrorCopy(error);
    const Icon = serverStartErrorIcon(error);
    const [opening, setOpening] = useState(false);
    const [openFailed, setOpenFailed] = useState(false);
    const open = async () => {
        if (!onOpenLogFolder) return;
        setOpening(true); setOpenFailed(false);
        try { await onOpenLogFolder(); } catch { setOpenFailed(true); } finally { setOpening(false); }
    };
    return (
        <div className={styles.panel} role="alert" data-kind={error.kind}>
            <div className={styles.header}><Icon size={15} className={styles.icon} aria-hidden />{copy.title}</div>
            <p className={styles.body}>{copy.body}</p>
            {copy.detail.length > 0 && <>
                {copy.detailLabel && <div className={styles.detailLabel}>{copy.detailLabel}</div>}
                <pre className={styles.detail}>{copy.detail.join('\n')}</pre>
            </>}
            {(logPath || onOpenLogFolder) && <div className={styles.footer}>
                {logPath && <span className={styles.logPath}><FileText size={12} aria-hidden />記錄檔：{logPath}</span>}
                {onOpenLogFolder && <button type="button" className={styles.openButton} disabled={opening} onClick={() => void open()}>
                    <FolderOpen size={13} aria-hidden />打開記錄資料夾
                </button>}
                {openFailed && <p className={styles.openError}>無法開啟記錄資料夾，請手動前往上方路徑。</p>}
            </div>}
        </div>
    );
}
