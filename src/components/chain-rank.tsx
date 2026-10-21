// src/components/chain-rank.tsx — 排行 view: groups ranked by net inflow.
//
// Restraint first. Each group is one row: a round category dot, the name,
// a small rank-change mark, a thin lane growing from a fixed centre axis
// (inflow right, outflow left, one square-root scale for both), and the value. Lane
// thickness follows turnover; the lane fades toward the axis and ends in a
// small solid dot. Only the leader (and this minute's biggest mover) gets a
// soft glow. Fine light particles drift along each lane, sparser and slower
// on quiet groups. Rows glide to their new rank when a minute bar lands;
// inflow and outflow groups are separated by a gap. Everything is static
// under prefers-reduced-motion; the canvas is capped at 30 fps and stops
// while the panel is hidden.

import { ChevronsDownUp, PanelRightOpen, Triangle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { slotLabel, SESSION_SLOTS } from '../lib/chain-flow';
import { fmtSignedPct, fmtTwd } from '../lib/chain-map';
import { comparesRanks, rankOrder, rankTurnover, rankValue, rankMoves, riverLength, riverWidth, type RankMetric } from '../lib/chain-motion';
import { vars } from '../theme.css';
import { FlowRankCard, metricLabel } from './chain-rank-card';
import { cssColor, dir, useBoxSize, type FlowRow } from './chain-ui';
import { Odometer } from './odometer';
import * as s from './chain-map.css';

const ROW_PX = 34;
const GAP_PX = 26;
/** Rows shown per side until the viewer asks for every group. */
const SIDE_ROWS = 8;
const MOVE_SHOW_MS = 6000;
const MAX_PARTICLES = 40;
/** Share of the half-track the largest value fills (room for the end dot). */
const REACH = 0.94;
/** Below this width the detail card is left out (the lanes need the room). */
/** Below this the detail card would squeeze the lanes: it becomes a drawer. */
const CARD_DOCK_PX = 1180;
const FRAME_MS = 1000 / 30 - 2;

interface Particle {
    phase: number;
    speed: number;
    /** dot radius, or dash length when `dash` */
    size: number;
    dash: boolean;
    /** vertical position across the lane, -0.5…0.5 */
    lane: number;
    alpha: number;
}

/** Parse #rgb / #rrggbb / rgb() into channels, or null. */
export function rgbOf(color: string): [number, number, number] | null {
    const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
        const h = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join('') : hex[1]!;
        return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
    }
    const rgb = color.match(/rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i);
    return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

/** `color` moved `t` of the way toward `target` (falls back to `color`). */
export function mixColor(color: string, target: string, t: number): string {
    const a = rgbOf(color);
    const b = rgbOf(target);
    if (!a || !b) return color;
    const c = a.map((v, i) => Math.round(v + (b[i]! - v) * t));
    return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

export function FlowRank({
    rows,
    metric,
    now,
    from,
    selectedId,
    reducedMotion,
    paused,
    onSelect,
    nameOf,
    onPick,
}: {
    rows: FlowRow[];
    metric: RankMetric;
    now: number | null;
    from: number | null;
    selectedId: string;
    reducedMotion: boolean;
    paused: boolean;
    onSelect: (id: string) => void;
    nameOf: (code: string) => string;
    onPick: (code: string) => void;
}) {
    const order = useMemo(
        () => rankOrder(rows, (r) => r.theme.id, (r) => rankValue(r.flow, now, metric)),
        [rows, now, metric],
    );
    // fixed centre axis, one square-root scale for both sides
    const maxAbs = useMemo(() => Math.max(0, ...order.map((r) => Math.abs(r.value))), [order]);
    // the largest inflows and outflows; the quiet middle folds into the gap
    const [showAll, setShowAll] = useState(false);
    const shown = useMemo(() => {
        if (showAll) return order;
        const ins = order.filter((r) => r.side === 'in').slice(0, SIDE_ROWS);
        const outs = order.filter((r) => r.side === 'out').slice(-SIDE_ROWS);
        return [...ins, ...outs];
    }, [order, showAll]);
    const hidden = order.length - shown.length;
    const firstOut = shown.findIndex((r) => r.side === 'out');
    const turnoverOf = (row: FlowRow) => rankTurnover(row.flow, now, metric);
    const maxTurnover = useMemo(() => Math.max(0, ...rows.map((r) => rankTurnover(r.flow, now, metric))), [rows, now, metric]);
    const { ref: layoutRef, size: layoutSize } = useBoxSize<HTMLDivElement>();
    const selectedRow = rows.find((r) => r.theme.id === selectedId) ?? null;
    const docked = layoutSize.width >= CARD_DOCK_PX;
    const [drawer, setDrawer] = useState(false);
    const showCard = selectedRow !== null && (docked || drawer);
    const label = metricLabel(metric);

    // rank changes and this minute's biggest mover
    const prevRanks = useRef(new Map<string, number>());
    const prevValues = useRef(new Map<string, number>());
    const [moves, setMoves] = useState<{ at: number; map: Map<string, number>; mover: string | null }>({
        at: 0,
        map: new Map(),
        mover: null,
    });
    const prevNow = useRef<number | null>(null);
    useEffect(() => {
        if (!comparesRanks(prevNow.current, now)) {
            prevNow.current = now;
            prevRanks.current = new Map(order.map((r) => [r.id, r.rank]));
            prevValues.current = new Map(order.map((r) => [r.id, r.value]));
            return;
        }
        prevNow.current = now;
        const map = rankMoves(prevRanks.current, order);
        let mover: string | null = null;
        let best = 0;
        for (const row of order) {
            const before = prevValues.current.get(row.id);
            const delta = before === undefined ? 0 : Math.abs(row.value - before);
            if (delta > best) {
                best = delta;
                mover = row.id;
            }
        }
        prevRanks.current = new Map(order.map((r) => [r.id, r.rank]));
        prevValues.current = new Map(order.map((r) => [r.id, r.value]));
        setMoves({ at: Date.now(), map, mover });
        // `now` changes together with `order`
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [order]);
    const [, setTick] = useState(0);
    useEffect(() => {
        if (moves.at === 0) return;
        const timer = setTimeout(() => setTick((n) => n + 1), MOVE_SHOW_MS);
        return () => clearTimeout(timer);
    }, [moves.at]);
    const showMoves = Date.now() - moves.at < MOVE_SHOW_MS;

    const sum = order.reduce((a, r) => a + r.value, 0);
    const top = order[0];
    const bottom = order[order.length - 1];

    // particles: one canvas over the lanes, reading each lane's live rect so
    // they follow the CSS transitions exactly
    const areaRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const particles = useRef(new Map<string, Particle[]>());
    const intensity = useMemo(() => {
        const map = new Map<string, number>();
        for (const row of rows) {
            const f = row.flow;
            map.set(row.theme.id, f.turnover5 > 0 ? Math.min(1, Math.abs(f.flow5) / f.turnover5) : 0);
        }
        return map;
    }, [rows]);
    useEffect(() => {
        const canvas = canvasRef.current;
        const area = areaRef.current;
        if (!canvas || !area || reducedMotion || paused || now === null) {
            canvas?.getContext?.('2d')?.clearRect(0, 0, canvas.width, canvas.height);
            return;
        }
        let raf = 0;
        let last = performance.now();
        const dark = getComputedStyle(document.documentElement).colorScheme.includes('dark');
        // light particles on dark lanes; on a light surface, the lane colour itself
        const up = cssColor(area, vars.color.up);
        const down = cssColor(area, vars.color.down);
        const inColor = dark ? mixColor(up, '#ffffff', 0.72) : up;
        const outColor = dark ? mixColor(down, '#ffffff', 0.72) : down;
        const frame = (t: number) => {
            raf = requestAnimationFrame(frame);
            if (t - last < FRAME_MS) return;
            const dt = Math.min(0.1, (t - last) / 1000);
            last = t;
            // the canvas overlays the visible part of the list only
            const box = area.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            const w = Math.round(box.width * dpr);
            const h = Math.round(box.height * dpr);
            if (canvas.width !== w) canvas.width = w;
            if (canvas.height !== h) canvas.height = h;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, box.width, box.height);
            ctx.lineCap = 'round';
            ctx.lineWidth = 1;
            for (const bar of area.querySelectorAll<HTMLElement>('[data-bar]')) {
                const r = bar.getBoundingClientRect();
                const len = r.width;
                if (len < 10 || r.bottom < box.top || r.top > box.bottom) continue;
                const id = bar.dataset.bar!;
                const k = intensity.get(id) ?? 0;
                // density follows length and recent intensity: busy lanes shimmer, quiet ones barely move
                const want = Math.min(MAX_PARTICLES, Math.round((len / 9) * (0.5 + 2.5 * k)) + 1);
                let list = particles.current.get(id);
                if (!list) {
                    list = [];
                    particles.current.set(id, list);
                }
                while (list.length < want) {
                    const dash = Math.random() < 0.25;
                    list.push({
                        phase: Math.random(),
                        speed: 0.12 + Math.random() * 0.2,
                        size: dash ? 2 + Math.random() * 3 : 0.6 + Math.random() * 0.5,
                        dash,
                        lane: Math.random() - 0.5,
                        alpha: 0.35 + Math.random() * 0.5,
                    });
                }
                list.length = want;
                const out = bar.dataset.side === 'out';
                const sign = out ? -1 : 1;
                const yMid = r.top - box.top + r.height / 2;
                const x0 = out ? r.right - box.left : r.left - box.left;
                const color = out ? outColor : inColor;
                ctx.fillStyle = color;
                ctx.strokeStyle = color;
                for (const p of list) {
                    p.phase = (p.phase + dt * p.speed * (0.6 + 1.2 * k)) % 1;
                    const x = x0 + sign * p.phase * (len - 4);
                    const y = yMid + p.lane * Math.max(0, r.height - 2);
                    // fade in off the axis and out before the end dot
                    ctx.globalAlpha = p.alpha * Math.min(1, p.phase * 5) * Math.min(1, (1 - p.phase) * 8);
                    ctx.beginPath();
                    if (p.dash) {
                        ctx.moveTo(x - sign * p.size, y);
                        ctx.lineTo(x, y);
                        ctx.stroke();
                    } else {
                        ctx.arc(x, y, p.size, 0, Math.PI * 2);
                        ctx.fill();
                    }
                }
            }
            ctx.globalAlpha = 1;
        };
        raf = requestAnimationFrame(frame);
        return () => cancelAnimationFrame(raf);
    }, [reducedMotion, paused, now, intensity]);

    const gap = firstOut > 0 || hidden > 0;
    const height = shown.length * ROW_PX + (gap ? GAP_PX : 0);
    const span =
        now === null ? '' : metric === 'cum' ? `${from !== null ? slotLabel(from) : ''} 至 ${slotLabel(Math.min(now + 1, SESSION_SLOTS - 1))}` : label;

    return (
        <div className={s.rank}>
            <div className={s.rankKpis}>
                <span className={s.kpi}>
                    <span className={s.kpiLabel}>族群淨流入合計{span ? `・${span}` : ''}</span>
                    <Odometer
                        className={`${s.rankKpiValue} ${s.rankTone[dir(now !== null ? sum : null)]}`}
                        text={now !== null ? fmtTwd(sum, true) : '--'}
                        reducedMotion={reducedMotion}
                    />
                </span>
                <span className={s.spacer} />
                <span className={s.rankKpiSide}>
                    <span className={s.rankKpiLine}>
                        <span className={s.kpiLabel}>淨流入最大</span>
                        <span className={s.rankKpiName}>{top && top.value > 0 ? top.item.theme.name : '--'}</span>
                        <span className={`${s.rankKpiSub} ${s.rankTone.up}`}>{top && top.value > 0 ? fmtTwd(top.value, true) : ''}</span>
                    </span>
                    <span className={s.rankKpiLine}>
                        <span className={s.kpiLabel}>淨流出最大</span>
                        <span className={s.rankKpiName}>{bottom && bottom.value < 0 ? bottom.item.theme.name : '--'}</span>
                        <span className={`${s.rankKpiSub} ${s.rankTone.down}`}>{bottom && bottom.value < 0 ? fmtTwd(bottom.value, true) : ''}</span>
                    </span>
                </span>
            </div>
            <div className={s.rankLayout} ref={layoutRef}>
                <div className={s.rankMain}>
                    <div className={s.rankHeader}>
                        <span className={s.rankHeaderTitle}>{label}淨流入排行</span>
                        <span className={s.rankHeaderNote}>長度為淨流入（平方根刻度）・粗細為成交值・點選看明細</span>
                        {showAll && order.length > SIDE_ROWS * 2 && (
                            <button type='button' className={s.rankDrawerToggle} onClick={() => setShowAll(false)} title='只顯示淨流入與淨流出最大的族群'>
                                <ChevronsDownUp size={12} aria-hidden='true' />
                                收合
                            </button>
                        )}
                        {!docked && selectedRow && (
                            <button
                                type='button'
                                className={s.rankDrawerToggle}
                                aria-pressed={drawer}
                                onClick={() => setDrawer((v) => !v)}
                                title='顯示選取族群的明細'
                            >
                                <PanelRightOpen size={12} aria-hidden='true' />
                                明細
                            </button>
                        )}
                    </div>
                    <div className={s.rankAxis} aria-hidden='true'>
                        <span />
                        <span className={s.rankAxisTrack}>
                            <span className={`${s.rankAxisSide} ${s.rankTone.down}`} style={{ right: '50%' }}>
                                流出
                            </span>
                            <span className={`${s.rankAxisSide} ${s.rankTone.up}`} style={{ left: '50%' }}>
                                流入
                            </span>
                        </span>
                        <span />
                    </div>
                    <div className={s.rankStage}>
                        <canvas ref={canvasRef} className={s.rankCanvas} aria-hidden='true' />
                        <div className={s.rankArea} ref={areaRef}>
                            <div className={s.rankRows} style={{ height }} role='group' aria-label={`族群${label}淨流入排行`}>
                                {hidden > 0 && (
                                    <button
                                        type='button'
                                        className={s.rankFold}
                                        style={{ top: (firstOut >= 0 ? firstOut : shown.length) * ROW_PX }}
                                        onClick={() => setShowAll(true)}
                                    >
                                        另有 {hidden} 個族群淨流量較小・顯示全部
                                    </button>
                                )}
                                {shown.map((row, index) => {
                                    const y = index * ROW_PX + (row.side === 'out' && gap ? GAP_PX : 0);
                                    const width = now !== null ? riverLength(row.value, maxAbs) * 50 * REACH : 0;
                                    const thick = Math.round(riverWidth(turnoverOf(row.item), maxTurnover, 3, 18) * 2) / 2;
                                    const move = showMoves ? (moves.map.get(row.id) ?? 0) : 0;
                                    const selected = row.id === selectedId;
                                    const f = row.item.flow;
                                    // only the leader, and this minute's biggest mover, glow
                                    const lead = row.rank === 0 && row.side === 'in';
                                    const glow = lead || (showMoves && moves.mover === row.id);
                                    // a brief ring only when one of the top three changed place
                                    const ring = !reducedMotion && move !== 0 && row.rank < 3 && row.side === 'in';
                                    const head = glow ? Math.max(10, Math.min(18, thick + 4)) : Math.max(6, Math.min(12, thick * 0.8));
                                    return (
                                        <button
                                            key={row.id}
                                            type='button'
                                            aria-pressed={selected}
                                            aria-label={`第 ${row.rank + 1} 名 ${row.item.theme.name}，${label}淨流入 ${fmtTwd(row.value, true)}，漲跌 ${fmtSignedPct(f.pct)}${move !== 0 ? `，${move > 0 ? '上升' : '下降'} ${Math.abs(move)} 名` : ''}`}
                                            className={`${s.rankRow[selected ? 'on' : 'off']} ${reducedMotion ? s.still : ''}`}
                                            style={{ transform: `translateY(${y}px)` }}
                                            onClick={() => onSelect(row.id)}
                                            title={`${row.item.theme.name}・${row.item.codes.length} 檔\n${label}淨流入 ${fmtTwd(row.value, true)}\n今日成交值 ${fmtTwd(f.total)}・漲跌 ${fmtSignedPct(f.pct)}`}
                                        >
                                            <span className={s.rankName}>
                                                <span className={s.rankDot[row.item.theme.kind === 'chain' ? 'chain' : 'theme']} aria-hidden='true' />
                                                <span className={s.rankNameText}>{row.item.theme.name}</span>
                                                {move !== 0 && (
                                                    <span
                                                        className={`${s.rankMove} ${s.rankTone[move > 0 ? 'up' : 'down']}`}
                                                        title={`與前一分鐘相比${move > 0 ? '上升' : '下降'} ${Math.abs(move)} 名`}
                                                    >
                                                        <Triangle size={6} fill='currentColor' strokeWidth={0} className={move < 0 ? s.rankMoveDown : undefined} />
                                                        {Math.abs(move)}
                                                    </span>
                                                )}
                                            </span>
                                            <span className={s.rankTrack}>
                                                <span className={s.rankZero} aria-hidden='true' />
                                                <span
                                                    data-bar={row.id}
                                                    data-side={row.side}
                                                    className={`${s.rankBar[row.side]} ${reducedMotion ? s.still : ''}`}
                                                    style={{
                                                        height: `${thick}px`,
                                                        width: `${width}%`,
                                                        borderRadius: `${thick / 2}px`,
                                                        ...(row.side === 'in' ? { left: '50%' } : { right: '50%' }),
                                                    }}
                                                >
                                                    {width > 0.3 && (
                                                        <span
                                                            className={`${(glow ? s.rankHeadGlow : s.rankHead)[row.side]} ${reducedMotion ? s.still : ''}`}
                                                            style={{
                                                                width: `${head}px`,
                                                                height: `${head}px`,
                                                                marginTop: `${-head / 2}px`,
                                                                ...(row.side === 'in' ? { right: `${-head / 2}px` } : { left: `${-head / 2}px` }),
                                                            }}
                                                        >
                                                            {ring && <span key={moves.at} className={s.rankPulse[row.side]} />}
                                                        </span>
                                                    )}
                                                </span>
                                            </span>
                                            <Odometer
                                                className={`${s.rankValue} ${s.rankTone[dir(now !== null ? row.value : null)]}`}
                                                text={now !== null ? fmtTwd(row.value, true) : '--'}
                                                reducedMotion={reducedMotion}
                                            />
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                </div>
                {showCard && selectedRow && (
                    <FlowRankCard
                        row={selectedRow}
                        metric={metric}
                        now={now}
                        from={from}
                        reducedMotion={reducedMotion}
                        paused={paused}
                        nameOf={nameOf}
                        onPick={onPick}
                        onClose={docked ? undefined : () => setDrawer(false)}
                    />
                )}
            </div>
        </div>
    );
}
