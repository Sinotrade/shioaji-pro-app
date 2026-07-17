// src/components/sector-heatmap.tsx — 類股熱力圖 (issue #2): pick a
// sector from the contract files' categories, tiles colored by today's
// percent change (intensity scales with magnitude), sized order by 成交額.
// Click a tile to link the symbol everywhere.

import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    useSyncExternalStore,
} from 'react';
import { usePoll } from '../hooks/use-poll';
import { ensureContract } from '../lib/contracts-cache';
import { fetchSnapshots } from '../lib/shioaji';
import { useFocusedSector } from '../lib/sector-sync';
import {
    categoriesOf,
    loadStockIndex,
    sectorLabel,
    SECTOR_INDICES,
    type StockMeta,
} from '../lib/stock-index';
import { getQuote, subscribeQuoteStore } from '../lib/stream';
import { getChartColors, useThemeSettings } from '../lib/theme-store';
import type { Snapshot } from '../lib/types/market';
import { fmtPrice } from '../lib/utils/format';
import * as dock from './bottom-dock.css';
import * as styles from './sector-heatmap.css';

const MAX_MEMBERS = 80;
const CAT_KEY = 'sj-pro-heatmap-cat';
const SECTOR_INDEX_CODES = SECTOR_INDICES.map((sector) => sector.index);

function subscribeSectorQuoteStore(listener: () => void) {
    const off = SECTOR_INDEX_CODES.map((code) =>
        subscribeQuoteStore(code, listener),
    );
    return () => off.forEach((unsubscribe) => unsubscribe());
}

function getSectorQuoteVersion() {
    return SECTOR_INDEX_CODES.map(
        (code) => getQuote(code)?.seq ?? 0,
    ).join(':');
}

const catLabel = sectorLabel;

export function SectorHeatmap({
    onPick,
}: {
    onPick?: (code: string) => void;
}) {
    const [index, setIndex] = useState<StockMeta[] | null>(null);
    const [cat, setCat] = useState(
        () => localStorage.getItem(CAT_KEY) ?? '24',
    );
    // two levels (issue #2): 'overview' compares 類股 by their TWSE industry
    // index; 'sector' drills into one sector's member stocks
    const [view, setView] = useState<'overview' | 'sector'>('overview');
    const theme = useThemeSettings();
    const colors = getChartColors(theme);
    const sectorQuoteVersion = useSyncExternalStore(
        subscribeSectorQuoteStore,
        getSectorQuoteVersion,
    );

    useEffect(() => {
        loadStockIndex().then(setIndex).catch(() => undefined);
    }, []);

    useEffect(() => {
        if (view !== 'overview') return;
        void Promise.allSettled(
            SECTOR_INDEX_CODES.map((code) => ensureContract(code, 'IND')),
        );
    }, [view]);

    // jump here when a leaderboard row's 跳同類 fires (issue #2)
    const focused = useFocusedSector();
    useEffect(() => {
        if (focused?.category) {
            setCat(focused.category);
            setView('sector');
            localStorage.setItem(CAT_KEY, focused.category);
        }
    }, [focused?.seq]);

    // overview: snapshot every sector index, colored by today's change%
    const overviewPoll = usePoll<Snapshot[]>(
        useCallback(() => {
            if (view !== 'overview') return Promise.resolve([]);
            return fetchSnapshots(
                SECTOR_INDICES.map((s) => ({
                    security_type: 'IND' as const,
                    exchange: 'TSE' as const,
                    code: s.index,
                    target_code: null,
                })),
            ).catch(() => []);
        }, [view]),
        20000,
    );

    const sectorTiles = useMemo(() => {
        const byCode = new Map(
            (overviewPoll.data ?? []).map((s) => [s.code, s]),
        );
        return SECTOR_INDICES.map((sec) => {
            const s = byCode.get(sec.index);
            const live = getQuote(sec.index)?.index;
            const close = live ? Number(live.close) : s?.close;
            const ref = live
                ? Number(live.reference)
                : s
                  ? s.close - s.change_price
                  : 0;
            const pct =
                close !== undefined && ref > 0
                    ? ((close - ref) / ref) * 100
                    : 0;
            return {
                ...sec,
                amount: live?.amount_sum
                    ? Number(live.amount_sum)
                    : (s?.total_amount ?? 0),
                pct,
            };
        }).sort((a, b) => b.pct - a.pct); // 最強類股在前
    }, [overviewPoll.data, sectorQuoteVersion]);

    const categories = useMemo(
        () => (index ? categoriesOf(index).filter((c) => c.count >= 5) : []),
        [index],
    );
    const members = useMemo(
        () =>
            (index ?? [])
                .filter((s) => s.category === cat && s.code.length === 4)
                .slice(0, MAX_MEMBERS),
        [index, cat],
    );

    const snapsPoll = usePoll<Snapshot[]>(
        useCallback(() => {
            if (members.length === 0) return Promise.resolve([]);
            return fetchSnapshots(
                members.map((m) => ({
                    security_type: 'STK' as const,
                    exchange: (m.exchange || 'TSE') as 'TSE',
                    code: m.code,
                    target_code: null,
                })),
            ).catch(() => []);
        }, [members]),
        20000,
    );

    const tiles = useMemo(() => {
        const byCode = new Map(
            (snapsPoll.data ?? []).map((s) => [s.code, s]),
        );
        return members
            .map((m) => {
                const s = byCode.get(m.code);
                const ref = s ? s.close - s.change_price : 0;
                const pct =
                    s && s.change_price && ref > 0
                        ? (s.change_price / ref) * 100
                        : 0;
                return {
                    code: m.code,
                    name: m.name,
                    close: s?.close ?? 0,
                    amount: s?.total_amount ?? 0,
                    pct,
                };
            })
            .sort((a, b) => b.amount - a.amount);
    }, [members, snapsPoll.data]);

    // color intensity: ±5% saturates
    const tileColor = (pct: number): string => {
        const base = pct >= 0 ? colors.up : colors.down;
        const alpha = Math.min(1, Math.abs(pct) / 5) * 0.75 + 0.08;
        // base is '#rrggbb' — build rgba
        const r = parseInt(base.slice(1, 3), 16);
        const g = parseInt(base.slice(3, 5), 16);
        const b = parseInt(base.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`;
    };

    if (!index) {
        return <div className={dock.emptyState}>載入商品分類…</div>;
    }

    if (view === 'overview') {
        return (
            <div className={styles.wrap}>
                <div className={styles.toolbar}>
                    <span className={styles.catSelect} style={{ pointerEvents: 'none' }}>
                        類股總覽
                    </span>
                    <span className={styles.hint}>
                        各類股指數漲跌 · 點一下進該類股
                    </span>
                </div>
                <div className={styles.gridBox}>
                    {sectorTiles.map((t) => (
                        <button
                            key={t.index}
                            className={styles.tile}
                            style={{ background: tileColor(t.pct) }}
                            title={`${t.label}指數（${t.pct >= 0 ? '+' : ''}${t.pct.toFixed(2)}%）`}
                            onClick={() => {
                                setCat(t.category);
                                localStorage.setItem(CAT_KEY, t.category);
                                setView('sector');
                            }}
                        >
                            <span className={styles.tileName}>{t.label}</span>
                            <span className={styles.tilePct}>
                                {t.pct >= 0 ? '+' : ''}
                                {t.pct.toFixed(2)}%
                            </span>
                        </button>
                    ))}
                    {sectorTiles.every((t) => t.pct === 0) && (
                        <div className={dock.emptyState}>類股指數載入中…</div>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div className={styles.wrap}>
            <div className={styles.toolbar}>
                <button
                    className={styles.hint}
                    style={{ cursor: 'pointer', background: 'none', border: 'none' }}
                    onClick={() => setView('overview')}
                    title='回類股總覽'
                >
                    ← 總覽
                </button>
                <select
                    className={styles.catSelect}
                    value={cat}
                    onChange={(e) => {
                        setCat(e.target.value);
                        localStorage.setItem(CAT_KEY, e.target.value);
                    }}
                >
                    {categories.map((c) => (
                        <option key={c.category} value={c.category}>
                            {catLabel(c.category)}（{c.count}）
                        </option>
                    ))}
                </select>
                <span className={styles.hint}>依成交額排序 · 色深=漲跌幅</span>
            </div>
            <div className={styles.gridBox}>
                {tiles.map((t) => (
                    <button
                        key={t.code}
                        className={styles.tile}
                        style={{ background: tileColor(t.pct) }}
                        title={`${t.name} ${fmtPrice(t.close)}（${t.pct >= 0 ? '+' : ''}${t.pct.toFixed(2)}%）`}
                        onClick={() => onPick?.(t.code)}
                    >
                        <span className={styles.tileCode}>{t.code}</span>
                        <span className={styles.tileName}>{t.name}</span>
                        <span className={styles.tilePct}>
                            {t.pct >= 0 ? '+' : ''}
                            {t.pct.toFixed(1)}%
                        </span>
                    </button>
                ))}
                {tiles.length === 0 && (
                    <div className={dock.emptyState}>此類股無資料</div>
                )}
            </div>
        </div>
    );
}
