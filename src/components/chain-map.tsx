// src/components/chain-map.tsx — 產業鏈地圖：shioaji-data 產業鏈／題材結構 ×
// 即時行情。
// - 左欄：所有產業鏈與題材依今日市值加權漲跌（或廣度、成交值）排行，附
//   漲／平／跌家數條 — 一眼看出今天哪個題材在動。
// - 主圖：所選產業鏈依上游 → 中游 → 下游分欄，每欄是成員 treemap（面積＝
//   市值或成交值、顏色＝今日漲跌或月營收年增），欄頭是該階段加權漲跌與家數。
// - 關係：鏈內供應關係畫成跨欄曲線；預設只畫焦點個股的上下游，其他淡出。
// - 點個股＝聚焦＋驅動連動群組；下方列出它的供應商／客戶／競爭／合作（含
//   國外、鏈外）與證據等級。連動群組換商品時自動聚焦，不在本鏈就切到它所屬
//   的產業鏈。
// 行情：一次 snapshots 取全部題材成員（約 800 檔、<1 s），15 秒輪詢；不訂閱
// tick、不讀 kbars。收盤或 sidecar 不通時以 shioaji-data 收盤價與市值排版。

import {
    AlertTriangle,
    ArrowDownRight,
    ArrowUpRight,
    CircleDot,
    Spline,
    Swords,
    Handshake,
    X,
} from 'lucide-react';
import {
    type CSSProperties,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { useChainMapData } from '../hooks/use-chain-map-data';
import { usePoll } from '../hooks/use-poll';
import {
    buildQuotes,
    chainLinks,
    fmtSignedPct,
    fmtTwd,
    groupStats,
    heatAlpha,
    layoutChain,
    linkPath,
    memberCodes,
    rankThemes,
    revenueYoy,
    stageMembers,
    stockContract,
    type Breadth,
    type ColorMetric,
    type HeatSort,
    type Quote,
    type SizeMetric,
    type Tile,
} from '../lib/chain-map';
import {
    entityIndex,
    entityName,
    relationsFor,
    STALE_TEXT,
    tierLabel,
    twCodeOf,
    type RelationHit,
    type RelationKind,
} from '../lib/company-data';
import type { Theme } from '../lib/company-data/types';
import { fetchSnapshots } from '../lib/shioaji';
import type { ContractBase } from '../lib/types/contract';
import type { Snapshot } from '../lib/types/market';
import { fmtPrice } from '../lib/utils/format';
import { vars } from '../theme.css';
import { AsyncStatus } from './async-status';
import * as panel from './panel.css';
import * as s from './chain-map.css';

const THEME_KEY = 'sj-pro-chainmap-theme';
const SIZE_KEY = 'sj-pro-chainmap-size';
const COLOR_KEY = 'sj-pro-chainmap-color';
const LINKS_KEY = 'sj-pro-chainmap-links';
const KIND_KEY = 'sj-pro-chainmap-kind';
const SORT_KEY = 'sj-pro-chainmap-sort';
const DEFAULT_THEME = 'theme.ai_server';
const REFRESH_MS = 15_000;
const SNAPSHOT_BATCH = 300;
/** Below this panel width the theme rail collapses into a select. */
const RAIL_MIN_PX = 640;
const HEADER_PX = 42;
/** Full colour at ±4 % change / ±60 % revenue YoY. */
const FULL_PCT = 4;
const FULL_YOY = 60;

type KindFilter = 'all' | 'chain' | 'theme';

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
    try {
        const value = localStorage.getItem(key);
        return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
    } catch {
        return fallback;
    }
}

function writePref(key: string, value: string) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // storage unavailable: preference lasts for this session only
    }
}

function dir(value: number | null | undefined): 'up' | 'down' | 'flat' {
    return value === null || value === undefined || value === 0 ? 'flat' : value > 0 ? 'up' : 'down';
}

function tierKey(tier: string): 'upstream' | 'midstream' | 'downstream' | 'other' {
    return tier === 'upstream' || tier === 'midstream' || tier === 'downstream' ? tier : 'other';
}

function heatVars(value: number | null, fullAt: number): CSSProperties {
    const color =
        value === null || value === 0
            ? vars.color.flat
            : value > 0
              ? vars.color.up
              : vars.color.down;
    const alpha = value === null ? 6 : heatAlpha(value, fullAt);
    return { '--heat-color': color, '--heat-alpha': `${alpha.toFixed(0)}%` } as CSSProperties;
}

// callback ref: the map box mounts after data loads, so observe by element
function useBoxSize<T extends HTMLElement>() {
    const [element, setElement] = useState<T | null>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });
    useEffect(() => {
        if (!element || typeof ResizeObserver === 'undefined') return;
        const update = () => {
            const { width, height } = element.getBoundingClientRect();
            setSize({ width: Math.floor(width), height: Math.floor(height) });
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(element);
        return () => observer.disconnect();
    }, [element]);
    return { ref: setElement, size };
}

function BreadthBar({ breadth, className }: { breadth: Breadth; className?: string }) {
    const live = breadth.up + breadth.flat + breadth.down;
    if (live === 0) return <span className={`${s.breadth} ${className ?? ''}`} />;
    return (
        <span
            className={`${s.breadth} ${className ?? ''}`}
            title={`漲 ${breadth.up}・平 ${breadth.flat}・跌 ${breadth.down}`}
        >
            <span className={s.breadthSeg.up} style={{ flexGrow: breadth.up }} />
            <span className={s.breadthSeg.flat} style={{ flexGrow: breadth.flat }} />
            <span className={s.breadthSeg.down} style={{ flexGrow: breadth.down }} />
        </span>
    );
}

function Segment<T extends string>({
    value,
    options,
    onChange,
    label,
}: {
    value: T;
    options: { value: T; label: string }[];
    onChange: (value: T) => void;
    label: string;
}) {
    return (
        <span className={s.segmentGroup} role='group' aria-label={label}>
            {options.map((option) => (
                <button
                    key={option.value}
                    type='button'
                    className={s.segment[option.value === value ? 'on' : 'off']}
                    aria-pressed={option.value === value}
                    onClick={() => onChange(option.value)}
                >
                    {option.label}
                </button>
            ))}
        </span>
    );
}

const RELATION_GROUPS: { kind: RelationKind; label: string; icon: typeof ArrowUpRight }[] = [
    { kind: 'supplier', label: '供應商', icon: ArrowDownRight },
    { kind: 'customer', label: '客戶', icon: ArrowUpRight },
    { kind: 'competitor', label: '競爭', icon: Swords },
    { kind: 'partner', label: '合作', icon: Handshake },
];
const RELATIONS_PER_GROUP = 8;

export function ChainMap({
    contract,
    onPick,
}: {
    contract?: ContractBase | null;
    onPick?: (code: string) => void;
}) {
    const data = useChainMapData();
    const ready = data.phase === 'ready' ? data : null;

    const [themeId, setThemeIdState] = useState(() => {
        try {
            return localStorage.getItem(THEME_KEY) || DEFAULT_THEME;
        } catch {
            return DEFAULT_THEME;
        }
    });
    const [kind, setKindState] = useState<KindFilter>(() => readPref(KIND_KEY, ['all', 'chain', 'theme'] as const, 'all'));
    const [sort, setSortState] = useState<HeatSort>(() => readPref(SORT_KEY, ['pct', 'breadth', 'amount'] as const, 'pct'));
    const [sizeMetric, setSizeState] = useState<SizeMetric>(() => readPref(SIZE_KEY, ['cap', 'amount'] as const, 'cap'));
    const [colorMetric, setColorState] = useState<ColorMetric>(() => readPref(COLOR_KEY, ['pct', 'yoy'] as const, 'pct'));
    const [showAllLinks, setShowAllLinks] = useState(() => readPref(LINKS_KEY, ['1', '0'] as const, '0') === '1');
    const [focus, setFocus] = useState<string | null>(null);
    const [hover, setHover] = useState<string | null>(null);

    const setThemeId = useCallback((id: string) => {
        setThemeIdState(id);
        writePref(THEME_KEY, id);
    }, []);
    const pref = <T extends string>(key: string, set: (v: T) => void) => (value: T) => {
        set(value);
        writePref(key, value);
    };

    const themes = ready?.themes ?? null;
    const entities = ready?.entities ?? null;
    const index = useMemo(() => (entities ? entityIndex(entities) : null), [entities]);
    const nameOf = useCallback((code: string) => entityName(index, `tw.${code}`), [index]);

    // ── live quotes: one snapshot batch for every member of every theme ──
    const allCodes = useMemo(() => (themes ? memberCodes(themes) : []), [themes]);
    const contracts = useMemo(
        () => allCodes.map((code) => stockContract(code, index?.get(`tw.${code}`)?.market)),
        [allCodes, index],
    );
    const lastSnapshots = useRef<Map<string, Snapshot> | null>(null);
    const fetchLive = useCallback(async () => {
        if (contracts.length === 0) return null;
        if (typeof document !== 'undefined' && document.hidden && lastSnapshots.current) {
            return lastSnapshots.current;
        }
        // the sidecar caps a request body at 64 KB (~600 contracts): batch it
        const batches: ContractBase[][] = [];
        for (let i = 0; i < contracts.length; i += SNAPSHOT_BATCH) batches.push(contracts.slice(i, i + SNAPSHOT_BATCH));
        const results = await Promise.allSettled(batches.map((batch) => fetchSnapshots(batch)));
        const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failed && results.every((r) => r.status === 'rejected')) throw failed.reason;
        const map = new Map(lastSnapshots.current ?? []);
        for (const r of results) if (r.status === 'fulfilled') for (const row of r.value) map.set(row.code, row);
        lastSnapshots.current = map;
        return map;
    }, [contracts]);
    const live = usePoll(fetchLive, REFRESH_MS);
    const refreshLive = live.refresh;
    useEffect(() => {
        if (contracts.length > 0) refreshLive();
    }, [contracts, refreshLive]);

    const quotes = useMemo(
        () => buildQuotes(allCodes, ready?.market ?? null, live.data ?? null),
        [allCodes, ready?.market, live.data],
    );
    const yoy = useMemo(() => revenueYoy(ready?.revenue), [ready?.revenue]);
    const hasLive = useMemo(() => [...quotes.values()].some((q) => q.pct !== null), [quotes]);
    const liveTime = useMemo(() => {
        let latest = '';
        for (const snap of live.data?.values() ?? []) if (snap.datetime > latest) latest = snap.datetime;
        return latest ? latest.slice(11, 19) : null;
    }, [live.data]);

    // ── theme rail ──
    const pool = useMemo(
        () => (themes ?? []).filter((t) => kind === 'all' || t.kind === kind),
        [themes, kind],
    );
    const ranked = useMemo(() => rankThemes(pool, quotes, sort, yoy), [pool, quotes, sort, yoy]);
    const theme: Theme | null = useMemo(() => {
        if (!themes) return null;
        return (
            themes.find((t) => t.id === themeId) ??
            themes.find((t) => t.id === DEFAULT_THEME) ??
            themes[0] ??
            null
        );
    }, [themes, themeId]);
    const themeById = useMemo(() => new Map((themes ?? []).map((t) => [t.id, t])), [themes]);

    // ── follow the linked contract ──
    const linkedCode = contract && contract.security_type === 'STK' ? contract.code : null;
    useEffect(() => {
        if (!linkedCode || !themes || !theme) return;
        const id = `tw.${linkedCode}`;
        if (theme.members.some((m) => m.id === id)) {
            setFocus(linkedCode);
            return;
        }
        const owners = themes.filter((t) => t.members.some((m) => m.id === id));
        const next = owners.find((t) => t.kind === 'chain' && t.id !== 'chain.finance') ?? owners[0];
        if (next) {
            setThemeId(next.id);
            setFocus(linkedCode);
        }
        // only react to the linked code, not to theme switches made here
    }, [linkedCode, themes]);

    // keep the selected theme visible in the rail (restored or followed)
    const railRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        const row = railRef.current?.querySelector<HTMLElement>('[aria-current="true"]');
        row?.scrollIntoView?.({ block: 'nearest' });
    }, [theme?.id, kind, ready !== null]);

    // ── chain layout ──
    const { ref: rootRef, size: rootSize } = useBoxSize<HTMLDivElement>();
    const { ref: mapRef, size: mapSize } = useBoxSize<HTMLDivElement>();
    const showRail = rootSize.width >= RAIL_MIN_PX;
    const members = useMemo(() => (theme ? stageMembers(theme) : new Map<string, string[]>()), [theme]);
    const themeCodes = useMemo(() => new Set([...members.values()].flat()), [members]);
    // market-cap layout uses the official daily cap so tiles do not drift on
    // every poll; turnover layout follows the live numbers by design
    const sizeOf = useMemo(() => {
        if (sizeMetric === 'amount') return (code: string) => quotes.get(code)?.amount ?? 0;
        const daily = ready?.market?.quotes;
        return (code: string) => daily?.[code]?.market_cap_twd ?? quotes.get(code)?.cap ?? 0;
    }, [sizeMetric, quotes, ready?.market]);
    const layout = useMemo(
        () =>
            theme
                ? layoutChain(theme, sizeOf, mapSize.width, Math.max(0, mapSize.height - HEADER_PX), { minColumn: 92 })
                : null,
        [theme, sizeOf, mapSize.width, mapSize.height],
    );
    const links = useMemo(
        () => (ready?.edges ? chainLinks(ready.edges, themeCodes) : []),
        [ready?.edges, themeCodes],
    );
    const active = hover ?? (focus && themeCodes.has(focus) ? focus : null);
    const neighbours = useMemo(() => {
        if (!active) return null;
        const set = new Set([active]);
        for (const link of links) {
            if (link.from === active) set.add(link.to);
            if (link.to === active) set.add(link.from);
        }
        return set;
    }, [active, links]);
    const themeStats = useMemo(() => groupStats(themeCodes, quotes, yoy), [themeCodes, quotes, yoy]);

    const memberInfo = useMemo(() => {
        const map = new Map<string, { stage: string; detail: string | null }[]>();
        for (const m of theme?.members ?? []) {
            const code = twCodeOf(m.id);
            if (!code) continue;
            const list = map.get(code) ?? [];
            list.push({ stage: theme!.stages.find((st) => st.id === m.stage)?.name ?? m.stage, detail: m.detail });
            map.set(code, list);
        }
        return map;
    }, [theme]);

    const pick = useCallback(
        (code: string) => {
            setFocus(code);
            onPick?.(code);
        },
        [onPick],
    );

    const colorValue = useCallback(
        (code: string): number | null =>
            colorMetric === 'yoy' ? (yoy.get(code) ?? null) : (quotes.get(code)?.pct ?? null),
        [colorMetric, yoy, quotes],
    );
    const fullAt = colorMetric === 'yoy' ? FULL_YOY : FULL_PCT;

    // ── render ──
    if (data.phase === 'loading') {
        return (
            <div className={s.center}>
                <AsyncStatus phase='loading' text='讀取產業鏈資料…' />
            </div>
        );
    }
    if (data.phase === 'error' || !theme || !layout) {
        return (
            <div className={s.center}>
                <AsyncStatus
                    phase='error'
                    text={data.phase === 'error' ? data.error : '沒有產業鏈資料'}
                    action={
                        <button type='button' className={panel.btn} onClick={data.retry}>
                            重試
                        </button>
                    }
                />
            </div>
        );
    }

    const tileTitle = (code: string, q: Quote | undefined) => {
        const parts = [`${nameOf(code)} ${code}`];
        if (q?.close) parts.push(`價 ${fmtPrice(q.close)}`);
        parts.push(`漲跌 ${fmtSignedPct(q?.pct)}`);
        if (q?.amount) parts.push(`成交值 ${fmtTwd(q.amount)}`);
        if (q?.cap) parts.push(`市值 ${fmtTwd(q.cap)}`);
        const y = yoy.get(code);
        if (y !== undefined) parts.push(`月營收年增 ${fmtSignedPct(y, 1)}`);
        for (const info of memberInfo.get(code) ?? []) parts.push(`${info.stage}：${info.detail ?? ''}`);
        return parts.join('\n');
    };

    const drawnLinks = links.filter((link) => showAllLinks || (active && (link.from === active || link.to === active)));
    const focusInTheme = focus && themeCodes.has(focus);

    return (
        <div ref={rootRef} className={`${s.wrap} ${showRail ? s.wrapRail : ''}`}>
            {showRail && (
                <aside className={s.rail} aria-label='產業鏈與題材排行'>
                    <div className={s.railHead}>
                        <Segment
                            label='類型'
                            value={kind}
                            onChange={pref<KindFilter>(KIND_KEY, setKindState)}
                            options={[
                                { value: 'all', label: '全部' },
                                { value: 'chain', label: '產業鏈' },
                                { value: 'theme', label: '題材' },
                            ]}
                        />
                        <Segment
                            label='排序'
                            value={sort}
                            onChange={pref<HeatSort>(SORT_KEY, setSortState)}
                            options={[
                                { value: 'pct', label: '漲跌' },
                                { value: 'breadth', label: '廣度' },
                                { value: 'amount', label: '成交值' },
                            ]}
                        />
                    </div>
                    <div className={s.railList} ref={railRef}>
                        {ranked.map(({ theme: t, stats }) => (
                            <button
                                key={t.id}
                                type='button'
                                className={s.railRow[t.id === theme.id ? 'on' : 'off']}
                                aria-current={t.id === theme.id ? 'true' : undefined}
                                onClick={() => setThemeId(t.id)}
                                title={`${t.name}・${stats.count} 檔\n加權漲跌 ${fmtSignedPct(stats.pct)}\n漲 ${stats.breadth.up}・平 ${stats.breadth.flat}・跌 ${stats.breadth.down}\n成交值 ${fmtTwd(stats.amount)}`}
                            >
                                <span className={s.railName}>
                                    {t.kind === 'chain' && <span className={s.kindDot} aria-label='產業鏈' />}
                                    {t.name}
                                </span>
                                <span className={`${s.railPct} ${panel.dirText[dir(stats.pct)]}`}>
                                    {sort === 'amount' ? fmtTwd(stats.amount) : fmtSignedPct(stats.pct)}
                                </span>
                                <BreadthBar breadth={stats.breadth} className={s.railBreadth} />
                                <span className={s.railCount}>
                                    {stats.breadth.up}/{stats.breadth.down}
                                </span>
                            </button>
                        ))}
                    </div>
                </aside>
            )}
            <section className={s.main}>
                <div className={s.toolbar}>
                    {!showRail && (
                        <select
                            className={s.select}
                            value={theme.id}
                            onChange={(e) => setThemeId(e.target.value)}
                            aria-label='產業鏈或題材'
                        >
                            {ranked.map(({ theme: t, stats }) => (
                                <option key={t.id} value={t.id}>
                                    {t.name} {fmtSignedPct(stats.pct)}
                                </option>
                            ))}
                        </select>
                    )}
                    {showRail && <span className={s.title}>{theme.name}</span>}
                    <span className={s.kindTag}>{theme.kind === 'chain' ? '產業鏈' : '題材'}</span>
                    <span className={`${s.totals} ${panel.dirText[dir(themeStats.pct)]}`}>
                        {fmtSignedPct(themeStats.pct)}
                    </span>
                    <BreadthBar breadth={themeStats.breadth} className={s.toolbarBreadth} />
                    <span className={s.hint}>
                        漲 {themeStats.breadth.up}・跌 {themeStats.breadth.down}・{fmtTwd(themeStats.amount)}
                    </span>
                    <span className={s.spacer} />
                    <Segment
                        label='面積'
                        value={sizeMetric}
                        onChange={pref<SizeMetric>(SIZE_KEY, setSizeState)}
                        options={[
                            { value: 'cap', label: '市值' },
                            { value: 'amount', label: '成交值' },
                        ]}
                    />
                    <Segment
                        label='顏色'
                        value={colorMetric}
                        onChange={pref<ColorMetric>(COLOR_KEY, setColorState)}
                        options={[
                            { value: 'pct', label: '漲跌' },
                            { value: 'yoy', label: '營收年增' },
                        ]}
                    />
                    <button
                        type='button'
                        className={s.iconToggle[showAllLinks ? 'on' : 'off']}
                        aria-pressed={showAllLinks}
                        title={showAllLinks ? '只顯示焦點個股的供應關係' : '顯示鏈內全部供應關係'}
                        onClick={() => {
                            setShowAllLinks((v) => !v);
                            writePref(LINKS_KEY, showAllLinks ? '0' : '1');
                        }}
                    >
                        <Spline size={13} aria-hidden='true' />
                        <span>{links.length}</span>
                    </button>
                </div>
                {(live.error || !hasLive || ready?.stale) && (
                    <div className={s.notice}>
                        <AlertTriangle size={12} aria-hidden='true' />
                        <span>
                            {live.error
                                ? '無法取得即時行情，以收盤價與市值排版'
                                : !hasLive
                                  ? '尚無今日成交，以收盤價與市值排版'
                                  : null}
                            {ready?.stale ? `${live.error || !hasLive ? '・' : ''}產業鏈資料${STALE_TEXT}` : ''}
                        </span>
                    </div>
                )}
                {theme.related.length > 0 && (
                    <div className={s.relatedRow}>
                        <span className={s.relatedLabel}>相關</span>
                        {theme.related.map((id) => {
                            const t = themeById.get(id);
                            if (!t) return null;
                            const st = groupStats(
                                t.members.flatMap((m) => (m.id.startsWith('tw.') ? [m.id.slice(3)] : [])),
                                quotes,
                            );
                            return (
                                <button key={id} type='button' className={s.chip} onClick={() => setThemeId(id)}>
                                    {t.name}
                                    <span className={panel.dirText[dir(st.pct)]}>{fmtSignedPct(st.pct)}</span>
                                </button>
                            );
                        })}
                    </div>
                )}
                <div ref={mapRef} className={s.map} onMouseLeave={() => setHover(null)}>
                    {layout.columns.map((column) => {
                        const stats = groupStats(column.codes, quotes, yoy);
                        const value = colorMetric === 'yoy' ? stats.yoy : stats.pct;
                        return (
                            <div
                                key={column.stage.id}
                                className={s.stageHead}
                                style={{ left: column.x, width: column.width, height: HEADER_PX - 4 }}
                                title={`${column.stage.name}（${tierLabel(column.stage.tier)}）\n${column.codes.length} 檔・加權漲跌 ${fmtSignedPct(stats.pct)}\n漲 ${stats.breadth.up}・平 ${stats.breadth.flat}・跌 ${stats.breadth.down}\n成交值 ${fmtTwd(stats.amount)}`}
                            >
                                <span className={s.stageTop}>
                                    <span className={s.tierTag[tierKey(column.stage.tier)]}>
                                        {tierLabel(column.stage.tier)}
                                    </span>
                                    <span className={s.stageName}>{column.stage.name}</span>
                                </span>
                                <span className={s.stageBottom}>
                                    <span className={`${s.stagePct} ${panel.dirText[dir(value)]}`}>
                                        {colorMetric === 'yoy' ? fmtSignedPct(value, 1) : fmtSignedPct(value)}
                                    </span>
                                    {column.width >= 130 && <BreadthBar breadth={stats.breadth} className={s.stageBreadth} />}
                                    {column.width >= 90 && <span className={s.stageCount}>{column.codes.length}</span>}
                                </span>
                            </div>
                        );
                    })}
                    <div className={s.tiles} style={{ top: HEADER_PX }}>
                        {layout.columns.flatMap((column) =>
                            column.tiles.map((tile) => {
                                const q = quotes.get(tile.code);
                                const value = colorValue(tile.code);
                                const w = tile.x1 - tile.x0;
                                const h = tile.y1 - tile.y0;
                                const dim = neighbours !== null && !neighbours.has(tile.code);
                                const isFocus = tile.code === focus;
                                const isLinked = tile.code === linkedCode;
                                return (
                                    <button
                                        key={tile.key}
                                        type='button'
                                        className={`${s.tile} ${dim ? s.tileDim : ''} ${isFocus ? s.tileFocus : ''} ${isLinked && !isFocus ? s.tileLinked : ''}`}
                                        style={{
                                            ...heatVars(value, fullAt),
                                            left: tile.x0,
                                            top: tile.y0,
                                            width: w,
                                            height: h,
                                        }}
                                        title={tileTitle(tile.code, q)}
                                        onMouseEnter={() => setHover(tile.code)}
                                        onFocus={() => setHover(tile.code)}
                                        onBlur={() => setHover(null)}
                                        onClick={() => pick(tile.code)}
                                    >
                                        {w >= 34 && h >= 18 && (
                                            <span className={s.tileName}>{nameOf(tile.code)}</span>
                                        )}
                                        {w >= 44 && h >= 32 && (
                                            <span className={`${s.tilePct} ${panel.dirText[dir(value)]}`}>
                                                {colorMetric === 'yoy' ? fmtSignedPct(value, 1) : fmtSignedPct(value)}
                                            </span>
                                        )}
                                        {w >= 70 && h >= 48 && (
                                            <span className={s.tileSub}>
                                                {tile.code}
                                                {q?.close ? ` ${fmtPrice(q.close)}` : ''}
                                            </span>
                                        )}
                                    </button>
                                );
                            }),
                        )}
                        <svg className={s.links} width={mapSize.width} height={Math.max(0, mapSize.height - HEADER_PX)} aria-hidden='true'>
                            <defs>
                                <marker id='chainmap-arrow' viewBox='0 0 8 8' refX='7' refY='4' markerWidth='7' markerHeight='7' orient='auto-start-reverse'>
                                    <path d='M0,0 L8,4 L0,8 z' className={s.arrowHead} />
                                </marker>
                            </defs>
                            {drawnLinks.map((link) => {
                                const a = layout.byCode.get(link.from);
                                const b = layout.byCode.get(link.to);
                                if (!a || !b) return null;
                                const hot = active !== null && (link.from === active || link.to === active);
                                return (
                                    <path
                                        key={`${link.from}>${link.to}`}
                                        d={linkPath(a as Tile, b as Tile)}
                                        className={hot ? s.linkHot : s.linkFaint}
                                        markerEnd='url(#chainmap-arrow)'
                                    />
                                );
                            })}
                        </svg>
                    </div>
                </div>
                {focus && (
                    <FocusStrip
                        code={focus}
                        inTheme={!!focusInTheme}
                        theme={theme}
                        quote={quotes.get(focus)}
                        yoy={yoy.get(focus)}
                        info={memberInfo.get(focus) ?? []}
                        hits={ready?.edges ?? null}
                        nameOf={(id) => entityName(index, id)}
                        quoteOf={(code) => quotes.get(code)}
                        inChain={(code) => themeCodes.has(code)}
                        onPick={pick}
                        onClose={() => setFocus(null)}
                    />
                )}
                <div className={s.footer}>
                    <span>
                        產業鏈、題材與關係為第三方 AI 整理資料（{ready?.themesMeta.asOf ?? '--'}），可能過時或有誤
                    </span>
                    <span className={s.spacer} />
                    <span>{liveTime ? `行情 ${liveTime}` : ready?.market ? '收盤資料' : ''}</span>
                </div>
            </section>
        </div>
    );
}

function FocusStrip({
    code,
    inTheme,
    theme,
    quote,
    yoy,
    info,
    hits,
    nameOf,
    quoteOf,
    inChain,
    onPick,
    onClose,
}: {
    code: string;
    inTheme: boolean;
    theme: Theme;
    quote: Quote | undefined;
    yoy: number | undefined;
    info: { stage: string; detail: string | null }[];
    hits: import('../lib/company-data/types').Edge[] | null;
    nameOf: (id: string) => string;
    quoteOf: (code: string) => Quote | undefined;
    inChain: (code: string) => boolean;
    onPick: (code: string) => void;
    onClose: () => void;
}) {
    const groups = useMemo(() => {
        if (!hits) return [];
        return RELATION_GROUPS.map((group) => ({
            ...group,
            rows: dedupe(relationsFor(hits, `tw.${code}`, group.kind)),
        })).filter((group) => group.rows.length > 0);
    }, [hits, code]);
    return (
        <div className={s.focus}>
            <div className={s.focusHead}>
                <CircleDot size={12} className={s.focusIcon} aria-hidden='true' />
                <button type='button' className={s.focusName} onClick={() => onPick(code)} title='設為連動商品'>
                    {nameOf(`tw.${code}`)} <span className={s.focusCode}>{code}</span>
                </button>
                {quote?.close ? <span className={s.focusNum}>{fmtPrice(quote.close)}</span> : null}
                <span className={`${s.focusNum} ${panel.dirText[dir(quote?.pct)]}`}>{fmtSignedPct(quote?.pct)}</span>
                {quote?.amount ? <span className={s.focusMeta}>成交值 {fmtTwd(quote.amount)}</span> : null}
                {yoy !== undefined && (
                    <span className={s.focusMeta}>
                        營收年增 <span className={panel.dirText[dir(yoy)]}>{fmtSignedPct(yoy, 1)}</span>
                    </span>
                )}
                {!inTheme && <span className={s.focusMeta}>不在「{theme.name}」</span>}
                <span className={s.spacer} />
                <button type='button' className={s.closeBtn} onClick={onClose} aria-label='取消聚焦'>
                    <X size={12} aria-hidden='true' />
                </button>
            </div>
            {info.length > 0 && (
                <div className={s.focusRole}>
                    {info.map((row, i) => (
                        <span key={i}>
                            <b>{row.stage}</b>
                            {row.detail ? `：${row.detail}` : ''}
                        </span>
                    ))}
                </div>
            )}
            {groups.length === 0 ? (
                <div className={s.focusEmpty}>資料中沒有這家公司的上下游關係</div>
            ) : (
                <div className={s.focusGroups}>
                    {groups.map((group) => {
                        const Icon = group.icon;
                        return (
                            <div key={group.kind} className={s.focusGroup}>
                                <span className={s.groupLabel}>
                                    <Icon size={11} aria-hidden='true' />
                                    {group.label}
                                    <span className={s.groupCount}>{group.rows.length}</span>
                                </span>
                                {group.rows.slice(0, RELATIONS_PER_GROUP).map((hit) => {
                                    const tw = twCodeOf(hit.counterparty);
                                    const q = tw ? quoteOf(tw) : undefined;
                                    const title = [
                                        nameOf(hit.counterparty),
                                        hit.edge.detail ?? '',
                                        `證據：${hit.edge.evidence_level === 'primary' ? '公司／交易對手公開文件' : hit.edge.evidence_level === 'media' ? '具名媒體' : hit.edge.evidence_level}`,
                                        hit.edge.as_of ? `as_of ${hit.edge.as_of}` : '',
                                    ]
                                        .filter(Boolean)
                                        .join('\n');
                                    const body = (
                                        <>
                                            {tw && inChain(tw) && <span className={s.inChainDot} aria-label='同鏈' />}
                                            <span className={s.relName}>{nameOf(hit.counterparty)}</span>
                                            {q?.pct !== null && q?.pct !== undefined && (
                                                <span className={`${s.relPct} ${panel.dirText[dir(q.pct)]}`}>{fmtSignedPct(q.pct)}</span>
                                            )}
                                            {hit.edge.evidence_level === 'media' && <span className={s.evidenceTag}>媒體</span>}
                                        </>
                                    );
                                    return tw ? (
                                        <button key={hit.edge.id} type='button' className={s.rel} title={title} onClick={() => onPick(tw)}>
                                            {body}
                                        </button>
                                    ) : (
                                        <span key={hit.edge.id} className={`${s.rel} ${s.relStatic}`} title={title}>
                                            {body}
                                        </span>
                                    );
                                })}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

/** One row per counterparty (the edge table can hold several per pair). */
function dedupe(hits: RelationHit[]): RelationHit[] {
    const seen = new Set<string>();
    return hits.filter((hit) => {
        if (seen.has(hit.counterparty)) return false;
        seen.add(hit.counterparty);
        return true;
    });
}
