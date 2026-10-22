// src/components/portfolio-bubbles.tsx — 持股泡泡 (grouped): every held group
// is a large translucent circle, my holdings are packed inside it.
//
// Group circle: x = the group's 近 10 分淨流入占成交值, y = the group's
// change today (market-cap weighted over all its members — the circle is
// the market's group; my own stocks speak through the members' colours).
// Rim colour = the group's flow direction, label on the rim: name, my
// weight, flow share. Members: size = market value (√, one scale for the
// whole chart, d3 packSiblings), colour = the stock's change today.
// Each minute the group circles glide on a spring and members re-pack on a
// spring inside them; groups never overlap (collision relax with room for
// the label). Theme mode uses each stock's primary theme only, so weights
// add up to 100 % and nothing is counted twice.

import { domAnimation, LazyMotion, m } from 'motion/react';
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { fmtSignedPct, fmtTwd } from '../lib/chain-map';
import { relaxCircles } from '../lib/chain-motion';
import { packGroup, packScale, placeLabels, type PackedMember } from '../lib/portfolio-pack';
import { GROUPING_LABEL, othersNote, type HeldGroup } from '../lib/portfolio-sector';
import { maskMoney } from '../lib/privacy';
import { dir, useBoxSize } from './chain-ui';
import type { VariantProps } from './portfolio-types';
import * as s from './portfolio-bubbles.css';

const PAD = { left: 48, right: 18, top: 34, bottom: 38 };
/** Plot width that fits the 漲跌 caption and the circle legend on one line. */
const LEGEND_MIN_PLOT_W = 740;
const SPRING = { type: 'spring', stiffness: 60, damping: 17, mass: 1 } as const;
const PACK_SPRING = { type: 'spring', stiffness: 80, damping: 18, mass: 1 } as const;
const STILL = { duration: 0 } as const;
/** Room kept around a group circle for its rim label when relaxing. */
const LABEL_ROOM = 16;
/** |net ÷ turnover| (%) from which a group's rim glows like a river head. */
const STRONG_FLOW = 20;

interface Bubble {
    group: HeldGroup;
    x: number;
    y: number;
    members: PackedMember[];
    R: number;
}

function textWidth(text: string, latin = 5.8) {
    let w = 0;
    for (const ch of text) w += ch.charCodeAt(0) > 0x2e80 ? 10 : latin;
    return w;
}

function fitName(name: string, room: number) {
    if (textWidth(name) <= room) return name;
    let out = '';
    for (const ch of name) {
        if (textWidth(`${out}${ch}…`) > room) break;
        out += ch;
    }
    return out.length >= 2 ? `${out}…` : null;
}

const labelName = (name: string) => (name.length > 8 ? `${name.slice(0, 8)}…` : name);

function niceCeil(value: number) {
    if (value <= 0) return 1;
    const p = 10 ** Math.floor(Math.log10(value));
    const q = value / p;
    return (q <= 1 ? 1 : q <= 1.5 ? 1.5 : q <= 2 ? 2 : q <= 3 ? 3 : q <= 4 ? 4 : q <= 5 ? 5 : q <= 6 ? 6 : q <= 8 ? 8 : 10) * p;
}

/** Extent that only grows during a session; shrinks once the data fits a third. */
function useRatchet(value: number, key: string) {
    const ref = useRef({ key, value });
    if (ref.current.key !== key || value > ref.current.value || value < ref.current.value / 3) ref.current = { key, value };
    return ref.current.value;
}

export function HoldingBubbles(props: VariantProps) {
    const { view, grouping, now, session, flips, privacyMoney, reducedMotion, paused, selectedGroup, onSelectGroup, onPick } = props;
    const { ref, size } = useBoxSize<HTMLDivElement>();
    const [hoverGroup, setHoverGroup] = useState<string | null>(null);
    const focusGroup = hoverGroup ?? selectedGroup;
    const gLabel = GROUPING_LABEL[grouping];

    const groups = view.groups.filter((g) => g.id !== 'none' && g.stocks.length > 0);
    const ungrouped = view.groups.find((g) => g.id === 'none');
    const stockOf = new Map(view.stocks.map((st) => [st.code, st]));

    const gx = (g: HeldGroup) => g.recent.ratio ?? 0;
    const gy = (g: HeldGroup) => g.flow.pct ?? 0;
    const rawX = niceCeil(Math.max(10, ...groups.map((g) => Math.abs(gx(g)) * 1.2)));
    const rawY = niceCeil(Math.max(1, ...groups.map((g) => Math.abs(gy(g)) * 1.25)));
    const extentX = useRatchet(rawX, `${session}:${grouping}:x`);
    const extentY = useRatchet(rawY, `${session}:${grouping}:y`);

    const w = size.width;
    const h = size.height;
    const plotW = Math.max(0, w - PAD.left - PAD.right);
    const plotH = Math.max(0, h - PAD.top - PAD.bottom);
    const cx = PAD.left + plotW / 2;
    const cy = PAD.top + plotH / 2;
    const px = (v: number) => cx + (Math.max(-1, Math.min(1, v / extentX)) * plotW) / 2;
    const py = (v: number) => cy - (Math.max(-1, Math.min(1, v / extentY)) * plotH) / 2;
    const box = { x0: PAD.left, x1: PAD.left + plotW, y0: PAD.top, y1: PAD.top + plotH };

    // one √-scale for every member: the biggest group fits about a quarter of
    // the short side, and all group circles together take about 30 % of the plot
    // geometry depends on the data and the box only: hover and selection
    // re-renders reuse it (packing + 140 relax iterations)
    const bubbles = useMemo(() => {
        const out: Bubble[] = [];
        if (plotW <= 0 || plotH <= 0 || groups.length === 0) return out;
        const items = groups.map((g) => g.stocks.map((st) => ({ code: st.code, value: st.value })));
        const scale = packScale(items, plotW, plotH);
        const packed = groups.map((g, i) => ({ group: g, ...packGroup(items[i]!, scale) }));
        const sorted = [...packed].sort((a, b) => (a.group.id < b.group.id ? -1 : 1));
        const circles = sorted.map((p) => ({ x: px(gx(p.group)), y: py(gy(p.group)), r: p.R + LABEL_ROOM }));
        const relaxed = relaxCircles(circles, box, { overlap: 0, maxShift: 3, iterations: 140 });
        sorted.forEach((p, i) => out.push({ ...p, x: relaxed[i]!.x, y: relaxed[i]!.y }));
        return out;
        // px/py/box/groups derive from these
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [view, plotW, plotH, extentX, extentY]);
    const labelPlaces = useMemo(
        () =>
            placeLabels(
                bubbles.map((b) => ({ id: b.group.id, x: b.x, y: b.y, R: b.R, w: textWidth(labelName(b.group.name), 6.5) + 64 })),
                { top: PAD.top, bottom: PAD.top + plotH, left: 0, right: w },
            ),
        [bubbles, plotH, w],
    );
    // big circles first so small ones stay on top and clickable
    const ordered = [...bubbles].sort((a, b) => b.R - a.R);

    const fmtTick = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v) >= 10 ? Math.abs(v).toFixed(0) : Math.abs(v).toFixed(1)}%`;

    return (
        <div className={s.root} ref={ref}>
            {w > 0 && h > 0 && (
                <svg className={s.svg} width={w} height={h} viewBox={`0 0 ${w} ${h}`} role='img' aria-label={`持股依${gLabel}分組：${gLabel}資金與漲跌`}>
                    {[-extentX / 2, extentX / 2].map((v) => (
                        <g key={`x${v}`}>
                            <line className={s.grid} x1={px(v)} x2={px(v)} y1={PAD.top} y2={PAD.top + plotH} />
                            <text className={s.tick} x={px(v)} y={PAD.top + plotH + 13} textAnchor='middle'>
                                {fmtTick(v)}
                            </text>
                        </g>
                    ))}
                    {[-extentY / 2, extentY / 2].map((v) => (
                        <g key={`y${v}`}>
                            <line className={s.grid} x1={PAD.left} x2={PAD.left + plotW} y1={py(v)} y2={py(v)} />
                            <text className={s.tick} x={PAD.left - 4} y={py(v) + 3} textAnchor='end'>
                                {fmtTick(v)}
                            </text>
                        </g>
                    ))}
                    <line className={s.axis} x1={PAD.left} x2={PAD.left + plotW} y1={cy} y2={cy} />
                    <line className={s.axis} x1={cx} x2={cx} y1={PAD.top} y2={PAD.top + plotH} />
                    <text className={s.tick} x={PAD.left - 4} y={cy + 3} textAnchor='end'>
                        0
                    </text>
                    <text className={s.caption} x={PAD.left + plotW} y={PAD.top + plotH + 29} textAnchor='end'>
                        {gLabel}資金：近 10 分淨流入占成交值 →
                    </text>
                    <text className={s.caption} x={PAD.left} y={PAD.top - 14}>
                        ↑ {gLabel}今日漲跌（{grouping === 'sector' ? '產業指標加權' : '市值加權'}）
                    </text>
                    {/* same line as the 漲跌 caption: only when both fit (a ~600px panel would overlap them) */}
                    {plotW >= LEGEND_MIN_PLOT_W && (
                        <text className={s.cornerSoft} x={PAD.left + plotW} y={PAD.top - 14} textAnchor='end' style={{ opacity: 0.85 }}>
                            外圓為{gLabel}（權重・近 10 分淨流入占成交值），內圓為持股，大小為市值、顏色為今日漲跌
                        </text>
                    )}
                    {(
                        [
                            ['流入・上漲', PAD.left + plotW - 8, PAD.top + 14, 'end'],
                            ['流入・下跌', PAD.left + plotW - 8, PAD.top + plotH - 8, 'end'],
                            ['流出・上漲', PAD.left + 8, PAD.top + 14, 'start'],
                            ['流出・下跌', PAD.left + 8, PAD.top + plotH - 8, 'start'],
                        ] as const
                    ).map(([label, x, y, anchor]) => (
                        <text key={label} className={s.cornerSoft} x={x} y={y} textAnchor={anchor}>
                            {label}
                        </text>
                    ))}

                    <LazyMotion features={domAnimation} strict>
                        {ordered.map((b) => {
                            const g = b.group;
                            const flowDir = dir(g.recent.net);
                            const dim = focusGroup !== null && focusGroup !== g.id;
                            const flip = flips.get(g.id);
                            const selected = selectedGroup === g.id;
                            return (
                                <m.g
                                    key={g.id}
                                    initial={false}
                                    animate={{ x: b.x, y: b.y, opacity: dim ? 0.28 : 1 }}
                                    transition={reducedMotion ? STILL : { ...SPRING, opacity: { duration: 0.3 } }}
                                >
                                    <g
                                        className={s.sector}
                                        role='button'
                                        tabIndex={0}
                                        aria-label={`${g.name} 權重 ${Math.round(g.weight * 100)}% 近 10 分淨流入占成交值 ${fmtSignedPct(g.recent.ratio, 1)}`}
                                        onClick={() => onSelectGroup(selected ? null : g.id)}
                                        onKeyDown={(e: KeyboardEvent<SVGGElement>) => {
                                            if (e.key === 'Enter' || e.key === ' ') {
                                                e.preventDefault();
                                                onSelectGroup(selected ? null : g.id);
                                            }
                                        }}
                                        onMouseEnter={() => setHoverGroup(g.id)}
                                        onMouseLeave={() => setHoverGroup(null)}
                                    >
                                        <title>{`${g.name}・持有 ${g.stocks.length} 檔・權重 ${Math.round(g.weight * 100)}%\n近 10 分淨流入 ${fmtTwd(g.recent.net, true)}（占成交值 ${fmtSignedPct(g.recent.ratio, 1)}）\n${gLabel}漲跌 ${fmtSignedPct(g.flow.pct)}・今日持股損益 ${maskMoney(fmtTwd(g.dayPnl, true), privacyMoney)}`}</title>
                                        {flip && !reducedMotion && !paused && <circle key={`pulse-${now}`} className={s.pulse} r={b.R} />}
                                        <circle className={`${s.sectorRim[flowDir]} ${Math.abs(g.recent.ratio ?? 0) >= STRONG_FLOW ? s.sectorGlow[flowDir] : ''}`} r={b.R} />
                                        {selected && <circle className={s.sectorSelected} r={b.R + 3} />}
                                    </g>
                                    {b.members.map((mb) => {
                                        const st = stockOf.get(mb.code);
                                        if (!st) return null;
                                        const tone = dir(st.dayPct);
                                        const depth = 0.34 + 0.5 * Math.min(1, Math.abs(st.dayPct ?? 0) / 4) ** 0.6;
                                        const font = Math.max(8, Math.min(12, mb.r * 0.38));
                                        const room = 2 * Math.sqrt(Math.max(0, mb.r * mb.r - font * font)) - 3;
                                        const name = mb.r >= 12 ? fitName(st.name, (room * 9.5) / font) : null;
                                        const withValue = name !== null && mb.r >= 19;
                                        return (
                                            <m.g
                                                key={mb.code}
                                                className={s.member}
                                                initial={false}
                                                animate={{ x: mb.dx, y: mb.dy }}
                                                transition={reducedMotion ? STILL : PACK_SPRING}
                                                role='button'
                                                tabIndex={0}
                                                aria-label={`${st.name} 今日 ${fmtSignedPct(st.dayPct)}`}
                                                onClick={() => onPick(st.code)}
                                                onKeyDown={(e: KeyboardEvent<SVGGElement>) => {
                                                    if (e.key === 'Enter' || e.key === ' ') {
                                                        e.preventDefault();
                                                        onPick(st.code);
                                                    }
                                                }}
                                                onMouseEnter={() => setHoverGroup(g.id)}
                                                onMouseLeave={() => setHoverGroup(null)}
                                            >
                                                <title>{`${st.name} ${st.code}・${g.name}\n今日 ${fmtSignedPct(st.dayPct)}・損益 ${maskMoney(fmtTwd(st.dayPnl, true), privacyMoney)}\n市值 ${maskMoney(fmtTwd(st.value), privacyMoney)}・權重 ${(st.weight * 100).toFixed(1)}%${othersNote(st.others, gLabel)}`}</title>
                                                <circle className={s.fill[tone]} r={mb.r} style={{ fillOpacity: depth }} />
                                                {name && (
                                                    <>
                                                        <text className={s.nameIn} y={withValue ? -1 : font * 0.35} textAnchor='middle' style={{ fontSize: `${font}px` }}>
                                                            {name}
                                                        </text>
                                                        {withValue && (
                                                            <text className={s.valueIn} y={font} textAnchor='middle' style={{ fontSize: `${font * 0.86}px` }}>
                                                                {fmtSignedPct(st.dayPct, 1)}
                                                            </text>
                                                        )}
                                                    </>
                                                )}
                                            </m.g>
                                        );
                                    })}
                                </m.g>
                            );
                        })}
                        {/* rim labels on a layer above every circle, riding the same spring */}
                        {ordered.map((b) => {
                            const g = b.group;
                            const dim = focusGroup !== null && focusGroup !== g.id;
                            const name = labelName(g.name);
                            const place = labelPlaces.get(g.id) ?? { dx: 0, dy: -b.R - 6 };
                            const flowDir = dir(g.recent.net);
                            return (
                                <m.g
                                    key={`label-${g.id}`}
                                    className={s.sectorLabel}
                                    initial={false}
                                    animate={{ x: b.x, y: b.y, opacity: dim ? 0.3 : 1 }}
                                    transition={reducedMotion ? STILL : { ...SPRING, opacity: { duration: 0.3 } }}
                                    aria-hidden='true'
                                >
                                    <text x={place.dx} y={place.dy} textAnchor='middle'>
                                        <tspan className={s.sectorName}>{name}</tspan>
                                        <tspan className={s.sectorMeta} dx={5}>
                                            {Math.round(g.weight * 100)}%
                                        </tspan>
                                        <tspan className={s.sectorFlow[flowDir]} dx={5}>
                                            {fmtSignedPct(g.recent.ratio, 0)}
                                        </tspan>
                                    </text>
                                </m.g>
                            );
                        })}
                    </LazyMotion>
                </svg>
            )}
            {ungrouped && ungrouped.stocks.length > 0 && (
                <div className={s.side} title={`沒有${gLabel}分類的持股（例如 ETF），只列出不畫入圖中`}>
                    <span>未歸類</span>
                    {ungrouped.stocks.map((st) => (
                        <button key={st.code} type='button' className={s.sideRow} onClick={() => onPick(st.code)}>
                            <span className={s.sideName}>{st.name}</span>
                            <span className={`${s.sideNum} ${s.toneText[dir(st.dayPct)]}`}>{fmtSignedPct(st.dayPct)}</span>
                        </button>
                    ))}
                </div>
            )}
            {now === null && groups.length > 0 && (
                <div className={s.empty}>收到第一根 1 分 K 起，{gLabel}圓依近 10 分鐘資金移動；目前依開盤至今彙總放置</div>
            )}
        </div>
    );
}
