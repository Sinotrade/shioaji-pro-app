// src/components/chain-detail.tsx — 鏈內流向 (upstream → midstream →
// downstream cards) and the focused-stock card of 產業鏈資金流向.

import { ArrowDownRight, ArrowUpRight, ChevronRight, CircleDot, Handshake, Swords, X } from 'lucide-react';
import { useMemo } from 'react';
import {
    codePct,
    leaders,
    sessionTurnover,
    WINDOW,
    type GroupFlow,
} from '../lib/chain-flow';
import { chainFlowBook } from '../lib/chain-flow-feed';
import { fmtSignedPct, fmtTwd } from '../lib/chain-map';
import { relationsFor, tierLabel, twCodeOf, type RelationHit, type RelationKind } from '../lib/company-data';
import type { ChainTier, Edge, Theme } from '../lib/company-data/types';
import { fmtPrice } from '../lib/utils/format';
import { vars } from '../theme.css';
import { cssColor, dir, useCanvas } from './chain-ui';
import * as panel from './panel.css';
import * as s from './chain-map.css';

/** Shortest span (minutes) the tier chart's x axis covers: the line grows from the left. */
export const TIER_SPAN = 15;
/** Fewer bars than this draw dots, not a line: two points scaled to the full height read as a spike. */
const TIER_MIN_LINE = 3;

/**
 * x domain of the tier chart: from the first received bar over at least
 * TIER_SPAN minutes, then the whole observed span.
 */
export function tierDomain(from: number, now: number, span = TIER_SPAN): { start: number; slots: number } {
    return { start: from, slots: Math.max(span, now - from + 1) };
}

/** Tier card chart: minute turnover (muted bars) and cumulative net inflow (line). */
function TierChart({
    flow,
    from,
    now,
    hover,
    themeKey,
    revision,
}: {
    flow: GroupFlow;
    from: number | null;
    now: number | null;
    hover: number | null;
    themeKey: string;
    revision: number;
}) {
    const ref = useCanvas(
        (ctx, w, h, el) => {
            const border = cssColor(el, vars.color.border);
            if (from === null || now === null) {
                ctx.strokeStyle = border;
                ctx.setLineDash([2, 3]);
                ctx.beginPath();
                ctx.moveTo(0, Math.round(h / 2) + 0.5);
                ctx.lineTo(w, Math.round(h / 2) + 0.5);
                ctx.stroke();
                return;
            }
            const { start, slots } = tierDomain(from, now);
            const step = w / slots;
            const sx = (slot: number) => ((slot - start + 0.5) / slots) * w;
            const count = now - from + 1;
            let maxT = 0;
            let minC = 0;
            let maxC = 0;
            for (let i = from; i <= now; i += 1) {
                maxT = Math.max(maxT, flow.turnover[i]!);
                minC = Math.min(minC, flow.cumNet[i]!);
                maxC = Math.max(maxC, flow.cumNet[i]!);
            }
            // minute turnover in the lower 40 %
            const barH = h * 0.4;
            ctx.fillStyle = cssColor(el, vars.color.mutedForeground);
            ctx.globalAlpha = 0.26;
            if (maxT > 0) {
                for (let i = from; i <= now; i += 1) {
                    const t = flow.turnover[i]!;
                    if (t <= 0) continue;
                    const len = Math.max(0.5, (t / maxT) * barH);
                    ctx.fillRect((i - start) * step, h - len, Math.max(1, step - 1), len);
                }
            }
            ctx.globalAlpha = 1;
            // cumulative net inflow over the full height
            const pad = 6;
            // a quiet group's few-thousand wobble must not fill the card
            const span = Math.max(maxC - minC, 1e6);
            if (maxC - minC < span) minC = (maxC + minC) / 2 - span / 2;
            const y = (v: number) => pad + (1 - (v - minC) / span) * (h - pad * 2);
            const zero = Math.round(y(0)) + 0.5;
            ctx.strokeStyle = border;
            ctx.setLineDash([2, 3]);
            ctx.beginPath();
            ctx.moveTo(0, zero);
            ctx.lineTo(w, zero);
            ctx.stroke();
            ctx.setLineDash([]);
            const last = flow.cumNet[now]!;
            const color = cssColor(el, last >= 0 ? vars.color.up : vars.color.down);
            if (count < TIER_MIN_LINE) {
                ctx.fillStyle = color;
                for (let i = from; i <= now; i += 1) {
                    ctx.beginPath();
                    ctx.arc(sx(i), y(flow.cumNet[i]!), 2.5, 0, Math.PI * 2);
                    ctx.fill();
                }
                return;
            }
            ctx.beginPath();
            for (let i = from; i <= now; i += 1) {
                const x = sx(i);
                if (i === from) ctx.moveTo(x, y(flow.cumNet[i]!));
                else ctx.lineTo(x, y(flow.cumNet[i]!));
            }
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.lineJoin = 'round';
            ctx.stroke();
            // soft fill back to the zero line
            ctx.lineTo(sx(now), zero);
            ctx.lineTo(sx(from), zero);
            ctx.closePath();
            ctx.globalAlpha = 0.1;
            ctx.fillStyle = color;
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(sx(now), y(last), 2.5, 0, Math.PI * 2);
            ctx.fill();
            if (hover !== null && hover >= start && hover < start + slots) {
                ctx.fillStyle = cssColor(el, vars.color.accent);
                ctx.fillRect(Math.round(sx(hover)), 0, 1, h);
            }
        },
        [flow, from, now, hover, themeKey, revision],
    );
    return <canvas ref={ref} className={s.tierCanvas} aria-hidden='true' />;
}

const RELATION_GROUPS: { kind: RelationKind; label: string; icon: typeof ArrowUpRight }[] = [
    { kind: 'supplier', label: '供應商', icon: ArrowDownRight },
    { kind: 'customer', label: '客戶', icon: ArrowUpRight },
    { kind: 'competitor', label: '競爭', icon: Swords },
    { kind: 'partner', label: '合作', icon: Handshake },
];
const RELATIONS_PER_GROUP = 5;

export interface TierView {
    tier: ChainTier;
    codes: string[];
    flow: GroupFlow;
}

export function TierCard({
    view,
    shift,
    last,
    from,
    now,
    hover,
    themeKey,
    revision,
    nameOf,
    stageOf,
    focus,
    onPick,
}: {
    view: TierView;
    shift: number;
    last: boolean;
    from: number | null;
    now: number | null;
    hover: number | null;
    themeKey: string;
    revision: number;
    nameOf: (code: string) => string;
    stageOf: Map<string, string>;
    focus: string | null;
    onPick: (code: string) => void;
}) {
    const { flow } = view;
    const live = now !== null;
    const top = useMemo(() => {
        if (live) return leaders(chainFlowBook, view.codes, 4, now);
        // before the first bar: largest session turnover so far
        return view.codes
            .map((code) => {
                const f = chainFlowBook.codes.get(code);
                return { code, flow5: 0, turnover5: f ? sessionTurnover(f) : 0, pct: codePct(f) };
            })
            .filter((row) => row.turnover5 > 0)
            .sort((a, b) => b.turnover5 - a.turnover5)
            .slice(0, 4);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [view, revision, now, live]);
    return (
        <div className={s.tierCard}>
            <div className={s.tierHead}>
                <span className={s.tierTag[view.tier === 'upstream' ? 'upstream' : view.tier === 'downstream' ? 'downstream' : 'midstream']}>
                    {tierLabel(view.tier)}
                </span>
                <span className={s.tierCount}>{view.codes.length} 檔</span>
                <span className={s.spacer} />
                {live && Math.abs(shift) >= 0.05 && (
                    <span
                        className={`${s.shift} ${panel.dirText[dir(shift)]}`}
                        title='近 15 分鐘成交值占全鏈比重，相對今日已接收 1 分 K 期間占比的變化（百分點）'
                    >
                        {shift > 0 ? <ArrowUpRight size={11} aria-hidden='true' /> : <ArrowDownRight size={11} aria-hidden='true' />}
                        {Math.abs(shift).toFixed(1)} pp
                    </span>
                )}
                {!last && <ChevronRight size={12} className={s.tierArrow} aria-hidden='true' />}
            </div>
            <div className={s.tierFigures}>
                <span className={s.figure}>
                    <span className={s.figureLabel}>近 5 分淨流入</span>
                    <span className={`${s.figureValue} ${panel.dirText[dir(live ? flow.flow5 : null)]}`}>
                        {live ? fmtTwd(flow.flow5, true) : '--'}
                    </span>
                </span>
                <span className={s.figure}>
                    <span className={s.figureLabel}>成交值</span>
                    <span className={s.figureValue}>{fmtTwd(flow.total)}</span>
                </span>
                <span className={s.figure}>
                    <span className={s.figureLabel}>漲跌</span>
                    <span className={`${s.figureValue} ${panel.dirText[dir(flow.pct)]}`}>{fmtSignedPct(flow.pct)}</span>
                </span>
            </div>
            <TierChart flow={flow} from={from} now={now} hover={hover} themeKey={themeKey} revision={revision} />
            <div className={s.leaders}>
                {top.map((row) => (
                    <button
                        key={row.code}
                        type='button'
                        className={s.leader[row.code === focus ? 'on' : 'off']}
                        onClick={() => onPick(row.code)}
                        title={`${nameOf(row.code)} ${row.code}・${stageOf.get(row.code) ?? ''}`}
                    >
                        <span className={s.leaderName}>{nameOf(row.code)}</span>
                        <span className={s.leaderStage}>{stageOf.get(row.code)}</span>
                        <span className={`${s.leaderNum} ${panel.dirText[dir(row.pct)]}`}>{fmtSignedPct(row.pct)}</span>
                        <span className={`${s.leaderNum} ${live ? panel.dirText[dir(row.flow5)] : s.dim}`}>
                            {live ? fmtTwd(row.flow5, true) : fmtTwd(row.turnover5)}
                        </span>
                    </button>
                ))}
                {top.length === 0 && <span className={s.empty}>尚無成交</span>}
            </div>
        </div>
    );
}

export function FocusCard({
    code,
    theme,
    edges,
    nameOf,
    inChain,
    onPick,
    onClose,
    revision,
}: {
    code: string;
    theme: Theme;
    edges: Edge[] | null;
    nameOf: (id: string) => string;
    inChain: (code: string) => boolean;
    onPick: (code: string) => void;
    onClose: () => void;
    revision: number;
}) {
    const flow = chainFlowBook.codes.get(code);
    const pct = codePct(flow);
    const price = flow?.last ?? null;
    const roles = useMemo(() => {
        const names = new Map(theme.stages.map((st) => [st.id, st]));
        return theme.members
            .filter((m) => m.id === `tw.${code}`)
            .map((m) => ({ stage: names.get(m.stage), detail: m.detail }));
    }, [theme, code]);
    const groups = useMemo(() => {
        if (!edges) return [];
        const same = (hit: RelationHit) => Number(inChain(twCodeOf(hit.counterparty) ?? ''));
        return RELATION_GROUPS.map((group) => ({
            ...group,
            // same-chain names first: those are what the flow view explains
            rows: dedupe(relationsFor(edges, `tw.${code}`, group.kind)).sort((a, b) => same(b) - same(a)),
        })).filter((group) => group.rows.length > 0);
    }, [edges, code, inChain]);
    const now = chainFlowBook.lastSlot;
    let flow5: number | null = null;
    if (flow && now !== null) {
        flow5 = 0;
        for (let i = Math.max(0, now - WINDOW + 1); i <= now; i += 1) flow5 += flow.net[i]!;
    }
    void revision;
    return (
        <aside className={s.focus} aria-label='聚焦個股'>
            <div className={s.focusHead}>
                <CircleDot size={12} className={s.focusIcon} aria-hidden='true' />
                <button type='button' className={s.focusName} onClick={() => onPick(code)} title='設為連動商品'>
                    {nameOf(`tw.${code}`)} <span className={s.focusCode}>{code}</span>
                </button>
                <span className={s.spacer} />
                <button type='button' className={s.closeBtn} onClick={onClose} aria-label='取消聚焦'>
                    <X size={12} aria-hidden='true' />
                </button>
            </div>
            <div className={s.focusFigures}>
                <span className={s.figure}>
                    <span className={s.figureLabel}>價</span>
                    <span className={`${s.figureValue} ${panel.dirText[dir(pct)]}`}>{price ? fmtPrice(price) : '--'}</span>
                </span>
                <span className={s.figure}>
                    <span className={s.figureLabel}>漲跌</span>
                    <span className={`${s.figureValue} ${panel.dirText[dir(pct)]}`}>{fmtSignedPct(pct)}</span>
                </span>
                <span className={s.figure}>
                    <span className={s.figureLabel}>近 5 分淨流入</span>
                    <span className={`${s.figureValue} ${panel.dirText[dir(flow5)]}`}>{fmtTwd(flow5, true)}</span>
                </span>
                <span className={s.figure}>
                    <span className={s.figureLabel}>成交值</span>
                    <span className={s.figureValue}>{flow ? fmtTwd(sessionTurnover(flow)) : '--'}</span>
                </span>
            </div>
            {roles.length > 0 && (
                <div className={s.focusRole}>
                    {roles.map((row, i) => (
                        <span key={i}>
                            <b>{row.stage?.name ?? ''}</b>
                            {row.detail ? `：${row.detail}` : ''}
                        </span>
                    ))}
                </div>
            )}
            <div className={s.focusGroups}>
                {groups.length === 0 && <span className={s.empty}>資料中沒有這家公司的上下游關係</span>}
                {groups.map((group) => {
                    const Icon = group.icon;
                    return (
                        <div key={group.kind} className={s.focusGroup}>
                            <span className={s.groupLabel}>
                                <Icon size={11} aria-hidden='true' />
                                {group.label}
                                <span className={s.groupCount}>{group.rows.length}</span>
                            </span>
                            {group.rows.slice(0, RELATIONS_PER_GROUP).map((hit) => {
                                const tw = twCodeOf(hit.counterparty);
                                const relPct = tw ? codePct(chainFlowBook.codes.get(tw)) : null;
                                const same = tw !== null && inChain(tw);
                                const title = [
                                    nameOf(hit.counterparty),
                                    hit.edge.detail ?? '',
                                    `證據：${hit.edge.evidence_level === 'primary' ? '公司／交易對手公開文件' : hit.edge.evidence_level === 'media' ? '具名媒體' : hit.edge.evidence_level}`,
                                    hit.edge.as_of ? `as_of ${hit.edge.as_of}` : '',
                                    same ? '同鏈' : '',
                                ]
                                    .filter(Boolean)
                                    .join('\n');
                                const body = (
                                    <>
                                        <span className={same ? s.inChainDot : s.outChainDot} aria-hidden='true' />
                                        <span className={s.relName}>{nameOf(hit.counterparty)}</span>
                                        {hit.edge.evidence_level === 'media' && <span className={s.evidenceTag}>媒體</span>}
                                        <span className={`${s.relPct} ${panel.dirText[dir(relPct)]}`}>
                                            {relPct !== null ? fmtSignedPct(relPct) : ''}
                                        </span>
                                    </>
                                );
                                return tw ? (
                                    <button key={hit.edge.id} type='button' className={s.rel} title={title} onClick={() => onPick(tw)}>
                                        {body}
                                    </button>
                                ) : (
                                    <span key={hit.edge.id} className={`${s.rel} ${s.relStatic}`} title={title}>
                                        {body}
                                    </span>
                                );
                            })}
                        </div>
                    );
                })}
            </div>
        </aside>
    );
}

/** One row per counterparty (the edge table can hold several per pair). */
function dedupe(hits: RelationHit[]): RelationHit[] {
    const seen = new Set<string>();
    return hits.filter((hit) => {
        if (seen.has(hit.counterparty)) return false;
        seen.add(hit.counterparty);
        return true;
    });
}
