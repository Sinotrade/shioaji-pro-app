// src/components/panel-chrome.tsx — shared panel title bar: drag handle,
// link/pin symbol toggle, remove button.

import { Check, ChevronDown, ExternalLink, Link2, Pin, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { LinkGroupId } from '../lib/flash-link';
import type { LinkMode } from '../lib/workspace';
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
    link,
    actions,
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
    /** 連動下拉（連動／群組 A／B／C／鎖定）；沒有時維持單一的連動／鎖定鈕 */
    link?: {
        mode: LinkMode;
        groups: { id: LinkGroupId; code: string | null; count: number }[];
        onMode: (mode: LinkMode) => void;
        onGroupCode: (group: LinkGroupId, code: string) => void;
    };
    /** 面板自己的標題列按鈕（例如成交明細的「完整」），放在連動鈕與彈出鈕之間 */
    actions?: React.ReactNode;
    children?: React.ReactNode;
}) {
    const group = link && link.mode !== 'main' && link.mode !== 'pin' ? link.mode : null;
    const groupCode = group ? link!.groups.find(g => g.id === group)?.code ?? '' : null;
    const [menuOpen, setMenuOpen] = useState(false);
    useEffect(() => {
        if (!menuOpen) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [menuOpen]);
    const [editCode, setEditCode] = useState(pin ?? '');
    // 草稿綁定「群組＋目前代碼」：群組代碼一變（或換群組），同一次 render 就顯示新代碼
    const draftKey = `${group ?? ''}:${groupCode ?? ''}`;
    const [groupDraft, setGroupDraft] = useState<{ key: string; value: string } | null>(null);
    const editGroupCode = groupDraft?.key === draftKey ? groupDraft.value : groupCode ?? '';
    const setEditGroupCode = (value: string) => setGroupDraft({ key: draftKey, value });
    // 鎖定時代碼已顯示在鎖定輸入框，標題不重複，把空間留給商品名稱
    const pinned = pinnable && !!onPinChange && pin !== null && pin !== undefined;
    // 鎖定輸入框正在輸入新代碼時，舊名稱會誤導 — 未按 Enter 套用前先隱藏
    const editingPin =
        pinned && editCode.trim().toUpperCase() !== (pin ?? '').toUpperCase();
    const showCode = !!symbolCode && !pinned && !(link && link.mode !== 'main');
    const showName = !!symbolCode && !!symbolName && !editingPin;
    // 面板名稱只在旁邊還有代碼或名稱時才可於極窄時隱藏
    const hasSymbol = showCode || showName;
    const fullTitle = [title, symbolCode, symbolName]
        .filter(Boolean)
        .join(' · ');
    useEffect(() => setEditCode(pin ?? ''), [pin]);

    return (
        <div
            className={`${panel.panelTitle} ${styles.titleBar} drag-handle`}
            data-controls={
                !pinnable || !onPinChange ? 'none' : pinned || group ? 'pinned' : 'linked'
            }
            data-link-group={group ?? undefined}
        >
            {group && <span className={styles.groupBar[group]} data-link-group={group} aria-hidden />}
            <span className={`${panel.panelTitleDeco} ${styles.deco}`} style={group ? { background: GROUP_COLOR[group] } : undefined} />
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
                    // 名稱放在自己的換行盒：寬度不足約三個字時整個換到
                    // 第二行被裁掉（不留孤立的省略號），代碼不受影響
                    <span className={styles.nameBox}>
                        <span className={styles.nameBreak} />
                        <span
                            className={
                                styles.symbolName[showCode ? 'afterCode' : 'afterLabel']
                            }
                            title={fullTitle}
                        >
                            {symbolName}
                        </span>
                    </span>
                )}
                {children}
            </span>
            {pinnable && onPinChange && link && (
                <span className={styles.linkAnchor}>
                    {pinned && (
                        <input
                            className={styles.pinInput}
                            value={editCode}
                            title='鎖定的商品代碼，Enter 套用'
                            onChange={(e) => setEditCode(e.target.value)}
                            onKeyDown={(e) => {
                                const code = editCode.trim().toUpperCase();
                                if (e.key === 'Enter' && code) onPinChange(code);
                            }}
                        />
                    )}
                    {group && (
                        <input
                            className={styles.groupInput[group]}
                            value={editGroupCode}
                            title={`群組 ${group} 的商品代碼，Enter 全組一起換`}
                            onChange={(e) => setEditGroupCode(e.target.value)}
                            onKeyDown={(e) => {
                                const code = editGroupCode.trim().toUpperCase();
                                if (e.key === 'Enter' && code) link.onGroupCode(group, code);
                            }}
                        />
                    )}
                    <button
                        className={group ? styles.groupBtn[group] : pinned ? styles.pinBtn.pinned : styles.pinBtn.linked}
                        aria-haspopup='menu'
                        aria-expanded={menuOpen}
                        title={group ? `群組 ${group}：群組內共用一個商品` : pinned ? '已鎖定' : '跟隨自選清單選擇'}
                        onClick={() => setMenuOpen(v => !v)}
                    >
                        {group ? <span className={styles.groupDot} style={{ background: GROUP_COLOR[group] }} />
                            : pinned ? <Pin size={10} style={{ verticalAlign: '-1px' }} />
                                : <Link2 size={10} style={{ verticalAlign: '-1px' }} />}
                        <span className={group ? undefined : styles.pinText}> {group ?? (pinned ? '鎖定' : '連動')}</span>
                        <ChevronDown size={9} aria-hidden />
                    </button>
                    {menuOpen && (
                        <>
                            <div className={styles.menuBackdrop} onClick={() => setMenuOpen(false)} />
                            <div className={styles.linkMenu} role='menu' aria-label='連動方式'>
                                {([['main', '連動', '自選清單'], ...link.groups.map(g => [g.id, `群組 ${g.id}`, g.count > 0 && g.code ? `${g.code} · ${g.count} 個` : '未使用'] as const)] as const).map(([mode, label, note]) => (
                                    <button key={mode} type='button' role='menuitemradio' aria-checked={link.mode === mode} className={styles.linkItem}
                                        onClick={() => { setMenuOpen(false); link.onMode(mode as LinkMode); }}>
                                        <span className={styles.groupDot} style={{ background: mode === 'main' ? undefined : GROUP_COLOR[mode as LinkGroupId] }} />
                                        {label}
                                        <span className={styles.linkNote}>{note}</span>
                                        {link.mode === mode && <Check size={11} aria-hidden />}
                                    </button>
                                ))}
                                <button type='button' role='menuitemradio' aria-checked={pinned} className={styles.linkItem}
                                    onClick={() => { setMenuOpen(false); link.onMode('pin'); }}>
                                    <Pin size={10} aria-hidden />鎖定目前商品
                                </button>
                                <div className={styles.linkHint}>同一群組的面板共用一個商品；彈出視窗不跟群組連動</div>
                            </div>
                        </>
                    )}
                </span>
            )}
            {pinnable &&
                onPinChange &&
                !link &&
                (pin === null || pin === undefined ? (
                    <button
                        className={styles.pinBtn.linked}
                        title='跟隨自選清單選擇；點擊鎖定目前商品'
                        onClick={() =>
                            currentCode && onPinChange(currentCode)
                        }
                    >
                        <Link2 size={10} style={{ verticalAlign: '-1px' }} />
                        <span className={styles.pinText}> 連動</span>
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
                            <Pin size={10} style={{ verticalAlign: '-1px' }} />
                            <span className={styles.pinText}> 鎖定</span>
                        </button>
                    </>
                ))}
            {actions}
            {onPopout && (
                <button
                    className={`${styles.closeBtn} ${styles.popoutBtn}`}
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

export const GROUP_COLOR: Record<LinkGroupId, string> = { A: '#8b5cf6', B: '#ec4899', C: '#06b6d4' };
