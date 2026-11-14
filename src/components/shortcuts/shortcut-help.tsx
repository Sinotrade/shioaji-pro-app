// src/components/shortcuts/shortcut-help.tsx — 快捷鍵提示頁（⌘/ · Ctrl+/）
//
// 主視窗與彈出視窗都掛：輸入框內也能叫出。依「目前選取的面板」把相關分類
// 排在最前面，其他分類的項目標示在哪裡才有作用。Esc 走 useEscClose，
// 關閉提示頁的這一下不會算進 Esc×2 全部刪單。

import {
    AppWindow,
    ArrowLeftRight,
    ArrowRight,
    Bot,
    ChartCandlestick,
    Keyboard,
    PanelTop,
    PenLine,
    Search,
    Settings,
    ShieldAlert,
    ShieldCheck,
    X,
    Zap,
    type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useEscClose } from '../../hooks/use-esc-close';
import { useRiskSettings } from '../../lib/risk';
import {
    currentWindowRole,
    getFocusedPanel,
    holdKeyboard,
    keyboardHeld,
    subscribeFocusedPanel,
    type WindowRole,
} from '../../lib/shortcuts/guards';
import { chordText } from '../../lib/shortcuts/keys';
import { emitShortcut, matchesShortcut, onShortcut } from '../../lib/shortcuts/match';
import {
    CATEGORY_LABEL,
    CATEGORY_ORDER,
    PANEL_SCOPE,
    SCOPE_LABEL,
    availability,
    effectiveKeys,
    forPlatform,
    type Availability,
    type Category,
    type ShortcutDef,
} from '../../lib/shortcuts/registry';
import { useShortcutState } from '../../lib/shortcuts/store';
import { BLOCK_META, type BlockType } from '../../lib/workspace';
import { KeyCaps } from './key-caps';
import * as styles from './shortcuts.css';

const CATEGORY_ICON: Record<Category, LucideIcon> = {
    general: Keyboard,
    trade: ArrowLeftRight,
    chart: ChartCandlestick,
    drawing: PenLine,
    flash: Zap,
    agent: Bot,
    dialog: PanelTop,
    native: AppWindow,
};

// 面板範圍 → 優先顯示的分類
const SCOPE_CATEGORIES: Partial<Record<string, Category[]>> = {
    ticket: ['trade'],
    chart: ['chart', 'drawing'],
    flash: ['flash'],
    oddspread: ['flash'],
    dock: ['trade'],
    agent: ['agent'],
};

const RISKY = new Set<ShortcutDef['risk']>(['cancel', 'send', 'edit', 'direction', 'lock']);

function panelLabel(type: string | null): string | null {
    if (!type) return null;
    return type in BLOCK_META ? BLOCK_META[type as BlockType].label : null;
}

function HelpRow({ d, avail }: { d: ShortcutDef; avail: Availability }) {
    const { overrides, platform } = useShortcutState();
    const dim = avail.state !== 'now';
    return (
        <div className={`${styles.helpRow} ${dim ? styles.helpRowDim : ''}`}>
            <span className={styles.helpLabel}>
                {RISKY.has(d.risk) && (
                    <span className={styles.riskGlyph} title='影響委託'>
                        <ShieldAlert size={11} />
                    </span>
                )}
                {d.label}
                {avail.state === 'reserved' && <span className={styles.badge.accent}>即將推出</span>}
                {avail.state === 'disabled' && <span className={styles.badge.muted}>已停用</span>}
                {avail.state === 'off' && <span className={styles.badge.muted}>{avail.reason}</span>}
                {avail.state === 'elsewhere' && <span className={styles.helpWhy}>{avail.reason}</span>}
            </span>
            <KeyCaps def={d} keys={effectiveKeys(d, overrides)} platform={platform} />
        </div>
    );
}

export function ShortcutHelpSheet({
    panel,
    role,
    onClose,
}: {
    panel: string | null;
    role: WindowRole;
    onClose: () => void;
}) {
    const { overrides, platform } = useShortcutState();
    const risk = useRiskSettings();
    const [query, setQuery] = useState('');
    const [onlyNow, setOnlyNow] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    useEscClose(onClose);
    useEffect(() => {
        inputRef.current?.focus();
        return holdKeyboard();
    }, []);

    const ctx = useMemo(() => ({ panel, escCancelAll: risk.escCancelAll, role }), [panel, risk.escCancelAll, role]);
    const rows = useMemo(() => {
        const q = query.trim().toLowerCase();
        return forPlatform(platform)
            .map((d) => ({ d, avail: availability(d, ctx) }))
            .filter(({ avail }) => !onlyNow || avail.state === 'now')
            .filter(({ d }) => {
                if (!q) return true;
                const keys = effectiveKeys(d, overrides).map((k) => chordText(k, platform)).join(' ');
                return [d.label, d.hint ?? '', CATEGORY_LABEL[d.category], SCOPE_LABEL[d.scope], keys, d.gesture ?? ''].join(' ').toLowerCase().includes(q);
            });
    }, [ctx, onlyNow, overrides, platform, query]);

    const scope = panel ? PANEL_SCOPE[panel] : undefined;
    const lead = new Set(scope ? SCOPE_CATEGORIES[scope] ?? [] : []);
    const order = [...CATEGORY_ORDER].sort((a, b) => Number(lead.has(b)) - Number(lead.has(a)));
    const groups = order.map((c) => ({ c, items: rows.filter((r) => r.d.category === c) })).filter((g) => g.items.length);
    const label = panelLabel(panel);
    const helpKey = effectiveKeys(forPlatform(platform).find((d) => d.id === 'help.open')!, overrides)[0];

    return (
        <>
            <div className={styles.overlay} onClick={onClose} />
            <div className={styles.sheet} role='dialog' aria-modal='true' aria-label='快捷鍵'>
                <div className={styles.sheetHead}>
                    <span className={styles.sheetTitle}>
                        <span className={styles.sheetTitleIcon}>
                            <Keyboard size={15} />
                        </span>
                        快捷鍵
                    </span>
                    <label className={styles.searchWrap}>
                        <Search size={13} />
                        <input
                            ref={inputRef}
                            className={styles.searchInput}
                            placeholder='搜尋操作或按鍵，例如 刪單、畫圖、Esc'
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                        />
                    </label>
                    {label ? (
                        <span className={styles.context} title='依目前選取的面板排序'>
                            <span className={styles.contextDot} /> 目前面板：{label}
                        </span>
                    ) : (
                        <span className={styles.context}>未選取面板</span>
                    )}
                    <button className={styles.chip[onlyNow ? 'on' : 'off']} aria-pressed={onlyNow} onClick={() => setOnlyNow((v) => !v)}>
                        只看現在可用
                    </button>
                    <button className={styles.iconBtn} aria-label='關閉' title='關閉（Esc）' onClick={onClose}>
                        <X size={14} />
                    </button>
                </div>
                <div className={styles.sheetBody}>
                    {groups.map(({ c, items }) => {
                        const Icon = CATEGORY_ICON[c];
                        return (
                            <section key={c} className={`${styles.card} ${lead.has(c) ? styles.cardLead : ''}`}>
                                <div className={styles.cardHead}>
                                    <span className={styles.cardIcon}>
                                        <Icon size={13} />
                                    </span>
                                    {CATEGORY_LABEL[c]}
                                    <span className={styles.spacer} />
                                    {lead.has(c) && <span className={styles.badge.accent}>目前面板</span>}
                                </div>
                                {items.map(({ d, avail }) => (
                                    <HelpRow key={d.id} d={d} avail={avail} />
                                ))}
                            </section>
                        );
                    })}
                    {!groups.length && (
                        <div className={styles.empty}>
                            <Search size={16} /> 沒有符合的快捷鍵
                        </div>
                    )}
                </div>
                <div className={styles.sheetFoot}>
                    <span className={styles.footItem}>
                        {helpKey ? chordText(helpKey, platform) : ''} 開關 · Esc 關閉
                    </span>
                    <span className={styles.footSafety}>
                        <ShieldCheck size={12} /> 下單相關按鍵只切方向或撤單，不會直接送單
                    </span>
                    <span className={styles.spacer} />
                    {role === 'main' ? (
                        <button
                            className={styles.textBtn}
                            onClick={() => {
                                onClose();
                                emitShortcut({ id: 'settings.open', tab: 'shortcuts' });
                            }}
                        >
                            <Settings size={12} /> 修改快捷鍵 <ArrowRight size={11} />
                        </button>
                    ) : (
                        <span className={styles.footItem}>交易按鍵只在主視窗作用 · 改鍵請到主視窗 設定 → 快捷鍵</span>
                    )}
                </div>
            </div>
        </>
    );
}

// 主視窗與彈出視窗各掛一個。popoutPanel：彈出視窗的面板類型（視為目前面板）
export function ShortcutHelpHost({ popoutPanel }: { popoutPanel?: string | null }) {
    const [open, setOpen] = useState(false);
    const openRef = useRef(false);
    openRef.current = open;
    const focused = useSyncExternalStore(subscribeFocusedPanel, getFocusedPanel, getFocusedPanel);
    const role = currentWindowRole();

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.repeat || !matchesShortcut('help.open', e)) return;
            // 正在錄製新按鍵：讓錄製元件收到這個組合
            if (!openRef.current && keyboardHeld()) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            setOpen((v) => !v);
        };
        window.addEventListener('keydown', onKey, true);
        const off = onShortcut('help.open', () => setOpen(true));
        return () => {
            window.removeEventListener('keydown', onKey, true);
            off();
        };
    }, []);

    if (!open) return null;
    const panel = popoutPanel ?? focused?.type ?? null;
    return <ShortcutHelpSheet panel={panel} role={role} onClose={() => setOpen(false)} />;
}
