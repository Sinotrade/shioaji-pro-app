// src/components/chain-rotation.tsx — 輪動 view: every chain/theme as a bubble.
//
// x = net inflow since the first received bar (asinh scale, so a small group
// stays readable next to the largest), y = 加速 (last ten minutes' flow
// intensity minus the last 30 minutes'), size = last ten minutes'
// turnover, colour = RRG quadrant (領先 / 轉弱 / 改善 / 落後).
// Restraint: translucent muted bubbles with a thin outline, names inside
// when they fit, no quadrant tints and no glow. Each minute the bubbles move
// on a spring (motion: a retarget mid-flight keeps its velocity, CSS
// transitions restart from zero); only the hovered or focused group draws
// its eight-minute trail, and a faint ring marks a genuine state change. The
// viewport only widens during the session, so motion always means change,
// never rescaling. Static under prefers-reduced-motion.

import { domAnimation, LazyMotion, m } from 'motion/react';
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { fmtSignedPct, fmtTwd } from '../lib/chain-map';
import {
    asinhScale,
    QUADRANT_LABEL,
    QUADRANTS,
    quadrantCounts,
    quadrantOf,
    rotationExtent,
    rotationPoint,
    relaxCircles,
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
    /** Inside: font size, and whether the value fits under the name. */
    font?: number;
    value?: boolean;
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

type Geometry = ReturnType<typeof plotGeometry>;
type Placement = Map<string, { x: number; y: number; r: number }>;

/** Plot box, scales and bubble radius for a panel size and the (ratcheted) extents. */
function plotGeometry(w: number, h: number, extentX: number, extentY: number, maxSize: number) {
    const plotW = Math.max(0, w - PAD.left - PAD.right);
    const plotH = Math.max(0, h - PAD.top - PAD.bottom);
    const cx = PAD.left + plotW / 2;
    const cy = PAD.top + plotH / 2;
    const px = (net: number) => cx + (asinhScale(net, extentX, NET_UNIT) * plotW) / 2;
    const py = (y: number) => cy - (Math.max(-1, Math.min(1, y / extentY)) * (plotH - 12)) / 2;
    // a narrow size range: every bubble is big enough to carry its name
    const rMax = Math.max(18, Math.min(44, Math.min(plotW, plotH) / 8));
    const rMin = Math.max(12, rMax * 0.4);
    const radius = (size: number) => rMin + Math.sqrt(Math.max(0, size) / maxSize) * (rMax - rMin);
    const plotBox: Box = { x0: PAD.left, x1: PAD.left + plotW, y0: PAD.top, y1: PAD.top + plotH };
    return { plotW, plotH, cx, cy, px, py, radius, plotBox };
}

/**
 * Gentle collision relaxation from the data positions; an edge group sits
 * whole against the frame.
 */
function placeBubbles(bubbles: readonly Bubble[], geo: Geometry): Placement {
    const { px, py, radius, plotW, plotH, plotBox } = geo;
    const place: Placement = new Map();
    const sorted = [...bubbles].sort((a, b) => (a.id < b.id ? -1 : 1));
    const circles = sorted.map((b) => ({
        x: px(b.point.net),
        y: py(b.point.y),
        r: radius(b.point.size),
    }));
    const relaxed = plotW > 0 && plotH > 0 ? relaxCircles(circles, plotBox) : circles;
    sorted.forEach((b, i) => place.set(b.id, { ...relaxed[i]!, r: circles[i]!.r }));
    return place;
}

/**
 * Every bubble is labelled inside when its radius allows (name cut to the
 * chord, value below); the rest try above, below, right and left and take
 * the first spot that hits no placed label, no other bubble and stays in the
 * plot. Outside labels are capped, inside ones are not.
 */
function placeLabels(bubbles: readonly Bubble[], place: Placement, geo: Geometry, selectedId: string) {
    const { plotW, plotH } = geo;
    const labels = new Map<string, LabelSpot>();
    const placed: Box[] = [];
    const circles = bubbles.map((b) => ({ id: b.id, ...place.get(b.id)! }));
    const candidates = [...bubbles].sort(
        (a, b) => (b.id === selectedId ? 1 : 0) - (a.id === selectedId ? 1 : 0) || Math.abs(b.point.net) - Math.abs(a.point.net),
    );
    let outside = 0;
    for (const b of candidates) {
        const { x, y, r } = place.get(b.id)!;
        const name = shortName(b.row.theme.name);
        const value = fmtTwd(b.point.net, true).replace(' ', '');
        const lw = Math.max(textWidth(name), textWidth(value, 5.4)) + 4;
        // inside: font follows the radius; the chord ±font from the centre is the room
        const font = Math.max(7.5, Math.min(10, r * 0.4));
        const scale = font / 9.5;
        const room = (2 * Math.sqrt(Math.max(0, r * r - font * font)) - 3) / scale;
        const withValue = r >= 13 && textWidth(value, 5.4) <= room;
        const fitted = r >= 10 ? fitName(b.row.theme.name, room) : null;
        const inside: LabelSpot[] = fitted
            ? [
                  {
                      dx: 0,
                      dy: withValue ? -1 : font * 0.35,
                      anchor: 'middle',
                      inside: true,
                      text: fitted,
                      font,
                      value: withValue,
                  },
              ]
            : [];
        const spots: LabelSpot[] = [
            ...inside,
            { dx: 0, dy: -r - 13, anchor: 'middle', text: name },
            { dx: 0, dy: r + 11, anchor: 'middle', text: name },
            { dx: r + 4, dy: -2, anchor: 'start', text: name },
            { dx: -r - 4, dy: -2, anchor: 'end', text: name },
        ];
        for (const spot of spots) {
            if (!spot.inside && outside >= MAX_LABELS) break;
            const sw = spot.inside ? Math.min(lw * scale, r * 1.8) : lw;
            const x0 = spot.anchor === 'middle' ? x + spot.dx - sw / 2 : spot.anchor === 'start' ? x + spot.dx : x + spot.dx - sw;
            const box = spot.inside
                ? {
                      x0,
                      x1: x0 + sw,
                      y0: y - font,
                      y1: y + (withValue ? font * 1.1 : 2),
                  }
                : { x0, x1: x0 + sw, y0: y + spot.dy - 10, y1: y + spot.dy + 12 };
            if (box.x0 < PAD.left || box.x1 > PAD.left + plotW || box.y0 < PAD.top || box.y1 > PAD.top + plotH) continue;
            if (placed.some((o) => overlaps(box, o))) continue;
            // an inside label may sit under a neighbour's rim, not across its centre
            if (
                spot.inside
                    ? circles.some((c) => c.id !== b.id && c.r > 4 && hitsCircle(box, { ...c, r: c.r * 0.55 }))
                    : circles.some((c) => c.id !== b.id && hitsCircle(box, c))
            )
                continue;
            placed.push(box);
            labels.set(b.id, spot);
            if (!spot.inside) outside += 1;
            break;
        }
        // the selection is always named: inside if it fits, else above, collisions or not
        if (b.id === selectedId && !labels.has(b.id)) labels.set(b.id, spots[0]!);
    }
    return labels;
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
    const ref = useRef<{ session: string | null; value: number }>({
        session,
        value,
    });
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
            return [
                {
                    row,
                    id: row.theme.id,
                    point,
                    trail,
                    state: quadrantOf(point.net, point.y),
                },
            ];
        });
    }, [rows, now, from]);

    // states of the previous minute → pulse on change
    const prev = useRef<{ now: number | null; states: Map<string, Quadrant> }>({
        now: null,
        states: new Map(),
    });
    const pulse = useMemo(() => {
        const set = new Set<string>();
        if (now === null || prev.current.now === now) return set;
        const before = prev.current.states;
        if (before.size > 0) {
            for (const b of bubbles) if (before.get(b.id) !== undefined && before.get(b.id) !== b.state) set.add(b.id);
        }
        prev.current = {
            now,
            states: new Map(bubbles.map((b) => [b.id, b.state])),
        };
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
    const geo = useMemo(() => plotGeometry(w, h, extentX, extentY, maxSize), [w, h, extentX, extentY, maxSize]);
    const { plotW, plotH, cx, cy, px, py, plotBox } = geo;
    const clampTo = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));

    // collision relaxation and label placement are the expensive part: they
    // depend on the data, the box and the selection only, so a hover or a
    // quadrant focus reuses them
    const place = useMemo(() => placeBubbles(bubbles, geo), [bubbles, geo]);
    const at = (b: Bubble) => place.get(b.id)!;
    const labels = useMemo(() => placeLabels(bubbles, place, geo, selectedId), [bubbles, place, geo, selectedId]);

    const top = bubbles.reduce<Bubble | null>((best, b) => (b.point.net > 0 && (!best || b.point.net > best.point.net) ? b : best), null);
    const bottom = bubbles.reduce<Bubble | null>(
        (best, b) => (b.point.net < 0 && (!best || b.point.net < best.point.net) ? b : best),
        null,
    );

    // draw order: small first, selection last
    const ordered = [...bubbles].sort((a, b) => (a.id === selectedId ? 1 : b.id === selectedId ? -1 : b.point.size - a.point.size));
    const ticks = NET_TICKS.filter((t) => asinhScale(t, extentX, NET_UNIT) < 0.74);

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
                // a labelled group, not role="img": it holds a focusable button per
                // group; the decorative geometry is hidden from assistive tech
                <svg className={s.rotSvg} width={w} height={h} viewBox={`0 0 ${w} ${h}`} role='group' aria-label='族群資金輪動圖'>
                    <g aria-hidden='true'>
                        {/* guides: thin grid at the asinh ticks, a crosshair at zero */}
                        {ticks.flatMap((t) =>
                            [t, -t].map((v) => (
                                <g key={v}>
                                    <line className={s.rotGrid} x1={px(v)} x2={px(v)} y1={PAD.top} y2={PAD.top + plotH} />
                                    <text className={s.rotTick} x={px(v)} y={PAD.top + plotH + 13} textAnchor='middle'>
                                        {v > 0 ? '+' : '−'}
                                        {(Math.abs(v) / 1e8).toLocaleString('en-US')}
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
                        <text className={s.rotTick} x={cx} y={PAD.top + plotH + 13} textAnchor='middle'>
                            0
                        </text>
                        <text className={s.rotCaption} x={PAD.left + plotW} y={PAD.top + plotH + 13} textAnchor='end'>
                            淨流入（億）→
                        </text>
                        <text className={s.rotCaption} x={PAD.left} y={PAD.top + plotH + 13}>
                            ← 淨流出（億）
                        </text>
                        <text className={s.rotCaption} x={6} y={PAD.top - 8}>
                            資金動能（百分點）
                        </text>
                        {/* the trail of the hovered (or keyboard-focused) group only */}
                        {ordered.map((b) => {
                            if (b.trail.length < 2 || b.id !== hoverId) return null;
                            if (focusState !== null && focusState !== b.state) return null;
                            // ends at the drawn (edge-clamped) centre of the bubble
                            const pts = [
                                ...b.trail.map((p) => ({
                                    slot: p.slot,
                                    x: clampTo(px(p.net), plotBox.x0 + at(b).r, plotBox.x1 - at(b).r),
                                    y: clampTo(py(p.y), plotBox.y0 + at(b).r, plotBox.y1 - at(b).r),
                                })),
                                { slot: b.point.slot, x: at(b).x, y: at(b).y },
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
                                                strokeOpacity={0.06 + (0.4 * (i + 1)) / pts.length}
                                            />
                                        );
                                    })}
                                    {pts.slice(0, -1).map((p, i) => (
                                        <circle
                                            key={`d${p.slot}`}
                                            className={s.rotTrailDot[b.state]}
                                            cx={p.x}
                                            cy={p.y}
                                            r={1.6}
                                            opacity={0.1 + (0.45 * (i + 1)) / pts.length}
                                        />
                                    ))}
                                </g>
                            );
                        })}
                    </g>

                    {/* bubbles move on a spring to their new place */}
                    <LazyMotion features={domAnimation} strict>
                        {ordered.map((b) => {
                            const r = at(b).r;
                            const selected = b.id === selectedId;
                            const dim = focusState !== null && focusState !== b.state;
                            const f = b.row.flow;
                            return (
                                <m.g
                                    key={b.id}
                                    className={s.rotBubble}
                                    initial={false}
                                    animate={{ x: at(b).x, y: at(b).y, opacity: dim ? 0.15 : 1 }}
                                    transition={reducedMotion ? STILL : { ...SPRING, opacity: { duration: 0.3 } }}
                                    onClick={() => onSelect(b.id)}
                                    onMouseEnter={() => setHoverId(b.id)}
                                    onMouseLeave={() => setHoverId((id) => (id === b.id ? null : id))}
                                    onFocus={() => setHoverId(b.id)}
                                    onBlur={() => setHoverId((id) => (id === b.id ? null : id))}
                                    tabIndex={0}
                                    onKeyDown={(e: KeyboardEvent<SVGGElement>) => {
                                        if (e.key === 'Enter' || e.key === ' ') {
                                            e.preventDefault();
                                            onSelect(b.id);
                                        }
                                    }}
                                    role='button'
                                    aria-pressed={selected}
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
                                </m.g>
                            );
                        })}
                        {/* labels ride the same spring on a layer above every bubble */}
                        {ordered.map((b) => {
                            const dim = focusState !== null && focusState !== b.state;
                            const spot = dim ? undefined : labels.get(b.id);
                            if (!spot) return null;
                            const value = fmtTwd(b.point.net, true).replace(' ', '');
                            const font = spot.font ?? 9.5;
                            return (
                                <m.g
                                    key={`label-${b.id}`}
                                    className={s.rotLabel}
                                    initial={false}
                                    animate={{ x: at(b).x, y: at(b).y }}
                                    transition={reducedMotion ? STILL : SPRING}
                                    aria-hidden='true'
                                >
                                    {spot.inside ? (
                                        <>
                                            <text className={s.rotNameIn} y={spot.dy} textAnchor='middle' style={{ fontSize: `${font}px` }}>
                                                {spot.text}
                                            </text>
                                            {spot.value && (
                                                <text
                                                    className={s.rotValueIn}
                                                    y={spot.dy + font}
                                                    textAnchor='middle'
                                                    style={{ fontSize: `${font * 0.9}px` }}
                                                >
                                                    {value}
                                                </text>
                                            )}
                                        </>
                                    ) : (
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
                    <g aria-hidden='true'>
                        {(
                            [
                                ['leading', PAD.left + plotW - 8, PAD.top + 14, 'end'],
                                ['weakening', PAD.left + plotW - 8, PAD.top + plotH - 7, 'end'],
                                ['improving', PAD.left + 16, PAD.top + 14, 'start'],
                                ['lagging', PAD.left + 16, PAD.top + plotH - 7, 'start'],
                            ] as const
                        ).map(([q, x, y, anchor]) => {
                            // a bubble parked in the corner wins: the chips still name the quadrant
                            const lw = textWidth(QUADRANT_LABEL[q]) + 14;
                            const box =
                                anchor === 'end'
                                    ? { x0: x - lw, x1: x, y0: y - 12, y1: y + 3 }
                                    : { x0: x - 12, x1: x + lw - 12, y0: y - 12, y1: y + 3 };
                            if (bubbles.some((b) => hitsCircle(box, { ...at(b), r: at(b).r + 2 }))) return null;
                            return (
                                <g key={q}>
                                    <circle
                                        className={s.rotCornerDot[q]}
                                        cx={anchor === 'end' ? x - textWidth(QUADRANT_LABEL[q]) - 7 : x - 8}
                                        cy={y - 3.5}
                                        r={3}
                                    />
                                    <text className={s.rotCorner} x={x} y={y} textAnchor={anchor}>
                                        {QUADRANT_LABEL[q]}
                                    </text>
                                </g>
                            );
                        })}
                    </g>
                </svg>
            )}
            {now === null && (
                <div className={s.rotEmpty}>盤中每分鐘更新：收到第一根 1 分 K 起，泡泡依淨流入與資金動能移動，滑過泡泡看 8 分鐘軌跡</div>
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
