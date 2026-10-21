// src/components/chain-rotation.tsx — 輪動 view: every chain/theme as a bubble.
//
// x = net inflow since the first received bar (asinh scale, so a small group
// stays readable next to the largest), y = 加速 (last ten minutes' flow
// intensity minus the last 30 minutes'), size = last ten minutes'
// turnover, colour = RRG quadrant (領先 / 轉弱 / 改善 / 落後).
// Restraint: translucent muted bubbles with a thin outline, names inside
// when they fit, no quadrant tints and no glow. Each minute the bubbles move
// on a spring (motion: a retarget mid-flight keeps its velocity, CSS
// transitions restart from zero); only the selected or hovered group draws
// its eight-minute trail, and a faint ring marks a genuine state change. The
// viewport only widens during the session, so motion always means change,
// never rescaling. Static under prefers-reduced-motion.

import { domAnimation, LazyMotion, m } from 'motion/react';
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
const SPRING = { type: 'spring', stiffness: 60, damping: 17, mass: 1 } as const;
const STILL = { duration: 0 } as const;

interface Box {
    x0: number;
    x1: number;
    y0: number;
    y1: number;
}

interface LabelSpot {
    dx: number;
    dy: number;
    anchor: 'start' | 'middle' | 'end';
    inside?: boolean;
    /** Name as drawn (fitted inside the bubble, or shortened outside). */
    text: string;
}

const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

/** True when the box comes closer than the circle's radius (minus a hair). */
function hitsCircle(box: Box, c: { x: number; y: number; r: number }) {
    const nx = Math.max(box.x0, Math.min(c.x, box.x1));
    const ny = Math.max(box.y0, Math.min(c.y, box.y1));
    return (nx - c.x) ** 2 + (ny - c.y) ** 2 < (c.r - 1.5) ** 2;
}

/** Approximate label width: CJK ~10 px, Latin ~`latin` px at 9.5 px. */
function textWidth(text: string, latin = 5.8) {
    let w = 0;
    for (const ch of text) w += ch.charCodeAt(0) > 0x2e80 ? 10 : latin;
    return w;
}

const shortName = (name: string) => (name.length > 6 ? `${name.slice(0, 6)}…` : name);

/** Longest prefix (with an ellipsis when cut) that fits `room` px. */
function fitName(name: string, room: number) {
    if (textWidth(name) <= room) return name;
    let out = '';
    for (const ch of name) {
        if (textWidth(`${out}${ch}…`) > room) break;
        out += ch;
    }
    return out.length >= 2 ? `${out}…` : null;
}

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

export function FlowRotation({
    rows,
    now,
    from,
    session,
    selectedId,
    reducedMotion,
    paused,
    onSelect,
}: {
    rows: FlowRow[];
    now: number | null;
    from: number | null;
    /** Trading date: resets the viewport ratchet. */
    session: string | null;
    selectedId: string;
    reducedMotion: boolean;
    /** Panel hidden or scrolled away: no running animations. */
    paused: boolean;
    onSelect: (id: string) => void;
}) {
    const { ref, size } = useBoxSize<HTMLDivElement>();
    const [focusState, setFocusState] = useState<Quadrant | null>(null);
    const [hoverId, setHoverId] = useState<string | null>(null);

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
    const rMax = Math.max(14, Math.min(40, Math.min(plotW, plotH) / 9));
    const rMin = Math.max(6, rMax * 0.26);
    const radius = (size: number) => rMin + Math.sqrt(Math.max(0, size) / maxSize) * (rMax - rMin);
    // a bubble stays whole inside the plot: an edge group sits against the frame
    const clampTo = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));
    const bx = (b: Bubble) => clampTo(px(b.point.net), PAD.left + radius(b.point.size), PAD.left + plotW - radius(b.point.size));
    const by = (b: Bubble) => clampTo(py(b.point.y), PAD.top + radius(b.point.size), PAD.top + plotH - radius(b.point.size));

    // label the selection and the biggest groups. Each label tries inside,
    // above, below, right and left of its bubble and takes the first spot
    // that hits no placed label, no other bubble and stays in the plot.
    const labels = new Map<string, LabelSpot>();
    {
        const placed: Box[] = [];
        const circles = bubbles.map((b) => ({ id: b.id, x: bx(b), y: by(b), r: radius(b.point.size) }));
        const candidates = [...bubbles].sort(
            (a, b) => (b.id === selectedId ? 1 : 0) - (a.id === selectedId ? 1 : 0) || Math.abs(b.point.net) - Math.abs(a.point.net),
        );
        // inside labels add no clutter: only labels outside a bubble count to the cap
        let outside = 0;
        for (const b of candidates) {
            const r = radius(b.point.size);
            const x = bx(b);
            const y = by(b);
            const name = shortName(b.row.theme.name);
            const value = fmtTwd(b.point.net, true).replace(' ', '');
            const lw = Math.max(textWidth(name), textWidth(value, 5.4)) + 4;
            // inside: the chord at ±7 px from the centre is the room for a line
            const room = 2 * Math.sqrt(Math.max(0, r * r - 49)) - 4;
            const fitted = r >= 15 && textWidth(value, 5) <= room ? fitName(b.row.theme.name, room) : null;
            const spots: LabelSpot[] = [
                ...(fitted ? [{ dx: 0, dy: -1, anchor: 'middle' as const, inside: true, text: fitted }] : []),
                { dx: 0, dy: -r - 13, anchor: 'middle', text: name },
                { dx: 0, dy: r + 11, anchor: 'middle', text: name },
                { dx: r + 4, dy: -2, anchor: 'start', text: name },
                { dx: -r - 4, dy: -2, anchor: 'end', text: name },
            ];
            for (const spot of spots) {
                if (!spot.inside && outside >= MAX_LABELS) break;
                const sw = spot.inside ? Math.min(lw, r * 2) : lw;
                const x0 = spot.anchor === 'middle' ? x + spot.dx - sw / 2 : spot.anchor === 'start' ? x + spot.dx : x + spot.dx - sw;
                const box = { x0, x1: x0 + sw, y0: y + spot.dy - 10, y1: y + spot.dy + 12 };
                if (box.x0 < PAD.left || box.x1 > PAD.left + plotW || box.y0 < PAD.top || box.y1 > PAD.top + plotH) continue;
                if (placed.some((o) => overlaps(box, o))) continue;
                if (circles.some((c) => c.id !== b.id && hitsCircle(box, c))) continue;
                placed.push(box);
                labels.set(b.id, spot);
                if (!spot.inside) outside += 1;
                break;
            }
            // the selection is always named: inside if it fits, else above, collisions or not
            if (b.id === selectedId && !labels.has(b.id)) labels.set(b.id, spots[0]!);
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
        <div className={s.rot} ref={ref}>
            <div className={s.rotStates} role='group' aria-label='族群狀態'>
                {QUADRANTS.map((q) => (
                    <button
                        key={q}
                        type='button'
                        className={`${s.rotState} ${focusState === q ? s.rotStateOn : ''}`}
                        aria-pressed={focusState === q}
                        onMouseEnter={() => setFocusState(q)}
                        onMouseLeave={() => setFocusState(null)}
                        onFocus={() => setFocusState(q)}
                        onBlur={() => setFocusState(null)}
                        title={
                            {
                                leading: '淨流入，且近 10 分鐘淨流入占比高於近 30 分鐘（動能增強）',
                                weakening: '淨流入，但近 10 分鐘淨流入占比低於近 30 分鐘（動能減弱）',
                                improving: '淨流出，但近 10 分鐘占比高於近 30 分鐘（流出收斂）',
                                lagging: '淨流出，且近 10 分鐘占比低於近 30 分鐘（流出擴大）',
                            }[q]
                        }
                    >
                        <span className={s.rotDot[q]} aria-hidden='true' />
                        <span className={s.rotStateLabel}>{QUADRANT_LABEL[q]}</span>
                        <span className={s.rotStateCount}>{now !== null ? counts[q] : '--'}</span>
                    </button>
                ))}
            </div>
            {w > 0 && h > 0 && (
                <svg className={s.rotSvg} width={w} height={h} viewBox={`0 0 ${w} ${h}`} role='img' aria-label='族群資金輪動圖'>
                    {/* guides: thin grid at the asinh ticks, a crosshair at zero */}
                    {ticks.flatMap((t) =>
                        [t, -t].map((v) => (
                            <g key={v}>
                                <line className={s.rotGrid} x1={px(v)} x2={px(v)} y1={PAD.top} y2={PAD.top + plotH} />
                                <text className={s.rotTick} x={px(v)} y={PAD.top + plotH + 11} textAnchor='middle'>
                                    {fmtTwd(v, true).replace(' ', '')}
                                </text>
                            </g>
                        )),
                    )}
                    {[extentY / 2, -extentY / 2].map((v) => (
                        <g key={`y${v}`}>
                            <line className={s.rotGrid} x1={PAD.left} x2={PAD.left + plotW} y1={py(v)} y2={py(v)} />
                            <text className={s.rotTick} x={PAD.left - 4} y={py(v) + 3} textAnchor='end'>
                                {v > 0 ? '+' : '−'}
                                {Math.abs(v)}
                            </text>
                        </g>
                    ))}
                    <line className={s.rotAxis} x1={PAD.left} x2={PAD.left + plotW} y1={cy} y2={cy} />
                    <line className={s.rotAxis} x1={cx} x2={cx} y1={PAD.top} y2={PAD.top + plotH} />
                    <text className={s.rotTick} x={PAD.left - 4} y={PAD.top + 8} textAnchor='end'>
                        +{extentY}
                    </text>
                    <text className={s.rotTick} x={PAD.left - 4} y={PAD.top + plotH} textAnchor='end'>
                        −{extentY}
                    </text>
                    <text className={s.rotTick} x={PAD.left - 4} y={cy + 3} textAnchor='end'>
                        0
                    </text>
                    <text className={s.rotCaption} x={PAD.left + plotW} y={PAD.top + plotH + 11} textAnchor='end'>
                        淨流入 →
                    </text>
                    <text className={s.rotCaption} x={PAD.left} y={PAD.top + plotH + 11}>
                        ← 淨流出
                    </text>
                    <text className={s.rotCaption} x={6} y={PAD.top - 8}>
                        資金動能（百分點）
                    </text>
                    {/* the trail of the selected or hovered group only */}
                    {ordered.map((b) => {
                        if (b.trail.length < 2 || (b.id !== selectedId && b.id !== hoverId)) return null;
                        if (focusState !== null && focusState !== b.state) return null;
                        // ends at the drawn (edge-clamped) centre of the bubble
                        const pts = [
                            ...b.trail.map((p) => ({ slot: p.slot, x: px(p.net), y: py(p.y) })),
                            { slot: b.point.slot, x: bx(b), y: by(b) },
                        ];
                        return (
                            <g key={`trail-${b.id}`} className={s.rotTrail[b.state]}>
                                {pts.slice(1).map((p, i) => {
                                    const a = pts[i]!;
                                    // a thin group crossing zero can jump: no streak across the chart
                                    if (Math.abs(p.x - a.x) > plotW * 0.2) return null;
                                    return (
                                        <line
                                            key={p.slot}
                                            x1={a.x}
                                            y1={a.y}
                                            x2={p.x}
                                            y2={p.y}
                                            strokeOpacity={0.08 + (0.5 * (i + 1)) / pts.length}
                                        />
                                    );
                                })}
                                {b.trail.map((p, i) => (
                                    <circle
                                        key={`d${p.slot}`}
                                        className={s.rotTrailDot[b.state]}
                                        cx={px(p.net)}
                                        cy={py(p.y)}
                                        r={1.6}
                                        opacity={0.15 + (0.55 * (i + 1)) / b.trail.length}
                                    />
                                ))}
                            </g>
                        );
                    })}

                    {/* bubbles move on a spring to their new place */}
                    <LazyMotion features={domAnimation} strict>
                        {ordered.map((b) => {
                            const r = radius(b.point.size);
                            const selected = b.id === selectedId;
                            const dim = focusState !== null && focusState !== b.state;
                            const spot = dim ? undefined : labels.get(b.id);
                            const f = b.row.flow;
                            const value = fmtTwd(b.point.net, true).replace(' ', '');
                            return (
                                <m.g
                                    key={b.id}
                                    className={s.rotBubble}
                                    initial={false}
                                    animate={{ x: bx(b), y: by(b), opacity: dim ? 0.15 : 1 }}
                                    transition={reducedMotion ? STILL : { ...SPRING, opacity: { duration: 0.3 } }}
                                    onClick={() => onSelect(b.id)}
                                    onMouseEnter={() => setHoverId(b.id)}
                                    onMouseLeave={() => setHoverId((id) => (id === b.id ? null : id))}
                                    role='button'
                                    aria-label={`${b.row.theme.name} ${QUADRANT_LABEL[b.state]} 淨流入 ${fmtTwd(b.point.net, true)}`}
                                >
                                    <title>
                                        {`${b.row.theme.name}・${QUADRANT_LABEL[b.state]}\n淨流入 ${fmtTwd(b.point.net, true)}・占成交值 ${fmtSignedPct(b.point.x, 1)}\n資金動能 ${b.point.y >= 0 ? '+' : ''}${b.point.y.toFixed(1)} 百分點\n近 10 分成交值 ${fmtTwd(b.point.size)}・漲跌 ${fmtSignedPct(f.pct)}`}
                                    </title>
                                    {pulse.has(b.id) && !reducedMotion && !paused && (
                                        <circle key={`pulse-${now}`} className={s.rotPulse[b.state]} r={r} />
                                    )}
                                    <circle className={s.rotFill[b.state]} r={r} />
                                    {selected && <circle className={s.rotSelected} r={r + 2.5} />}
                                    {spot?.inside && (
                                        <>
                                            <text className={s.rotNameIn} y={-1} textAnchor='middle'>
                                                {spot.text}
                                            </text>
                                            <text className={s.rotValueIn} y={9.5} textAnchor='middle'>
                                                {value}
                                            </text>
                                        </>
                                    )}
                                    {spot && !spot.inside && (
                                        <>
                                            <text className={s.rotName} x={spot.dx} y={spot.dy} textAnchor={spot.anchor}>
                                                {spot.text}
                                            </text>
                                            <text className={s.rotValue[b.state]} x={spot.dx} y={spot.dy + 10} textAnchor={spot.anchor}>
                                                {value}
                                            </text>
                                        </>
                                    )}
                                </m.g>
                            );
                        })}
                    </LazyMotion>
                    {/* corner names on top: a small dot carries the colour */}
                    {(
                        [
                            ['leading', PAD.left + plotW - 8, PAD.top + 14, 'end'],
                            ['weakening', PAD.left + plotW - 8, PAD.top + plotH - 7, 'end'],
                            ['improving', PAD.left + 16, PAD.top + 14, 'start'],
                            ['lagging', PAD.left + 16, PAD.top + plotH - 7, 'start'],
                        ] as const
                    ).map(([q, x, y, anchor]) => (
                        <g key={q}>
                            <circle className={s.rotCornerDot[q]} cx={anchor === 'end' ? x - textWidth(QUADRANT_LABEL[q]) - 7 : x - 8} cy={y - 3.5} r={3} />
                            <text className={s.rotCorner} x={x} y={y} textAnchor={anchor}>
                                {QUADRANT_LABEL[q]}
                            </text>
                        </g>
                    ))}

                </svg>
            )}
            {now === null && (
                <div className={s.rotEmpty}>
                    盤中每分鐘更新：收到第一根 1 分 K 起，泡泡依淨流入與資金動能移動，點選泡泡看 8 分鐘軌跡
                </div>
            )}
            {now !== null && (top || bottom) && (
                <div className={s.rotFoot}>
                    {top && (
                        <span>
                            淨流入最大 <b className={s.rotFootName}>{top.row.theme.name}</b>{' '}
                            <span className={s.rotFootValue.leading}>{fmtTwd(top.point.net, true)}</span>
                        </span>
                    )}
                    {bottom && (
                        <span>
                            淨流出最大 <b className={s.rotFootName}>{bottom.row.theme.name}</b>{' '}
                            <span className={s.rotFootValue.lagging}>{fmtTwd(bottom.point.net, true)}</span>
                        </span>
                    )}
                </div>
            )}
        </div>
    );
}
