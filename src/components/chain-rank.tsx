// src/components/chain-rank.tsx：金流 (rank) view: groups ranked by net inflow.
//
// One row per group: a category dot, the name, a small rank-change mark, a
// lane growing from a fixed dashed centre axis (inflow right, outflow left,
// one square-root scale for both) and the value. Inflows sit on top, then a
// gap, then outflows. The lanes themselves are drawn by the river engine
// (chain-river.tsx): a soft translucent band whose thickness follows
// turnover, a glowing head at the leading edge, and fine particles streaming
// from the axis toward the head, denser and faster on bigger flows. Rows glide
// to their new rank and bands ease to their new length when a minute bar
// lands. Everything is static under prefers-reduced-motion, and the loop
// stops while the panel is hidden or off screen.

import { ChevronsDownUp, PanelRightOpen, Triangle } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { slotLabel, SESSION_SLOTS } from '../lib/chain-flow';
import { fmtSignedPct, fmtTwd } from '../lib/chain-map';
import { comparesRanks, rankOrder, rankTurnover, rankValue, rankMoves, riverLength, type RankMetric } from '../lib/chain-motion';
import { bandThickness } from '../lib/chain-river';
import { FlowRankCard, metricLabel } from './chain-rank-card';
import { RIVER_ROW_PX, useRiver, type RiverLane } from './chain-river';
import { dir, markKind, useBoxSize, type FlowRow } from './chain-ui';
import { Odometer } from './odometer';
import * as s from './chain-map.css';

const ROW_PX = RIVER_ROW_PX;
/** Gap between inflows and outflows; wider when it holds the fold button. */
const GAP_PX = 14;
const FOLD_GAP_PX = 26;
/** Rows shown per side until the viewer asks for every group. */
const SIDE_ROWS = 8;
const MOVE_SHOW_MS = 6000;
/** Below this the detail card would squeeze the lanes: it becomes a drawer. */
const CARD_DOCK_PX = 1180;
/** Emphasis of the lanes other than the selected one. */
const DIM = 0.4;

/** "+19.12 億" → ["+19.12", " 億"] so the unit can sit back. */
export function splitUnit(text: string): [string, string] {
    const m = text.match(/^(.*?)(\s*[^\d\s.,+−-]+)$/);
    return m ? [m[1]!, m[2]!] : [text, ''];
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
    focus = null,
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
    /** The stock the panel follows: marked in the detail card's list. */
    focus?: string | null;
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
    const maxTurnover = useMemo(() => Math.max(0, ...rows.map((r) => rankTurnover(r.flow, now, metric))), [rows, now, metric]);
    const { ref: layoutRef, size: layoutSize } = useBoxSize<HTMLDivElement>();
    const selectedRow = rows.find((r) => r.theme.id === selectedId) ?? null;
    const docked = layoutSize.width >= CARD_DOCK_PX;
    const [drawer, setDrawer] = useState(false);
    const showCard = selectedRow !== null && (docked || drawer);
    const drawerId = useId();
    const drawerToggle = useRef<HTMLButtonElement | null>(null);
    // closing from inside the drawer (close button, Escape) returns focus to its trigger
    const closeDrawer = () => {
        setDrawer(false);
        drawerToggle.current?.focus();
    };
    const label = metricLabel(metric);
    const note =
        now === null
            ? '尚無淨流入：盤中收到 1 分 K 起才有；今日漲跌與成交值請看「漲跌」'
            : '長度為淨流入（平方根刻度）・粗細為成交值・點選看明細';

    // rank changes since the previous minute bar
    const prevRanks = useRef(new Map<string, number>());
    const [moves, setMoves] = useState<{ at: number; map: Map<string, number> }>({ at: 0, map: new Map() });
    const prevNow = useRef<number | null>(null);
    useEffect(() => {
        const compare = comparesRanks(prevNow.current, now);
        prevNow.current = now;
        const before = prevRanks.current;
        prevRanks.current = new Map(order.map((r) => [r.id, r.rank]));
        if (compare) setMoves({ at: Date.now(), map: rankMoves(before, order) });
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

    const gap = firstOut > 0 || hidden > 0;
    const gapPx = hidden > 0 ? FOLD_GAP_PX : GAP_PX;
    const height = shown.length * ROW_PX + (gap ? gapPx : 0);

    // the river: DOM rows for text, one canvas for bands, heads and particles
    const stageRef = useRef<HTMLDivElement | null>(null);
    const areaRef = useRef<HTMLDivElement | null>(null);
    const rowsRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const rowEls = useRef(new Map<string, HTMLElement>());
    const focusShown = shown.some((r) => r.id === selectedId);
    const lanes = useMemo<RiverLane[]>(
        () =>
            shown.map((row, index) => ({
                id: row.id,
                y: index * ROW_PX + (row.side === 'out' && gap ? gapPx : 0),
                m: now !== null ? riverLength(row.value, maxAbs) * Math.sign(row.value) : 0,
                thick: bandThickness(rankTurnover(row.item.flow, now, metric), maxTurnover),
                focus: !focusShown || row.id === selectedId ? 1 : DIM,
            })),
        [shown, gap, gapPx, now, metric, maxAbs, maxTurnover, selectedId, focusShown],
    );
    useRiver({ lanes, stageRef, areaRef, rowsRef, canvasRef, rowEls, reducedMotion, active: !paused && now !== null });
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
                        <span className={s.rankHeaderNote} title={note}>
                            {note}
                        </span>
                        {showAll && order.length > SIDE_ROWS * 2 && (
                            <button type='button' className={s.rankDrawerToggle} onClick={() => setShowAll(false)} title='只顯示淨流入與淨流出最大的族群'>
                                <ChevronsDownUp size={12} aria-hidden='true' />
                                收合
                            </button>
                        )}
                        {!docked && selectedRow && (
                            <button
                                type='button'
                                ref={drawerToggle}
                                className={s.rankDrawerToggle}
                                aria-expanded={drawer}
                                aria-controls={drawer ? drawerId : undefined}
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
                    <div className={s.rankStage} ref={stageRef}>
                        <canvas ref={canvasRef} className={s.rankCanvas} aria-hidden='true' />
                        <div className={s.rankArea} ref={areaRef}>
                            <div className={s.rankRows} ref={rowsRef} style={{ height }} role='group' aria-label={`族群${label}淨流入排行`}>
                                {hidden > 0 && (
                                    <button
                                        type='button'
                                        className={s.rankFold}
                                        style={{ top: (firstOut >= 0 ? firstOut : shown.length) * ROW_PX }}
                                        onClick={() => setShowAll(true)}
                                    >
                                        {now === null ? `另有 ${hidden} 個族群・顯示全部` : `另有 ${hidden} 個族群淨流量較小・顯示全部`}
                                    </button>
                                )}
                                {shown.map((row) => {
                                    const move = showMoves ? (moves.map.get(row.id) ?? 0) : 0;
                                    const selected = row.id === selectedId;
                                    const f = row.item.flow;
                                    const [num, unit] = splitUnit(now !== null ? fmtTwd(row.value, true) : '--');
                                    // the river engine positions the row (translateY) every frame
                                    return (
                                        <button
                                            key={row.id}
                                            ref={(el) => {
                                                if (el) rowEls.current.set(row.id, el);
                                                else rowEls.current.delete(row.id);
                                            }}
                                            type='button'
                                            aria-pressed={selected}
                                            aria-label={`第 ${row.rank + 1} 名 ${row.item.theme.name}，${label}淨流入 ${fmtTwd(row.value, true)}，漲跌 ${fmtSignedPct(f.pct)}${move !== 0 ? `，${move > 0 ? '上升' : '下降'} ${Math.abs(move)} 名` : ''}`}
                                            className={s.rankRow[selected ? 'on' : 'off']}
                                            onClick={() => onSelect(row.id)}
                                            title={`${row.item.theme.name}・${row.item.codes.length} 檔\n${label}淨流入 ${fmtTwd(row.value, true)}\n今日成交值 ${fmtTwd(f.total)}・漲跌 ${fmtSignedPct(f.pct)}`}
                                        >
                                            <span className={s.rankName}>
                                                <span className={s.rankDot[markKind(row.item.theme.kind)]} aria-hidden='true' />
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
                                            <span className={s.rankTrack} data-track='' aria-hidden='true' />
                                            <span className={`${s.rankValue} ${s.rankTone[dir(now !== null ? row.value : null)]}`}>
                                                <Odometer text={num} reducedMotion={reducedMotion} />
                                                {unit && <span className={s.rankUnit}>{unit}</span>}
                                            </span>
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
                        focus={focus}
                        onPick={onPick}
                        onClose={docked ? undefined : closeDrawer}
                        id={docked ? undefined : drawerId}
                    />
                )}
            </div>
        </div>
    );
}
