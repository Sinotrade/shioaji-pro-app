// src/components/portfolio-lanes.tsx — 持股「資金通道」: one lane per held group.
//
// The lanes are drawn by the same river engine as 排行 (chain-river.tsx):
// a soft translucent band growing from the dashed centre axis, a glowing
// head at its leading edge, fine particles streaming toward the head, and
// rows gliding (translateY) to their new place when a minute bar lands.
// Here the band's length is the group's net inflow over the chosen window
// (近 5 分／近 10 分／累計) and its thickness is my weight in the group
// (lib/portfolio-lanes-layout.ts). Under each band: my stocks in the group
// as chips; right: 淨流入, 權重, 今日損益. A group whose flow flipped this
// minute flashes a single amber ring. Static under reduced motion; the loop
// stops while the panel is hidden or off screen.

import { BellRing, Clock3 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { slotLabel } from '../lib/chain-flow';
import { fmtSignedPct, fmtTwd } from '../lib/chain-map';
import { TIER_LABEL } from '../lib/company-data/queries';
import { BAND_LINE_PX, layoutLanes } from '../lib/portfolio-lanes-layout';
import { GROUPING_LABEL, othersNote, type HeldGroup } from '../lib/portfolio-sector';
import { maskMoney } from '../lib/privacy';
import { useRiver } from './chain-river';
import { dir, useBoxSize } from './chain-ui';
import { Odometer } from './odometer';
import type { VariantProps } from './portfolio-types';
import * as s from './portfolio-lanes.css';

type Win = '5' | '10' | 'cum';
const WINDOWS: { value: Win; label: string }[] = [
    { value: '5', label: '近 5 分' },
    { value: '10', label: '近 10 分' },
    { value: 'cum', label: '累計' },
];
const NARROW_PX = 1000;

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

    const rows = useMemo(
        () =>
            view.groups.map((g) => {
                const w = windowOf(g, now, win);
                return { id: g.id, g, net: w.net, turnover: w.turnover, weight: g.weight };
            }),
        [view.groups, now, win],
    );
    const maxStock = useMemo(() => Math.max(0, ...view.stocks.map((x) => x.weight)), [view.stocks]);
    const layout = useMemo(
        () => layoutLanes(rows, { live: now !== null, rowPx: BAND_LINE_PX, selected: selectedGroup }),
        [rows, now, selectedGroup],
    );

    // columns follow the panel width
    const cols = narrow ? 'minmax(78px, 112px) minmax(0, 1fr) 64px 42px 78px' : 'minmax(100px, 156px) minmax(0, 1fr) 78px 50px 96px';
    const gap = narrow ? 8 : 12;
    const trackPx = Math.max(80, size.width - (narrow ? 112 + 64 + 42 + 78 + 4 * 8 : 156 + 78 + 50 + 96 + 4 * 12) - 48);

    // the river: DOM rows for text and chips, one canvas for bands, heads and particles
    const stageRef = useRef<HTMLDivElement | null>(null);
    const areaRef = useRef<HTMLDivElement | null>(null);
    const rowsRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const rowEls = useRef(new Map<string, HTMLElement>());
    useRiver({ lanes: layout.lanes, stageRef, areaRef, rowsRef, canvasRef, rowEls, reducedMotion, active: !paused && now !== null });

    const label = GROUPING_LABEL[grouping];
    const winLabel = WINDOWS.find((w) => w.value === win)!.label;
    const span = win === 'cum' && now !== null && from !== null ? `${slotLabel(from)} 起` : winLabel;

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
            <div className={s.stage} ref={stageRef}>
                <canvas ref={canvasRef} className={s.canvas} aria-hidden='true' />
                <div className={s.area} ref={areaRef}>
                    <div className={s.rows} ref={rowsRef} style={{ height: layout.height }} role='list' aria-label={`持有${label}依${winLabel}淨流入排序`}>
                        {layout.divider !== null && (
                            <span className={s.divider} style={{ transform: `translateY(${layout.divider}px)` }} aria-hidden='true' />
                        )}
                        {layout.rows.map((r) => {
                            const g = r.g;
                            const side = r.net >= 0 ? 'in' : 'out';
                            const selected = selectedGroup === g.id;
                            const state = selectedGroup === null ? 'plain' : selected ? 'on' : 'off';
                            const flip = flips.get(g.id);
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
                                // the river engine positions the row (translateY) every frame
                                <div
                                    key={g.id}
                                    ref={(el) => {
                                        if (el) rowEls.current.set(g.id, el);
                                        else rowEls.current.delete(g.id);
                                    }}
                                    role='listitem'
                                    className={s.row[state]}
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
                                    <span className={s.track} data-track='' aria-hidden='true' />
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
                                                    className={s.chipWeight}
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
