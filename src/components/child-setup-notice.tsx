// src/components/child-setup-notice.tsx — shown in the tray panel / popouts
// while first-run setup is not done. Child windows never read settings.json
// (API keys live there), so setup can only happen in the main window.

import { AppWindow, KeyRound } from 'lucide-react';
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
