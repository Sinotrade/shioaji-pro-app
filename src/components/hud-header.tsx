// src/components/hud-header.tsx — top status bar with workspace menus

import { Eye, EyeOff, Lock, Unlock, Volume2, VolumeX, X, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useStreamStatus } from '../hooks/use-stream';
import {
    ensureAccounts,
    selectAccount,
    useAccounts,
} from '../lib/account-store';
import {
    getDailyPnl,
    setRiskSettings,
    useRiskSettings,
} from '../lib/risk';
import { fetchInfo } from '../lib/shioaji';
import {
    maskAccountId,
    maskMoney,
    maskName,
    setPrivacyMode,
    setPrivacyMoney,
    usePrivacyMode,
    usePrivacyMoney,
} from '../lib/privacy';
import { setSoundEnabled, soundEnabled } from '../lib/sounds';
import {
    setToastScale,
    useToastScale,
    type ToastScale,
} from '../lib/toast-prefs';
import {
    setThemeSettings,
    useThemeSettings,
    type Convention,
    type FontScale,
    type ThemeMode,
} from '../lib/theme-store';
import {
    appVersion,
    checkForUpdates,
    listenTrayEvents,
    openFlashTiles,
    type FlashTileLayout,
} from '../lib/tauri';
import { fmtMoney } from '../lib/utils/format';
import { LAYOUT_PRESETS } from '../lib/workspace';
import { MarketBar } from './market-bar';
import { ServerManager } from './server-manager';
import * as panel from './panel.css';
import * as styles from './hud-header.css';

const STATUS_LABEL = {
    live: 'LIVE',
    connecting: 'SYNC',
    down: 'LOST',
} as const;

const MODE_OPTIONS: { key: ThemeMode; label: string }[] = [
    { key: 'dark', label: '深色' },
    { key: 'midnight', label: '純黑' },
    { key: 'light', label: '淺色' },
];

const CONVENTION_OPTIONS: { key: Convention; label: string }[] = [
    { key: 'tw', label: '紅漲綠跌' },
    { key: 'intl', label: '綠漲紅跌' },
];

function Menu({
    label,
    children,
}: {
    label: React.ReactNode;
    children: (close: () => void) => React.ReactNode;
}) {
    const [open, setOpen] = useState(false);
    return (
        <div className={styles.settingsWrap}>
            <button
                className={styles.resetBtn}
                onClick={() => setOpen((o) => !o)}
            >
                {label}
            </button>
            {open && (
                <>
                    <div
                        className={styles.popoverBackdrop}
                        onClick={() => setOpen(false)}
                    />
                    <div className={styles.popover}>
                        {children(() => setOpen(false))}
                    </div>
                </>
            )}
        </div>
    );
}

function ThemeSettings() {
    const settings = useThemeSettings();
    const [sound, setSound] = useState(soundEnabled());
    const priv = usePrivacyMode();
    const privMoney = usePrivacyMoney();
    const toastScale = useToastScale();
    return (
        <Menu label='主題'>
            {() => (
                <>
                    <span className={styles.settingLabel}>主題 Theme</span>
                    <div className={styles.settingGroup}>
                        {MODE_OPTIONS.map((m) => (
                            <button
                                key={m.key}
                                className={
                                    styles.opt[
                                        settings.mode === m.key ? 'on' : 'off'
                                    ]
                                }
                                onClick={() =>
                                    setThemeSettings({ mode: m.key })
                                }
                            >
                                {m.label}
                            </button>
                        ))}
                    </div>
                    <span className={styles.settingLabel}>
                        漲跌顏色 Price Colors
                    </span>
                    <div className={styles.settingGroup}>
                        {CONVENTION_OPTIONS.map((c) => (
                            <button
                                key={c.key}
                                className={
                                    styles.opt[
                                        settings.convention === c.key
                                            ? 'on'
                                            : 'off'
                                    ]
                                }
                                onClick={() =>
                                    setThemeSettings({ convention: c.key })
                                }
                            >
                                {c.label}
                            </button>
                        ))}
                    </div>
                    <div className={styles.convPreview}>
                        <span className={panel.dirText.up}>▲ +1.25 上漲</span>
                        <span className={panel.dirText.down}>
                            ▼ -1.25 下跌
                        </span>
                    </div>
                    <span className={styles.settingLabel}>字級 Font Size</span>
                    <div className={styles.settingGroup}>
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
                                    styles.opt[
                                        settings.fontScale === scale
                                            ? 'on'
                                            : 'off'
                                    ]
                                }
                                onClick={() =>
                                    setThemeSettings({ fontScale: scale })
                                }
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                    <span className={styles.settingLabel}>
                        通知大小 Toast Size
                    </span>
                    <div className={styles.settingGroup}>
                        {(
                            [
                                [0.9, '小'],
                                [1, '標準'],
                                [1.25, '大'],
                            ] as [ToastScale, string][]
                        ).map(([scale, label]) => (
                            <button
                                key={scale}
                                className={
                                    styles.opt[
                                        toastScale === scale ? 'on' : 'off'
                                    ]
                                }
                                onClick={() => setToastScale(scale)}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                    <span className={styles.settingLabel}>音效 Sound</span>
                    <button
                        className={styles.opt[sound ? 'on' : 'off']}
                        onClick={() => {
                            setSoundEnabled(!sound);
                            setSound(!sound);
                        }}
                    >
                        {sound ? (
                            <>
                                <Volume2 size={11} style={{ verticalAlign: '-1px' }} />{' '}
                                成交/警示音效開啟
                            </>
                        ) : (
                            <>
                                <VolumeX size={11} style={{ verticalAlign: '-1px' }} />{' '}
                                音效關閉
                            </>
                        )}
                    </button>
                    <span className={styles.settingLabel}>
                        隱私 Privacy
                    </span>
                    <button
                        className={styles.opt[priv ? 'on' : 'off']}
                        title='截圖/分享畫面時遮蔽帳號號碼與姓名'
                        onClick={() => setPrivacyMode(!priv)}
                    >
                        {priv ? (
                            <>
                                <EyeOff size={11} style={{ verticalAlign: '-1px' }} />{' '}
                                帳號已遮蔽
                            </>
                        ) : (
                            <>
                                <Eye size={11} style={{ verticalAlign: '-1px' }} />{' '}
                                顯示完整帳號
                            </>
                        )}
                    </button>
                    <button
                        className={styles.opt[privMoney ? 'on' : 'off']}
                        title='遮蔽水位/數量/損益/權益等金額（炫耀截圖用）'
                        onClick={() => setPrivacyMoney(!privMoney)}
                    >
                        {privMoney ? (
                            <>
                                <EyeOff size={11} style={{ verticalAlign: '-1px' }} />{' '}
                                金額已遮蔽
                            </>
                        ) : (
                            <>
                                <Eye size={11} style={{ verticalAlign: '-1px' }} />{' '}
                                顯示完整金額
                            </>
                        )}
                    </button>
                </>
            )}
        </Menu>
    );
}

function AccountMenu() {
    const { accounts, selectedStock, selectedFutures, loaded } = useAccounts();
    const priv = usePrivacyMode();
    useEffect(ensureAccounts, []);
    if (!loaded || accounts.length === 0) return null;
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
        <Menu label='帳號'>
            {() => (
                <>
                    {groups.map((g) => {
                        const list = accounts.filter(
                            (a) => a.account_type === g.type,
                        );
                        if (list.length === 0) return null;
                        return (
                            <div key={g.type}>
                                <span className={styles.settingLabel}>
                                    {g.label}
                                </span>
                                {list.map((a) => {
                                    const key = `${a.broker_id}-${a.account_id}`;
                                    return (
                                        <button
                                            key={key}
                                            className={
                                                styles.opt[
                                                    g.selected === key
                                                        ? 'on'
                                                        : 'off'
                                                ]
                                            }
                                            style={{
                                                width: '100%',
                                                marginTop: 4,
                                            }}
                                            onClick={() => selectAccount(a)}
                                        >
                                            {a.broker_id}-
                                            {maskAccountId(
                                                a.account_id,
                                                priv,
                                            )}
                                            （{maskName(a.username, priv)}）
                                        </button>
                                    );
                                })}
                            </div>
                        );
                    })}
                    <span className={styles.emptyHint}>
                        下單與帳務查詢都使用選定的帳號
                    </span>
                </>
            )}
        </Menu>
    );
}

function RiskMenu() {
    const risk = useRiskSettings();
    const dailyPnl = getDailyPnl();
    return (
        <Menu
            label={
                risk.locked ? (
                    <>
                        <Lock size={11} style={{ verticalAlign: '-1px' }} /> 風控鎖定
                    </>
                ) : (
                    '風控'
                )
            }
        >
            {() => (
                <>
                    <button
                        className={
                            risk.locked
                                ? styles.killBtnOn
                                : styles.killBtnOff
                        }
                        onClick={() =>
                            setRiskSettings({ locked: !risk.locked })
                        }
                    >
                        {risk.locked
                            ? (
                                  <>
                                      <Unlock size={11} style={{ verticalAlign: '-1px' }} />{' '}
                                      解除鎖定（恢復下單）
                                  </>
                              )
                            : (
                                  <>
                                      <Lock size={11} style={{ verticalAlign: '-1px' }} />{' '}
                                      鎖定下單 Kill Switch
                                  </>
                              )}
                    </button>
                    <span className={styles.settingLabel}>
                        風控規則 Rules
                    </span>
                    <button
                        className={
                            styles.opt[risk.enabled ? 'on' : 'off']
                        }
                        onClick={() =>
                            setRiskSettings({ enabled: !risk.enabled })
                        }
                    >
                        {risk.enabled ? '✓ 規則啟用中' : '啟用風控規則'}
                    </button>
                    <div className={styles.saveRow}>
                        <span className={styles.riskLabel}>單筆上限</span>
                        <input
                            className={styles.saveInput}
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
                    <div className={styles.saveRow}>
                        <span className={styles.riskLabel}>日虧上限</span>
                        <input
                            className={styles.saveInput}
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
                    <span className={styles.emptyHint}>
                        目前當日損益估算：{Math.round(dailyPnl).toLocaleString()}
                        （持倉未實現＋期貨平倉）
                        <br />
                        停損/停利觸價單不受風控封鎖。
                    </span>
                </>
            )}
        </Menu>
    );
}

function ProfilesMenu({
    profiles,
    onSaveProfile,
    onLoadProfile,
    onDeleteProfile,
    onResetWorkspace,
    onLoadPreset,
}: {
    profiles: string[];
    onSaveProfile: (name: string) => void;
    onLoadProfile: (name: string) => void;
    onDeleteProfile: (name: string) => void;
    onResetWorkspace: () => void;
    onLoadPreset: (name: string) => void;
}) {
    const [name, setName] = useState('');
    return (
        <Menu label='版面'>
            {(close) => (
                <>
                    <span className={styles.settingLabel}>
                        預設版面 Presets
                    </span>
                    {LAYOUT_PRESETS.map((p) => (
                        <button
                            key={p.name}
                            className={styles.menuItem}
                            title={p.desc}
                            onClick={() => {
                                onLoadPreset(p.name);
                                close();
                            }}
                        >
                            {p.name}
                            <span className={styles.presetDesc}>
                                {p.desc}
                            </span>
                        </button>
                    ))}
                    <span className={styles.settingLabel}>
                        儲存目前版面 Save Layout
                    </span>
                    <div className={styles.saveRow}>
                        <input
                            className={styles.saveInput}
                            placeholder='版面名稱'
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && name.trim()) {
                                    onSaveProfile(name.trim());
                                    setName('');
                                }
                            }}
                        />
                        <button
                            className={styles.resetBtn}
                            disabled={!name.trim()}
                            onClick={() => {
                                if (name.trim()) {
                                    onSaveProfile(name.trim());
                                    setName('');
                                }
                            }}
                        >
                            儲存
                        </button>
                    </div>
                    <span className={styles.settingLabel}>
                        版面列表 Saved Layouts
                    </span>
                    {profiles.length === 0 && (
                        <span className={styles.emptyHint}>
                            尚無儲存的版面
                        </span>
                    )}
                    {profiles.map((p) => (
                        <div key={p} className={styles.profileRow}>
                            <button
                                className={styles.menuItem}
                                style={{ flex: 1 }}
                                onClick={() => {
                                    onLoadProfile(p);
                                    close();
                                }}
                            >
                                {p}
                            </button>
                            <button
                                className={styles.profileDelete}
                                title='刪除此版面'
                                onClick={() => onDeleteProfile(p)}
                            >
                                <X size={10} />
                            </button>
                        </div>
                    ))}
                    <button
                        className={styles.menuItem}
                        onClick={() => {
                            onResetWorkspace();
                            close();
                        }}
                    >
                        ↺ 重設為預設版面
                    </button>
                </>
            )}
        </Menu>
    );
}

// ⚡全開 layout picker: thumbnails first, windows open per the chosen
// arrangement. Flash ladders are tall and narrow, so the practical
// layouts are full-height strips side by side.
const FLASH_LAYOUTS: (FlashTileLayout & { key: string; label: string })[] = [
    { key: 's8', label: '8 長條', cols: 8, rows: 1, region: 'full' },
    { key: 's6', label: '6 長條', cols: 6, rows: 1, region: 'full' },
    { key: 's4', label: '4 長條', cols: 4, rows: 1, region: 'full' },
    { key: 's3', label: '3 長條', cols: 3, rows: 1, region: 'full' },
    { key: 'right4', label: '右側直欄', cols: 1, rows: 4, region: 'right' },
];

function FlashThumb({ layout }: { layout: FlashTileLayout }) {
    const regionStyle: React.CSSProperties =
        layout.region === 'right'
            ? { top: 1, bottom: 1, right: 1, width: '26%' }
            : layout.region === 'bottom'
              ? { left: 1, right: 1, bottom: 1, height: '34%' }
              : { inset: 1 };
    return (
        <span className={styles.flashThumb}>
            <span
                className={styles.flashThumbRegion}
                style={{
                    ...regionStyle,
                    gridTemplateColumns: `repeat(${layout.cols}, 1fr)`,
                    gridTemplateRows: `repeat(${layout.rows}, 1fr)`,
                }}
            >
                {Array.from({ length: layout.cols * layout.rows }).map(
                    (_, i) => (
                        <span key={i} className={styles.flashThumbCell} />
                    ),
                )}
            </span>
        </span>
    );
}

function FlashTilesMenu({ flashCodes }: { flashCodes: string[] }) {
    return (
        <Menu
            label={
                <>
                    <Zap size={11} style={{ verticalAlign: '-1px' }} /> 全開
                </>
            }
        >
            {(close) => (
                <>
                    <span className={styles.settingLabel}>
                        閃電下單全開 — 選擇排版
                    </span>
                    {FLASH_LAYOUTS.map((lay) => {
                        const count = Math.min(
                            flashCodes.length,
                            lay.cols * lay.rows,
                        );
                        return (
                            <button
                                key={lay.key}
                                className={styles.flashLayoutItem}
                                onClick={() => {
                                    close();
                                    void openFlashTiles(flashCodes, lay);
                                }}
                            >
                                <FlashThumb layout={lay} />
                                <span className={styles.flashLayoutLabel}>
                                    {lay.label}
                                    <span className={styles.presetDesc}>
                                        自選前 {count} 檔
                                    </span>
                                </span>
                            </button>
                        );
                    })}
                </>
            )}
        </Menu>
    );
}

export function HudHeader({
    accBalance,
    onOpenPanelLibrary,
    profiles,
    onSaveProfile,
    onLoadProfile,
    onDeleteProfile,
    onResetWorkspace,
    onLoadPreset,
    flashCodes = [],
}: {
    accBalance?: number;
    onOpenPanelLibrary: () => void;
    flashCodes?: string[];
    profiles: string[];
    onSaveProfile: (name: string) => void;
    onLoadProfile: (name: string) => void;
    onDeleteProfile: (name: string) => void;
    onResetWorkspace: () => void;
    onLoadPreset: (name: string) => void;
}) {
    const streamStatus = useStreamStatus();
    const privMoney = usePrivacyMoney();
    const [simulation, setSimulation] = useState<boolean | null>(null);
    const [appVer, setAppVer] = useState('');
    const [now, setNow] = useState(() => new Date());
    const [serverMgrOpen, setServerMgrOpen] = useState(false);

    useEffect(() => {
        let cleanup: (() => void) | undefined;
        listenTrayEvents(() => setServerMgrOpen(true)).then((un) => {
            cleanup = un;
        });
        const t = setTimeout(() => checkForUpdates(true), 8000);
        return () => {
            cleanup?.();
            clearTimeout(t);
        };
    }, []);

    useEffect(() => {
        void appVersion().then(setAppVer);
    }, []);

    useEffect(() => {
        // retry until the server answers — a one-shot fetch loses the race
        // against a daemon that is still starting after an app update
        let done = false;
        const load = () =>
            fetchInfo()
                .then((info) => {
                    done = true;
                    clearInterval(retry);
                    setSimulation(info.simulation);
                })
                .catch(() => undefined);
        const retry = setInterval(() => {
            if (!done) void load();
        }, 5000);
        void load();
        const t = setInterval(() => setNow(new Date()), 1000);
        return () => {
            clearInterval(t);
            clearInterval(retry);
        };
    }, []);

    return (
        <header className={styles.header}>
            <div className={styles.logoBlock}>
                <span className={styles.logoMain}>Shioaji Pro</span>
                <span className={styles.logoSub}>
                    交易終端
                    {appVer &&
                        ` · ${appVer === 'dev' ? 'Dev' : `App v${appVer}`}`}
                </span>
            </div>

            {simulation !== null &&
                (simulation ? (
                    <span className={styles.simBadge}>模擬環境</span>
                ) : (
                    <span className={styles.prodBadge}>正式環境</span>
                ))}

            <MarketBar />

            <div className={styles.spacer} />

            {accBalance !== undefined && (
                <div className={styles.chip}>
                    <span className={styles.chipLabel}>銀行水位</span>
                    <span>{maskMoney(fmtMoney(accBalance), privMoney)}</span>
                </div>
            )}

            <div className={styles.chip}>
                <span className={styles.led[streamStatus]} />
                <span>{STATUS_LABEL[streamStatus]}</span>
            </div>

            <ServerManager
                open={serverMgrOpen}
                onToggle={setServerMgrOpen}
            />
            <AccountMenu />
            <RiskMenu />
            <button
                className={styles.resetBtn}
                onClick={onOpenPanelLibrary}
            >
                ＋ 新增面板
            </button>
            {flashCodes.length > 0 && (
                <FlashTilesMenu flashCodes={flashCodes} />
            )}
            <ProfilesMenu
                profiles={profiles}
                onSaveProfile={onSaveProfile}
                onLoadProfile={onLoadProfile}
                onDeleteProfile={onDeleteProfile}
                onResetWorkspace={onResetWorkspace}
                onLoadPreset={onLoadPreset}
            />
            <ThemeSettings />

            <span className={styles.clock}>
                {now.toLocaleTimeString('en-GB', { hour12: false })}
            </span>
        </header>
    );
}
