// Order-flow sub-chart: per-bar Delta histogram + cumulative Delta (CVD) line
// with inner/outer (aggressor) share. Presentation-only. Click/drag to seek.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { OrderFlowBar } from '../lib/order-flow';
import { summarizeOrderFlow } from '../lib/order-flow';

const PAD_L = 8;
const PAD_R = 58; // align roughly with the main chart right price axis
const PAD_T = 10;
const PAD_B = 16;
const H = 156;
const LONG = '#fb7185';
const SHORT = '#4ade80';
const CVD_C = '#22d3ee';

const p2 = (n: number) => String(n).padStart(2, '0');
function hhmm(t: number): string {
    const d = new Date(t * 1000);
    return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

interface Props {
    flow: OrderFlowBar[];
    dayStart: number;
    dayEnd: number;
    visibleTime: number;
    onSeek?: (time: number) => void;
}

export function ResearchOrderFlow({
    flow, dayStart, dayEnd, visibleTime, onSeek,
}: Props) {
    const hostRef = useRef<HTMLDivElement>(null);
    const svgRef = useRef<SVGSVGElement>(null);
    const [width, setWidth] = useState(900);
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        const ro = new ResizeObserver(() => setWidth(host.clientWidth));
        ro.observe(host);
        setWidth(host.clientWidth);
        return () => ro.disconnect();
    }, []);

    const summary = useMemo(() => summarizeOrderFlow(flow), [flow]);
    const geom = useMemo(() => {
        const plotW = Math.max(40, width - PAD_L - PAD_R);
        const plotH = H - PAD_T - PAD_B;
        const x = (t: number) => PAD_L
            + ((t - dayStart) / Math.max(1, dayEnd - dayStart)) * plotW;
        let maxAbsDelta = 1;
        let cvdMin = Infinity;
        let cvdMax = -Infinity;
        for (const b of flow) {
            maxAbsDelta = Math.max(maxAbsDelta, Math.abs(b.delta));
            cvdMin = Math.min(cvdMin, b.cvd);
            cvdMax = Math.max(cvdMax, b.cvd);
        }
        if (!isFinite(cvdMin) || !isFinite(cvdMax)) {
            cvdMin = 0;
            cvdMax = 0;
        }
        const zeroY = PAD_T + plotH / 2;
        const dScale = (plotH / 2 - 4) / maxAbsDelta;
        const cvdY = (v: number) => {
            const span = cvdMax - cvdMin || 1;
            return PAD_T + plotH - 6
                - ((v - cvdMin) / span) * (plotH - 12);
        };
        const bars = flow.map((b, i) => {
            const next = i + 1 < flow.length ? flow[i + 1]!.time : dayEnd;
            const x0 = x(b.time);
            const bw = Math.max(1, x(next) - x0 - 1);
            const bh = b.delta * dScale;
            return {
                b, x0, bw,
                y: bh >= 0 ? zeroY - bh : zeroY,
                h: Math.abs(bh),
                color: b.delta >= 0 ? LONG : SHORT,
            };
        });
        const cvdPath = flow
            .map((b, i) => `${i === 0 ? 'M' : 'L'}${x(b.time).toFixed(1)},${cvdY(b.cvd).toFixed(1)}`)
            .join(' ');
        return { plotW, plotH, x, zeroY, bars, cvdPath, cvdLastY: cvdY(flow.at(-1)?.cvd ?? 0) };
    }, [flow, width, dayStart, dayEnd]);

    const seekFromEvent = (clientX: number) => {
        if (!onSeek || !svgRef.current) return;
        const rect = svgRef.current.getBoundingClientRect();
        const plotW = Math.max(40, rect.width - PAD_L - PAD_R);
        const frac = (clientX - rect.left - PAD_L) / plotW;
        const t = dayStart + frac * (dayEnd - dayStart);
        onSeek(Math.min(Math.max(t, dayStart), dayEnd));
    };

    if (flow.length === 0) {
        return (
            <div ref={hostRef} style={hostStyle}>
                <span style={{ color: '#94a3b8' }}>
                    Order Flow：該日無內外盤 Tick，無法計算 Delta／CVD
                </span>
            </div>
        );
    }
    const nowX = geom.x(visibleTime);
    const cvdPositive = summary.cvd >= 0;

    return (
        <div ref={hostRef} style={hostStyle}>
            <div style={headerStyle}>
                <span style={{ color: '#e2e8f0', fontWeight: 600 }}>
                    Order Flow
                </span>
                <span style={{ color: LONG }}>外盤 {summary.buyPct.toFixed(1)}%</span>
                <span style={{ color: SHORT }}>內盤 {summary.sellPct.toFixed(1)}%</span>
                <span style={{ color: '#94a3b8' }}>Δ {summary.delta}</span>
                <span style={{ color: CVD_C }}>
                    CVD {cvdPositive ? '+' : ''}{summary.cvd}
                </span>
                <span style={{ marginLeft: 'auto', color: '#64748b' }}>
                    {onSeek ? '點擊／拖曳圖區可快轉' : ''}
                </span>
            </div>
            <svg
                ref={svgRef}
                width={width}
                height={H}
                style={{ display: 'block', touchAction: 'none', cursor: onSeek ? 'pointer' : 'default' }}
                onPointerDown={(e) => seekFromEvent(e.clientX)}
                onPointerMove={(e) => { if (e.buttons === 1) seekFromEvent(e.clientX); }}
            >
                <line x1={PAD_L} y1={geom.zeroY} x2={width - PAD_R} y2={geom.zeroY}
                    stroke="#334155" strokeWidth={1} strokeDasharray="3 3" />
                {geom.bars.map((r, i) => (
                    <rect key={i} x={r.x0} y={r.y} width={r.bw} height={Math.max(0.5, r.h)}
                        fill={r.color} opacity={0.55} />
                ))}
                <path d={geom.cvdPath} fill="none" stroke={CVD_C} strokeWidth={1.8} />
                <line x1={nowX} y1={PAD_T} x2={nowX} y2={H - PAD_B}
                    stroke="#e2e8f0" strokeWidth={1} opacity={0.7} />
                <circle cx={nowX} cy={geom.cvdLastY} r={2.6} fill={CVD_C} />
                <text x={PAD_L} y={H - 4} fontSize={10} fill="#64748b">{hhmm(dayStart)}</text>
                <text x={width / 2} y={H - 4} fontSize={10} fill="#64748b"
                    textAnchor="middle">{hhmm((dayStart + dayEnd) / 2)}</text>
                <text x={width - PAD_R} y={H - 4} fontSize={10} fill="#64748b"
                    textAnchor="end">{hhmm(dayEnd)}</text>
            </svg>
        </div>
    );
}

const hostStyle: React.CSSProperties = {
    marginTop: 6,
    background: '#14181f',
    border: '1px solid #232a36',
    borderRadius: 8,
    overflow: 'hidden',
};
const headerStyle: React.CSSProperties = {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 10,
    alignItems: 'center',
    padding: '5px 10px',
    fontSize: 12,
    borderBottom: '1px solid #1f2632',
};
