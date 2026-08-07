// src/components/opt-payoff.tsx — 選擇權到期損益圖 (issue #2).
// Builds the settlement payoff curve from option (and simulated futures)
// legs: real positions of a chosen expiry can be toggled in, simulated
// legs added freely. Settlement intrinsic only — no time value.

import { FlaskConical, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuote } from '../hooks/use-stream';
import { ensureContract } from '../lib/contracts-cache';
import { getChartColors, useThemeSettings } from '../lib/theme-store';
import type { Position } from '../lib/types/portfolio';
import { fmtPrice } from '../lib/utils/format';
import * as dock from './bottom-dock.css';
import * as ticket from './order-ticket.css';
import * as styles from './opt-payoff.css';
import { Orb } from './orb';

interface Leg {
    id: string;
    label: string;
    right: 'C' | 'P' | 'F'; // F = futures leg
    strike: number; // unused for F
    qty: number; // signed: + long, − short
    entry: number; // premium for options, price for futures
    mult: number;
    month: string;
    include: boolean;
    simulated: boolean;
}

function legPnl(leg: Leg, settle: number): number {
    if (leg.right === 'F') {
        return (settle - leg.entry) * leg.mult * leg.qty;
    }
    const intrinsic =
        leg.right === 'C'
            ? Math.max(0, settle - leg.strike)
            : Math.max(0, leg.strike - settle);
    return (intrinsic - leg.entry) * leg.mult * leg.qty;
}

export function OptPayoff({ positions = [] }: { positions?: Position[] }) {
    const [legs, setLegs] = useState<Leg[]>([]);
    const [month, setMonth] = useState('');
    const [loadingPos, setLoadingPos] = useState(true);
    // simulated-leg form
    const [simRight, setSimRight] = useState<'C' | 'P' | 'F'>('C');
    const [simSide, setSimSide] = useState<'Buy' | 'Sell'>('Buy');
    const [simStrike, setSimStrike] = useState('');
    const [simQty, setSimQty] = useState('1');
    const [simPrice, setSimPrice] = useState('');
    const theme = useThemeSettings();
    const colors = getChartColors(theme);
    const txf = useQuote('TXFR1');
    const anchor = txf?.tick ? Number(txf.tick.close) : null;

    // resolve option positions (futures-account codes) into legs
    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoadingPos(true);
            const out: Leg[] = [];
            for (const p of positions) {
                if ('yd_quantity' in p) continue; // stocks irrelevant here
                try {
                    const c = await ensureContract(p.code);
                    if (c.security_type !== 'OPT' || !c.strike_price) {
                        continue;
                    }
                    out.push({
                        id: `pos-${p.code}-${p.id}`,
                        label: `${p.code}（${p.direction === 'Buy' ? '買' : '賣'}${p.quantity}）`,
                        right: c.option_right?.toUpperCase().startsWith('C')
                            ? 'C'
                            : 'P',
                        strike: c.strike_price,
                        qty: p.direction === 'Buy' ? p.quantity : -p.quantity,
                        entry: p.price,
                        mult: c.multiplier && c.multiplier > 0 ? c.multiplier : 50,
                        month: c.delivery_month ?? '',
                        include: true,
                        simulated: false,
                    });
                } catch {
                    // not an option — skip
                }
            }
            if (cancelled) return;
            setLegs((prev) => [
                ...out,
                ...prev.filter((l) => l.simulated), // keep simulated legs
            ]);
            const months = [...new Set(out.map((l) => l.month))].sort();
            setMonth((m) => m || months[0] || '');
            setLoadingPos(false);
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [positions.map((p) => `${p.code}:${p.quantity}`).join('|')]);

    const months = useMemo(
        () =>
            [...new Set(legs.map((l) => l.month).filter(Boolean))].sort(),
        [legs],
    );
    const active = legs.filter(
        (l) => l.include && (l.simulated || !month || l.month === month),
    );

    const addSim = () => {
        const strike = Number(simStrike);
        // explicit 買/賣 toggle drives the sign (issue #2: sell side wasn't
        // discoverable when it relied on typing a negative qty)
        const qty = Math.abs(Number(simQty)) * (simSide === 'Sell' ? -1 : 1);
        const price = Number(simPrice);
        if (
            (simRight !== 'F' && (!Number.isFinite(strike) || strike <= 0)) ||
            !Number.isFinite(qty) ||
            qty === 0 ||
            !Number.isFinite(price) ||
            price <= 0
        ) {
            return;
        }
        setLegs((prev) => [
            ...prev,
            {
                id: `sim-${Date.now()}-${prev.length}`,
                label:
                    simRight === 'F'
                        ? `模擬期貨 ${qty > 0 ? '買' : '賣'}${Math.abs(qty)} @${price}`
                        : `模擬 ${strike}${simRight} ${qty > 0 ? '買' : '賣'}${Math.abs(qty)} @${price}`,
                right: simRight,
                strike,
                qty,
                entry: price,
                mult: 50,
                month: month || 'SIM',
                include: true,
                simulated: true,
            },
        ]);
        setSimStrike('');
        setSimPrice('');
    };

    // payoff curve
    const canvasRef = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        const cv = canvasRef.current;
        if (!cv) return;
        const W = cv.clientWidth || 480;
        const H = cv.clientHeight || 220;
        const dpr = window.devicePixelRatio || 1;
        cv.width = W * dpr;
        cv.height = H * dpr;
        const ctx = cv.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        if (active.length === 0) return;

        const strikes = active
            .filter((l) => l.right !== 'F')
            .map((l) => l.strike);
        const center =
            anchor ??
            (strikes.length
                ? strikes.reduce((s, v) => s + v, 0) / strikes.length
                : 20000);
        const lo = Math.min(center * 0.9, ...strikes, center) * 0.985;
        const hi = Math.max(center * 1.1, ...strikes, center) * 1.015;
        const N = 240;
        const pts: { s: number; pnl: number }[] = [];
        let minP = 0;
        let maxP = 0;
        for (let i = 0; i <= N; i++) {
            const s = lo + ((hi - lo) * i) / N;
            const pnl = active.reduce((sum, l) => sum + legPnl(l, s), 0);
            pts.push({ s, pnl });
            minP = Math.min(minP, pnl);
            maxP = Math.max(maxP, pnl);
        }
        const padP = Math.max(1, (maxP - minP) * 0.1);
        minP -= padP;
        maxP += padP;
        const x = (s: number) => ((s - lo) / (hi - lo)) * W;
        const y = (p: number) => H - ((p - minP) / (maxP - minP)) * H;

        // zero line
        ctx.strokeStyle = colors.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y(0));
        ctx.lineTo(W, y(0));
        ctx.stroke();

        // strike markers
        ctx.setLineDash([3, 3]);
        for (const k of new Set(strikes)) {
            ctx.strokeStyle = colors.grid;
            ctx.beginPath();
            ctx.moveTo(x(k), 0);
            ctx.lineTo(x(k), H);
            ctx.stroke();
        }
        ctx.setLineDash([]);

        // current price marker
        if (anchor !== null && anchor >= lo && anchor <= hi) {
            ctx.strokeStyle = colors.crosshair;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.moveTo(x(anchor), 0);
            ctx.lineTo(x(anchor), H);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // payoff: profit segment up-color, loss segment down-color
        ctx.lineWidth = 1.8;
        ctx.lineJoin = 'round';
        for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1]!;
            const b = pts[i]!;
            ctx.strokeStyle = (a.pnl + b.pnl) / 2 >= 0 ? colors.up : colors.down;
            ctx.beginPath();
            ctx.moveTo(x(a.s), y(a.pnl));
            ctx.lineTo(x(b.s), y(b.pnl));
            ctx.stroke();
        }

        // axis labels
        ctx.fillStyle = colors.text;
        ctx.font = "10px 'JetBrains Mono', monospace";
        ctx.textAlign = 'left';
        ctx.fillText(fmtPrice(lo, 0), 4, H - 4);
        ctx.textAlign = 'right';
        ctx.fillText(fmtPrice(hi, 0), W - 4, H - 4);
        ctx.textAlign = 'left';
        ctx.fillText(`max ${fmtPrice(maxP, 0)}`, 4, 12);
        ctx.fillText(`min ${fmtPrice(minP, 0)}`, 4, 24);
    }, [active, anchor, colors]);

    return (
        <div className={styles.wrap}>
            <div className={styles.toolbar}>
                {months.length > 0 && (
                    <select
                        className={styles.monthSelect}
                        value={month}
                        onChange={(e) => setMonth(e.target.value)}
                    >
                        {months.map((m) => (
                            <option key={m} value={m}>
                                {m}
                            </option>
                        ))}
                    </select>
                )}
                <span className={styles.warn}>
                    ⚠ 結算損益試算（不含時間價值/手續費），僅供參考，盈虧自負
                </span>
            </div>
            <canvas ref={canvasRef} className={styles.chart} />
            <div className={styles.legList}>
                {loadingPos && legs.length === 0 && (
                    <span className={dock.emptyState}>
                        <Orb size={12} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                        載入持倉…
                    </span>
                )}
                {!loadingPos && legs.length === 0 && (
                    <span className={dock.emptyState}>
                        無選擇權持倉 — 可在下方加入模擬部位
                    </span>
                )}
                {legs.map((l) => (
                    <label key={l.id} className={styles.legRow}>
                        <input
                            type='checkbox'
                            checked={l.include}
                            onChange={() =>
                                setLegs((prev) =>
                                    prev.map((x) =>
                                        x.id === l.id
                                            ? { ...x, include: !x.include }
                                            : x,
                                    ),
                                )
                            }
                        />
                        <span className={styles.legLabel}>
                            {l.simulated && (
                                <FlaskConical size={10} style={{ verticalAlign: '-1px' }} />
                            )}{' '}
                            {l.label}
                        </span>
                        {l.simulated && (
                            <button
                                className={styles.legRemove}
                                onClick={() =>
                                    setLegs((prev) =>
                                        prev.filter((x) => x.id !== l.id),
                                    )
                                }
                            >
                                <X size={10} />
                            </button>
                        )}
                    </label>
                ))}
            </div>
            <div className={styles.simRow}>
                <div className={ticket.segGroup} style={{ flex: '0 0 auto' }}>
                    {(['Buy', 'Sell'] as const).map((s) => (
                        <button
                            key={s}
                            className={ticket.seg[simSide === s ? 'on' : 'off']}
                            onClick={() => setSimSide(s)}
                        >
                            {s === 'Buy' ? '買' : '賣'}
                        </button>
                    ))}
                </div>
                <select
                    className={styles.monthSelect}
                    value={simRight}
                    onChange={(e) =>
                        setSimRight(e.target.value as 'C' | 'P' | 'F')
                    }
                >
                    <option value='C'>Call</option>
                    <option value='P'>Put</option>
                    <option value='F'>期貨</option>
                </select>
                {simRight !== 'F' && (
                    <input
                        className={ticket.numInput}
                        placeholder='履約價'
                        value={simStrike}
                        inputMode='numeric'
                        onChange={(e) => setSimStrike(e.target.value)}
                    />
                )}
                <input
                    className={ticket.numInput}
                    placeholder='口數'
                    value={simQty}
                    inputMode='numeric'
                    onChange={(e) => setSimQty(e.target.value)}
                />
                <input
                    className={ticket.numInput}
                    placeholder={simRight === 'F' ? '成交價' : '權利金'}
                    value={simPrice}
                    inputMode='decimal'
                    onChange={(e) => setSimPrice(e.target.value)}
                />
                <button className={styles.addBtn} onClick={addSim}>
                    ＋模擬
                </button>
            </div>
        </div>
    );
}
