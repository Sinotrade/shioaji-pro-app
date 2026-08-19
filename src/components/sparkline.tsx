// src/components/sparkline.tsx — tiny intraday trend line for list rows.
// Canvas-based: live ticks only repaint pixels (no DOM churn), draws are
// rAF-coalesced and DPR-aware. Today's 1-minute closes load once per
// symbol through a module-level cache shared by every row/panel; the
// reference price is drawn as a dashed baseline and sets the color.

import { useEffect, useRef, useState } from 'react';
import { fetchKbars } from '../lib/kgi';
import { useThemeSettings } from '../lib/theme-store';
import type { ContractBase } from '../lib/types/contract';
import { dateStrOffset } from '../lib/utils/kbars';
import { vars } from '../theme.css';

const MAX_POINTS = 90;
const CACHE_TTL = 5 * 60_000;

const cache = new Map<string, { at: number; pts: Promise<number[]> }>();

function loadPoints(contract: ContractBase): Promise<number[]> {
    const hit = cache.get(contract.code);
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.pts;
    const pts = fetchKbars(
        contract,
        // yesterday..tomorrow covers stocks and the futures night session
        dateStrOffset(1),
        dateStrOffset(-1),
    )
        .then((k) => {
            const closes: number[] = [];
            const lastDate = k.datetime[k.datetime.length - 1]?.slice(0, 10);
            for (let i = 0; i < k.datetime.length; i++) {
                // keep only the latest session day
                if (k.datetime[i]?.slice(0, 10) !== lastDate) continue;
                const c = k.Close[i];
                if (c) closes.push(c);
            }
            if (closes.length <= MAX_POINTS) return closes;
            const step = closes.length / MAX_POINTS;
            const out: number[] = [];
            for (let i = 0; i < MAX_POINTS; i++) {
                out.push(closes[Math.floor(i * step)]!);
            }
            out.push(closes[closes.length - 1]!);
            return out;
        })
        .catch(() => [] as number[]);
    cache.set(contract.code, { at: Date.now(), pts });
    return pts;
}

// resolve a vanilla-extract `var(--x)` reference to a concrete color
function cssColor(el: HTMLElement, varRef: string): string {
    if (!varRef.startsWith('var(')) return varRef;
    const name = varRef.slice(4, -1);
    return getComputedStyle(el).getPropertyValue(name).trim() || '#888';
}

export function Sparkline({
    contract,
    last,
    reference,
    width = 64,
    height = 18,
    stretch = false, // fill the container width
}: {
    contract: ContractBase;
    last?: number; // live price — appended to the series
    reference?: number; // baseline (昨收/參考價)
    width?: number;
    height?: number;
    stretch?: boolean;
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [pts, setPts] = useState<number[]>([]);
    const [resizeSeq, setResizeSeq] = useState(0);
    const theme = useThemeSettings();
    const themeKey = `${theme.mode}-${theme.convention}`;

    useEffect(() => {
        let cancelled = false;
        setPts([]);
        loadPoints(contract).then((p) => {
            if (!cancelled) setPts(p);
        });
        return () => {
            cancelled = true;
        };
    }, [contract]);

    // stretch mode follows the container width
    useEffect(() => {
        if (!stretch) return;
        const cv = canvasRef.current;
        if (!cv) return;
        const ro = new ResizeObserver(() => setResizeSeq((v) => v + 1));
        ro.observe(cv);
        return () => ro.disconnect();
    }, [stretch]);

    // rAF-coalesced repaint on data / live price / theme / size change
    useEffect(() => {
        const cv = canvasRef.current;
        if (!cv) return;
        const raf = requestAnimationFrame(() => {
            const data =
                last !== undefined && Number.isFinite(last)
                    ? [...pts, last]
                    : pts;
            const cssW = stretch ? cv.clientWidth || width : width;
            const cssH = height;
            const dpr = window.devicePixelRatio || 1;
            const pw = Math.max(1, Math.round(cssW * dpr));
            const ph = Math.max(1, Math.round(cssH * dpr));
            if (cv.width !== pw) cv.width = pw;
            if (cv.height !== ph) cv.height = ph;
            const ctx = cv.getContext('2d');
            if (!ctx) return;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, cssW, cssH);
            if (data.length < 2) return;

            let min = Math.min(...data);
            let max = Math.max(...data);
            if (reference) {
                min = Math.min(min, reference);
                max = Math.max(max, reference);
            }
            if (max === min) {
                max += 1;
                min -= 1;
            }
            const pad = (max - min) * 0.08;
            min -= pad;
            max += pad;
            const x = (i: number) => (i / (data.length - 1)) * cssW;
            const y = (v: number) =>
                cssH - ((v - min) / (max - min)) * (cssH - 2) - 1;

            if (reference !== undefined && reference > 0) {
                ctx.strokeStyle = cssColor(cv, vars.color.mutedForeground);
                ctx.globalAlpha = 0.55;
                ctx.lineWidth = 0.6;
                ctx.setLineDash([2, 2]);
                ctx.beginPath();
                ctx.moveTo(0, y(reference));
                ctx.lineTo(cssW, y(reference));
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.globalAlpha = 1;
            }

            const lastV = data[data.length - 1]!;
            const up = reference ? lastV >= reference : lastV >= data[0]!;
            ctx.strokeStyle = cssColor(
                cv,
                up ? vars.color.up : vars.color.down,
            );
            ctx.lineWidth = 1.1;
            ctx.lineJoin = 'round';
            ctx.beginPath();
            data.forEach((v, i) => {
                if (i === 0) ctx.moveTo(x(0), y(v));
                else ctx.lineTo(x(i), y(v));
            });
            ctx.stroke();
        });
        return () => cancelAnimationFrame(raf);
    }, [pts, last, reference, stretch, width, height, themeKey, resizeSeq]);

    return (
        <canvas
            ref={canvasRef}
            style={{
                width: stretch ? '100%' : width,
                height,
                display: 'block',
                flexShrink: stretch ? 1 : 0,
                minWidth: 0,
            }}
        />
    );
}

