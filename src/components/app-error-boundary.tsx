// src/components/app-error-boundary.tsx — App 頂層的最後一道保險。
// 面板內的錯誤由 PanelErrorBoundary 隔離；這裡接住面板框架之外的 render
// 崩潰（例如版面資料讓 BlockView 取不到面板定義），避免整個視窗白畫面。
// 「重設版面」把目前版面（sj-pro-workspace-v3）寫回預設，版面庫不刪。

import { LayoutGrid, RotateCw, TriangleAlert } from 'lucide-react';
import { Component, type ReactNode } from 'react';
import { resetSavedWorkspace } from '../lib/workspace';
import { isChildWindow } from '../lib/window-role';
import * as styles from './child-setup-notice.css';
import * as local from './app-error-boundary.css';

interface Props {
    children: ReactNode;
}

interface State {
    error: Error | null;
}

export class AppErrorBoundary extends Component<Props, State> {
    state: State = { error: null };

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    componentDidCatch(error: Error) {
        console.error('[app] render crash:', error);
    }

    render() {
        const { error } = this.state;
        if (!error) return this.props.children;
        const message = String(error.message || error);
        // 彈出視窗不在版面裡，重設版面沒有意義，只給重新載入
        const child = isChildWindow();
        return (
            <div className={styles.wrap} role='alert'>
                <TriangleAlert className={local.icon} size={22} aria-hidden />
                <h1 className={styles.title}>畫面發生錯誤</h1>
                <p className={styles.body}>
                    {child
                        ? '這個視窗無法顯示，請重新載入。'
                        : '可能是版面資料與此版本不相容。可先重新載入；若仍無法顯示，請重設版面（只重設目前版面，已儲存的版面庫不會刪除）。'}
                </p>
                <pre className={local.message}>{message}</pre>
                <div className={local.actions}>
                    <button
                        type='button'
                        className={styles.button}
                        onClick={() => window.location.reload()}
                    >
                        <RotateCw size={14} aria-hidden />
                        重新載入
                    </button>
                    {!child && (
                        <button
                            type='button'
                            className={styles.button}
                            onClick={() => {
                                try {
                                    resetSavedWorkspace();
                                } catch {
                                    // storage 不可用時照樣重新載入
                                }
                                window.location.reload();
                            }}
                        >
                            <LayoutGrid size={14} aria-hidden />
                            重設版面
                        </button>
                    )}
                </div>
            </div>
        );
    }
}
