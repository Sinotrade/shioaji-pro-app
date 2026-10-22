// src/components/portfolio-lanes.tsx — 持股「資金通道」: one lane per held group.
//
// Same restraint as 排行 (chain-rank.tsx). Each held group is one row:
// - lane thickness = my weight in the group (market value share, square-root
//   scaled 4–22 px), so the rows I own most of are visibly heavier;
// - lane length / direction = the group's net inflow over the chosen window
//   (近 5 分／近 10 分／累計) on a centred diverging axis, one square-root
//   scale for both sides (riverLength);
// - fine particles drift along each lane (canvas, 30 fps cap), denser and
//   faster when net ÷ turnover is strong; only the minute's top mover gets a
//   glowing head;
// - rows are ordered by the group's net inflow (inflow above, a hairline,
//   outflow below) and glide to their new place when a minute bar lands
//   (translateY 700 ms ease-out). Ordering by flow rather than by weight is
//   what makes the rotation readable: thickness already carries my weight,
//   and a heavy lane sinking below the line is the signal worth noticing.
// - under the lane: my stocks in the group as small chips (name + today %,
//   a hairline underline ∝ weight); right: 淨流入, 權重, 今日損益 (odometer).
// A group whose flow flipped this minute flashes a single amber ring.
// Static under reduced motion; no animation loop while paused.

import { BellRing, Clock3 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { slotLabel } from '../lib/chain-flow';
import { fmtSignedPct, fmtTwd } from '../lib/chain-map';
import { riverLength } from '../lib/chain-motion';
import { TIER_LABEL } from '../lib/company-data/queries';
import { GROUPING_LABEL, othersNote, type HeldGroup } from '../lib/portfolio-sector';
import { maskMoney } from '../lib/privacy';
import { vars } from '../theme.css';
import { mixColor } from './chain-rank';
import { cssColor, dir, useBoxSize } from './chain-ui';
import { Odometer } from './odometer';
import type { VariantProps } from './portfolio-types';
import * as s from './portfolio-lanes.css';

type Win = '5' | '10' | 'cum';
const WINDOWS: { value: Win; label: string }[] = [
    { value: '5', label: '近 5 分' },
    { value: '10', label: '近 10 分' },
    { value: 'cum', label: '累計' },
];
const CHIP_ROW = 18;
const SIDE_GAP = 14;
const THICK_MIN = 4;
const THICK_MAX = 22;
const REACH = 0.94;
const MAX_PARTICLES = 44;
const FRAME_MS = 1000 / 30 - 2;
const NARROW_PX = 1000;

interface Particle {
    phase: number;
    speed: number;
    size: number;
    dash: boolean;
    lane: number;
    alpha: number;
}

function windowOf(g: HeldGroup, now: number | null, win: Win): { net: number; turnover: number } {
    if (now === null) return { net: 0, turnover: 0 };
    if (win === '10') return g.recent;
    if (win === 'cum') return g.cum;
    let net = 0;
    let turnover = 0;
    for (let i = Math.max(0, now - 4); i <= now; i += 1) {
        net += g.flow.net[i]!;
        turnover += g.flow.turnover[i]!;
    }
    return { net, turnover };
}

/** Rough chip width in px (CJK ≈ 10.5 px at 0.62rem, plus the % and padding). */
function chipWidth(name: string, tier: boolean): number {
    let w = 0;
    for (const ch of name) w += /[⺀-￿]/.test(ch) ? 10.5 : 6.2;
    return w + 12 + 4 + 40 + (tier ? 14 : 0) + 4;
}

export function HoldingLanes({
    view,
    grouping,
    now,
    from,
    flips,
    privacyMoney,
    reducedMotion,
    paused,
    selectedGroup,
    onSelectGroup,
    onPick,
}: VariantProps) {
    const [win, setWin] = useState<Win>('10');
    const { ref: rootRef, size } = useBoxSize<HTMLDivElement>();
    const narrow = size.width > 0 && size.width < NARROW_PX;

    const rows = useMemo(() => {
        const list = view.groups.map((g) => {
            const w = windowOf(g, now, win);
            return { g, net: w.net, turnover: w.turnover };
        });
        // before the first bar there is no flow yet: weight order
        if (now === null) list.sort((a, b) => b.g.weight - a.g.weight || a.g.id.localeCompare(b.g.id));
        else list.sort((a, b) => b.net - a.net || a.g.id.localeCompare(b.g.id));
        return list;
    }, [view.groups, now, win]);
    const maxAbs = useMemo(() => Math.max(0, ...rows.map((r) => Math.abs(r.net))), [rows]);
    const maxWeight = useMemo(() => Math.max(0, ...view.groups.map((g) => g.weight)), [view.groups]);
    const maxStock = useMemo(() => Math.max(0, ...view.stocks.map((x) => x.weight)), [view.stocks]);

    // this minute's top mover (largest change of the window value); before a
    // comparison exists, the largest absolute flow
    const prevNow = useRef<number | null>(null);
    const prevValues = useRef(new Map<string, number>());
    const [mover, setMover] = useState<string | null>(null);
    useEffect(() => {
        if (now === null) return;
        const step = prevNow.current !== null && now - prevNow.current === 1;
        if (prevNow.current === now && prevValues.current.size > 0) return;
        let best = 0;
        let id: string | null = null;
        for (const r of rows) {
            const before = prevValues.current.get(r.g.id);
            const delta = step && before !== undefined ? Math.abs(r.net - before) : Math.abs(r.net);
            if (delta > best) {
                best = delta;
                id = r.g.id;
            }
        }
        setMover(id);
        prevNow.current = now;
        prevValues.current = new Map(rows.map((r) => [r.g.id, r.net]));
        // `rows` changes with `now`; a window switch re-baselines on the next bar
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [now]);

    // layout: rows stacked with a gap between inflow and outflow
    const layout = useMemo(() => {
        let y = 0;
        let divider: number | null = null;
        const out = rows.map((r, i) => {
            const thick = maxWeight > 0 ? THICK_MIN + (THICK_MAX - THICK_MIN) * Math.sqrt(r.g.weight / maxWeight) : THICK_MIN;
            const laneH = Math.max(24, Math.round(thick) + 12);
            if (now !== null && i > 0 && r.net < 0 && rows[i - 1]!.net >= 0) {
                divider = y + SIDE_GAP / 2 - 1;
                y += SIDE_GAP;
            }
            const top = y;
            y += laneH + CHIP_ROW + 6;
            return { ...r, thick: Math.round(thick * 2) / 2, laneH, top };
        });
        return { rows: out, height: y, divider };
    }, [rows, maxWeight, now]);

    // columns follow the panel width
    const cols = narrow ? 'minmax(78px, 112px) minmax(0, 1fr) 64px 42px 78px' : 'minmax(100px, 156px) minmax(0, 1fr) 78px 50px 96px';
    const gap = narrow ? 8 : 12;
    const trackPx = Math.max(80, size.width - (narrow ? 112 + 64 + 42 + 78 + 4 * 8 : 156 + 78 + 50 + 96 + 4 * 12) - 48);

    // particles: one canvas, reading each lane's live rect so they follow
    // the CSS transitions
    const areaRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const particles = useRef(new Map<string, Particle[]>());
    const intensity = useMemo(() => {
        const map = new Map<string, number>();
        for (const r of rows) map.set(r.g.id, r.turnover > 0 ? Math.min(1, Math.abs(r.net) / r.turnover) : 0);
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
        const up = cssColor(area, vars.color.up);
        const down = cssColor(area, vars.color.down);
        const inColor = dark ? mixColor(up, '#ffffff', 0.72) : up;
        const outColor = dark ? mixColor(down, '#ffffff', 0.72) : down;
        const frame = (t: number) => {
            raf = requestAnimationFrame(frame);
            if (t - last < FRAME_MS) return;
            const dt = Math.min(0.1, (t - last) / 1000);
            last = t;
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
                // thicker lanes (more of my money) carry a little more traffic
                const want = Math.min(MAX_PARTICLES, Math.round((len / 10) * (0.45 + 2.4 * k) * (0.7 + r.height / 30)) + 1);
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
                    p.phase = (p.phase + dt * p.speed * (0.6 + 1.3 * k)) % 1;
                    const x = x0 + sign * p.phase * (len - 4);
                    const y = yMid + p.lane * Math.max(0, r.height - 2);
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

    const label = GROUPING_LABEL[grouping];
    const winLabel = WINDOWS.find((w) => w.value === win)!.label;
    const span = win === 'cum' && now !== null && from !== null ? `${slotLabel(from)} 起` : winLabel;
    const still = reducedMotion ? s.still : '';

    return (
        <div className={s.root} ref={rootRef} style={{ ['--cols' as string]: cols, ['--gap' as string]: `${gap}px` }}>
            <div className={s.header}>
                <span className={s.title}>持有{label}資金通道</span>
                <span className={s.windows} role='group' aria-label='淨流入區間'>
                    {WINDOWS.map((w) => (
                        <button
                            key={w.value}
                            type='button'
                            className={s.windowBtn[w.value === win ? 'on' : 'off']}
                            aria-pressed={w.value === win}
                            onClick={() => setWin(w.value)}
                        >
                            {w.label}
                        </button>
                    ))}
                </span>
                {now === null ? (
                    <span className={s.waiting} style={{ marginLeft: 'auto' }}>
                        <Clock3 size={11} aria-hidden='true' />
                        等待第一根分 K，通道長度稍後出現
                    </span>
                ) : (
                    <span className={s.note}>
                        {narrow ? '粗細＝持股權重・長度＝淨流入' : '粗細為持股權重・長度為分組淨流入（平方根刻度）・點選分組連動、點個股開啟'}
                    </span>
                )}
            </div>
            <div className={s.axis} aria-hidden='true'>
                <span>{label}・持有檔數</span>
                <span className={s.axisTrack}>
                    <span className={`${s.axisSide} ${s.tone.down}`} style={{ right: '50%' }}>
                        流出
                    </span>
                    <span className={`${s.axisSide} ${s.tone.up}`} style={{ left: '50%' }}>
                        流入
                    </span>
                </span>
                <span className={s.axisNum}>淨流入</span>
                <span className={s.axisNum}>權重</span>
                <span className={s.axisNum}>今日損益</span>
            </div>
            <div className={s.stage}>
                <canvas ref={canvasRef} className={s.canvas} aria-hidden='true' />
                <div className={s.area} ref={areaRef}>
                    <div className={s.rows} style={{ height: layout.height }} role='list' aria-label={`持有${label}依${winLabel}淨流入排序`}>
                        {layout.divider !== null && (
                            <span className={`${s.divider} ${still}`} style={{ transform: `translateY(${layout.divider}px)` }} aria-hidden='true' />
                        )}
                        {layout.rows.map((r) => {
                            const g = r.g;
                            const side = r.net >= 0 ? 'in' : 'out';
                            const width = now !== null ? riverLength(r.net, maxAbs) * 50 * REACH : 0;
                            const selected = selectedGroup === g.id;
                            const state = selectedGroup === null ? 'plain' : selected ? 'on' : 'off';
                            const flip = flips.get(g.id);
                            const glow = mover === g.id && now !== null;
                            const headPx = glow ? Math.max(9, Math.min(18, r.thick + 4)) : Math.max(5, Math.min(12, r.thick * 0.75));
                            const ratio = r.turnover > 0 ? (r.net / r.turnover) * 100 : null;
                            const pnlPct = g.value - g.dayPnl > 0 ? (g.dayPnl / (g.value - g.dayPnl)) * 100 : null;
                            // chips that fit the lane width; the rest fold into "+N"
                            let room = trackPx / 2 - 30;
                            let fit = 0;
                            for (const st of g.stocks) {
                                const cw = chipWidth(st.name, grouping === 'chain' && !!st.tier);
                                if (room < cw && fit > 0) break;
                                room -= cw;
                                fit += 1;
                            }
                            const more = g.stocks.length - fit;
                            return (
                                <div
                                    key={g.id}
                                    role='listitem'
                                    className={`${s.row[state]} ${still}`}
                                    style={{ transform: `translateY(${r.top}px)`, ['--lane-h' as string]: `${r.laneH}px` }}
                                    onClick={() => onSelectGroup(selected ? null : g.id)}
                                    title={`${g.name}・持有 ${g.stocks.length} 檔\n${span}淨流入 ${fmtTwd(r.net, true)}${ratio !== null ? `（占成交值 ${fmtSignedPct(ratio, 1)}）` : ''}\n${label}漲跌 ${fmtSignedPct(g.flow.pct)}・權重 ${(g.weight * 100).toFixed(1)}%`}
                                >
                                    {flip && !reducedMotion && <span key={flip.slot} className={s.flip} aria-hidden='true' />}
                                    <button
                                        type='button'
                                        className={s.nameBtn}
                                        aria-pressed={selected}
                                        aria-label={`${g.name}，持有 ${g.stocks.length} 檔，權重 ${(g.weight * 100).toFixed(1)}%，${span}淨流入 ${now !== null ? fmtTwd(r.net, true) : '尚無資料'}`}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onSelectGroup(selected ? null : g.id);
                                        }}
                                    >
                                        <span className={`${s.nameText} ${g.id === 'none' ? s.nameNone : ''}`}>{g.name}</span>
                                        <span className={s.count}>{g.stocks.length} 檔</span>
                                        {flip && (
                                            <span className={s.flipMark} title={flip.to === 'out' ? '本分鐘轉為淨流出' : '本分鐘轉為淨流入'}>
                                                <BellRing size={10} aria-hidden='true' />
                                            </span>
                                        )}
                                    </button>
                                    <span className={s.sub}>
                                        {g.id === 'none' ? (
                                            <span>持股自身資金</span>
                                        ) : (
                                            <>
                                                <span>漲跌</span>
                                                <span className={`${s.subNum} ${s.tone[dir(g.flow.pct)]}`}>{fmtSignedPct(g.flow.pct)}</span>
                                            </>
                                        )}
                                    </span>
                                    <span className={s.track}>
                                        <span className={s.zero} aria-hidden='true' />
                                        <span
                                            data-bar={g.id}
                                            data-side={side}
                                            className={`${s.bar[side]} ${still}`}
                                            style={{
                                                height: `${r.thick}px`,
                                                width: `${width}%`,
                                                borderRadius: `${r.thick / 2}px`,
                                                ...(side === 'in' ? { left: '50%' } : { right: '50%' }),
                                            }}
                                        >
                                            {width > 0.3 && (
                                                <span
                                                    className={`${(glow ? s.headGlow : s.head)[side]} ${still}`}
                                                    style={{
                                                        width: `${headPx}px`,
                                                        height: `${headPx}px`,
                                                        marginTop: `${-headPx / 2}px`,
                                                        ...(side === 'in' ? { right: `${-headPx / 2}px` } : { left: `${-headPx / 2}px` }),
                                                    }}
                                                />
                                            )}
                                        </span>
                                    </span>
                                    <span className={s.chips[now === null ? 'start' : side]}>
                                        {g.stocks.slice(0, fit).map((st) => (
                                            <button
                                                key={st.code}
                                                type='button'
                                                className={s.chip}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    onPick(st.code);
                                                }}
                                                title={`${st.code} ${st.name}・今日 ${fmtSignedPct(st.dayPct)}・權重 ${(st.weight * 100).toFixed(1)}%${
                                                    privacyMoney ? '' : `\n市值 ${fmtTwd(st.value)}・今日損益 ${fmtTwd(st.dayPnl, true)}`
                                                }${othersNote(st.others, label)}`}
                                            >
                                                {grouping === 'chain' && st.tier && TIER_LABEL[st.tier] && (
                                                    <span className={s.chipTier}>{TIER_LABEL[st.tier]!.slice(0, 1)}</span>
                                                )}
                                                <span>{st.name}</span>
                                                <span className={`${s.chipPct} ${s.tone[dir(st.dayPct)]}`}>{fmtSignedPct(st.dayPct)}</span>
                                                <span
                                                    className={`${s.chipWeight} ${still}`}
                                                    style={{ width: `${maxStock > 0 ? Math.max(6, (st.weight / maxStock) * 100) : 0}%` }}
                                                    aria-hidden='true'
                                                />
                                            </button>
                                        ))}
                                        {more > 0 && <span className={s.chipMore}>+{more}</span>}
                                    </span>
                                    <Odometer
                                        className={`${s.net} ${s.tone[dir(now !== null ? r.net : null)]}`}
                                        text={now !== null ? fmtTwd(r.net, true) : '--'}
                                        reducedMotion={reducedMotion}
                                    />
                                    <span className={s.netSub}>{now !== null && ratio !== null ? `占 ${fmtSignedPct(ratio, 1)}` : ''}</span>
                                    <Odometer className={s.weight} text={`${(g.weight * 100).toFixed(1)}%`} reducedMotion={reducedMotion} />
                                    {privacyMoney ? (
                                        <span className={`${s.pnl} ${s.masked}`}>{maskMoney('', true)}</span>
                                    ) : (
                                        <Odometer className={`${s.pnl} ${s.tone[dir(g.dayPnl)]}`} text={fmtTwd(g.dayPnl, true)} reducedMotion={reducedMotion} />
                                    )}
                                    <span className={`${s.pnlSub} ${s.tone[dir(pnlPct)]}`}>{fmtSignedPct(pnlPct)}</span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
}
