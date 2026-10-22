// src/components/chain-river.tsx — the canvas engine behind the 金流 (rank) lanes.
//
// DOM owns the rows (name, value, hit target); one canvas over the list owns
// everything that moves: a dashed centre axis, each group's soft gradient
// band growing from it, a glowing head at the leading edge, and tiny
// particles streaming from the axis toward the head. One rAF loop eases each
// lane's row position, length, thickness and emphasis, writes the row's
// translateY itself (so text and band never drift apart) and draws.
//
// The loop runs only while the panel is shown, on screen and the document is
// visible. Under prefers-reduced-motion there are no particles and every
// change snaps, so the loop draws once and stops.

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import {
    approach,
    capParticles,
    easeStep,
    headRadius,
    MAX_STEP_S,
    particleAlpha,
    particleSpeed,
    spawnCount,
    spawnRate,
} from '../lib/chain-river';
import { vars } from '../theme.css';
import { cssColor } from './chain-ui';

/** One lane's target; `m` is the signed magnitude (−1…1, square-root scale). */
export interface RiverLane {
    id: string;
    /** row offset in px inside the rows box */
    y: number;
    m: number;
    thick: number;
    /** 1 for the focused lane (or all when none is), lower for the rest */
    focus: number;
}

interface LaneState {
    y: number;
    len: number;
    thick: number;
    alpha: number;
    m: number;
    live: boolean;
    el: HTMLElement | null;
    shownY: number;
}

interface Particle {
    lane: LaneState;
    p: number;
    v: number;
    off: number;
    r: number;
    b: number;
}

interface Palette {
    dark: boolean;
    up: [number, number, number];
    down: [number, number, number];
    dot: { up: string; down: string };
    axis: string;
}

/** Row height of a lane, also the band's vertical slot. */
export const RIVER_ROW_PX = 34;
const Y_RATE = 10;
const LEN_RATE = 7;
const STYLE_RATE = 9;
const PALETTE_MS = 1000;

function rgb(color: string): [number, number, number] {
    const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
        const h = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join('') : hex[1]!;
        return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
    }
    const m = color.match(/rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [128, 128, 128];
}
const rgba = (c: [number, number, number], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
const mix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] =>
    a.map((v, i) => Math.round(v + (b[i]! - v) * t)) as [number, number, number];

function readPalette(el: HTMLElement): Palette {
    const dark = getComputedStyle(document.documentElement).colorScheme.includes('dark');
    const up = rgb(cssColor(el, vars.color.up));
    const down = rgb(cssColor(el, vars.color.down));
    const fg = rgb(cssColor(el, vars.color.foreground));
    const muted = rgb(cssColor(el, vars.color.mutedForeground));
    // dark: near-white sparks; light: the lane colour pulled toward the ink
    const spark = (c: [number, number, number]) => (dark ? mix(c, [255, 255, 255], 0.86) : mix(c, fg, 0.35));
    return {
        dark,
        // a touch of grey takes the edge off the saturated tokens
        up: mix(up, muted, 0.18),
        down: mix(down, muted, 0.18),
        dot: { up: spark(up).join(','), down: spark(down).join(',') },
        axis: rgba(muted, dark ? 0.32 : 0.4),
    };
}

export function useRiver({
    lanes,
    stageRef,
    areaRef,
    rowsRef,
    canvasRef,
    rowEls,
    reducedMotion,
    active,
    layoutKey,
}: {
    lanes: RiverLane[];
    stageRef: RefObject<HTMLElement | null>;
    areaRef: RefObject<HTMLElement | null>;
    rowsRef: RefObject<HTMLElement | null>;
    canvasRef: RefObject<HTMLCanvasElement | null>;
    rowEls: RefObject<Map<string, HTMLElement>>;
    reducedMotion: boolean;
    active: boolean;
    /**
     * Changes when the row columns change without the stage or rows box
     * resizing (e.g. responsive grid columns): the track is measured again.
     */
    layoutKey?: string | number;
}) {
    const target = useRef(lanes);
    target.current = lanes;
    const states = useRef(new Map<string, LaneState>());
    const particles = useRef<Particle[]>([]);
    const kick = useRef<() => void>(() => {});
    const remeasure = useRef<() => void>(() => {});
    const reduced = useRef(reducedMotion);
    reduced.current = reducedMotion;

    // place new rows (and every row while the loop is idle) before paint
    useLayoutEffect(() => {
        const map = states.current;
        for (const lane of lanes) {
            const el = rowEls.current.get(lane.id) ?? null;
            let st = map.get(lane.id);
            if (!st) {
                st = { y: lane.y, len: 0, thick: lane.thick, alpha: lane.focus, m: lane.m, live: true, el, shownY: Number.NaN };
                map.set(lane.id, st);
            }
            // a remounted row starts without a transform: write it again
            if (st.el !== el) st.shownY = Number.NaN;
            st.el = el;
            st.live = true;
            if (el && st.shownY !== st.y) {
                el.style.transform = `translateY(${st.y.toFixed(1)}px)`;
                st.shownY = st.y;
            }
        }
        // lanes that left the list go now; their particles see `live` and drop
        const ids = new Set(lanes.map((l) => l.id));
        for (const [id, st] of map) {
            if (!ids.has(id)) {
                st.live = false;
                map.delete(id);
            }
        }
        kick.current();
    }, [lanes, rowEls]);

    useEffect(() => {
        const canvas = canvasRef.current;
        const stage = stageRef.current;
        const area = areaRef.current;
        const rows = rowsRef.current;
        // no layout engine (tests, SSR): the rows were placed by the layout effect
        if (!canvas || !stage || !area || !rows || typeof getComputedStyle !== 'function' || typeof requestAnimationFrame !== 'function') return;
        const ctx = canvas.getContext?.('2d') ?? null;
        let raf = 0;
        let last = 0;
        let onScreen = true;
        let palette = readPalette(stage);
        let paletteAt = performance.now();
        // geometry, refreshed on resize: track centre and half-width, rows offset
        const geo = { cx: 0, half: 0, rowsTop: 0, w: 0, h: 0 };
        const measure = () => {
            const s = stage.getBoundingClientRect();
            const a = area.getBoundingClientRect();
            const r = rows.getBoundingClientRect();
            const track = rows.querySelector<HTMLElement>('[data-track]')?.getBoundingClientRect();
            geo.w = s.width;
            geo.h = s.height;
            geo.rowsTop = r.top - a.top + area.scrollTop + (a.top - s.top);
            if (track) {
                geo.cx = track.left - s.left + track.width / 2;
                // room for the largest head and its glow at the far end
                geo.half = Math.max(0, track.width / 2 - 10);
            }
        };

        const draw = (t: number, dt: number): boolean => {
            const reduce = reduced.current;
            const map = states.current;
            const lanesNow = target.current;
            if (t - paletteAt > PALETTE_MS) {
                palette = readPalette(stage);
                paletteAt = t;
            }
            const scroll = area.scrollTop;
            const dpr = window.devicePixelRatio || 1;
            const bw = Math.round(geo.w * dpr);
            const bh = Math.round(geo.h * dpr);
            if (canvas.width !== bw) canvas.width = bw;
            if (canvas.height !== bh) canvas.height = bh;
            if (!ctx) return false;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, geo.w, geo.h);
            if (lanesNow.length === 0 || geo.half <= 0) return false;

            const kY = easeStep(dt, Y_RATE, reduce);
            const kLen = easeStep(dt, LEN_RATE, reduce);
            const kStyle = easeStep(dt, STYLE_RATE, reduce);
            const { cx, half } = geo;
            const top = geo.rowsTop - scroll;
            let moving = false;

            // dashed centre axis across the whole list
            const first = top + RIVER_ROW_PX * 0.15;
            const lastLane = lanesNow[lanesNow.length - 1]!;
            const end = Math.min(geo.h, top + lastLane.y + RIVER_ROW_PX * 0.85);
            if (end > first) {
                ctx.strokeStyle = palette.axis;
                ctx.lineWidth = 1;
                ctx.setLineDash([2, 4]);
                ctx.beginPath();
                ctx.moveTo(Math.round(cx) + 0.5, Math.max(0, first));
                ctx.lineTo(Math.round(cx) + 0.5, end);
                ctx.stroke();
                ctx.setLineDash([]);
            }

            for (const lane of lanesNow) {
                const st = map.get(lane.id);
                if (!st) continue;
                const lenTarget = lane.m * half;
                st.y = approach(st.y, lane.y, kY, 0.05);
                st.len = approach(st.len, lenTarget, kLen, 0.05);
                st.thick = approach(st.thick, lane.thick, kStyle, 0.02);
                st.alpha = approach(st.alpha, lane.focus, kStyle, 0.002);
                st.m = lane.m;
                if (st.y !== lane.y || st.len !== lenTarget || st.thick !== lane.thick || st.alpha !== lane.focus) moving = true;
                if (st.el && Math.abs(st.shownY - st.y) >= 0.05) {
                    st.el.style.transform = `translateY(${st.y.toFixed(1)}px)`;
                    st.shownY = st.y;
                }
                const yMid = top + st.y + RIVER_ROW_PX / 2;
                // off screen: keep easing, skip drawing and spawning
                if (yMid < -RIVER_ROW_PX || yMid > geo.h + RIVER_ROW_PX) continue;
                const dir = Math.sign(st.len) || 1;
                const len = Math.abs(st.len);
                if (len < 0.5) continue;
                const color = dir > 0 ? palette.up : palette.down;
                // on a light surface faint lanes wash out sooner: keep them a step stronger
                const a = palette.dark ? st.alpha : 0.3 + 0.7 * st.alpha;
                const head = cx + dir * len;
                const thick = st.thick;
                const grad = ctx.createLinearGradient(cx, 0, head, 0);
                grad.addColorStop(0, rgba(color, (palette.dark ? 0.04 : 0.06) * a));
                grad.addColorStop(1, rgba(color, (palette.dark ? 0.34 : 0.4) * a));
                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.roundRect(Math.min(cx, head), yMid - thick / 2, len, thick, thick / 2);
                ctx.fill();
                // glowing head
                ctx.shadowColor = rgba(color, palette.dark ? 1 : 0.7);
                ctx.shadowBlur = (palette.dark ? 12 : 9) * a;
                ctx.fillStyle = rgba(color, 0.95 * a);
                ctx.beginPath();
                ctx.arc(head, yMid, headRadius(thick), 0, Math.PI * 2);
                ctx.fill();
                ctx.shadowBlur = 0;
                if (!reduce) {
                    const m = Math.abs(lane.m);
                    const n = spawnCount(spawnRate(m), dt, Math.random);
                    for (let i = 0; i < n; i++) {
                        particles.current.push({
                            lane: st,
                            p: 0,
                            v: particleSpeed(m, Math.random()),
                            off: (Math.random() - 0.5) * 0.8,
                            r: 0.8 + Math.random() * 1.2,
                            b: Math.random() < 0.18 ? 1 : 0.45 + Math.random() * 0.4,
                        });
                    }
                }
            }

            // particles: a short streak in the lane colour behind a bright spark
            if (!reduce && particles.current.length > 0) {
                const kept: Particle[] = [];
                ctx.lineCap = 'round';
                for (const pt of particles.current) {
                    const st = pt.lane;
                    if (!st.live) continue;
                    pt.p += pt.v * dt;
                    if (pt.p >= 1) continue;
                    kept.push(pt);
                    const dir = Math.sign(st.len) || 1;
                    const len = Math.abs(st.len);
                    const yMid = top + st.y + RIVER_ROW_PX / 2;
                    if (len < 0.5 || yMid < -RIVER_ROW_PX || yMid > geo.h + RIVER_ROW_PX) continue;
                    const x = cx + dir * len * pt.p;
                    const y = yMid + pt.off * st.thick;
                    const d = particleAlpha(pt.p) * 1.15 * (palette.dark ? st.alpha : 0.3 + 0.7 * st.alpha);
                    const color = dir > 0 ? palette.up : palette.down;
                    ctx.strokeStyle = rgba(color, d * (palette.dark ? 0.5 : 0.45));
                    ctx.lineWidth = pt.r;
                    ctx.beginPath();
                    ctx.moveTo(x - dir * Math.min(10, len * 0.12), y);
                    ctx.lineTo(x, y);
                    ctx.stroke();
                    ctx.fillStyle = `rgba(${dir > 0 ? palette.dot.up : palette.dot.down},${Math.min(1, d * 0.85 * pt.b).toFixed(3)})`;
                    ctx.beginPath();
                    ctx.arc(x, y, pt.r * 0.75, 0, Math.PI * 2);
                    ctx.fill();
                }
                particles.current = capParticles(kept);
            }

            // particles keep the loop alive; reduced motion stops once settled
            return moving || !reduce;
        };

        const frame = (t: number) => {
            raf = 0;
            const dt = last === 0 ? 0 : Math.min(MAX_STEP_S, (t - last) / 1000);
            last = t;
            const more = draw(t, dt);
            if (more && running()) raf = requestAnimationFrame(frame);
            else last = 0;
        };
        const running = () => active && onScreen && document.visibilityState === 'visible';
        kick.current = () => {
            if (raf !== 0) return;
            if (running()) {
                raf = requestAnimationFrame(frame);
                return;
            }
            // idle: snap rows to their slots so the list is right when shown again
            for (const lane of target.current) {
                const st = states.current.get(lane.id);
                if (!st) continue;
                st.y = lane.y;
                st.len = lane.m * geo.half;
                st.thick = lane.thick;
                st.alpha = lane.focus;
                if (st.el && st.shownY !== st.y) {
                    st.el.style.transform = `translateY(${st.y.toFixed(1)}px)`;
                    st.shownY = st.y;
                }
            }
            // and paint that state once, without particles: an inactive river
            // (no data yet, a session reset) must not keep the last frame's bands
            particles.current = [];
            draw(performance.now(), 0);
        };
        remeasure.current = () => {
            measure();
            kick.current();
        };

        measure();
        const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
            measure();
            kick.current();
        }) : null;
        resize?.observe(stage);
        resize?.observe(rows);
        const io = typeof IntersectionObserver !== 'undefined'
            ? new IntersectionObserver((entries) => {
                  onScreen = entries.some((e) => e.isIntersecting);
                  kick.current();
              })
            : null;
        io?.observe(stage);
        const onVisible = () => kick.current();
        document.addEventListener('visibilitychange', onVisible);
        // moving to a display with another pixel ratio: rebuild the backing store
        let dprQuery: MediaQueryList | null = null;
        const onDpr = () => {
            dprQuery?.removeEventListener('change', onDpr);
            dprQuery = typeof matchMedia === 'function' ? matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`) : null;
            dprQuery?.addEventListener('change', onDpr);
            kick.current();
        };
        const onScroll = () => kick.current();
        area.addEventListener('scroll', onScroll, { passive: true });
        if (!active) particles.current = [];
        onDpr();
        return () => {
            if (raf !== 0) cancelAnimationFrame(raf);
            raf = 0;
            kick.current = () => {};
            remeasure.current = () => {};
            resize?.disconnect();
            io?.disconnect();
            document.removeEventListener('visibilitychange', onVisible);
            area.removeEventListener('scroll', onScroll);
            dprQuery?.removeEventListener('change', onDpr);
            particles.current = [];
        };
    }, [active, reducedMotion, canvasRef, stageRef, areaRef, rowsRef]);

    // columns changed inside an unchanged box: the track moved, measure again
    useEffect(() => {
        if (layoutKey !== undefined) remeasure.current();
    }, [layoutKey]);
}
