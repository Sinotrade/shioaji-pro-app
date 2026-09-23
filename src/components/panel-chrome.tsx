// src/components/panel-chrome.tsx — shared panel title bar: drag handle,
// link/pin symbol toggle, remove button.

import { ExternalLink, Link2, Pin, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import * as panel from './panel.css';
import * as styles from './panel-chrome.css';

export function PanelChrome({
    title,
    symbolCode,
    symbolName,
    pinnable = false,
    pin,
    currentCode,
    onPinChange,
    onRemove,
    onPopout,
    children,
}: {
    title: string;
    /** 商品代碼：窄面板時不截斷；鎖定時由鎖定輸入框顯示 */
    symbolCode?: string | null;
    /** 商品名稱（#125）：接在代碼後、省略號截斷；極窄時改隱藏面板名稱 */
    symbolName?: string | null;
    pinnable?: boolean;
    pin?: string | null;
    currentCode?: string | null;
    onPinChange?: (pin: string | null) => void;
    onRemove?: () => void;
    onPopout?: () => void;
    children?: React.ReactNode;
}) {
    const [editCode, setEditCode] = useState(pin ?? '');
    // 鎖定時代碼已顯示在鎖定輸入框，標題不重複，把空間留給商品名稱
    const pinned = pinnable && !!onPinChange && pin !== null && pin !== undefined;
    const showCode = !!symbolCode && !pinned;
    const showName = !!symbolCode && !!symbolName;
    // 面板名稱只在旁邊還有代碼或名稱時才可於極窄時隱藏
    const hasSymbol = showCode || showName;
    const fullTitle = [title, symbolCode, symbolName]
        .filter(Boolean)
        .join(' · ');
    useEffect(() => setEditCode(pin ?? ''), [pin]);

    return (
        <div className={`${panel.panelTitle} drag-handle`}>
            <span className={panel.panelTitleDeco} />
            <span className={styles.titleGroup}>
                <span
                    className={
                        hasSymbol ? styles.symbolLabel : styles.titleText
                    }
                    title={symbolCode ? fullTitle : undefined}
                >
                    {title}
                </span>
                {showCode && (
                    <span className={styles.symbolCode}>{symbolCode}</span>
                )}
                {showName && (
                    <span className={styles.symbolName} title={fullTitle}>
                        {symbolName}
                    </span>
                )}
                {children}
            </span>
            {pinnable &&
                onPinChange &&
                (pin === null || pin === undefined ? (
                    <button
                        className={styles.pinBtn.linked}
                        title='跟隨自選清單選擇；點擊鎖定目前商品'
                        onClick={() =>
                            currentCode && onPinChange(currentCode)
                        }
                    >
                        <Link2 size={10} style={{ verticalAlign: '-1px' }} />{' '}
                        連動
                    </button>
                ) : (
                    <>
                        <input
                            className={styles.pinInput}
                            value={editCode}
                            title='鎖定的商品代碼，Enter 套用'
                            onChange={(e) => setEditCode(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    const code = editCode
                                        .trim()
                                        .toUpperCase();
                                    if (code) onPinChange(code);
                                }
                            }}
                        />
                        <button
                            className={styles.pinBtn.pinned}
                            title='已鎖定；點擊恢復連動'
                            onClick={() => onPinChange(null)}
                        >
                            <Pin size={10} style={{ verticalAlign: '-1px' }} />{' '}
                            鎖定
                        </button>
                    </>
                ))}
            {onPopout && (
                <button
                    className={styles.closeBtn}
                    title='彈出為獨立視窗（多螢幕）'
                    onClick={onPopout}
                >
                    <ExternalLink size={11} />
                </button>
            )}
            {onRemove && (
                <button
                    className={styles.closeBtn}
                    title='移除此面板'
                    onClick={onRemove}
                >
                    <X size={11} />
                </button>
            )}
        </div>
    );
}
