// src/components/settings-dialog.tsx — 統一設定面板：外觀／音效與隱私／
// 帳號／風控／版面 五分類。原本散在 header 的主題/帳號/版面 popover 全數
// 收斂到這裡；風控「規則」也在此（Kill Switch 留在 header，一鍵可達）。

import {
    LayoutGrid,
    Palette,
    RefreshCw,
    ShieldAlert,
    UserRound,
    Volume2,
    X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import {
    ensureAccounts,
    refreshAccounts,
    selectAccount,
    useAccounts,
} from '../lib/account-store';
import {
    HEADER_ITEMS,
    setHeaderItem,
    useHeaderItems,
} from '../lib/header-items';
import {
    maskAccountId,
    maskMoney,
    maskName,
    setPrivacyMode,
    setPrivacyMoney,
    usePrivacyMode,
    usePrivacyMoney,
} from '../lib/privacy';
import {
    getDailyPnl,
    setRiskSettings,
    useRiskSettings,
} from '../lib/risk';
import { setSoundEnabled, soundEnabled } from '../lib/sounds';
import {
    setThemeSettings,
    useThemeSettings,
    type Convention,
    type FontScale,
    type ThemeMode,
} from '../lib/theme-store';
import {
    setToastScale,
    useToastScale,
    type ToastScale,
} from '../lib/toast-prefs';
import { Orb } from './orb';
import * as hud from './hud-header.css';
import * as panel from './panel.css';
import * as styles from './settings-dialog.css';

const MODE_OPTIONS: { key: ThemeMode; label: string }[] = [
    { key: 'dark', label: '深色' },
    { key: 'midnight', label: '純黑' },
    { key: 'light', label: '淺色' },
];

const CONVENTION_OPTIONS: { key: Convention; label: string }[] = [
    { key: 'tw', label: '紅漲綠跌' },
    { key: 'intl', label: '綠漲紅跌' },
];

type SettingsTab = 'appearance' | 'soundPrivacy' | 'accounts' | 'risk' | 'layout';

const TABS: { key: SettingsTab; label: string; icon: React.ReactNode }[] = [
    { key: 'appearance', label: '外觀', icon: <Palette size={13} /> },
    { key: 'soundPrivacy', label: '音效與隱私', icon: <Volume2 size={13} /> },
    { key: 'accounts', label: '帳號', icon: <UserRound size={13} /> },
    { key: 'risk', label: '風控', icon: <ShieldAlert size={13} /> },
    { key: 'layout', label: '版面', icon: <LayoutGrid size={13} /> },
];

function AppearanceSection() {
    const settings = useThemeSettings();
    const toastScale = useToastScale();
    const headerItems = useHeaderItems();
    return (
        <>
            <span className={hud.settingLabel}>主題 Theme</span>
            <div className={hud.settingGroup}>
                {MODE_OPTIONS.map((m) => (
                    <button
                        key={m.key}
                        className={hud.opt[settings.mode === m.key ? 'on' : 'off']}
                        onClick={() => setThemeSettings({ mode: m.key })}
                    >
                        {m.label}
                    </button>
                ))}
            </div>
            <span className={hud.settingLabel}>漲跌顏色 Price Colors</span>
            <div className={hud.settingGroup}>
                {CONVENTION_OPTIONS.map((c) => (
                    <button
                        key={c.key}
                        className={
                            hud.opt[settings.convention === c.key ? 'on' : 'off']
                        }
                        onClick={() => setThemeSettings({ convention: c.key })}
                    >
                        {c.label}
                    </button>
                ))}
            </div>
            <div className={hud.convPreview}>
                <span className={panel.dirText.up}>▲ +1.25 上漲</span>
                <span className={panel.dirText.down}>▼ -1.25 下跌</span>
            </div>
            <span className={hud.settingLabel}>字級 Font Size</span>
            <div className={hud.settingGroup}>
                {(
                    [
                        [0.85, '小'],
                        [1, '標準'],
                        [1.15, '大'],
                        [1.3, '特大'],
                    ] as [FontScale, string][]
                ).map(([scale, label]) => (
                    <button
                        key={scale}
                        className={
                            hud.opt[settings.fontScale === scale ? 'on' : 'off']
                        }
                        onClick={() => setThemeSettings({ fontScale: scale })}
                    >
                        {label}
                    </button>
                ))}
            </div>
            <span className={hud.settingLabel}>通知大小 Toast Size</span>
            <div className={hud.settingGroup}>
                {(
                    [
                        [0.9, '小'],
                        [1, '標準'],
                        [1.25, '大'],
                    ] as [ToastScale, string][]
                ).map(([scale, label]) => (
                    <button
                        key={scale}
                        className={hud.opt[toastScale === scale ? 'on' : 'off']}
                        onClick={() => setToastScale(scale)}
                    >
                        {label}
                    </button>
                ))}
            </div>
            <span className={hud.settingLabel}>頂欄顯示 Header Items</span>
            {HEADER_ITEMS.map((item) => (
                <div key={item.key} className={hud.switchRow}>
                    <span className={hud.switchLabel}>{item.label}</span>
                    <button
                        className={
                            hud.switchTrack[
                                headerItems[item.key] ? 'on' : 'off'
                            ]
                        }
                        title={
                            headerItems[item.key]
                                ? `隱藏頂欄「${item.label}」`
                                : `顯示頂欄「${item.label}」`
                        }
                        onClick={() =>
                            setHeaderItem(item.key, !headerItems[item.key])
                        }
                    />
                </div>
            ))}
            <span className={hud.emptyHint}>
                logo、環境徽章、伺服器、風控、新增面板與設定為固定項目，
                無法隱藏。
            </span>
        </>
    );
}

function SoundPrivacySection() {
    const [sound, setSound] = useState(soundEnabled());
    const priv = usePrivacyMode();
    const privMoney = usePrivacyMoney();
    return (
        <>
            <span className={hud.settingLabel}>音效 Sound</span>
            <div className={hud.switchRow}>
                <span className={hud.switchLabel}>成交/警示音效</span>
                <button
                    className={hud.switchTrack[sound ? 'on' : 'off']}
                    title={sound ? '關閉音效' : '開啟成交/警示音效'}
                    onClick={() => {
                        setSoundEnabled(!sound);
                        setSound(!sound);
                    }}
                />
            </div>
            <span className={hud.settingLabel}>隱私 Privacy</span>
            <div className={hud.switchRow}>
                <span
                    className={hud.switchLabel}
                    title='截圖/分享畫面時遮蔽帳號號碼與姓名'
                >
                    帳號遮蔽
                </span>
                <button
                    className={hud.switchTrack[priv ? 'on' : 'off']}
                    title='截圖/分享畫面時遮蔽帳號號碼與姓名'
                    onClick={() => setPrivacyMode(!priv)}
                />
            </div>
            <div className={hud.switchRow}>
                <span
                    className={hud.switchLabel}
                    title='遮蔽水位/數量/損益/權益等金額（炫耀截圖用）'
                >
                    金額遮蔽
                </span>
                <button
                    className={hud.switchTrack[privMoney ? 'on' : 'off']}
                    title='遮蔽水位/數量/損益/權益等金額（炫耀截圖用）'
                    onClick={() => setPrivacyMoney(!privMoney)}
                />
            </div>
            <span className={hud.emptyHint}>
                遮蔽只影響畫面顯示，不影響下單與查詢。
            </span>
        </>
    );
}

function AccountsSection() {
    const { accounts, selectedStock, selectedFutures, loaded } = useAccounts();
    const priv = usePrivacyMode();
    const [refreshing, setRefreshing] = useState(false);
    useEffect(ensureAccounts, []);
    const groups: { label: string; type: 'S' | 'F'; selected: string }[] = [
        {
            label: '證券帳戶',
            type: 'S',
            selected: selectedStock
                ? `${selectedStock.broker_id}-${selectedStock.account_id}`
                : '',
        },
        {
            label: '期貨帳戶',
            type: 'F',
            selected: selectedFutures
                ? `${selectedFutures.broker_id}-${selectedFutures.account_id}`
                : '',
        },
    ];
    return (
        <>
            {groups.map((g) => {
                const list = accounts.filter(
                    (a) => a.account_type === g.type,
                );
                if (list.length === 0) return null;
                return (
                    <div key={g.type}>
                        <span className={hud.settingLabel}>{g.label}</span>
                        {list.map((a) => {
                            const key = `${a.broker_id}-${a.account_id}`;
                            return (
                                <button
                                    key={key}
                                    className={`${
                                        hud.opt[
                                            g.selected === key ? 'on' : 'off'
                                        ]
                                    } ${a.signed ? '' : styles.acctUnsigned}`}
                                    style={{ width: '100%', marginTop: 4 }}
                                    disabled={!a.signed}
                                    title={
                                        a.signed
                                            ? undefined
                                            : '未簽署 API 約定書（無法下單）'
                                    }
                                    onClick={() => selectAccount(a)}
                                >
                                    {a.broker_id}-
                                    {maskAccountId(a.account_id, priv)}（
                                    {maskName(a.username, priv)}）
                                    {!a.signed && (
                                        <span className={styles.unsignedTag}>
                                            未簽署（無法下單）
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                );
            })}
            {loaded && accounts.length === 0 && (
                <span className={hud.emptyHint}>
                    尚未取得帳號 — 伺服器就緒後按下方「重新整理帳號」。
                </span>
            )}
            {!loaded && (
                <span className={hud.emptyHint}>載入帳號中…</span>
            )}
            <span className={hud.emptyHint}>
                下單與帳務查詢都使用選定的帳號；未簽署 API
                約定書的帳戶會列出但無法選為下單帳戶。
            </span>
            <button
                className={hud.updateBtn}
                disabled={refreshing}
                onClick={() => {
                    setRefreshing(true);
                    void refreshAccounts().finally(() =>
                        setRefreshing(false),
                    );
                }}
            >
                {refreshing ? (
                    <Orb size={12} variant='ring' />
                ) : (
                    <RefreshCw size={13} />
                )}
                {refreshing ? '重新整理中…' : '重新整理帳號'}
            </button>
        </>
    );
}

function RiskSection() {
    const risk = useRiskSettings();
    const dailyPnl = getDailyPnl();
    // 金額遮蔽也要蓋住這裡的損益估算 — 隱私開關不該在設定 dialog 裡漏底
    const privMoney = usePrivacyMoney();
    return (
        <>
            <span className={hud.settingLabel}>風控規則 Rules</span>
            <div className={hud.switchRow}>
                <span className={hud.switchLabel}>啟用風控規則</span>
                <button
                    className={hud.switchTrack[risk.enabled ? 'on' : 'off']}
                    onClick={() =>
                        setRiskSettings({ enabled: !risk.enabled })
                    }
                />
            </div>
            <div className={hud.saveRow}>
                <span className={hud.riskLabel}>單筆上限</span>
                <input
                    className={hud.saveInput}
                    inputMode='numeric'
                    value={risk.maxQty || ''}
                    placeholder='不限'
                    onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isInteger(v) && v >= 0) {
                            setRiskSettings({ maxQty: v });
                        }
                    }}
                />
            </div>
            <div className={hud.saveRow}>
                <span className={hud.riskLabel}>日虧上限</span>
                <input
                    className={hud.saveInput}
                    inputMode='numeric'
                    value={risk.maxDailyLoss || ''}
                    placeholder='不限 (TWD)'
                    onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isInteger(v) && v >= 0) {
                            setRiskSettings({ maxDailyLoss: v });
                        }
                    }}
                />
            </div>
            <span className={hud.emptyHint}>
                目前當日損益估算：
                {maskMoney(Math.round(dailyPnl).toLocaleString(), privMoney)}
                （持倉未實現＋期貨平倉）
                <br />
                停損/停利觸價單不受風控封鎖。
                <br />
                Kill Switch（鎖定下單）在畫面右上角「風控」鈕，一鍵鎖定/解鎖。
            </span>
        </>
    );
}

export interface LayoutSectionProps {
    onResetWorkspace: () => void;
    // 開版面庫（presets/save/load/rename/delete 全在版面庫 dialog）
    onOpenLayoutLibrary: () => void;
}

function LayoutSection({
    onResetWorkspace,
    onOpenLayoutLibrary,
    onClose,
}: LayoutSectionProps & { onClose: () => void }) {
    return (
        <>
            <span className={hud.settingLabel}>版面 Layouts</span>
            <button
                className={hud.updateBtn}
                onClick={() => {
                    onClose();
                    onOpenLayoutLibrary();
                }}
            >
                <LayoutGrid size={13} /> 開啟版面庫…
            </button>
            <span className={hud.emptyHint}>
                預設版面、儲存/切換/改名/刪除自訂版面都在版面庫；
                頂欄的「版面」鈕可直接開啟。
            </span>
            <button
                className={hud.menuItem}
                onClick={() => {
                    onResetWorkspace();
                    onClose();
                }}
            >
                ↺ 重設為預設版面
            </button>
        </>
    );
}

export function SettingsDialog({
    open,
    onClose,
    ...layoutProps
}: LayoutSectionProps & {
    open: boolean;
    onClose: () => void;
}) {
    const [tab, setTab] = useState<SettingsTab>('appearance');

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    if (!open) return null;

    return (
        <>
            <div className={styles.backdrop} onClick={onClose} />
            <div className={styles.dialog}>
                <div className={hud.srvDialogTitle}>
                    設定
                    <button
                        className={hud.profileDelete}
                        title='關閉（Esc）'
                        onClick={onClose}
                    >
                        <X size={12} />
                    </button>
                </div>
                <div className={styles.body}>
                    <div className={styles.nav}>
                        {TABS.map((t) => (
                            <button
                                key={t.key}
                                className={
                                    styles.navItem[tab === t.key ? 'on' : 'off']
                                }
                                onClick={() => setTab(t.key)}
                            >
                                {t.icon}
                                {t.label}
                            </button>
                        ))}
                    </div>
                    <div className={styles.content}>
                        {tab === 'appearance' && <AppearanceSection />}
                        {tab === 'soundPrivacy' && <SoundPrivacySection />}
                        {tab === 'accounts' && <AccountsSection />}
                        {tab === 'risk' && <RiskSection />}
                        {tab === 'layout' && (
                            <LayoutSection {...layoutProps} onClose={onClose} />
                        )}
                    </div>
                </div>
            </div>
        </>
    );
}
