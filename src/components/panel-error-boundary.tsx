// src/components/panel-error-boundary.tsx — 面板崩潰隔離（QA11）。
// 單一面板 render throw 只讓該面板顯示錯誤卡，其餘面板與版面照常；
// 「重新載入面板」以 epoch key 強制整個子樹重掛（不只清錯誤旗標，
// 避免壞掉的元件內部狀態原地復活再炸一次）。

import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Component, Fragment, type ReactNode } from 'react';
import * as styles from './panel-error-boundary.css';

interface Props {
    label?: string;
    children: ReactNode;
}

interface State {
    error: Error | null;
    epoch: number;
}

export class PanelErrorBoundary extends Component<Props, State> {
    state: State = { error: null, epoch: 0 };

    static getDerivedStateFromError(error: Error): Partial<State> {
        return { error };
    }

    componentDidCatch(error: Error) {
        console.error('[panel] render crash（已隔離）:', error);
    }

    render() {
        if (this.state.error) {
            const message = String(
                this.state.error.message || this.state.error,
            );
            return (
                <div className={styles.wrap} role="alert">
                    <AlertTriangle size={16} className={styles.icon} />
                    <div className={styles.title}>
                        {this.props.label ?? '面板'}發生錯誤
                    </div>
                    <div className={styles.message}>{message}</div>
                    <button
                        className={styles.retry}
                        onClick={() =>
                            this.setState((current) => ({
                                error: null,
                                epoch: current.epoch + 1,
                            }))
                        }
                    >
                        <RotateCcw size={12} /> 重新載入面板
                    </button>
                </div>
            );
        }
        return (
            <Fragment key={this.state.epoch}>{this.props.children}</Fragment>
        );
    }
}
