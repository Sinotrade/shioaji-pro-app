// src/components/chain-tide.tsx — 潮汐泡泡: every chain/theme as a bubble.
//
// x = net inflow since the first received bar (asinh scale, so a small group
// stays readable next to the largest), y = 加速 (last ten minutes' flow
// intensity minus the last 30 minutes'), size = last ten minutes'
// turnover, colour = state (加速流入 / 流入放緩 / 流出放緩 / 加速流出).
// Each minute the bubbles glide to their new place leaving a fading
// eight-minute trail; a ring pulses on groups that changed state or moved the
// most; accelerating groups breathe. The viewport only widens during the
// session, so motion always means change, never rescaling. Static under
// prefers-reduced-motion.

import { useMemo, useRef, useState } from 'react';
import { fmtSignedPct, fmtTwd } from '../lib/chain-map';
import {
    asinhScale,
    QUADRANT_LABEL,
    QUADRANTS,
    quadrantCounts,
    quadrantOf,
    rotationExtent,
    rotationPoint,
    rotationTrail,
    smoothTrail,
    type Quadrant,
    type RotationPoint,
} from '../lib/chain-motion';
import { useBoxSize, type FlowRow } from './chain-ui';
import * as s from './chain-map.css';

const TRAIL = 8;
const PAD = { left: 40, right: 14, top: 30, bottom: 34 };
const NET_TICKS = [1e8, 1e9, 1e10, 1e11];
const MAX_LABELS = 12;
/** asinh knee: linear below 1 億, logarithmic above. */
const NET_UNIT = 1e8;
const PULSES = 4;

interface Bubble {
    row: FlowRow;
    id: string;
    point: RotationPoint;
    trail: RotationPoint[];
    state: Quadrant;
}

/** Round up to 1 / 2 / 5 × 10^n. */
function niceCeil(value: number) {
    if (value <= 0) return 1;
    const p = 10 ** Math.floor(Math.log10(value));
    const m = value / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

/** Extent that only grows during a session; shrinks once the data fits in a third of it. */
function useRatchet(value: number, session: string | null) {
    const ref = useRef<{ session: string | null; value: number }>({ session, value });
    if (ref.current.session !== session || value > ref.current.value || value < ref.current.value / 3) {
        ref.current = { session, value };
    }
    return ref.current.value;
}

export function FlowTide({
    rows,
    now,
    from,
    session,
    selectedId,
    reducedMotion,
    onSelect,
}: {
    rows: FlowRow[];
    now: number | null;
    from: number | null;
    /** Trading date: resets the viewport ratchet. */
    session: string | null;
    selectedId: string;
    reducedMotion: boolean;
    onSelect: (id: string) => void;
}) {
    const { ref, size } = useBoxSize<HTMLDivElement>();
    const [focusState, setFocusState] = useState<Quadrant | null>(null);

    const bubbles = useMemo<Bubble[]>(() => {
        if (now === null) return [];
        return rows.flatMap((row) => {
            const point = rotationPoint(row.flow, now);
            if (!point) return [];
            const trail = smoothTrail(rotationTrail(row.flow, now - 1, TRAIL, 1, from ?? 0));
            return [{ row, id: row.theme.id, point, trail, state: quadrantOf(point.net, point.y) }];
        });
    }, [rows, now, from]);

    // states of the previous minute → pulse on change
    const prev = useRef<{ now: number | null; states: Map<string, Quadrant> }>({ now: null, states: new Map() });
    const pulse = useMemo(() => {
        const set = new Set<string>();
        if (now === null || prev.current.now === now) return set;
        const before = prev.current.states;
        if (before.size > 0) {
            for (const b of bubbles) if (before.get(b.id) !== undefined && before.get(b.id) !== b.state) set.add(b.id);
            // and the groups with the largest last-minute flow
            [...bubbles]
                .sort((a, b) => Math.abs(b.row.flow.net[now]!) - Math.abs(a.row.flow.net[now]!))
                .slice(0, PULSES)
                .forEach((b) => set.add(b.id));
        }
        prev.current = { now, states: new Map(bubbles.map((b) => [b.id, b.state])) };
        return set;
    }, [bubbles, now]);

    const rawX = useMemo(() => {
        let max = 0;
        for (const b of bubbles) {
            max = Math.max(max, Math.abs(b.point.net));
            for (const p of b.trail) max = Math.max(max, Math.abs(p.net));
        }
        return niceCeil(Math.max(max * 1.15, 1e8));
    }, [bubbles]);
    // robust: a thin group's acceleration can spike; it is pinned to the edge
    const rawY = useMemo(() => {
        const ys = bubbles.map((b) => Math.abs(b.point.y)).sort((a, b) => a - b);
        const p85 = ys.length > 0 ? ys[Math.min(ys.length - 1, Math.floor(ys.length * 0.85))]! : 0;
        return rotationExtent([p85 * 1.3], 4, 2);
    }, [bubbles]);
    const extentX = useRatchet(rawX, session);
    const extentY = useRatchet(rawY, session);
    const maxSize = useMemo(() => Math.max(1, ...bubbles.map((b) => b.point.size)), [bubbles]);
    const counts = useMemo(() => quadrantCounts(bubbles.map((b) => ({ x: b.point.net, y: b.point.y }))), [bubbles]);

    const w = size.width;
    const h = size.height;
    const plotW = Math.max(0, w - PAD.left - PAD.right);
    const plotH = Math.max(0, h - PAD.top - PAD.bottom);
    const cx = PAD.left + plotW / 2;
    const cy = PAD.top + plotH / 2;
    const px = (net: number) => cx + (asinhScale(net, extentX, NET_UNIT) * plotW) / 2;
    const py = (y: number) => cy - (Math.max(-1, Math.min(1, y / extentY)) * (plotH - 12)) / 2;
    const rMax = Math.max(10, Math.min(30, Math.min(plotW, plotH) / 11));
    const radius = (size: number) => Math.max(3.5, Math.sqrt(size / maxSize) * rMax);

    // label the selection and the biggest groups, skipping any label that
    // would overlap one already placed
    const labelled = new Set<string>();
    {
        const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
        const candidates = [...bubbles].sort(
            (a, b) => (b.id === selectedId ? 1 : 0) - (a.id === selectedId ? 1 : 0) || Math.abs(b.point.net) - Math.abs(a.point.net),
        );
        for (const b of candidates) {
            if (labelled.size >= MAX_LABELS) break;
            const r = radius(b.point.size);
            const x = px(b.point.net);
            const y = py(b.point.y);
            const half = Math.min(6, b.row.theme.name.length) * 5 + 4;
            const top = r >= 13 ? y - 11 : y - r - 19;
            const box = { x0: x - half, x1: x + half, y0: top, y1: top + 22 };
            if (placed.some((o) => box.x0 < o.x1 && box.x1 > o.x0 && box.y0 < o.y1 && box.y1 > o.y0)) continue;
            placed.push(box);
            labelled.add(b.id);
        }
    }

    const top = bubbles.reduce<Bubble | null>((best, b) => (b.point.net > 0 && (!best || b.point.net > best.point.net) ? b : best), null);
    const bottom = bubbles.reduce<Bubble | null>((best, b) => (b.point.net < 0 && (!best || b.point.net < best.point.net) ? b : best), null);

    // draw order: small first, selection last
    const ordered = [...bubbles].sort((a, b) =>
        a.id === selectedId ? 1 : b.id === selectedId ? -1 : b.point.size - a.point.size,
    );
    const ticks = NET_TICKS.filter((t) => asinhScale(t, extentX, NET_UNIT) < 0.8);

    return (
        <div className={s.tide} ref={ref}>
            <div className={s.tideStates} role='group' aria-label='族群狀態'>
                {QUADRANTS.map((q) => (
                    <button
                        key={q}
                        type='button'
                        className={`${s.tideState} ${focusState === q ? s.tideStateOn : ''}`}
                        aria-pressed={focusState === q}
                        onMouseEnter={() => setFocusState(q)}
                        onMouseLeave={() => setFocusState(null)}
                        onFocus={() => setFocusState(q)}
                        onBlur={() => setFocusState(null)}
                        title={
                            {
                                leading: '淨流入，且近 10 分鐘淨流入比重高於近 30 分鐘',
                                weakening: '淨流入，但近 10 分鐘淨流入比重低於近 30 分鐘',
                                improving: '淨流出，但近 10 分鐘比重回升',
                                lagging: '淨流出，且近 10 分鐘比重低於近 30 分鐘',
                            }[q]
                        }
                    >
                        <span className={s.tideDot[q]} aria-hidden='true' />
                        <span className={s.tideStateLabel}>{QUADRANT_LABEL[q]}</span>
                        <span className={s.tideStateCount}>{now !== null ? counts[q] : '--'}</span>
                    </button>
                ))}
            </div>
            {w > 0 && h > 0 && (
                <svg className={s.tideSvg} width={w} height={h} viewBox={`0 0 ${w} ${h}`} role='img' aria-label='族群資金潮汐圖'>
                    {/* quadrant tints */}
                    <rect className={s.tideTint.leading} x={cx} y={PAD.top} width={plotW / 2} height={plotH / 2} />
                    <rect className={s.tideTint.weakening} x={cx} y={cy} width={plotW / 2} height={plotH / 2} />
                    <rect className={s.tideTint.improving} x={PAD.left} y={PAD.top} width={plotW / 2} height={plotH / 2} />
                    <rect className={s.tideTint.lagging} x={PAD.left} y={cy} width={plotW / 2} height={plotH / 2} />
                    {/* net ticks (asinh) */}
                    {ticks.flatMap((t) =>
                        [t, -t].map((v) => (
                            <g key={v}>
                                <line className={s.tideGrid} x1={px(v)} x2={px(v)} y1={PAD.top} y2={PAD.top + plotH} />
                                <text className={s.tideTick} x={px(v)} y={PAD.top + plotH + 11} textAnchor='middle'>
                                    {fmtTwd(v, true).replace(' ', '')}
                                </text>
                            </g>
                        )),
                    )}
                    <line className={s.tideAxis} x1={PAD.left} x2={PAD.left + plotW} y1={cy} y2={cy} />
                    <line className={s.tideAxis} x1={cx} x2={cx} y1={PAD.top} y2={PAD.top + plotH} />
                    <text className={s.tideTick} x={PAD.left - 4} y={PAD.top + 8} textAnchor='end'>
                        +{extentY}
                    </text>
                    <text className={s.tideTick} x={PAD.left - 4} y={PAD.top + plotH} textAnchor='end'>
                        −{extentY}
                    </text>
                    <text className={s.tideTick} x={PAD.left - 4} y={cy + 3} textAnchor='end'>
                        0
                    </text>
                    <text className={s.tideCaption} x={PAD.left + plotW} y={PAD.top + plotH + 11} textAnchor='end'>
                        淨流入 →
                    </text>
                    <text className={s.tideCaption} x={PAD.left} y={PAD.top + plotH + 11}>
                        ← 淨流出
                    </text>
                    <text className={s.tideCaption} x={6} y={PAD.top - 8}>
                        加速 pp
                    </text>
                    {/* corner names */}
                    <text className={s.tideCorner.leading} x={PAD.left + plotW - 6} y={PAD.top + 13} textAnchor='end'>
                        {QUADRANT_LABEL.leading}
                    </text>
                    <text className={s.tideCorner.weakening} x={PAD.left + plotW - 6} y={PAD.top + plotH - 6} textAnchor='end'>
                        {QUADRANT_LABEL.weakening}
                    </text>
                    <text className={s.tideCorner.improving} x={PAD.left + 6} y={PAD.top + 13}>
                        {QUADRANT_LABEL.improving}
                    </text>
                    <text className={s.tideCorner.lagging} x={PAD.left + 6} y={PAD.top + plotH - 6}>
                        {QUADRANT_LABEL.lagging}
                    </text>

                    {/* trails: the last ten minutes, fading out */}
                    {ordered.map((b) => {
                        if (b.trail.length < 2) return null;
                        const dim = focusState !== null && focusState !== b.state;
                        return (
                            <g key={`trail-${b.id}`} className={s.tideTrail[b.state]} opacity={dim ? 0.06 : b.id === selectedId ? 1 : 0.4}>
                                {b.trail.slice(1).map((p, i) => {
                                    const a = b.trail[i]!;
                                    // a thin group crossing zero can jump: no streak across the chart
                                    if (Math.abs(px(p.net) - px(a.net)) > plotW * 0.2) return null;
                                    return (
                                        <line
                                            key={p.slot}
                                            x1={px(a.net)}
                                            y1={py(a.y)}
                                            x2={px(p.net)}
                                            y2={py(p.y)}
                                            strokeOpacity={0.12 + (0.6 * (i + 1)) / b.trail.length}
                                        />
                                    );
                                })}
                            </g>
                        );
                    })}

                    {/* bubbles glide to their new place */}
                    {ordered.map((b) => {
                        const r = radius(b.point.size);
                        const selected = b.id === selectedId;
                        const dim = focusState !== null && focusState !== b.state;
                        const hot = b.state === 'leading' || b.state === 'lagging';
                        const label = labelled.has(b.id) && !dim;
                        const f = b.row.flow;
                        return (
                            <g
                                key={b.id}
                                className={`${s.tideBubble} ${reducedMotion ? s.still : ''}`}
                                style={{ transform: `translate(${px(b.point.net)}px, ${py(b.point.y)}px)`, opacity: dim ? 0.15 : 1 }}
                                onClick={() => onSelect(b.id)}
                                role='button'
                                aria-label={`${b.row.theme.name} ${QUADRANT_LABEL[b.state]} 淨流入 ${fmtTwd(b.point.net, true)}`}
                            >
                                <title>
                                    {`${b.row.theme.name}・${QUADRANT_LABEL[b.state]}\n淨流入 ${fmtTwd(b.point.net, true)}（強度 ${fmtSignedPct(b.point.x, 1)}）\n加速 ${b.point.y >= 0 ? '+' : ''}${b.point.y.toFixed(1)} pp\n近 10 分成交值 ${fmtTwd(b.point.size)}・漲跌 ${fmtSignedPct(f.pct)}`}
                                </title>
                                {hot && !reducedMotion && <circle className={s.tideHalo[b.state]} r={r + 4} />}
                                {pulse.has(b.id) && !reducedMotion && (
                                    <circle key={`pulse-${now}`} className={s.tidePulse[b.state]} r={r} />
                                )}
                                <circle className={s.tideFill[b.state]} r={r} />
                                {selected && <circle className={s.tideSelected} r={r + 3} />}
                                {label && (
                                    <>
                                        <text className={s.tideName} y={r >= 13 ? -1 : -r - 9} textAnchor='middle'>
                                            {b.row.theme.name.length > 6 ? `${b.row.theme.name.slice(0, 6)}…` : b.row.theme.name}
                                        </text>
                                        <text className={s.tideValue[b.state]} y={r >= 13 ? 10 : -r - 1} textAnchor='middle'>
                                            {fmtTwd(b.point.net, true).replace(' ', '')}
                                        </text>
                                    </>
                                )}
                            </g>
                        );
                    })}
                </svg>
            )}
            {now === null && (
                <div className={s.tideEmpty}>
                    盤中每分鐘更新：收到第一根 1 分 K 起，泡泡依淨流入與加速度移動，並留下 8 分鐘軌跡
                </div>
            )}
            {now !== null && (top || bottom) && (
                <div className={s.tideFoot}>
                    {top && (
                        <span>
                            吸金最多 <b className={s.tideFootName}>{top.row.theme.name}</b>{' '}
                            <span className={s.tideValue.leading}>{fmtTwd(top.point.net, true)}</span>
                        </span>
                    )}
                    {bottom && (
                        <span>
                            失血最多 <b className={s.tideFootName}>{bottom.row.theme.name}</b>{' '}
                            <span className={s.tideValue.lagging}>{fmtTwd(bottom.point.net, true)}</span>
                        </span>
                    )}
                </div>
            )}
        </div>
    );
}
