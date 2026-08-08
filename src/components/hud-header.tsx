// src/components/hud-header.tsx — top status bar. 主題/帳號/版面/風控規則
// 都收斂進統一設定 dialog（settings-dialog.tsx）；header 只留高頻操作：
// 伺服器狀態、Kill Switch（一鍵鎖定/解鎖）、新增面板、閃電全開、設定。

import { LayoutGrid, Lock, Settings, Unlock, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useStreamStatus } from '../hooks/use-stream';
import { useHeaderItems } from '../lib/header-items';
import { setRiskSettings, useRiskSettings } from '../lib/risk';
import { fetchInfo } from '../lib/shioaji';
import { maskMoney, usePrivacyMoney } from '../lib/privacy';
import {
    appVersion,
    checkForUpdates,
    listenTrayEvents,
    openFlashTiles,
    type FlashTileLayout,
} from '../lib/tauri';
import { fmtMoney } from '../lib/utils/format';
import type { Profile, Workspace } from '../lib/workspace';
import { LayoutLibrary } from './layout-library';
import { MarketBar } from './market-bar';
import { ServerManager } from './server-manager';
import { SettingsDialog } from './settings-dialog';
import * as styles from './hud-header.css';

const STATUS_LABEL = {
    live: 'LIVE',
    connecting: 'SYNC',
    down: 'LOST',
} as const;

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

// Kill Switch 一鍵可達：鎖定中紅色＋脈動，一鍵解鎖。規則設定在設定 dialog
// 的風控分類（同一 useRiskSettings store，兩處自然同步）。
function KillSwitchButton() {
    const risk = useRiskSettings();
    return (
        <button
            className={risk.locked ? styles.killHeaderOn : styles.resetBtn}
            title={
                risk.locked
                    ? '風控鎖定中 — 點擊解除鎖定（恢復下單）'
                    : '鎖定下單 Kill Switch（規則設定在「設定 → 風控」）'
            }
            onClick={() => setRiskSettings({ locked: !risk.locked })}
        >
            {risk.locked ? (
                <>
                    <Unlock size={11} style={{ verticalAlign: '-1px' }} />{' '}
                    風控鎖定
                </>
            ) : (
                <>
                    <Lock size={11} style={{ verticalAlign: '-1px' }} /> 風控
                </>
            )}
        </button>
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
    currentWorkspace,
    onSaveProfile,
    onLoadProfile,
    onDeleteProfile,
    onRenameProfile,
    onResetWorkspace,
    onLoadPreset,
    flashCodes = [],
}: {
    accBalance?: number;
    onOpenPanelLibrary: () => void;
    flashCodes?: string[];
    profiles: Profile[];
    currentWorkspace: Workspace;
    onSaveProfile: (name: string, icon?: string) => void;
    onLoadProfile: (name: string) => void;
    onDeleteProfile: (name: string) => void;
    onRenameProfile: (oldName: string, newName: string) => void;
    onResetWorkspace: () => void;
    onLoadPreset: (name: string) => void;
}) {
    const streamStatus = useStreamStatus();
    const privMoney = usePrivacyMoney();
    const headerItems = useHeaderItems();
    const [simulation, setSimulation] = useState<boolean | null>(null);
    const [appVer, setAppVer] = useState('');
    const [now, setNow] = useState(() => new Date());
    const [serverMgrOpen, setServerMgrOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [layoutLibOpen, setLayoutLibOpen] = useState(false);

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

            {headerItems.bankBalance && accBalance !== undefined && (
                <div className={styles.chip}>
                    <span className={styles.chipLabel}>銀行水位</span>
                    <span>{maskMoney(fmtMoney(accBalance), privMoney)}</span>
                </div>
            )}

            {headerItems.liveStatus && (
                <div className={styles.chip}>
                    <span className={styles.led[streamStatus]} />
                    <span>{STATUS_LABEL[streamStatus]}</span>
                </div>
            )}

            <ServerManager
                open={serverMgrOpen}
                onToggle={setServerMgrOpen}
            />
            <KillSwitchButton />
            <button
                className={styles.resetBtn}
                onClick={onOpenPanelLibrary}
            >
                ＋ 新增面板
            </button>
            {headerItems.layoutLibrary && (
                <button
                    className={styles.resetBtn}
                    title='版面庫（預設版面/我的版面/儲存目前版面）'
                    onClick={() => setLayoutLibOpen(true)}
                >
                    <LayoutGrid size={11} style={{ verticalAlign: '-1px' }} />{' '}
                    版面
                </button>
            )}
            {headerItems.flashAll && flashCodes.length > 0 && (
                <FlashTilesMenu flashCodes={flashCodes} />
            )}
            <button
                className={styles.resetBtn}
                title='設定（外觀/音效與隱私/帳號/風控/版面）'
                onClick={() => setSettingsOpen(true)}
            >
                <Settings size={11} style={{ verticalAlign: '-1px' }} /> 設定
            </button>
            <SettingsDialog
                open={settingsOpen}
                onClose={() => setSettingsOpen(false)}
                onResetWorkspace={onResetWorkspace}
                onOpenLayoutLibrary={() => setLayoutLibOpen(true)}
            />
            <LayoutLibrary
                open={layoutLibOpen}
                onClose={() => setLayoutLibOpen(false)}
                profiles={profiles}
                currentWorkspace={currentWorkspace}
                onSaveProfile={onSaveProfile}
                onLoadProfile={onLoadProfile}
                onDeleteProfile={onDeleteProfile}
                onRenameProfile={onRenameProfile}
                onLoadPreset={onLoadPreset}
            />

            {headerItems.clock && (
                <span className={styles.clock}>
                    {now.toLocaleTimeString('en-GB', { hour12: false })}
                </span>
            )}
        </header>
    );
}
