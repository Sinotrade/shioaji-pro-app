// src/components/chain-rank-card.tsx — detail card beside the 排行 view for
// the selected group: rotation state, change, turnover, net inflow over the
// ranking window (rolling digits), the cumulative net-inflow line since the
// panel started receiving bars (window shaded, glowing end), and the five
// largest net-inflow and net-outflow members over the window.

import { X } from 'lucide-react';
import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { chainFlowBook } from '../lib/chain-flow-feed';
import { memberFlows, slotLabel } from '../lib/chain-flow';
import { fmtSignedPct, fmtTwd } from '../lib/chain-map';
import { metricMinutes, QUADRANT_LABEL, quadrantOf, rankValue, rotationPoint, type RankMetric } from '../lib/chain-motion';
import { dir, type FlowRow } from './chain-ui';
import { Odometer } from './odometer';
import * as panel from './panel.css';
import * as s from './chain-map.css';

const W = 240;
const H = 72;
const TOP = 5;

export function metricLabel(metric: RankMetric): string {
    return metric === 'cum' ? '累計' : `近 ${metric} 分`;
}

export function FlowRankCard({
    row,
    metric,
    now,
    from,
    reducedMotion,
    paused,
    nameOf,
    onPick,
    onClose,
    id,
}: {
    row: FlowRow;
    metric: RankMetric;
    now: number | null;
    from: number | null;
    reducedMotion: boolean;
    paused: boolean;
    nameOf: (code: string) => string;
    onPick: (code: string) => void;
    /**
     * Shown as a drawer over the lanes (narrow panel): a close button, focus
     * moves into the drawer when it opens and Escape closes it.
     */
    onClose?: () => void;
    /** Element id (the drawer toggle's aria-controls). */
    id?: string;
}) {
    const drawer = onClose !== undefined;
    const rootRef = useRef<HTMLElement | null>(null);
    useEffect(() => {
        if (drawer) rootRef.current?.focus();
    }, [drawer]);
    const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
        if (onClose && e.key === 'Escape') {
            e.stopPropagation();
            onClose();
        }
    };
    const f = row.flow;
    const value = rankValue(f, now, metric);
    const point = now !== null ? rotationPoint(f, now) : null;
    const state = point ? quadrantOf(point.x, point.y) : null;

    const members = useMemo(() => memberFlows(chainFlowBook, row.codes, metricMinutes(metric), now), [row, metric, now]);
    const ins = members.filter((m) => m.net > 0).sort((a, b) => b.net - a.net).slice(0, TOP);
    const outs = members.filter((m) => m.net < 0).sort((a, b) => a.net - b.net).slice(0, TOP);

    // cumulative net since the first observed bar
    const chart = useMemo(() => {
        if (now === null || from === null || now <= from) return null;
        const base = from > 0 ? f.cumNet[from - 1]! : 0;
        const values: number[] = [];
        for (let i = from; i <= now; i += 1) values.push(f.cumNet[i]! - base);
        let lo = Math.min(0, ...values);
        let hi = Math.max(0, ...values);
        if (hi - lo < 1) {
            hi += 1;
            lo -= 1;
        }
        const x = (i: number) => (i / (values.length - 1)) * W;
        const y = (v: number) => TOP_PAD + (1 - (v - lo) / (hi - lo)) * (H - TOP_PAD * 2);
        const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
        const zero = y(0);
        const area = `${line}L${W},${zero.toFixed(1)}L0,${zero.toFixed(1)}Z`;
        const n = metricMinutes(metric);
        const shadeX = n === null ? null : x(Math.max(0, values.length - n));
        const last = values[values.length - 1]!;
        return { line, area, zero, shadeX, end: { x: 100, y: (y(last) / H) * 100 }, last };
    }, [f, from, now, metric]);

    const side = dir(chart ? chart.last : null);
    const live = !reducedMotion && !paused;

    return (
        <aside
            ref={rootRef}
            id={id}
            className={`${s.card} ${onClose ? s.cardDrawer : ''}`}
            aria-label={`${row.theme.name} 明細`}
            tabIndex={drawer ? -1 : undefined}
            onKeyDown={drawer ? onKeyDown : undefined}
        >
            <div className={s.cardHead}>
                <span className={s.kindMark[row.theme.kind === 'chain' ? 'chain' : 'theme']} aria-hidden='true' />
                <span className={s.cardTitle}>{row.theme.name}</span>
                {state && (
                    <span className={s.cardBadge[state]} title='輪動象限：依累計淨流入方向與資金動能'>
                        {QUADRANT_LABEL[state]}
                    </span>
                )}
                {onClose && (
                    <button type='button' className={s.cardClose} onClick={onClose} aria-label='關閉明細' title='關閉明細'>
                        <X size={13} aria-hidden='true' />
                    </button>
                )}
            </div>
            <div className={s.cardStats}>
                <span className={s.cardStat}>
                    <span className={s.kpiLabel}>漲跌</span>
                    <span className={`${s.cardStatValue} ${panel.dirText[dir(f.pct)]}`}>{fmtSignedPct(f.pct)}</span>
                </span>
                <span className={s.cardStat}>
                    <span className={s.kpiLabel}>今日成交值</span>
                    <span className={s.cardStatValue}>{fmtTwd(f.total)}</span>
                </span>
                <span className={s.cardStat}>
                    <span className={s.kpiLabel}>成分股</span>
                    <span className={s.cardStatValue}>{row.codes.length} 檔</span>
                </span>
            </div>
            <div className={s.cardFlow}>
                <span className={s.kpiLabel}>{metricLabel(metric)}淨流入</span>
                <Odometer
                    className={`${s.cardFlowValue} ${panel.dirText[dir(now !== null ? value : null)]}`}
                    text={now !== null ? fmtTwd(value, true) : '--'}
                    reducedMotion={reducedMotion}
                />
            </div>
            <div className={s.cardChart}>
                {chart ? (
                    <>
                        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio='none' className={s.cardSvg} aria-hidden='true'>
                            {chart.shadeX !== null && <rect className={s.cardShade} x={chart.shadeX} y={0} width={W - chart.shadeX} height={H} />}
                            <line className={s.cardZero} x1={0} x2={W} y1={chart.zero} y2={chart.zero} vectorEffect='non-scaling-stroke' />
                            <path className={s.cardArea[side === 'down' ? 'down' : 'up']} d={chart.area} />
                            <path className={s.cardLine[side === 'down' ? 'down' : 'up']} d={chart.line} vectorEffect='non-scaling-stroke' />
                        </svg>
                        <span
                            className={`${s.cardEnd[side === 'down' ? 'down' : 'up']} ${live ? '' : s.still}`}
                            style={{ left: `${chart.end.x}%`, top: `${chart.end.y}%` }}
                            aria-hidden='true'
                        />
                    </>
                ) : (
                    <span className={s.cardEmpty}>收到兩根 1 分 K 後顯示走勢</span>
                )}
            </div>
            <div className={s.cardCaption}>
                累計淨流入走勢{from !== null ? `・${slotLabel(from)} 起` : ''}
                {metric !== 'cum' ? `・陰影為${metricLabel(metric)}` : ''}
            </div>
            <MemberList title={`${metricLabel(metric)}淨流入前 ${TOP}`} rows={ins} nameOf={nameOf} onPick={onPick} />
            <MemberList title={`${metricLabel(metric)}淨流出前 ${TOP}`} rows={outs} nameOf={nameOf} onPick={onPick} />
        </aside>
    );
}

const TOP_PAD = 6;

function MemberList({
    title,
    rows,
    nameOf,
    onPick,
}: {
    title: string;
    rows: { code: string; net: number; pct: number | null }[];
    nameOf: (code: string) => string;
    onPick: (code: string) => void;
}) {
    return (
        <div className={s.cardList}>
            <div className={s.cardListTitle}>{title}</div>
            {rows.length === 0 ? (
                <div className={s.cardEmpty}>無</div>
            ) : (
                rows.map((m) => (
                    <button
                        key={m.code}
                        type='button'
                        className={s.cardMember}
                        onClick={() => onPick(m.code)}
                        aria-label={`${nameOf(m.code)} ${m.code}，淨流入 ${fmtTwd(m.net, true)}，漲跌 ${fmtSignedPct(m.pct)}`}
                    >
                        <span className={s.cardMemberName}>{nameOf(m.code)}</span>
                        <span className={s.cardMemberCode}>{m.code}</span>
                        <span className={`${s.cardMemberPct} ${panel.dirText[dir(m.pct)]}`}>{fmtSignedPct(m.pct)}</span>
                        <span className={`${s.cardMemberNet} ${panel.dirText[dir(m.net)]}`}>{fmtTwd(m.net, true)}</span>
                    </button>
                ))
            )}
        </div>
    );
}
