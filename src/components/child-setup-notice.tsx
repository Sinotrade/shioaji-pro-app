// src/components/child-setup-notice.tsx — shown in the tray panel / popouts
// while first-run setup is not done. Child windows never read settings.json
// (API keys live there), so setup can only happen in the main window.

import { AppWindow, KeyRound, RotateCw, TriangleAlert } from 'lucide-react';
import { focusMainWindow } from '../lib/window-role';
import * as styles from './child-setup-notice.css';

export function ChildSetupNotice() {
    return (
        <div className={styles.wrap} role='status'>
            <KeyRound className={styles.icon} size={22} aria-hidden />
            <h1 className={styles.title}>請在主視窗完成設定</h1>
            <p className={styles.body}>
                API 金鑰只在主視窗讀取與設定。完成設定後，這個視窗會自動更新。
            </p>
            <button
                type='button'
                className={styles.button}
                onClick={() => void focusMainWindow().catch(() => undefined)}
            >
                <AppWindow size={14} aria-hidden />
                開啟主視窗
            </button>
        </div>
    );
}

// Main window: settings.json could not be read. Retry instead of showing
// first-run setup, which would invite overwriting the saved keys.
export function SettingsLoadError({ onRetry }: { onRetry: () => void }) {
    return (
        <div className={styles.wrap} role='alert'>
            <TriangleAlert className={styles.icon} size={22} aria-hidden />
            <h1 className={styles.title}>無法讀取本機設定</h1>
            <p className={styles.body}>
                API 金鑰等設定暫時無法讀取，已保留原設定不做變更。請重試；若持續失敗，請重新開啟 App。
            </p>
            <button type='button' className={styles.button} onClick={onRetry}>
                <RotateCw size={14} aria-hidden />
                重試
            </button>
        </div>
    );
}
