import { RefreshButton } from './refresh-button';
// src/components/tray-panel.tsx — compact menu-bar dropdown panel.
// Sections are user-configurable (gear): 持倉損益 / 自選清單 / 排行榜.
// Clicking any symbol focuses the main window and links it everywhere.

import { Maximize2, Settings2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '../hooks/use-query';
import { useQuote } from '../hooks/use-stream';
import type { WatchItem } from '../hooks/use-watchlist';
import { useWatchlist } from '../hooks/use-watchlist';
import { maskMoney, usePrivacyMoney } from '../lib/privacy';
import { isTauri } from '../lib/runtime';
import {
    fetchScanner
} from '../lib/shioaji';
import { getAliasFor } from '../lib/stream';
import { useTradingState } from '../lib/trading-state';
import { queryDisplayState } from '../lib/query-display-state';
import type { ScannerItem } from '../lib/types/market';
import {
    fmtInt,
    fmtPct,
    fmtPrice,
    fmtSigned,
    fmtStockLots,
} from '../lib/utils/format';
import { AsyncStatus } from './async-status';
import * as panel from './panel.css';
import { Sparkline } from './sparkline';
import * as styles from './tray-panel.css';

type SectionKey = 'positions' | 'watchlist' | 'movers';

const SECTIONS: { key: SectionKey; label: string }[] = [
    { key: 'positions', label: '持倉損益' },
    { key: 'watchlist', label: '自選清單' },
    { key: 'movers', label: '排行榜' },
];

const STORE_KEY = 'sj-pro-tray-sections';
const SPARK_KEY = 'sj-pro-tray-spark';

function loadSections(): Set<SectionKey> {
    try {
        const raw = localStorage.getItem(STORE_KEY);
        if (raw) return new Set(JSON.parse(raw));
    } catch {
        // defaults
    }
    return new Set(['positions', 'watchlist']);
}

// focus the main window and link this symbol everywhere
async function pickCode(code: string) {
    if (!isTauri) return;
    try {
        const { emit } = await import('@tauri-apps/api/event');
        await emit('tray-pick-code', code);
        const { WebviewWindow } = await import(
            '@tauri-apps/api/webviewWindow'
        );
        const main = await WebviewWindow.getByLabel('main');
        await main?.show();
        await main?.unminimize();
        await main?.setFocus();
    } catch {
        // main window unavailable
    }
}

function WatchMini({ item, spark }: { item: WatchItem; spark: boolean }) {
    const quote = useQuote(item.contract.code);
    const tick = quote?.tick;
    const index = quote?.index;
    const close = tick
        ? Number(tick.close)
        : index
          ? Number(index.close)
          : item.snapshot?.close;
    const ref = index ? Number(index.reference) : item.contract.reference;
    const pct =
        close !== undefined && ref
            ? ((close - ref) / ref) * 100
            : (item.snapshot?.change_rate ?? 0);
    const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
    return (
        <button
            className={spark ? styles.rowSpark : styles.row}
            onClick={() => void pickCode(item.contract.code)}
        >
            <span className={styles.code}>{item.contract.code}</span>
            <span className={styles.name}>{item.contract.name}</span>
            {spark && (
                <Sparkline
                    contract={item.contract}
                    last={close}
                    reference={ref || undefined}
                    height={18}
                    stretch
                />
            )}
            <span className={`${styles.num} ${panel.dirText[dir]}`}>
                {fmtPrice(close)}
            </span>
            <span className={`${styles.numSm} ${panel.dirText[dir]}`}>
                {fmtPct(pct)}
            </span>
        </button>
    );
}

export function TrayPanel() {
    const [sections, setSections] = useState<Set<SectionKey>>(loadSections);
    const [spark, setSpark] = useState(
        () => localStorage.getItem(SPARK_KEY) !== '0',
    );
    const [gearOpen, setGearOpen] = useState(false);
    const privMoney = usePrivacyMoney();
    const { items, loading: watchlistLoading, loadError: watchlistError } = useWatchlist();

    const portfolio = useTradingState();
    const positionsQuery = portfolio.queries.positions;
    const moversPoll = useQuery<ScannerItem[]>(
        useCallback(
            () =>
                sections.has('movers')
                    ? fetchScanner('ChangePercentRank', 6, true)
                    : Promise.resolve([]),
            [sections],
        ),
        'tray-movers', sections.has('movers'),
    );

    const positions = portfolio.positions;
    const positionsState = queryDisplayState(positionsQuery);
    const positionsFailed = positionsState === 'failed';
    const positionsPending = positionsState === 'loading';
    const totalPnl = positions.reduce((s, p) => s + (p.pnl || 0), 0);
    const topPositions = useMemo(
        () =>
            [...positions]
                .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl))
                .slice(0, 6),
        [positions],
    );

    const toggleSection = (key: SectionKey) => {
        setSections((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            localStorage.setItem(STORE_KEY, JSON.stringify([...next]));
            return next;
        });
    };

    // Esc hides the panel
    useEffect(() => {
        const onKey = async (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || !isTauri) return;
            const { getCurrentWebviewWindow } = await import(
                '@tauri-apps/api/webviewWindow'
            );
            void getCurrentWebviewWindow().hide();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    const pnlDir = totalPnl > 0 ? 'up' : totalPnl < 0 ? 'down' : 'flat';

    return (
        <div className={styles.wrap}>
            <div className={styles.header}>
                <span className={styles.title}>Shioaji Pro</span>
                <span className={`${styles.headPnl} ${panel.dirText[pnlDir]}`}>
                    {positions.length > 0
                        ? `未實現 ${maskMoney(fmtSigned(Math.round(totalPnl), 0), privMoney)}`
                        : ''}
                </span>
                <RefreshButton label="更新排行" loading={moversPoll.loading} onClick={() => void moversPoll.refresh()} />
                <button
                    className={styles.gearBtn}
                    title='自訂顯示內容'
                    onClick={() => setGearOpen((o) => !o)}
                >
                    <Settings2 size={13} />
                </button>
                <button
                    className={styles.gearBtn}
                    title='開啟主視窗'
                    onClick={() => void pickCode('')}
                >
                    <Maximize2 size={13} />
                </button>
            </div>

            {gearOpen && (
                <div className={styles.gearRow}>
                    {SECTIONS.map((s) => (
                        <button
                            key={s.key}
                            className={
                                styles.gearOpt[
                                    sections.has(s.key) ? 'on' : 'off'
                                ]
                            }
                            onClick={() => toggleSection(s.key)}
                        >
                            {sections.has(s.key) ? '✓ ' : ''}
                            {s.label}
                        </button>
                    ))}
                    <button
                        className={styles.gearOpt[spark ? 'on' : 'off']}
                        onClick={() =>
                            setSpark((v) => {
                                localStorage.setItem(SPARK_KEY, v ? '0' : '1');
                                return !v;
                            })
                        }
                    >
                        {spark ? '✓ ' : ''}小線圖
                    </button>
                </div>
            )}

            <div className={styles.scroller}>
                {sections.has('positions') && (
                    <>
                        <span className={styles.sectionTitle}>
                            持倉 [{positionsQuery.updatedAt !== null && !positionsFailed ? positions.length : positions.length > 0 ? `${positions.length}+` : '…'}]
                        </span>
                        {topPositions.length === 0 && (
                            <span className={styles.empty}>
                                <AsyncStatus
                                    phase={positionsPending ? 'loading' : positionsFailed ? 'error' : 'empty'}
                                    text={positionsPending ? '載入持倉…' : positionsFailed ? '持倉尚未確認' : '無持倉'}
                                />
                            </span>
                        )}
                        {topPositions.map((p) => {
                            const dir =
                                p.pnl > 0 ? 'up' : p.pnl < 0 ? 'down' : 'flat';
                            return (
                                <button
                                    key={`${p.code}-${p.id}`}
                                    className={styles.row}
                                    onClick={() =>
                                        void pickCode(
                                            getAliasFor(p.code) ?? p.code,
                                        )
                                    }
                                >
                                    <span className={styles.code}>
                                        {p.code}
                                    </span>
                                    <span className={styles.name}>
                                        {p.direction === 'Buy' ? '多' : '空'}{' '}
                                        {'yd_quantity' in p
                                            ? fmtStockLots(p.quantity)
                                            : fmtInt(p.quantity)}{' '}
                                        @{fmtPrice(p.price)}
                                    </span>
                                    <span
                                        className={`${styles.num} ${panel.dirText[dir]}`}
                                    >
                                        {maskMoney(
                                            fmtSigned(Math.round(p.pnl), 0),
                                            privMoney,
                                        )}
                                    </span>
                                </button>
                            );
                        })}
                    </>
                )}

                {sections.has('watchlist') && (
                    <>
                        <span className={styles.sectionTitle}>自選清單</span>
                        {items.slice(0, 10).map((item) => (
                            <WatchMini
                                key={item.contract.code}
                                item={item}
                                spark={spark}
                            />
                        ))}
                        {items.length === 0 && (
                            <span className={styles.empty}>
                                <AsyncStatus
                                    phase={watchlistLoading ? 'loading' : watchlistError ? 'error' : 'empty'}
                                    text={watchlistLoading ? '載入清單…' : watchlistError ? '自選清單尚未取得' : '自選清單是空的'}
                                />
                            </span>
                        )}
                        {watchlistLoading && items.length > 0 && (
                            <span className={styles.empty}><AsyncStatus phase='loading' text='載入其餘商品…' /></span>
                        )}
                    </>
                )}

                {sections.has('movers') && (
                    <>
                        <span className={styles.sectionTitle}>漲幅排行</span>
                        {(moversPoll.data ?? []).map((it) => {
                            const ref = it.close - it.change_price;
                            const pct =
                                it.change_price && ref > 0
                                    ? (it.change_price / ref) * 100
                                    : 0;
                            const dir =
                                it.change_price > 0
                                    ? 'up'
                                    : it.change_price < 0
                                      ? 'down'
                                      : 'flat';
                            return (
                                <button
                                    key={it.code}
                                    className={styles.row}
                                    onClick={() => void pickCode(it.code)}
                                >
                                    <span className={styles.code}>
                                        {it.code}
                                    </span>
                                    <span className={styles.name}>
                                        {it.name}
                                    </span>
                                    <span
                                        className={`${styles.num} ${panel.dirText[dir]}`}
                                    >
                                        {fmtPrice(it.close)}
                                    </span>
                                    <span
                                        className={`${styles.numSm} ${panel.dirText[dir]}`}
                                    >
                                        {fmtPct(pct)}
                                    </span>
                                </button>
                            );
                        })}
                        {(moversPoll.data?.length ?? 0) === 0 && (
                            <span className={styles.empty}>
                                <AsyncStatus
                                    phase={moversPoll.error ? 'error' : moversPoll.updatedAt === null ? 'loading' : 'empty'}
                                    text={moversPoll.error ? '排行尚未取得' : moversPoll.updatedAt === null ? '載入排行…' : '目前沒有排行資料'}
                                />
                            </span>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
