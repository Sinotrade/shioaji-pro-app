// src/components/sector-heatmap.tsx — 類股熱力圖 (issue #2): pick a
// sector from the contract files' categories, tiles colored by today's
// percent change (intensity scales with magnitude) and SIZED by 成交額
// (treemap area = amount) so a tile's size carries real meaning, not just
// its sort order. Click a tile to link the symbol everywhere. Batch-only
// data source (fetchSnapshots), never subscribes tick/bidask per stock.

import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy';
import {
    type CSSProperties,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
} from 'react';
import { usePoll } from '../hooks/use-poll';
import { ensureContract } from '../lib/contracts-cache';
import { fetchSnapshots } from '../lib/kgi';
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
import { vars } from '../theme.css';
import * as dock from './bottom-dock.css';
import * as styles from './sector-heatmap.css';
import { Orb } from './orb';

interface HeatTile {
    key: string;
    label: string;
    sub?: string;
    pct: number;
    amount: number;
    title: string;
    onClick?: () => void;
}

interface HeatDatum {
    name: string;
    tile?: HeatTile;
    children?: HeatDatum[];
}

// Squarified treemap sized by `amount` (成交額) — same d3-hierarchy
// convention as market-pulse-panel.tsx's industry contribution map.
function HeatmapTreemap({
    tiles,
    colors,
}: {
    tiles: HeatTile[];
    colors: ReturnType<typeof getChartColors>;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });

    useEffect(() => {
        const element = ref.current;
        if (!element || typeof ResizeObserver === 'undefined') return;
        const update = () => {
            const { width, height } = element.getBoundingClientRect();
            setSize({ width: Math.floor(width), height: Math.floor(height) });
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const layout = useMemo(() => {
        if (size.width <= 0 || size.height <= 0) return [];
        const visible = tiles.filter((t) => t.amount > 0);
        if (visible.length === 0) return [];
        const root = hierarchy<HeatDatum>({
            name: 'heatmap',
            children: visible.map((tile) => ({ name: tile.key, tile })),
        })
            .sum((d) => d.tile?.amount ?? 0)
            .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
        const laidOut = treemap<HeatDatum>()
            .tile(treemapSquarify.ratio(1.35))
            .size([size.width, size.height])
            .paddingInner(2)
            .round(true)(root);
        return laidOut
            .leaves()
            .map((leaf) => ({ ...leaf, tile: leaf.data.tile as HeatTile }));
    }, [tiles, size]);

    return (
        <div ref={ref} className={styles.treemap}>
            {layout.map((leaf) => {
                const width = leaf.x1 - leaf.x0;
                const height = leaf.y1 - leaf.y0;
                const t = leaf.tile;
                const base =
                    t.pct > 0 ? colors.up : t.pct < 0 ? colors.down : vars.color.flat;
                const alpha = Math.min(1, Math.abs(t.pct) / 5) * 70 + 14;
                const style = {
                    left: leaf.x0,
                    top: leaf.y0,
                    width,
                    height,
                    '--heat-color': base,
                    '--heat-alpha': `${alpha.toFixed(0)}%`,
                } as CSSProperties;
                return (
                    <button
                        key={t.key}
                        className={styles.tile}
                        style={style}
                        title={t.title}
                        onClick={t.onClick}
                    >
                        {width >= 34 && height >= 18 && (
                            <span className={styles.tileCode}>{t.label}</span>
                        )}
                        {t.sub && width >= 50 && height >= 30 && (
                            <span className={styles.tileName}>{t.sub}</span>
                        )}
                        {width >= 46 && height >= 26 && (
                            <span className={styles.tilePct}>
                                {t.pct >= 0 ? '+' : ''}
                                {t.pct.toFixed(2)}%
                            </span>
                        )}
                    </button>
                );
            })}
            {layout.length === 0 && (
                <div className={dock.emptyState}>
                    <Orb
                        size={12}
                        style={{ marginRight: 6, verticalAlign: '-2px' }}
                    />
                    載入中或此範圍無成交額資料…
                </div>
            )}
        </div>
    );
}

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
    // Real per-stock `category` values come straight from KGI's own
    // product-category taxonomy (verified live: e.g. "生技", "IC-設計",
    // "航運" — a much finer, differently-shaped system than the 26-bucket
    // TWSE numeric industry codes SECTOR_INDICES below uses for its index
    // tiles). There is no verified mapping between the two, so `cat` is
    // always a real category string sourced from the live catalog — never
    // a guessed/hardcoded default.
    const [cat, setCat] = useState(() => localStorage.getItem(CAT_KEY) ?? '');
    // two levels (issue #2): 'overview' compares 類股 by their TWSE industry
    // index; 'sector' drills into one sector's member stocks. Defaults to
    // 'sector' — verified live against a real account: only IX0001 (加權
    // 指數) has a confirmed KGI native index code in this bridge, so
    // 'overview' has no real data for any of its 26 tiles today. 'sector'
    // (real per-stock category + batch snapshot data) works now; 'overview'
    // stays reachable and will start showing real tiles the moment verified
    // index codes are added for the other TWSE sub-indices.
    const [view, setView] = useState<'overview' | 'sector'>('sector');
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

    // self-heal `cat`: once the real catalog loads, snap to a category that
    // actually exists in it — covers the first-ever load (no persisted
    // value) and a value persisted before this fix (the old hardcoded '24'
    // TWSE code, which no longer matches any real per-stock category)
    useEffect(() => {
        if (!index || categories.length === 0) return;
        if (categories.some((c) => c.category === cat)) return;
        const top = categories[0]!;
        setCat(top.category);
        localStorage.setItem(CAT_KEY, top.category);
    }, [index, categories, cat]);

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

    const overviewTiles = useMemo<HeatTile[]>(
        () =>
            sectorTiles.map((t) => ({
                key: t.index,
                label: t.label,
                pct: t.pct,
                amount: t.amount,
                title: `${t.label}指數（${t.pct >= 0 ? '+' : ''}${t.pct.toFixed(2)}%）`,
                // Index tiles use the 26-bucket TWSE industry-index code
                // system; per-stock `category` (below) uses KGI's own,
                // differently-shaped product-category taxonomy — there is
                // no verified mapping between the two, so a click switches
                // to the sector browser (real categories, picked by the
                // user) rather than guessing which one this index
                // corresponds to.
                onClick: () => setView('sector'),
            })),
        [sectorTiles],
    );

    const memberTiles = useMemo<HeatTile[]>(
        () =>
            tiles.map((t) => ({
                key: t.code,
                label: t.code,
                sub: t.name,
                pct: t.pct,
                amount: t.amount,
                title: `${t.name} ${fmtPrice(t.close)}（${t.pct >= 0 ? '+' : ''}${t.pct.toFixed(2)}%）`,
                onClick: () => onPick?.(t.code),
            })),
        [tiles, onPick],
    );

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
                        各類股指數漲跌 · 點一下瀏覽個股分類
                    </span>
                </div>
                <div className={styles.gridBox}>
                    {overviewPoll.data === undefined ? (
                        <div className={dock.emptyState}>
                            <Orb
                                size={12}
                                style={{ marginRight: 6, verticalAlign: '-2px' }}
                            />
                            類股指數載入中…
                        </div>
                    ) : sectorTiles.every(
                          (t) => t.pct === 0 && t.amount === 0,
                      ) ? (
                        // First poll came back but every tile is still
                        // zero — not "still loading" any more, a real
                        // capability gap: only IX0001 (加權指數) has a
                        // verified KGI native index code in this bridge,
                        // the other 25 TWSE sub-indices don't, so KGI may
                        // have no data for them under this account.
                        <div className={dock.emptyState}>
                            類股指數資料暫不可用 · 可改用下方「瀏覽個股分類」
                        </div>
                    ) : (
                        <HeatmapTreemap tiles={overviewTiles} colors={colors} />
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
                {tiles.length === 0 ? (
                    <div className={dock.emptyState}>此類股無資料</div>
                ) : (
                    <HeatmapTreemap tiles={memberTiles} colors={colors} />
                )}
            </div>
        </div>
    );
}

