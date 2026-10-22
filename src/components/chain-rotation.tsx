// src/components/chain-rotation.tsx — 輪動 view: every chain/theme as a bubble.
//
// x = net inflow since the first received bar (asinh scale, so a small group
// stays readable next to the largest; robust per-side extents, zero placed
// where both sides fit), y = 資金動能 (last ten minutes' flow intensity minus
// the last 30 minutes'), size = last ten minutes' turnover, colour = RRG
// quadrant (領先 / 轉弱 / 改善 / 落後).
// Warm-up: until MOMENTUM_WARMUP minutes of bars have arrived the momentum is
// identically 0 (both windows hold the same bars), so it is not drawn: the
// bubbles sit grey on a beeswarm along the centre line, ordered by net
// inflow only, with no quadrant, and spring to their real places once the
// momentum exists.
// Restraint: translucent muted bubbles with a thin outline, names inside
// when they fit, no quadrant tints and no glow. Each minute the bubbles move
// on a spring (motion: a retarget mid-flight keeps its velocity, CSS
// transitions restart from zero); only the hovered or focused group draws
// its eight-minute trail, and a faint ring marks a genuine state change. The
// viewport only widens during the session, so motion always means change,
// never rescaling. Static under prefers-reduced-motion.

import { Hourglass } from 'lucide-react';
import { domAnimation, LazyMotion, m } from 'motion/react';
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { fmtSignedPct, fmtTwd } from '../lib/chain-map';
import {
    beeswarm,
    MOMENTUM_WARMUP,
    momentumWarmup,
    RECENT,
    netExtents,
    netFrac,
    netScale,
    netTicks,
    QUADRANT_LABEL,
    QUADRANTS,
    quadrantCounts,
    quadrantOf,
    rotationExtent,
    rotationPoint,
    relaxCircles,
    rotationTrail,
    smoothTrail,
    softUnit,
    type NetScale,
    type Quadrant,
    type RotationPoint,
} from '../lib/chain-motion';
import { useBoxSize, type FlowRow } from './chain-ui';
import * as s from './chain-map.css';

const TRAIL = 8;
const PAD = { left: 40, right: 14, top: 30, bottom: 34 };
const MAX_LABELS = 12;
/** Width kept clear for the 淨流出／淨流入 captions at both ends of the tick row. */
const CAPTION_W = 96;
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
    /** null while the momentum warms up: no quadrant yet. */
    state: Quadrant | null;
}

type Geometry = ReturnType<typeof plotGeometry>;
type Placement = Map<string, { x: number; y: number; r: number }>;

/** Share of the plot area all bubbles together may cover before they shrink. */
const AREA_BUDGET = 0.2;

/** Plot box, scales and bubble radius for a panel size and the (ratcheted) extents. */
function plotGeometry(w: number, h: number, scale: NetScale, extentY: number, sizes: readonly number[]) {
    const plotW = Math.max(0, w - PAD.left - PAD.right);
    const plotH = Math.max(0, h - PAD.top - PAD.bottom);
    const cx = PAD.left + scale.zero * plotW;
    const cy = PAD.top + plotH / 2;
    const px = (net: number) => PAD.left + netFrac(net, scale) * plotW;
    // soft clamp: a thin group's momentum spike rests against the edge
    const py = (y: number) => cy - (Math.sign(y) * softUnit(Math.abs(y) / extentY) * (plotH - 12)) / 2;
    const maxSize = Math.max(1, ...sizes);
    // a narrow size range: every bubble is big enough to carry its name
    let rMax = Math.max(18, Math.min(44, Math.min(plotW, plotH) / 8));
    let rMin = Math.max(12, rMax * 0.4);
    const raw = (size: number) => rMin + Math.sqrt(Math.max(0, size) / maxSize) * (rMax - rMin);
    // many groups in a small panel: shrink together so they can all be seen
    const area = sizes.reduce((sum, size) => sum + Math.PI * raw(size) ** 2, 0);
    const k = area > 0 ? Math.min(1, Math.sqrt((AREA_BUDGET * plotW * plotH) / area)) : 1;
    rMax *= k;
    rMin = Math.max(8, rMin * k);
    const radius = (size: number) => rMin + Math.sqrt(Math.max(0, size) / maxSize) * Math.max(0, rMax - rMin);
    const plotBox: Box = { x0: PAD.left, x1: PAD.left + plotW, y0: PAD.top, y1: PAD.top + plotH };
    return { plotW, plotH, cx, cy, px, py, radius, plotBox };
}

/**
 * Bubble centres. Warm-up: a beeswarm on the centre line (x = net only).
 * Live: gentle collision relaxation from the data positions; an edge group
 * sits whole against the frame.
 */
function placeBubbles(bubbles: readonly Bubble[], geo: Geometry, warming: boolean): Placement {
    const { px, py, radius, plotW, plotH, plotBox, cx, cy } = geo;
    const place: Placement = new Map();
    const sorted = [...bubbles].sort((a, b) => (a.id < b.id ? -1 : 1));
    const circles = sorted.map((b) => {
        const r = radius(b.point.size);
        const x = Math.max(plotBox.x0 + r, Math.min(plotBox.x1 - r, px(b.point.net)));
        if (warming) return { x, y: cy, r };
        // live: a nudge never carries a bubble across a zero line, so its
        // drawn quadrant always matches its colour (quadrantOf: 0 is ≥ 0)
        const right = b.point.net >= 0;
        const up = b.point.y >= 0;
        const keep = {
            x0: right ? cx : -Infinity,
            x1: right ? Infinity : cx - 0.01,
            y0: up ? -Infinity : cy + 0.01,
            y1: up ? cy : Infinity,
        };
        return { x, y: py(b.point.y), r, keep };
    });
    let out: { x: number; y: number }[] = circles;
    if (plotW > 0 && plotH > 0) {
        if (warming) {
            const ys = beeswarm(circles, cy, plotBox);
            out = relaxCircles(
                circles.map((c, i) => ({ ...c, y: ys[i]! })),
                plotBox,
            );
        } else {
            out = relaxCircles(circles, plotBox);
        }
    }
    sorted.forEach((b, i) => place.set(b.id, { ...out[i]!, r: circles[i]!.r }));
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

/** `value` as of the last time `key` changed: tick-only updates reuse the layout. */
function useKeyed<T>(value: T, key: string): T {
    const ref = useRef({ key, value });
    if (ref.current.key !== key) ref.current = { key, value };
    return ref.current.value;
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

    const remaining = momentumWarmup(from, now);
    const warming = now !== null && remaining > 0;

    const bubbles = useMemo<Bubble[]>(() => {
        if (now === null) return [];
        // trails start where the momentum exists, never at the warm-up zeros
        const trailFrom = (from ?? 0) + MOMENTUM_WARMUP - 1;
        return rows.flatMap((row) => {
            const point = rotationPoint(row.flow, now);
            if (!point) return [];
            const trail = warming ? [] : smoothTrail(rotationTrail(row.flow, now - 1, TRAIL, 1, trailFrom));
            return [
                {
                    row,
                    id: row.theme.id,
                    point,
                    trail,
                    state: warming ? null : quadrantOf(point.net, point.y),
                },
            ];
        });
    }, [rows, now, from, warming]);

    // layout inputs change once a minute (bar data), not on every price
    // tick that rebuilds `rows`: the expensive placement keys on them only
    const layoutKey = useMemo(
        () => `${warming ? 'w' : 'l'}|${bubbles.map((b) => `${b.id}:${b.row.theme.name}:${b.point.net}:${b.point.y}:${b.point.size}`).join('|')}`,
        [bubbles, warming],
    );
    const layoutBubbles = useKeyed(bubbles, layoutKey);

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
            for (const b of bubbles) {
                const was = before.get(b.id);
                // leaving the warm-up is not a state change
                if (was && b.state && was !== b.state) set.add(b.id);
            }
        }
        prev.current = {
            now,
            states: new Map(bubbles.flatMap((b) => (b.state ? [[b.id, b.state] as const] : []))),
        };
        return set;
    }, [bubbles, now]);

    // robust per side: one dominant group does not squash the other 35
    const rawX = useMemo(() => netExtents(layoutBubbles.map((b) => b.point.net), { floor: NET_UNIT }), [layoutBubbles]);
    // robust: a thin group's acceleration can spike; it is pinned to the edge
    const rawY = useMemo(() => {
        const ys = layoutBubbles.map((b) => Math.abs(b.point.y)).sort((a, b) => a - b);
        const p85 = ys.length > 0 ? ys[Math.min(ys.length - 1, Math.floor(ys.length * 0.85))]! : 0;
        return rotationExtent([p85 * 1.3], 4, 2);
    }, [layoutBubbles]);
    const extentPos = useRatchet(rawX.pos, session);
    const extentNeg = useRatchet(rawX.neg, session);
    const extentY = useRatchet(rawY, session);
    const scale = useMemo(() => netScale(extentPos, extentNeg, NET_UNIT), [extentPos, extentNeg]);
    const sizes = useMemo(() => layoutBubbles.map((b) => b.point.size), [layoutBubbles]);
    const counts = useMemo(() => quadrantCounts(bubbles.map((b) => ({ x: b.point.net, y: b.point.y }))), [bubbles]);

    const w = size.width;
    const h = size.height;
    const geo = useMemo(() => plotGeometry(w, h, scale, extentY, sizes), [w, h, scale, extentY, sizes]);
    const { plotW, plotH, cx, cy, px, py, plotBox } = geo;
    const clampTo = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));

    // collision relaxation and label placement are the expensive part: they
    // depend on the data, the box and the selection only, so a hover or a
    // quadrant focus reuses them
    const place = useMemo(() => placeBubbles(layoutBubbles, geo, warming), [layoutBubbles, geo, warming]);
    const at = (b: Bubble) => place.get(b.id)!;
    const labels = useMemo(() => placeLabels(layoutBubbles, place, geo, selectedId), [layoutBubbles, place, geo, selectedId]);

    const top = bubbles.reduce<Bubble | null>((best, b) => (b.point.net > 0 && (!best || b.point.net > best.point.net) ? b : best), null);
    const bottom = bubbles.reduce<Bubble | null>(
        (best, b) => (b.point.net < 0 && (!best || b.point.net < best.point.net) ? b : best),
        null,
    );

    // draw order: small first, selection last
    const ordered = [...bubbles].sort((a, b) => (a.id === selectedId ? 1 : b.id === selectedId ? -1 : b.point.size - a.point.size));
    const ticks = useMemo(
        () => netTicks(scale, plotW).filter((v) => {
            const x = netFrac(v, scale) * plotW;
            return x > CAPTION_W && x < plotW - CAPTION_W;
        }),
        [scale, plotW],
    );
    const focus = warming ? null : focusState;
    const fillOf = (b: Bubble) => (b.state ? s.rotFill[b.state] : s.rotFillWarm);
    const stateText = (b: Bubble) => (b.state ? QUADRANT_LABEL[b.state] : '動能累積中');
    // the hovered group is always named, even when the label cap hid it
    const hovered = hoverId !== null && !labels.has(hoverId) ? bubbles.find((b) => b.id === hoverId) : undefined;
    // kept inside the plot: shifted sideways at an edge, below when no room above
    const hoverSpot = (() => {
        if (!hovered) return null;
        const { x, y, r } = at(hovered);
        const value = fmtTwd(hovered.point.net, true).replace(' ', '');
        const half = Math.max(textWidth(hovered.row.theme.name), textWidth(value, 5.4)) / 2 + 2;
        const lo = PAD.left + half;
        const hi = PAD.left + plotW - half;
        const dx = (lo > hi ? PAD.left + plotW / 2 : Math.max(lo, Math.min(hi, x))) - x;
        const above = y - r - 23 >= PAD.top;
        return { dx, nameY: above ? -r - 13 : r + 11, value };
    })();

    return (
        <div className={s.rot} ref={ref}>
            <div className={s.rotStates} role='group' aria-label='族群狀態'>
                {QUADRANTS.map((q) => (
                    <button
                        key={q}
                        type='button'
                        className={`${s.rotState} ${focus === q ? s.rotStateOn : ''}`}
                        aria-pressed={focus === q}
                        onMouseEnter={() => setFocusState(q)}
                        onMouseLeave={() => setFocusState(null)}
                        onFocus={() => setFocusState(q)}
                        onBlur={() => setFocusState(null)}
                        title={
                            warming
                                ? `資金動能需要至少 ${MOMENTUM_WARMUP} 分鐘的 1 分 K，累積完成前不分類`
                                : {
                                leading: '淨流入，且近 10 分鐘淨流入占比高於近 30 分鐘（動能增強）',
                                weakening: '淨流入，但近 10 分鐘淨流入占比低於近 30 分鐘（動能減弱）',
                                improving: '淨流出，但近 10 分鐘占比高於近 30 分鐘（流出收斂）',
                                lagging: '淨流出，且近 10 分鐘占比低於近 30 分鐘（流出擴大）',
                              }[q]
                        }
                    >
                        <span className={s.rotDot[q]} aria-hidden='true' />
                        <span className={s.rotStateLabel}>{QUADRANT_LABEL[q]}</span>
                        <span className={s.rotStateCount}>{now === null ? '--' : warming ? '—' : counts[q]}</span>
                    </button>
                ))}
            </div>
            {w > 0 && h > 0 && (
                // a labelled group, not role="img": it holds a focusable button per
                // group; the decorative geometry is hidden from assistive tech
                <svg className={s.rotSvg} width={w} height={h} viewBox={`0 0 ${w} ${h}`} role='group' aria-label='族群資金輪動圖'>
                    <g aria-hidden='true'>
                        {/* guides: thin grid at the asinh ticks, a crosshair at zero */}
                        {ticks.map((v) => (
                            <g key={v}>
                                <line className={s.rotGrid} x1={px(v)} x2={px(v)} y1={PAD.top} y2={PAD.top + plotH} />
                                <text className={s.rotTick} x={px(v)} y={PAD.top + plotH + 13} textAnchor='middle'>
                                    {v > 0 ? '+' : '−'}
                                    {(Math.abs(v) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 2 })}
                                </text>
                            </g>
                        ))}
                        {!warming && [extentY / 2, -extentY / 2].map((v) => (
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
                        {!warming && (
                            <>
                                <text className={s.rotTick} x={PAD.left - 4} y={PAD.top + 8} textAnchor='end'>
                                    +{extentY}
                                </text>
                                <text className={s.rotTick} x={PAD.left - 4} y={PAD.top + plotH} textAnchor='end'>
                                    −{extentY}
                                </text>
                                <text className={s.rotTick} x={PAD.left - 4} y={cy + 3} textAnchor='end'>
                                    0
                                </text>
                            </>
                        )}
                        {cx - PAD.left > CAPTION_W && PAD.left + plotW - cx > CAPTION_W && (
                            <text className={s.rotTick} x={cx} y={PAD.top + plotH + 13} textAnchor='middle'>
                                0
                            </text>
                        )}
                        <text className={s.rotCaption} x={PAD.left + plotW} y={PAD.top + plotH + 13} textAnchor='end'>
                            淨流入（億）→
                        </text>
                        <text className={s.rotCaption} x={PAD.left} y={PAD.top + plotH + 13}>
                            ← 淨流出（億）
                        </text>
                        {!warming && (
                            <text className={s.rotCaption} x={6} y={PAD.top - 8}>
                                資金動能（百分點）
                            </text>
                        )}
                        {/* the trail of the hovered (or keyboard-focused) group only */}
                        {ordered.map((b) => {
                            if (!b.state || b.trail.length < 2 || b.id !== hoverId) return null;
                            if (focus !== null && focus !== b.state) return null;
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
                                <g key={`trail-${b.id}`} className={s.rotTrail[b.state!]}>
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
                                            className={s.rotTrailDot[b.state!]}
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
                            const dim = focus !== null && focus !== b.state;
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
                                    aria-label={`${b.row.theme.name} ${stateText(b)} 淨流入 ${fmtTwd(b.point.net, true)}`}
                                >
                                    <title>
                                        {`${b.row.theme.name}・${stateText(b)}\n淨流入 ${fmtTwd(b.point.net, true)}・占成交值 ${fmtSignedPct(b.point.x, 1)}\n${
                                            b.state
                                                ? `資金動能 ${b.point.y >= 0 ? '+' : ''}${b.point.y.toFixed(1)} 百分點`
                                                : `資金動能累積中，還需 ${remaining} 分鐘`
                                        }\n近 10 分成交值 ${fmtTwd(b.point.size)}・漲跌 ${fmtSignedPct(f.pct)}`}
                                    </title>
                                    {b.state && pulse.has(b.id) && !reducedMotion && !paused && (
                                        <circle key={`pulse-${now}`} className={s.rotPulse[b.state]} r={r} />
                                    )}
                                    <circle className={fillOf(b)} r={r} />
                                    {selected && <circle className={s.rotSelected} r={r + 2.5} />}
                                </m.g>
                            );
                        })}
                        {/* labels ride the same spring on a layer above every bubble */}
                        {ordered.map((b) => {
                            const dim = focus !== null && focus !== b.state;
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
                                            <text
                                                className={b.state ? s.rotValue[b.state] : s.rotValueWarm}
                                                x={spot.dx}
                                                y={spot.dy + 10}
                                                textAnchor={spot.anchor}
                                            >
                                                {value}
                                            </text>
                                        </>
                                    )}
                                </m.g>
                            );
                        })}
                        {hovered && hoverSpot && (
                            <m.g
                                key={`hover-${hovered.id}`}
                                className={s.rotLabel}
                                initial={false}
                                animate={{ x: at(hovered).x, y: at(hovered).y }}
                                transition={reducedMotion ? STILL : SPRING}
                                aria-hidden='true'
                            >
                                <text className={s.rotName} x={hoverSpot.dx} y={hoverSpot.nameY} textAnchor='middle'>
                                    {hovered.row.theme.name}
                                </text>
                                <text
                                    className={hovered.state ? s.rotValue[hovered.state] : s.rotValueWarm}
                                    x={hoverSpot.dx}
                                    y={hoverSpot.nameY + 10}
                                    textAnchor='middle'
                                >
                                    {hoverSpot.value}
                                </text>
                            </m.g>
                        )}
                    </LazyMotion>
                    {/* corner names on top: a small dot carries the colour */}
                    <g aria-hidden='true'>
                        {!warming && (
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
            {warming && (
                <div
                    className={s.rotWarm}
                    role='status'
                    title={`資金動能比較近 ${RECENT} 分鐘與近 30 分鐘的淨流入占比，需要至少 ${MOMENTUM_WARMUP} 分鐘的 1 分 K；累積完成前泡泡只依淨流入左右排列，不分象限`}
                >
                    <Hourglass size={11} aria-hidden='true' />
                    資金動能累積中・還需 {remaining} 分鐘
                </div>
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
