// src/components/screen-lock-switch.tsx — 頂部列「螢幕鎖」膠囊：只在已啟用、沒鎖時出現，
// 按一下就鎖定（同 ⇧⌘L）。要不要顯示在 設定 → 頂欄顯示（header-items 的 screenLock）。
import { isMac, lockApp, lockShortcutLabel, useAppLock } from '../lib/app-lock';
import { switchTrack } from './hud-header.css';
import * as styles from './screen-lock-switch.css';

export function ScreenLockSwitch() {
    const lock = useAppLock();
    if (!lock || lock.locked) return null;
    return <button type='button' role='switch' aria-checked={false} aria-label='螢幕鎖'
        aria-keyshortcuts={isMac() ? 'Meta+Shift+L' : 'Control+Shift+L'}
        title={`遮住 Shioaji Pro 畫面，背景監控照常（${lockShortcutLabel()}）`} className={styles.capsule} onClick={lockApp}>
        <span className={styles.label}>螢幕鎖</span><span aria-hidden='true' className={switchTrack.off} />
    </button>;
}
