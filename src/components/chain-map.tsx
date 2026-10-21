// src/components/chain-map.tsx — 產業鏈資金流向：shioaji-data 產業鏈／題材 ×
// 即時 1 分 K 資金流。
// - 流向時間軸（主視圖）：每列一個產業鏈或題材，依 5 分鐘淨流入排序；中間是
//   09:00–13:30 的每分鐘淨流入（上＝流入、下＝流出，所有列同一比例），右側是
//   5 分淨流入、量能倍數、加權漲跌。滑過任一列，所有列對齊同一分鐘，看得出
//   資金從哪裡轉到哪裡。
// - 鏈內流向（下方）：所選列依上游 → 中游 → 下游彙總，每段是成交值與累積淨
//   流入走勢、近 15 分鐘資金占比變化與領頭個股。
// - 聚焦個股：只列供應商／客戶／競爭／合作清單，不畫關係線。
// 行情：即時 1 分 K 訂閱（約 800 檔、3 個 POST、每分鐘 0 request）＋其他面板
// 既有 tick；snapshots 只在當日第一次開啟時補開盤至今的彙總。見
// lib/chain-flow-feed.ts。面板隱藏或捲出畫面時暫停重繪。

import {
    AlertTriangle,
    ArrowDownRight,
    ArrowUpRight,
    ChevronRight,
    CircleDot,
    Handshake,
    Radio,
    Swords,
    X,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useChainMapData } from '../hooks/use-chain-map-data';
import {
    codePct,
    flowSortKey,
    groupFlow,
    leaders,
    SESSION_SLOTS,
    sessionTurnover,
    shareShift,
    slotLabel,
    WINDOW,
    type FlowSort,
    type GroupFlow,
} from '../lib/chain-flow';
import {
    chainFlowBook,
    chainFlowStatus,
    connectChainFlow,
    useChainFlowRevision,
    type FeedMember,
} from '../lib/chain-flow-feed';
import { fmtSignedPct, fmtTwd, memberCodes, stageMembers, stockContract, themeCodes, tierRank } from '../lib/chain-map';
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
import type { ChainTier, Edge, Theme } from '../lib/company-data/types';
import { themeKey as themeKeyOf, useThemeSettings } from '../lib/theme-store';
import type { ContractBase } from '../lib/types/contract';
import { fmtPrice } from '../lib/utils/format';
import { vars } from '../theme.css';
import { AsyncStatus } from './async-status';
import * as panel from './panel.css';
import * as s from './chain-map.css';

const THEME_KEY = 'sj-pro-chainmap-theme';
const KIND_KEY = 'sj-pro-chainmap-kind';
const SORT_KEY = 'sj-pro-chainmap-flow-sort';
const DEFAULT_THEME = 'theme.ai_server';
/** Below this panel height the chain detail is hidden (tape only). */
const DETAIL_MIN_PX = 440;
/** Below this width the 量能 column is dropped. */
const NARROW_PX = 720;
const TIERS: ChainTier[] = ['upstream', 'midstream', 'downstream'];
const HOURS = [0, 60, 120, 180, 240, 270];
/** Strip height reaches 76 % at net ÷ turnover = ±40 % (tanh knee). */
const FULL_INTENSITY = 0.4;

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

// resolve a vanilla-extract `var(--x)` reference to a concrete colour for canvas
function cssColor(el: HTMLElement, ref: string): string {
    if (!ref.startsWith('var(')) return ref;
    return getComputedStyle(el).getPropertyValue(ref.slice(4, -1)).trim() || '#888';
}

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
    return { ref: setElement, element, size };
}

/** Paused while the document is hidden or the panel is scrolled out of view. */
function usePaused(element: HTMLElement | null) {
    const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
    const [offscreen, setOffscreen] = useState(false);
    useEffect(() => {
        const onVisibility = () => setHidden(document.hidden);
        document.addEventListener('visibilitychange', onVisibility);
        return () => document.removeEventListener('visibilitychange', onVisibility);
    }, []);
    useEffect(() => {
        if (!element || typeof IntersectionObserver === 'undefined') return;
        const observer = new IntersectionObserver((entries) => {
            const entry = entries[entries.length - 1];
            if (entry) setOffscreen(!entry.isIntersecting);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, [element]);
    return hidden || offscreen;
}

/** DPR-aware canvas that repaints when `deps` or its size change. */
function useCanvas(
    draw: (ctx: CanvasRenderingContext2D, w: number, h: number, el: HTMLCanvasElement) => void,
    deps: unknown[],
) {
    const ref = useRef<HTMLCanvasElement | null>(null);
    const [seq, setSeq] = useState(0);
    useEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(() => setSeq((n) => n + 1));
        observer.observe(el);
        return () => observer.disconnect();
    }, []);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const w = el.clientWidth;
        const h = el.clientHeight;
        if (w === 0 || h === 0) return;
        const dpr = window.devicePixelRatio || 1;
        const pw = Math.round(w * dpr);
        const ph = Math.round(h * dpr);
        if (el.width !== pw) el.width = pw;
        if (el.height !== ph) el.height = ph;
        const ctx = el.getContext?.('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        draw(ctx, w, h, el);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...deps, seq]);
    return ref;
}

const slotX = (slot: number, w: number) => ((slot + 0.5) / SESSION_SLOTS) * w;

/** Per-minute net inflow, mirrored around the centre line. */
function FlowStrip({
    net,
    turnover,
    from,
    now,
    hover,
    themeKey,
    revision,
    onHover,
}: {
    net: Float64Array;
    turnover: Float64Array;
    from: number | null;
    now: number | null;
    hover: number | null;
    themeKey: string;
    revision: number;
    onHover: (slot: number | null) => void;
}) {
    const ref = useCanvas(
        (ctx, w, h, el) => {
            const mid = Math.round(h / 2) + 0.5;
            const half = h / 2 - 2;
            const up = cssColor(el, vars.color.up);
            const down = cssColor(el, vars.color.down);
            ctx.strokeStyle = cssColor(el, vars.color.border);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, mid);
            ctx.lineTo(w, mid);
            ctx.stroke();
            const step = w / SESSION_SLOTS;
            if (from !== null && now !== null) {
                // flow intensity = net ÷ turnover over a 3-minute centred window:
                // comparable across a 5-stock theme and a 250-stock chain (the
                // absolute amount is in the 5 分淨流入 column)
                const ys: number[] = [];
                for (let i = from; i <= now; i += 1) {
                    let sumNet = 0;
                    let sumTurnover = 0;
                    for (let j = Math.max(from, i - 1); j <= Math.min(now, i + 1); j += 1) {
                        sumNet += net[j]!;
                        sumTurnover += turnover[j]!;
                    }
                    const v = sumTurnover > 0 ? sumNet / sumTurnover : 0;
                    // soft knee instead of a hard clip
                    const len = Math.tanh(Math.abs(v) / FULL_INTENSITY) * half;
                    ys.push(v >= 0 ? mid - len : mid + len);
                }
                const trace = () => {
                    ctx.beginPath();
                    ctx.moveTo(slotX(from, w), mid);
                    ys.forEach((y, k) => ctx.lineTo(slotX(from + k, w), y));
                    ctx.lineTo(slotX(now, w), mid);
                };
                for (const [color, top] of [
                    [up, true],
                    [down, false],
                ] as const) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(0, top ? 0 : mid, w, top ? mid : h - mid);
                    ctx.clip();
                    trace();
                    ctx.closePath();
                    ctx.globalAlpha = 0.28;
                    ctx.fillStyle = color;
                    ctx.fill();
                    ctx.globalAlpha = 0.95;
                    ctx.strokeStyle = color;
                    ctx.lineWidth = 1.1;
                    ctx.lineJoin = 'round';
                    trace();
                    ctx.stroke();
                    ctx.restore();
                }
            }
            if (now !== null) {
                ctx.fillStyle = cssColor(el, vars.color.mutedForeground);
                ctx.globalAlpha = 0.45;
                ctx.fillRect(Math.round((now + 1) * step), 3, 1, h - 6);
                ctx.globalAlpha = 1;
            }
            if (hover !== null) {
                ctx.fillStyle = cssColor(el, vars.color.accent);
                ctx.fillRect(Math.round(slotX(hover, w)), 0, 1, h);
            }
        },
        [net, turnover, from, now, hover, themeKey, revision],
    );
    return (
        <canvas
            ref={ref}
            className={s.stripCanvas}
            onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const slot = Math.floor(((e.clientX - rect.left) / rect.width) * SESSION_SLOTS);
                onHover(Math.max(0, Math.min(SESSION_SLOTS - 1, slot)));
            }}
            onMouseLeave={() => onHover(null)}
            aria-hidden='true'
        />
    );
}

/** Tier card chart: minute turnover (muted bars) and cumulative net inflow (line). */
function TierChart({
    flow,
    from,
    now,
    hover,
    themeKey,
    revision,
}: {
    flow: GroupFlow;
    from: number | null;
    now: number | null;
    hover: number | null;
    themeKey: string;
    revision: number;
}) {
    const ref = useCanvas(
        (ctx, w, h, el) => {
            const border = cssColor(el, vars.color.border);
            if (from === null || now === null) {
                ctx.strokeStyle = border;
                ctx.setLineDash([2, 3]);
                ctx.beginPath();
                ctx.moveTo(0, Math.round(h / 2) + 0.5);
                ctx.lineTo(w, Math.round(h / 2) + 0.5);
                ctx.stroke();
                return;
            }
            const step = w / SESSION_SLOTS;
            let maxT = 0;
            let minC = 0;
            let maxC = 0;
            for (let i = from; i <= now; i += 1) {
                maxT = Math.max(maxT, flow.turnover[i]!);
                minC = Math.min(minC, flow.cumNet[i]!);
                maxC = Math.max(maxC, flow.cumNet[i]!);
            }
            // minute turnover in the lower 40 %
            const barH = h * 0.4;
            ctx.fillStyle = cssColor(el, vars.color.mutedForeground);
            ctx.globalAlpha = 0.26;
            if (maxT > 0) {
                for (let i = from; i <= now; i += 1) {
                    const t = flow.turnover[i]!;
                    if (t <= 0) continue;
                    const len = Math.max(0.5, (t / maxT) * barH);
                    ctx.fillRect(i * step, h - len, Math.max(1, step - 0.5), len);
                }
            }
            ctx.globalAlpha = 1;
            // cumulative net inflow over the full height
            const pad = 6;
            const span = maxC - minC || 1;
            const y = (v: number) => pad + (1 - (v - minC) / span) * (h - pad * 2);
            const zero = Math.round(y(0)) + 0.5;
            ctx.strokeStyle = border;
            ctx.setLineDash([2, 3]);
            ctx.beginPath();
            ctx.moveTo(0, zero);
            ctx.lineTo(w, zero);
            ctx.stroke();
            ctx.setLineDash([]);
            const last = flow.cumNet[now]!;
            const color = cssColor(el, last >= 0 ? vars.color.up : vars.color.down);
            ctx.beginPath();
            for (let i = from; i <= now; i += 1) {
                const x = slotX(i, w);
                if (i === from) ctx.moveTo(x, y(flow.cumNet[i]!));
                else ctx.lineTo(x, y(flow.cumNet[i]!));
            }
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.lineJoin = 'round';
            ctx.stroke();
            // soft fill back to the zero line
            ctx.lineTo(slotX(now, w), zero);
            ctx.lineTo(slotX(from, w), zero);
            ctx.closePath();
            ctx.globalAlpha = 0.1;
            ctx.fillStyle = color;
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(slotX(now, w), y(last), 2.5, 0, Math.PI * 2);
            ctx.fill();
            if (hover !== null) {
                ctx.fillStyle = cssColor(el, vars.color.accent);
                ctx.fillRect(Math.round(slotX(hover, w)), 0, 1, h);
            }
        },
        [flow, from, now, hover, themeKey, revision],
    );
    return <canvas ref={ref} className={s.tierCanvas} aria-hidden='true' />;
}

function Segment<T extends string>({
    value,
    options,
    onChange,
    label,
}: {
    value: T;
    options: { value: T; label: string; title?: string }[];
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
                    title={option.title}
                    onClick={() => onChange(option.value)}
                >
                    {option.label}
                </button>
            ))}
        </span>
    );
}

function fmtAccel(value: number | null) {
    return value === null ? '--' : `${value.toFixed(1)}×`;
}

function sumBars(flow: GroupFlow) {
    let sum = 0;
    for (const v of flow.turnover) sum += v;
    return sum;
}

const RELATION_GROUPS: { kind: RelationKind; label: string; icon: typeof ArrowUpRight }[] = [
    { kind: 'supplier', label: '供應商', icon: ArrowDownRight },
    { kind: 'customer', label: '客戶', icon: ArrowUpRight },
    { kind: 'competitor', label: '競爭', icon: Swords },
    { kind: 'partner', label: '合作', icon: Handshake },
];
const RELATIONS_PER_GROUP = 5;

interface TierView {
    tier: ChainTier;
    codes: string[];
    flow: GroupFlow;
}

export function ChainMap({
    contract,
    onPick,
}: {
    contract?: ContractBase | null;
    onPick?: (code: string) => void;
}) {
    const data = useChainMapData();
    const ready = data.phase === 'ready' ? data : null;
    const themeKey = themeKeyOf(useThemeSettings());

    const [themeId, setThemeIdState] = useState(() => {
        try {
            return localStorage.getItem(THEME_KEY) || DEFAULT_THEME;
        } catch {
            return DEFAULT_THEME;
        }
    });
    const [kind, setKindState] = useState<KindFilter>(() => readPref(KIND_KEY, ['all', 'chain', 'theme'] as const, 'all'));
    const [sort, setSortState] = useState<FlowSort>(() => readPref(SORT_KEY, ['flow5', 'accel', 'pct'] as const, 'flow5'));
    const [focus, setFocus] = useState<string | null>(null);
    const [hoverRaw, setHover] = useState<number | null>(null);

    const setThemeId = useCallback((id: string) => {
        setThemeIdState(id);
        writePref(THEME_KEY, id);
    }, []);

    const themes = ready?.themes ?? null;
    const entities = ready?.entities ?? null;
    const index = useMemo(() => (entities ? entityIndex(entities) : null), [entities]);
    const nameOf = useCallback((code: string) => entityName(index, `tw.${code}`), [index]);

    // ── live feed: every member of every chain and theme ──
    const members = useMemo<FeedMember[]>(() => {
        if (!themes) return [];
        const daily = ready?.market?.quotes;
        return memberCodes(themes).map((code) => ({
            code,
            contract: stockContract(code, index?.get(`tw.${code}`)?.market),
            shares: daily?.[code]?.shares ?? null,
        }));
    }, [themes, index, ready?.market]);
    useEffect(() => (members.length > 0 ? connectChainFlow(members) : undefined), [members]);

    const { ref: rootRef, element: rootEl, size: rootSize } = useBoxSize<HTMLDivElement>();
    const paused = usePaused(rootEl);
    const revision = useChainFlowRevision(paused);
    const book = chainFlowBook;
    const feed = chainFlowStatus();
    const now = book.lastSlot;
    const from = book.firstSlot;
    // the crosshair only means something over received minutes
    const hover = hoverRaw !== null && from !== null && now !== null && hoverRaw >= from && hoverRaw <= now ? hoverRaw : null;

    // ── tape rows ──
    const pool = useMemo(() => (themes ?? []).filter((t) => kind === 'all' || t.kind === kind), [themes, kind]);
    const rows = useMemo(() => {
        const list = pool.flatMap((theme) => {
            const codes = themeCodes(theme);
            return codes.length > 0 ? [{ theme, codes, flow: groupFlow(book, codes, now) }] : [];
        });
        return list.sort(
            (a, b) =>
                flowSortKey(b.flow, sort) - flowSortKey(a.flow, sort) ||
                (b.flow.pct ?? -Infinity) - (a.flow.pct ?? -Infinity) ||
                b.flow.total - a.flow.total,
        );
        // the book mutates in place: `revision` is the change signal
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pool, sort, revision, now]);

    const theme: Theme | null = useMemo(() => {
        if (!themes) return null;
        return themes.find((t) => t.id === themeId) ?? themes.find((t) => t.id === DEFAULT_THEME) ?? themes[0] ?? null;
    }, [themes, themeId]);

    // ── chain detail: upstream → midstream → downstream ──
    const stageOf = useMemo(() => {
        const map = new Map<string, string>();
        if (!theme) return map;
        const names = new Map(theme.stages.map((st) => [st.id, st.name]));
        for (const m of theme.members) {
            const code = twCodeOf(m.id);
            if (code && !map.has(code)) map.set(code, names.get(m.stage) ?? '');
        }
        return map;
    }, [theme]);
    const tiers = useMemo<TierView[]>(() => {
        if (!theme) return [];
        const byStage = stageMembers(theme);
        const tierOf = new Map(theme.stages.map((st) => [st.id, st.tier]));
        const buckets = new Map<ChainTier, Set<string>>();
        for (const [stageId, codes] of byStage) {
            const raw = tierOf.get(stageId);
            const tier = raw && TIERS.includes(raw) ? raw : 'midstream';
            const set = buckets.get(tier) ?? new Set<string>();
            codes.forEach((c) => set.add(c));
            buckets.set(tier, set);
        }
        return [...buckets.entries()]
            .filter(([, set]) => set.size > 0)
            .sort((a, b) => tierRank(a[0]) - tierRank(b[0]))
            .map(([tier, set]) => {
                const codes = [...set];
                return { tier, codes, flow: groupFlow(book, codes, now) };
            });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [theme, revision, now]);
    const shifts = useMemo(() => shareShift(tiers.map((t) => t.flow), now), [tiers, now]);

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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [linkedCode, themes]);

    // keep the selected row visible (restored or followed)
    const tapeRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        tapeRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView?.({ block: 'nearest' });
    }, [theme?.id, kind, ready !== null]);

    const pick = useCallback(
        (code: string) => {
            setFocus(code);
            onPick?.(code);
        },
        [onPick],
    );

    // ── render ──
    if (data.phase === 'loading') {
        return (
            <div className={s.center}>
                <AsyncStatus phase='loading' text='讀取產業鏈資料…' />
            </div>
        );
    }
    if (data.phase === 'error' || !theme) {
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

    const narrow = rootSize.width > 0 && rootSize.width < NARROW_PX;
    const showDetail = rootSize.height === 0 || rootSize.height >= DETAIL_MIN_PX;
    // minutes before the first received bar are covered by the seed summary
    const covered = from ?? (book.codes.size > 0 ? SESSION_SLOTS : 0);
    const seedWidth = (covered / SESSION_SLOTS) * 100;
    // seeded after 13:30: the snapshot already covers the whole session
    let closed = false;
    if (now === null) for (const f of book.codes.values()) if (f.seedSlot >= SESSION_SLOTS) { closed = true; break; }
    const liveText =
        now !== null
            ? `1 分 K・${feed.kbarCodes} 檔・${slotLabel(Math.min(now + 1, SESSION_SLOTS - 1))}`
            : closed
              ? '已收盤・今日彙總'
              : feed.batches > 0
                ? `1 分 K 已訂閱 ${feed.subscribed}/${feed.batches} 批・等待下一根`
                : '';

    return (
        <div ref={rootRef} className={s.wrap}>
            <div className={s.toolbar}>
                <Segment
                    label='類型'
                    value={kind}
                    onChange={(v) => {
                        setKindState(v);
                        writePref(KIND_KEY, v);
                    }}
                    options={[
                        { value: 'all', label: '全部' },
                        { value: 'chain', label: '產業鏈' },
                        { value: 'theme', label: '題材' },
                    ]}
                />
                <Segment
                    label='排序'
                    value={sort}
                    onChange={(v) => {
                        setSortState(v);
                        writePref(SORT_KEY, v);
                    }}
                    options={[
                        { value: 'flow5', label: '5 分淨流入', title: '最近 5 根 1 分 K 的淨流入（估算）' },
                        { value: 'accel', label: '量能', title: '近 5 分鐘成交值 ÷（今日每分鐘平均 × 5）' },
                        { value: 'pct', label: '漲跌', title: '市值加權漲跌' },
                    ]}
                />
                <span className={s.spacer} />
                {feed.kbarError ? (
                    <span className={`${s.live} ${panel.statusText.err}`} title={feed.kbarError}>
                        <AlertTriangle size={11} aria-hidden='true' />1 分 K 訂閱失敗
                    </span>
                ) : liveText ? (
                    <span className={s.live} title='即時 1 分 K 訂閱；其他面板已訂閱的 tick 會更快更新價格'>
                        <Radio size={11} className={now !== null ? s.liveOn : undefined} aria-hidden='true' />
                        {liveText}
                    </span>
                ) : null}
                {ready?.stale && <span className={s.stale}>{STALE_TEXT}</span>}
            </div>

            <div className={s.tape} ref={tapeRef}>
                <div className={`${s.row} ${s.headRow} ${narrow ? s.rowNarrow : ''}`}>
                    <span className={s.headName}>{kind === 'theme' ? '題材' : kind === 'chain' ? '產業鏈' : '產業鏈／題材'}</span>
                    <span className={s.axis} title='每分鐘淨流入 ÷ 成交值（3 分鐘平滑）：中線以上＝流入、以下＝流出；斜線區＝開啟面板前，只有成交值彙總'>
                        {HOURS.map((slot) => (
                            <span key={slot} className={s.axisTick} style={{ left: `${((slot + 0.5) / SESSION_SLOTS) * 100}%` }}>
                                {slotLabel(slot)}
                            </span>
                        ))}
                        {hover !== null && (
                            <span className={s.axisHover} style={{ left: `${((hover + 0.5) / SESSION_SLOTS) * 100}%` }}>
                                {slotLabel(hover)}
                            </span>
                        )}
                    </span>
                    <span className={s.headNum} title='最近 5 根 1 分 K：成交值 × 方向（收盤價較前一分鐘），估算'>
                        5 分淨流入
                    </span>
                    {!narrow && (
                        <span className={s.headNum} title='近 5 分鐘成交值 ÷（今日每分鐘平均 × 5）'>
                            量能
                        </span>
                    )}
                    <span className={s.headNum}>漲跌</span>
                </div>
                {rows.map(({ theme: t, codes, flow }) => {
                    const selected = t.id === theme.id;
                    const seedAmount = flow.total - sumBars(flow);
                    return (
                        <div
                            key={t.id}
                            role='button'
                            tabIndex={0}
                            className={`${s.row} ${s.dataRow[selected ? 'on' : 'off']} ${narrow ? s.rowNarrow : ''}`}
                            aria-current={selected ? 'true' : undefined}
                            onClick={() => setThemeId(t.id)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    setThemeId(t.id);
                                }
                            }}
                            title={[
                                `${t.name}・${codes.length} 檔`,
                                `今日成交值 ${fmtTwd(flow.total)}`,
                                now !== null ? `累積淨流入（已收到的 1 分 K）${fmtTwd(flow.cumNet[now]!, true)}` : '',
                                `漲 ${flow.breadth.up}・平 ${flow.breadth.flat}・跌 ${flow.breadth.down}`,
                                hover !== null
                                    ? `${slotLabel(hover)} 淨流入 ${fmtTwd(flow.net[hover]!, true)}・成交值 ${fmtTwd(flow.turnover[hover]!)}`
                                    : '',
                            ]
                                .filter(Boolean)
                                .join('\n')}
                        >
                            <span className={s.name}>
                                <span className={s.kindMark[t.kind === 'chain' ? 'chain' : 'theme']} aria-hidden='true' />
                                <span className={s.nameText}>{t.name}</span>
                            </span>
                            <span className={s.strip}>
                                {seedWidth > 0 && (
                                    <span className={s.seed} style={{ width: `${seedWidth}%` }}>
                                        {seedWidth >= 8 && seedAmount > 0 && (
                                            <span
                                                className={s.seedText}
                                                title={`${from === null ? '今日' : `開盤至 ${slotLabel(from)}`}成交值（snapshot 彙總，開啟面板前沒有逐分資料）`}
                                            >
                                                {fmtTwd(seedAmount)}
                                            </span>
                                        )}
                                    </span>
                                )}
                                <FlowStrip
                                    net={flow.net}
                                    turnover={flow.turnover}
                                    from={from}
                                    now={now}
                                    hover={hover}
                                    themeKey={themeKey}
                                    revision={revision}
                                    onHover={setHover}
                                />
                            </span>
                            <span className={`${s.num} ${panel.dirText[dir(now !== null ? flow.flow5 : null)]}`}>
                                {now !== null ? fmtTwd(flow.flow5, true) : '--'}
                            </span>
                            {!narrow && (
                                <span className={`${s.num} ${flow.accel !== null && flow.accel >= 1.5 ? s.hot : s.dim}`}>
                                    {fmtAccel(flow.accel)}
                                </span>
                            )}
                            <span className={`${s.num} ${panel.dirText[dir(flow.pct)]}`}>{fmtSignedPct(flow.pct)}</span>
                        </div>
                    );
                })}
            </div>

            {showDetail && (
                <div className={s.detail}>
                    <div className={s.detailHead}>
                        <span className={s.kindMark[theme.kind === 'chain' ? 'chain' : 'theme']} aria-hidden='true' />
                        <span className={s.detailTitle}>{theme.name}</span>
                        <span className={s.detailMeta}>
                            {themeCodes(theme).length} 檔・
                            {now !== null ? '累積淨流入走勢・近 15 分鐘資金占比變化' : closed ? '今日收盤彙總；盤中依 1 分 K 顯示資金流向' : '開盤至今彙總，下一根 1 分 K 起顯示走勢'}
                        </span>
                    </div>
                    <div className={`${s.detailBody} ${focus ? s.detailBodyFocus : ''}`}>
                        <div className={s.tiers} style={{ gridTemplateColumns: `repeat(${Math.max(1, tiers.length)}, minmax(0, 1fr))` }}>
                            {tiers.map((tier, i) => (
                                <TierCard
                                    key={tier.tier}
                                    view={tier}
                                    shift={shifts[i] ?? 0}
                                    last={i === tiers.length - 1}
                                    from={from}
                                    now={now}
                                    hover={hover}
                                    themeKey={themeKey}
                                    revision={revision}
                                    nameOf={nameOf}
                                    stageOf={stageOf}
                                    focus={focus}
                                    onPick={pick}
                                />
                            ))}
                        </div>
                        {focus && (
                            <FocusCard
                                code={focus}
                                theme={theme}
                                edges={ready?.edges ?? null}
                                nameOf={(id) => entityName(index, id)}
                                inChain={(code) => stageOf.has(code)}
                                onPick={pick}
                                onClose={() => setFocus(null)}
                                revision={revision}
                            />
                        )}
                    </div>
                </div>
            )}

            <div className={s.footer}>
                <span>
                    淨流入為估算：每分鐘成交值 × 方向（收盤價較前一分鐘）。產業鏈與題材為第三方 AI 整理資料（
                    {ready?.themesMeta.asOf ?? '--'}），可能過時或有誤
                </span>
            </div>
        </div>
    );
}

function TierCard({
    view,
    shift,
    last,
    from,
    now,
    hover,
    themeKey,
    revision,
    nameOf,
    stageOf,
    focus,
    onPick,
}: {
    view: TierView;
    shift: number;
    last: boolean;
    from: number | null;
    now: number | null;
    hover: number | null;
    themeKey: string;
    revision: number;
    nameOf: (code: string) => string;
    stageOf: Map<string, string>;
    focus: string | null;
    onPick: (code: string) => void;
}) {
    const { flow } = view;
    const live = now !== null;
    const top = useMemo(() => {
        if (live) return leaders(chainFlowBook, view.codes, 4, now);
        // before the first bar: largest session turnover so far
        return view.codes
            .map((code) => {
                const f = chainFlowBook.codes.get(code);
                return { code, flow5: 0, turnover5: f ? sessionTurnover(f) : 0, pct: codePct(f) };
            })
            .filter((row) => row.turnover5 > 0)
            .sort((a, b) => b.turnover5 - a.turnover5)
            .slice(0, 4);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [view, revision, now, live]);
    return (
        <div className={s.tierCard}>
            <div className={s.tierHead}>
                <span className={s.tierTag[view.tier === 'upstream' ? 'upstream' : view.tier === 'downstream' ? 'downstream' : 'midstream']}>
                    {tierLabel(view.tier)}
                </span>
                <span className={s.tierCount}>{view.codes.length} 檔</span>
                <span className={s.spacer} />
                {live && Math.abs(shift) >= 0.05 && (
                    <span
                        className={`${s.shift} ${panel.dirText[dir(shift)]}`}
                        title='近 15 分鐘成交值占全鏈比重，相對今日已收到 1 分 K 占比的變化'
                    >
                        {shift > 0 ? <ArrowUpRight size={11} aria-hidden='true' /> : <ArrowDownRight size={11} aria-hidden='true' />}
                        {Math.abs(shift).toFixed(1)} pp
                    </span>
                )}
                {!last && <ChevronRight size={12} className={s.tierArrow} aria-hidden='true' />}
            </div>
            <div className={s.tierFigures}>
                <span className={s.figure}>
                    <span className={s.figureLabel}>5 分淨流入</span>
                    <span className={`${s.figureValue} ${panel.dirText[dir(live ? flow.flow5 : null)]}`}>
                        {live ? fmtTwd(flow.flow5, true) : '--'}
                    </span>
                </span>
                <span className={s.figure}>
                    <span className={s.figureLabel}>成交值</span>
                    <span className={s.figureValue}>{fmtTwd(flow.total)}</span>
                </span>
                <span className={s.figure}>
                    <span className={s.figureLabel}>漲跌</span>
                    <span className={`${s.figureValue} ${panel.dirText[dir(flow.pct)]}`}>{fmtSignedPct(flow.pct)}</span>
                </span>
            </div>
            <TierChart flow={flow} from={from} now={now} hover={hover} themeKey={themeKey} revision={revision} />
            <div className={s.leaders}>
                {top.map((row) => (
                    <button
                        key={row.code}
                        type='button'
                        className={s.leader[row.code === focus ? 'on' : 'off']}
                        onClick={() => onPick(row.code)}
                        title={`${nameOf(row.code)} ${row.code}・${stageOf.get(row.code) ?? ''}`}
                    >
                        <span className={s.leaderName}>{nameOf(row.code)}</span>
                        <span className={s.leaderStage}>{stageOf.get(row.code)}</span>
                        <span className={`${s.leaderNum} ${panel.dirText[dir(row.pct)]}`}>{fmtSignedPct(row.pct)}</span>
                        <span className={`${s.leaderNum} ${live ? panel.dirText[dir(row.flow5)] : s.dim}`}>
                            {live ? fmtTwd(row.flow5, true) : fmtTwd(row.turnover5)}
                        </span>
                    </button>
                ))}
                {top.length === 0 && <span className={s.empty}>尚無成交</span>}
            </div>
        </div>
    );
}

function FocusCard({
    code,
    theme,
    edges,
    nameOf,
    inChain,
    onPick,
    onClose,
    revision,
}: {
    code: string;
    theme: Theme;
    edges: Edge[] | null;
    nameOf: (id: string) => string;
    inChain: (code: string) => boolean;
    onPick: (code: string) => void;
    onClose: () => void;
    revision: number;
}) {
    const flow = chainFlowBook.codes.get(code);
    const pct = codePct(flow);
    const roles = useMemo(() => {
        const names = new Map(theme.stages.map((st) => [st.id, st]));
        return theme.members
            .filter((m) => m.id === `tw.${code}`)
            .map((m) => ({ stage: names.get(m.stage), detail: m.detail }));
    }, [theme, code]);
    const groups = useMemo(() => {
        if (!edges) return [];
        const same = (hit: RelationHit) => Number(inChain(twCodeOf(hit.counterparty) ?? ''));
        return RELATION_GROUPS.map((group) => ({
            ...group,
            // same-chain names first: those are what the flow view explains
            rows: dedupe(relationsFor(edges, `tw.${code}`, group.kind)).sort((a, b) => same(b) - same(a)),
        })).filter((group) => group.rows.length > 0);
    }, [edges, code, inChain]);
    const now = chainFlowBook.lastSlot;
    let flow5: number | null = null;
    if (flow && now !== null) {
        flow5 = 0;
        for (let i = Math.max(0, now - WINDOW + 1); i <= now; i += 1) flow5 += flow.net[i]!;
    }
    void revision;
    return (
        <aside className={s.focus} aria-label='聚焦個股'>
            <div className={s.focusHead}>
                <CircleDot size={12} className={s.focusIcon} aria-hidden='true' />
                <button type='button' className={s.focusName} onClick={() => onPick(code)} title='設為連動商品'>
                    {nameOf(`tw.${code}`)} <span className={s.focusCode}>{code}</span>
                </button>
                <span className={s.spacer} />
                <button type='button' className={s.closeBtn} onClick={onClose} aria-label='取消聚焦'>
                    <X size={12} aria-hidden='true' />
                </button>
            </div>
            <div className={s.focusFigures}>
                <span className={s.figure}>
                    <span className={s.figureLabel}>價</span>
                    <span className={`${s.figureValue} ${panel.dirText[dir(pct)]}`}>{flow?.last ? fmtPrice(flow.last) : '--'}</span>
                </span>
                <span className={s.figure}>
                    <span className={s.figureLabel}>漲跌</span>
                    <span className={`${s.figureValue} ${panel.dirText[dir(pct)]}`}>{fmtSignedPct(pct)}</span>
                </span>
                <span className={s.figure}>
                    <span className={s.figureLabel}>5 分淨流入</span>
                    <span className={`${s.figureValue} ${panel.dirText[dir(flow5)]}`}>{fmtTwd(flow5, true)}</span>
                </span>
                <span className={s.figure}>
                    <span className={s.figureLabel}>成交值</span>
                    <span className={s.figureValue}>{flow ? fmtTwd(sessionTurnover(flow)) : '--'}</span>
                </span>
            </div>
            {roles.length > 0 && (
                <div className={s.focusRole}>
                    {roles.map((row, i) => (
                        <span key={i}>
                            <b>{row.stage?.name ?? ''}</b>
                            {row.detail ? `：${row.detail}` : ''}
                        </span>
                    ))}
                </div>
            )}
            <div className={s.focusGroups}>
                {groups.length === 0 && <span className={s.empty}>資料中沒有這家公司的上下游關係</span>}
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
                                const relPct = tw ? codePct(chainFlowBook.codes.get(tw)) : null;
                                const same = tw !== null && inChain(tw);
                                const title = [
                                    nameOf(hit.counterparty),
                                    hit.edge.detail ?? '',
                                    `證據：${hit.edge.evidence_level === 'primary' ? '公司／交易對手公開文件' : hit.edge.evidence_level === 'media' ? '具名媒體' : hit.edge.evidence_level}`,
                                    hit.edge.as_of ? `as_of ${hit.edge.as_of}` : '',
                                    same ? '同鏈' : '',
                                ]
                                    .filter(Boolean)
                                    .join('\n');
                                const body = (
                                    <>
                                        <span className={same ? s.inChainDot : s.outChainDot} aria-hidden='true' />
                                        <span className={s.relName}>{nameOf(hit.counterparty)}</span>
                                        {hit.edge.evidence_level === 'media' && <span className={s.evidenceTag}>媒體</span>}
                                        <span className={`${s.relPct} ${panel.dirText[dir(relPct)]}`}>
                                            {relPct !== null ? fmtSignedPct(relPct) : ''}
                                        </span>
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
        </aside>
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
