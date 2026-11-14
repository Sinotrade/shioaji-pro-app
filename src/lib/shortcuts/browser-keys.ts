// src/lib/shortcuts/browser-keys.ts — Windows 桌面版停用瀏覽器按鍵
//
// WebView2 預設保留瀏覽器快捷鍵：F5／Ctrl+R 重新載入整個畫面（盤中誤按會
// 中斷串流、清掉未存的輸入）、Ctrl+P 開列印對話框。Chromium 在網頁的
// keydown 被 preventDefault 時不執行這些瀏覽器動作，所以在 capture 階段
// 先攔下。原生層另可關掉 AreBrowserAcceleratorKeysEnabled 作為第二道防線
// （JS 還沒載入或畫面卡住時也有效），見 docs/design/keyboard-shortcuts.md。
//
// 只在 Tauri 的 Windows（非 macOS）視窗啟用：瀏覽器開發與 macOS 不受影響。

import type { KeyEventLike } from './keys';

export function isBlockedBrowserKey(e: KeyEventLike): boolean {
    const code = e.code || '';
    const key = (e.key || '').toLowerCase();
    // F5、Shift+F5、Ctrl+F5：重新載入
    if (code === 'F5' || key === 'f5') return true;
    if (!e.ctrlKey || e.altKey || e.metaKey) return false;
    // Ctrl+R、Ctrl+Shift+R：重新載入；Ctrl+P、Ctrl+Shift+P：列印
    return code === 'KeyR' || code === 'KeyP' || (!code && (key === 'r' || key === 'p'));
}

export function installBrowserKeyGuard(opts: { tauri: boolean; mac: boolean }): () => void {
    if (!opts.tauri || opts.mac || typeof window === 'undefined') return () => {};
    const onKey = (e: KeyboardEvent) => {
        if (isBlockedBrowserKey(e)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
}
