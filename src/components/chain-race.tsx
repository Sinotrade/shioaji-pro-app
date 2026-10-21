// src/components/chain-race.tsx — 資金流賽跑: groups race on net inflow.
//
// Rows glide to their new rank when a minute bar lands (CSS transform
// transition), bars grow from a centre line (inflow right, outflow left),
// the head of each bar glows, and particles stream along the bar at a speed
// set by the last five minutes' flow intensity. A row flashes when its value
// changes and shows a rank-move arrow for a few seconds. Everything static
// under prefers-reduced-motion.

import { ArrowDown, ArrowUp } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { slotLabel, SESSION_SLOTS } from '../lib/chain-flow';
import { fmtSignedPct, fmtTwd } from '../lib/chain-map';
import { raceOrder, raceValue, rankMoves, type RaceMetric } from '../lib/chain-motion';
import { vars } from '../theme.css';
import { cssColor, dir, type FlowRow } from './chain-ui';
import * as panel from './panel.css';
import * as s from './chain-map.css';

const ROW_PX = 26;
const GAP_PX = 10;
const MOVE_SHOW_MS = 4000;

interface Particle {
    phase: number;
    speed: number;
    size: number;
}

export function FlowRace({
    rows,
    metric,
    now,
    from,
    selectedId,
    reducedMotion,
    paused,
    onSelect,
}: {
    rows: FlowRow[];
    metric: RaceMetric;
    now: number | null;
    from: number | null;
    selectedId: string;
    reducedMotion: boolean;
    paused: boolean;
    onSelect: (id: string) => void;
}) {
    const order = useMemo(
        () => raceOrder(rows, (r) => r.theme.id, (r) => raceValue(r.flow, now, metric)),
        [rows, now, metric],
    );
    const max = useMemo(() => Math.max(1, ...order.map((r) => Math.abs(r.value))), [order]);
    const firstOut = order.findIndex((r) => r.side === 'out');

    // rank-move arrows and value flashes, keyed to the minute that caused them
    const prevRanks = useRef(new Map<string, number>());
    const prevValues = useRef(new Map<string, number>());
    const [moves, setMoves] = useState<{ at: number; map: Map<string, number>; flash: Set<string> }>({
        at: 0,
        map: new Map(),
        flash: new Set(),
    });
    useEffect(() => {
        const map = rankMoves(prevRanks.current, order);
        const flash = new Set<string>();
        for (const row of order) {
            const before = prevValues.current.get(row.id);
            if (before !== undefined && before !== row.value) flash.add(row.id);
        }
        prevRanks.current = new Map(order.map((r) => [r.id, r.rank]));
        prevValues.current = new Map(order.map((r) => [r.id, r.value]));
        if (flash.size > 0 || [...map.values()].some((m) => m !== 0)) setMoves({ at: Date.now(), map, flash });
    }, [order]);
    const [, setTick] = useState(0);
    useEffect(() => {
        if (moves.at === 0) return;
        const timer = setTimeout(() => setTick((n) => n + 1), MOVE_SHOW_MS);
        return () => clearTimeout(timer);
    }, [moves.at]);
    const showMoves = Date.now() - moves.at < MOVE_SHOW_MS;

    // KPI strip
    const sum = order.reduce((a, r) => a + r.value, 0);
    const top = order[0];
    const bottom = order[order.length - 1];

    // particles: one canvas over the bars, reading each bar's live rect so
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
        const up = cssColor(area, vars.color.up);
        const down = cssColor(area, vars.color.down);
        const frame = (t: number) => {
            const dt = Math.min(0.1, (t - last) / 1000);
            last = t;
            const box = area.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            const w = Math.round(box.width * dpr);
            const h = Math.round(area.scrollHeight * dpr);
            if (canvas.width !== w) canvas.width = w;
            if (canvas.height !== h) canvas.height = h;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, box.width, area.scrollHeight);
            for (const bar of area.querySelectorAll<HTMLElement>('[data-bar]')) {
                const id = bar.dataset.bar!;
                const r = bar.getBoundingClientRect();
                const len = r.width;
                if (len < 6) continue;
                const k = intensity.get(id) ?? 0;
                const want = Math.round(2 + 9 * k * Math.min(1, len / 120));
                let list = particles.current.get(id);
                if (!list) {
                    list = [];
                    particles.current.set(id, list);
                }
                while (list.length < want) list.push({ phase: Math.random(), speed: 0.25 + Math.random() * 0.35, size: 0.8 + Math.random() * 0.9 });
                list.length = want;
                const out = bar.dataset.side === 'out';
                const y0 = r.top - box.top + area.scrollTop + r.height / 2;
                const x0 = out ? r.right - box.left : r.left - box.left;
                ctx.fillStyle = out ? down : up;
                for (const p of list) {
                    p.phase = (p.phase + dt * p.speed * (0.6 + 1.4 * k)) % 1;
                    const x = out ? x0 - p.phase * len : x0 + p.phase * len;
                    ctx.globalAlpha = 0.25 + 0.65 * p.phase;
                    ctx.beginPath();
                    ctx.arc(x, y0 + Math.sin((p.phase + p.speed) * 12) * 2.2, p.size, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
            ctx.globalAlpha = 1;
            raf = requestAnimationFrame(frame);
        };
        raf = requestAnimationFrame(frame);
        return () => cancelAnimationFrame(raf);
    }, [reducedMotion, paused, now, intensity]);

    const clock = now !== null ? slotLabel(Math.min(now + 1, SESSION_SLOTS - 1)) : '--:--';
    const height = order.length * ROW_PX + (firstOut > 0 ? GAP_PX : 0);

    return (
        <div className={s.race}>
            <div className={s.kpis}>
                <span className={s.kpi}>
                    <span className={s.kpiLabel}>{metric === 'cum' ? `族群合計・${from !== null ? `${slotLabel(from)} 起` : '開啟至今'}` : '族群合計・近 5 分'}</span>
                    <span className={`${s.kpiValue} ${panel.dirText[dir(now !== null ? sum : null)]}`}>{now !== null ? fmtTwd(sum, true) : '--'}</span>
                </span>
                <span className={s.kpi}>
                    <span className={s.kpiLabel}>吸金最多</span>
                    <span className={s.kpiName}>{top && top.value > 0 ? top.item.theme.name : '--'}</span>
                    <span className={`${s.kpiSub} ${panel.dirText.up}`}>{top && top.value > 0 ? fmtTwd(top.value, true) : ''}</span>
                </span>
                <span className={s.kpi}>
                    <span className={s.kpiLabel}>失血最多</span>
                    <span className={s.kpiName}>{bottom && bottom.value < 0 ? bottom.item.theme.name : '--'}</span>
                    <span className={`${s.kpiSub} ${panel.dirText.down}`}>{bottom && bottom.value < 0 ? fmtTwd(bottom.value, true) : ''}</span>
                </span>
                <span className={s.spacer} />
                <span className={s.clock} aria-live='off'>
                    {clock}
                </span>
            </div>
            <div className={s.raceArea} ref={areaRef}>
                <canvas ref={canvasRef} className={s.raceCanvas} aria-hidden='true' />
                <div className={s.raceRows} style={{ height }} role='list'>
                    <span className={s.raceZero} aria-hidden='true' />
                    {order.map((row) => {
                        const y = row.rank * ROW_PX + (row.side === 'out' && firstOut > 0 ? GAP_PX : 0);
                        const width = now !== null ? (Math.abs(row.value) / max) * 50 : 0;
                        const move = showMoves ? (moves.map.get(row.id) ?? 0) : 0;
                        const flash = showMoves && moves.flash.has(row.id);
                        const selected = row.id === selectedId;
                        const f = row.item.flow;
                        return (
                            <div
                                key={row.id}
                                role='listitem'
                                className={`${s.raceRow[selected ? 'on' : 'off']} ${reducedMotion ? s.still : ''}`}
                                style={{ transform: `translateY(${y}px)` }}
                                onClick={() => onSelect(row.id)}
                                title={`${row.item.theme.name}・${row.item.codes.length} 檔\n${metric === 'cum' ? '累積' : '近 5 分'}淨流入 ${fmtTwd(row.value, true)}\n成交值 ${fmtTwd(f.total)}・漲跌 ${fmtSignedPct(f.pct)}`}
                            >
                                {flash && !reducedMotion && <span key={moves.at} className={s.raceFlash[row.side]} aria-hidden='true' />}
                                <span className={s.raceName}>
                                    <span className={s.kindMark[row.item.theme.kind === 'chain' ? 'chain' : 'theme']} aria-hidden='true' />
                                    <span className={s.nameText}>{row.item.theme.name}</span>
                                    {move > 0 && <ArrowUp size={10} className={panel.dirText.up} aria-label={`上升 ${move} 名`} />}
                                    {move < 0 && <ArrowDown size={10} className={panel.dirText.down} aria-label={`下降 ${-move} 名`} />}
                                </span>
                                <span className={s.raceTrack}>
                                    <span
                                        data-bar={row.id}
                                        data-side={row.side}
                                        className={`${s.raceBar[row.side]} ${reducedMotion ? s.still : ''}`}
                                        style={row.side === 'in' ? { left: '50%', width: `${width}%` } : { right: '50%', width: `${width}%` }}
                                    >
                                        {width > 0.5 && <span className={s.raceHead[row.side]} />}
                                    </span>
                                </span>
                                <span className={`${s.raceValue} ${panel.dirText[dir(now !== null ? row.value : null)]}`}>
                                    {now !== null ? fmtTwd(row.value, true) : '--'}
                                </span>
                                <span className={`${s.racePct} ${panel.dirText[dir(f.pct)]}`}>{fmtSignedPct(f.pct)}</span>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
