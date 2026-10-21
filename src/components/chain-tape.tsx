// src/components/chain-tape.tsx — 時間軸 view of 產業鏈資金流向: one row per
// group with the session's per-minute flow intensity ribbon.

import { useEffect, useRef } from 'react';
import { SESSION_SLOTS, slotLabel } from '../lib/chain-flow';
import { fmtSignedPct, fmtTwd } from '../lib/chain-map';
import { vars } from '../theme.css';
import { cssColor, dir, fmtAccel, slotX, sumBars, useCanvas, type FlowRow } from './chain-ui';
import * as panel from './panel.css';
import * as s from './chain-map.css';

const HOURS = [0, 60, 120, 180, 240, 270];
/** Strip height reaches 76 % at net ÷ turnover = ±40 % (tanh knee). */
const FULL_INTENSITY = 0.4;

/** Per-minute net inflow, mirrored around the centre line. */
function FlowStrip({
    net,
    turnover,
    from,
    now,
    hover,
    themeKey,
    revision,
    onHover,
}: {
    net: Float64Array;
    turnover: Float64Array;
    from: number | null;
    now: number | null;
    hover: number | null;
    themeKey: string;
    revision: number;
    onHover: (slot: number | null) => void;
}) {
    const ref = useCanvas(
        (ctx, w, h, el) => {
            const mid = Math.round(h / 2) + 0.5;
            const half = h / 2 - 2;
            const up = cssColor(el, vars.color.up);
            const down = cssColor(el, vars.color.down);
            ctx.strokeStyle = cssColor(el, vars.color.border);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, mid);
            ctx.lineTo(w, mid);
            ctx.stroke();
            const step = w / SESSION_SLOTS;
            if (from !== null && now !== null) {
                // flow intensity = net ÷ turnover over a 3-minute centred window:
                // comparable across a 5-stock theme and a 250-stock chain (the
                // absolute amount is in the 5 分淨流入 column)
                const ys: number[] = [];
                for (let i = from; i <= now; i += 1) {
                    let sumNet = 0;
                    let sumTurnover = 0;
                    for (let j = Math.max(from, i - 1); j <= Math.min(now, i + 1); j += 1) {
                        sumNet += net[j]!;
                        sumTurnover += turnover[j]!;
                    }
                    const v = sumTurnover > 0 ? sumNet / sumTurnover : 0;
                    // soft knee instead of a hard clip
                    const len = Math.tanh(Math.abs(v) / FULL_INTENSITY) * half;
                    ys.push(v >= 0 ? mid - len : mid + len);
                }
                const trace = () => {
                    ctx.beginPath();
                    ctx.moveTo(slotX(from, w), mid);
                    ys.forEach((y, k) => ctx.lineTo(slotX(from + k, w), y));
                    ctx.lineTo(slotX(now, w), mid);
                };
                for (const [color, top] of [
                    [up, true],
                    [down, false],
                ] as const) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(0, top ? 0 : mid, w, top ? mid : h - mid);
                    ctx.clip();
                    trace();
                    ctx.closePath();
                    ctx.globalAlpha = 0.28;
                    ctx.fillStyle = color;
                    ctx.fill();
                    ctx.globalAlpha = 0.95;
                    ctx.strokeStyle = color;
                    ctx.lineWidth = 1.1;
                    ctx.lineJoin = 'round';
                    trace();
                    ctx.stroke();
                    ctx.restore();
                }
            }
            if (now !== null) {
                ctx.fillStyle = cssColor(el, vars.color.mutedForeground);
                ctx.globalAlpha = 0.45;
                ctx.fillRect(Math.round((now + 1) * step), 3, 1, h - 6);
                ctx.globalAlpha = 1;
            }
            if (hover !== null) {
                ctx.fillStyle = cssColor(el, vars.color.accent);
                ctx.fillRect(Math.round(slotX(hover, w)), 0, 1, h);
            }
        },
        [net, turnover, from, now, hover, themeKey, revision],
    );
    return (
        <canvas
            ref={ref}
            className={s.stripCanvas}
            onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const slot = Math.floor(((e.clientX - rect.left) / rect.width) * SESSION_SLOTS);
                onHover(Math.max(0, Math.min(SESSION_SLOTS - 1, slot)));
            }}
            onMouseLeave={() => onHover(null)}
            aria-hidden='true'
        />
    );
}

export function FlowTape({
    rows,
    selectedId,
    kind,
    narrow,
    from,
    now,
    covered,
    hover,
    themeKey,
    revision,
    onHover,
    onSelect,
}: {
    rows: FlowRow[];
    selectedId: string;
    kind: 'all' | 'chain' | 'theme';
    narrow: boolean;
    from: number | null;
    now: number | null;
    /** Slots covered by the seed summary (before the first bar). */
    covered: number;
    hover: number | null;
    themeKey: string;
    revision: number;
    onHover: (slot: number | null) => void;
    onSelect: (id: string) => void;
}) {
    const tapeRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        tapeRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView?.({ block: 'nearest' });
    }, [selectedId, kind]);
    const seedWidth = (covered / SESSION_SLOTS) * 100;
    const setHover = onHover;
    return (
            <div className={s.tape} ref={tapeRef}>
                <div className={`${s.row} ${s.headRow} ${narrow ? s.rowNarrow : ''}`}>
                    <span className={s.headName}>{kind === 'theme' ? '題材' : kind === 'chain' ? '產業鏈' : '產業鏈／題材'}</span>
                    <span className={s.axis} title='每分鐘淨流入 ÷ 成交值（3 分鐘平滑）：中線以上＝流入、以下＝流出；斜線區＝開啟面板前，只有成交值彙總'>
                        {HOURS.map((slot) => (
                            <span key={slot} className={s.axisTick} style={{ left: `${((slot + 0.5) / SESSION_SLOTS) * 100}%` }}>
                                {slotLabel(slot)}
                            </span>
                        ))}
                        {hover !== null && (
                            <span className={s.axisHover} style={{ left: `${((hover + 0.5) / SESSION_SLOTS) * 100}%` }}>
                                {slotLabel(hover)}
                            </span>
                        )}
                    </span>
                    <span className={s.headNum} title='最近 5 根 1 分 K：成交值 × 方向（收盤價較前一分鐘），估算'>
                        5 分淨流入
                    </span>
                    {!narrow && (
                        <span className={s.headNum} title='近 5 分鐘成交值 ÷（今日每分鐘平均 × 5）'>
                            量能
                        </span>
                    )}
                    <span className={s.headNum}>漲跌</span>
                </div>
                {rows.map(({ theme: t, codes, flow }) => {
                    const selected = t.id === selectedId;
                    const seedAmount = flow.total - sumBars(flow);
                    return (
                        <div
                            key={t.id}
                            role='button'
                            tabIndex={0}
                            className={`${s.row} ${s.dataRow[selected ? 'on' : 'off']} ${narrow ? s.rowNarrow : ''}`}
                            aria-current={selected ? 'true' : undefined}
                            onClick={() => onSelect(t.id)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    onSelect(t.id);
                                }
                            }}
                            title={[
                                `${t.name}・${codes.length} 檔`,
                                `今日成交值 ${fmtTwd(flow.total)}`,
                                now !== null ? `累積淨流入（已收到的 1 分 K）${fmtTwd(flow.cumNet[now]!, true)}` : '',
                                `漲 ${flow.breadth.up}・平 ${flow.breadth.flat}・跌 ${flow.breadth.down}`,
                                hover !== null
                                    ? `${slotLabel(hover)} 淨流入 ${fmtTwd(flow.net[hover]!, true)}・成交值 ${fmtTwd(flow.turnover[hover]!)}`
                                    : '',
                            ]
                                .filter(Boolean)
                                .join('\n')}
                        >
                            <span className={s.name}>
                                <span className={s.kindMark[t.kind === 'chain' ? 'chain' : 'theme']} aria-hidden='true' />
                                <span className={s.nameText}>{t.name}</span>
                            </span>
                            <span className={s.strip}>
                                {seedWidth > 0 && (
                                    <span className={s.seed} style={{ width: `${seedWidth}%` }}>
                                        {seedWidth >= 8 && seedAmount > 0 && (
                                            <span
                                                className={s.seedText}
                                                title={`${from === null ? '今日' : `開盤至 ${slotLabel(from)}`}成交值（snapshot 彙總，開啟面板前沒有逐分資料）`}
                                            >
                                                {fmtTwd(seedAmount)}
                                            </span>
                                        )}
                                    </span>
                                )}
                                <FlowStrip
                                    net={flow.net}
                                    turnover={flow.turnover}
                                    from={from}
                                    now={now}
                                    hover={hover}
                                    themeKey={themeKey}
                                    revision={revision}
                                    onHover={setHover}
                                />
                            </span>
                            <span className={`${s.num} ${panel.dirText[dir(now !== null ? flow.flow5 : null)]}`}>
                                {now !== null ? fmtTwd(flow.flow5, true) : '--'}
                            </span>
                            {!narrow && (
                                <span className={`${s.num} ${flow.accel !== null && flow.accel >= 1.5 ? s.hot : s.dim}`}>
                                    {fmtAccel(flow.accel)}
                                </span>
                            )}
                            <span className={`${s.num} ${panel.dirText[dir(flow.pct)]}`}>{fmtSignedPct(flow.pct)}</span>
                        </div>
                    );
                })}
            </div>

    );
}
