// src/components/chain-rank-card.tsx：detail card beside the 金流 view for
// the selected group: rotation state, change, turnover, net inflow over the
// ranking window (rolling digits), the cumulative net-inflow line since the
// panel started receiving bars (window shaded, glowing end), and every member
// with its net inflow over the window, sortable.

import { X } from 'lucide-react';
import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { chainFlowBook } from '../lib/chain-flow-feed';
import { codePct, memberFlows, sessionTurnover, slotLabel } from '../lib/chain-flow';
import { fmtSignedPct, fmtTwd } from '../lib/chain-map';
import { metricMinutes, QUADRANT_LABEL, quadrantOf, rankValue, rotationPoint, type RankMetric } from '../lib/chain-motion';
import { HeatList, type ListCol, type ListStep, type Tile } from './chain-heat';
import { dir, markKind, type FlowRow } from './chain-ui';
import { Odometer } from './odometer';
import * as panel from './panel.css';
import * as s from './chain-map.css';

const W = 240;
const H = 72;
// the card is too narrow for codes or 成交值; its point is each member's net inflow
const CARD_COLUMNS: readonly ListCol[] = ['pct', 'net'];
const CARD_STEPS: readonly ListStep[] = ['slim'];

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
    focus = null,
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
    /** The stock the panel follows: marked in the list. */
    focus?: string | null;
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

    // every member; memberFlows only has the ones with a bar in the window
    const members = useMemo<Tile[]>(() => {
        const inWindow = new Map(memberFlows(chainFlowBook, row.codes, metricMinutes(metric), now).map((m) => [m.code, m]));
        return row.codes.flatMap((code) => {
            const flow = chainFlowBook.codes.get(code);
            if (!flow) return [];
            const m = inWindow.get(code);
            const net = m?.net ?? 0;
            const turnover = m?.turnover ?? 0;
            return [
                {
                    id: code,
                    name: nameOf(code),
                    sub: code,
                    code,
                    cell: { net, turnover, ratio: null, minutes: [], amounts: [] },
                    pct: codePct(flow),
                    order: sessionTurnover(flow),
                },
            ];
        });
    }, [row, metric, now, nameOf]);

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
                <span className={s.kindMark[markKind(row.theme.kind)]} aria-hidden='true' />
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
            <div className={s.cardMembers}>
                <HeatList
                    tiles={members}
                    now={now}
                    netTitle={`${metricLabel(metric)}淨流入（估算）`}
                    nameLabel='個股'
                    columns={CARD_COLUMNS}
                    steps={CARD_STEPS}
                    selectedId={focus}
                    scope={row.theme.id}
                    sortKey='sj-pro-chainmap-card-sort'
                    label={`${row.theme.name}成分股`}
                    onClick={onPick}
                />
            </div>
        </aside>
    );
}

const TOP_PAD = 6;
