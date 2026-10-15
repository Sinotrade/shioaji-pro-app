// src/components/depth-map.tsx — five-level resting-volume heatmap.
// Display-only: timestamped samples, readable axes and latest tick overlay.
// It must not feed sampled display values into orders or strategies.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useDisplayBook } from '../hooks/use-display-book';
import type { Snapshot } from '../lib/types/market';
import { getChartColors, useThemeSettings } from '../lib/theme-store';
import { marketTime } from '../lib/display-book';
import {
    appendDepthColumn,
    depthPriceTicks,
    depthTimeRange,
    observedSpanMs,
    type DepthColumn,
} from '../lib/depth-map-model';
import type { ContractBase } from '../lib/types/contract';
import * as styles from './depth-map.css';

const LEFT = 8;
const RIGHT = 70;
const TOP = 12;
const BOTTOM = 26;

function formatTime(ms: number): string {
    return new Date(ms).toLocaleTimeString('zh-TW', {
        timeZone: 'Asia/Taipei', hour12: false,
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
}

function formatPrice(price: number): string {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(price);
}

interface Hover {
    sample: DepthColumn;
    x: number;
    y: number;
}

export function DepthMap({ contract, snapshot }: { contract: ContractBase; snapshot?: Snapshot }) {
    const { book, quote } = useDisplayBook(contract.code, snapshot, contract);
    const current = useRef({ book, tick: quote?.tick });
    current.current = { book, tick: quote?.tick };
    const appendRef = useRef<() => void>(() => undefined);
    const redrawRef = useRef<() => void>(() => undefined);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const colsRef = useRef<DepthColumn[]>([]);
    const themeSettings = useThemeSettings();
    const themeRef = useRef(themeSettings);
    themeRef.current = themeSettings;
    const [hover, setHover] = useState<Hover | null>(null);

    useEffect(() => {
        colsRef.current = [];
        setHover(null);
        let raf = 0;
        let dirty = false;

        const draw = () => {
            raf = 0;
            if (!dirty) return;
            dirty = false;
            const canvas = canvasRef.current;
            if (!canvas) return;
            const dpr = window.devicePixelRatio || 1;
            const w = canvas.clientWidth;
            const h = canvas.clientHeight;
            if (w <= RIGHT + LEFT + 10 || h <= TOP + BOTTOM + 10) return;
            const pixelW = Math.round(w * dpr);
            const pixelH = Math.round(h * dpr);
            if (canvas.width !== pixelW) canvas.width = pixelW;
            if (canvas.height !== pixelH) canvas.height = pixelH;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);
            const cols = colsRef.current;
            const range = depthTimeRange(cols);
            if (!range) return;

            let min = Infinity;
            let max = -Infinity;
            let maxVol = 1;
            for (const sample of cols) {
                for (const level of [...sample.bids, ...sample.asks]) {
                    if (level.vol <= 0 || !Number.isFinite(level.price)) continue;
                    min = Math.min(min, level.price);
                    max = Math.max(max, level.price);
                    maxVol = Math.max(maxVol, level.vol);
                }
            }
            if (!Number.isFinite(min) || !Number.isFinite(max)) return;

            // Latest tick is an independently updated overlay, never backfilled
            // as a book state. Stale tick prices cannot affect the price scale.
            const tick = current.current.tick;
            const tickPrice = Number(tick?.close);
            const tickTime = marketTime(tick?.date, tick?.time);
            const showTick = !!tick && Number.isFinite(tickPrice) && Number.isFinite(tickTime)
                && Math.abs(tickTime - range.end) <= 60_000;
            if (showTick) {
                min = Math.min(min, tickPrice);
                max = Math.max(max, tickPrice);
            }
            const pad = Math.max(1, (max - min) * 0.08);
            min -= pad;
            max += pad;
            const plotW = w - LEFT - RIGHT;
            const plotH = h - TOP - BOTTOM;
            const xOf = (ms: number) => LEFT + (ms - range.start) / (range.end - range.start) * plotW;
            const yOf = (price: number) => TOP + (max - price) / (max - min) * plotH;
            const colors = getChartColors(themeRef.current);

            ctx.save();
            ctx.font = '10px monospace';
            ctx.lineWidth = 1;
            ctx.fillStyle = colors.text;
            ctx.strokeStyle = colors.grid;

            // Price axis is derived from sampled prices, not guessed tick size.
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'left';
            for (const price of depthPriceTicks(min, max)) {
                const y = yOf(price);
                ctx.beginPath();
                ctx.moveTo(LEFT, y);
                ctx.lineTo(w - RIGHT + 4, y);
                ctx.stroke();
                ctx.fillText(formatPrice(price), w - RIGHT + 9, y);
            }

            // Equal distances here represent equal real elapsed time.
            ctx.textBaseline = 'alphabetic';
            [0, 0.5, 1].forEach((part, i) => {
                const x = LEFT + part * plotW;
                ctx.beginPath();
                ctx.moveTo(x, TOP);
                ctx.lineTo(x, h - BOTTOM);
                ctx.stroke();
                ctx.textAlign = i === 0 ? 'left' : i === 2 ? 'right' : 'center';
                ctx.fillText(formatTime(range.start + part * (range.end - range.start)), x, h - 7);
            });

            const cellH = Math.max(2, Math.min(8, plotH / 60));
            ctx.beginPath();
            ctx.rect(LEFT, TOP, plotW, plotH);
            ctx.clip();
            cols.forEach((sample, i) => {
                const x = xOf(sample.timeMs);
                const next = cols[i + 1];
                const span = observedSpanMs(sample, next);
                const width = Math.max(1, span / (range.end - range.start) * plotW);
                for (const [levels, color] of [
                    [sample.bids, colors.up],
                    [sample.asks, colors.down],
                ] as const) {
                    ctx.fillStyle = color;
                    for (const level of levels) {
                        if (level.vol <= 0 || !Number.isFinite(level.price)) continue;
                        ctx.globalAlpha = Math.min(0.85, 0.12 + (level.vol / maxVol) * 0.75);
                        ctx.fillRect(x, yOf(level.price) - cellH / 2, width, cellH);
                    }
                }
                // A dot of observed volume remains visible for isolated updates.
                ctx.globalAlpha = 1;
            });

            if (showTick) {
                const y = yOf(tickPrice);
                ctx.globalAlpha = 0.95;
                ctx.strokeStyle = colors.crosshair;
                ctx.setLineDash([5, 4]);
                ctx.beginPath();
                ctx.moveTo(LEFT, y);
                ctx.lineTo(w - RIGHT, y);
                ctx.stroke();
                ctx.setLineDash([]);
            }
            ctx.restore();

            if (showTick) {
                // The current trade price is not a historical book sample.
                ctx.fillStyle = colors.crosshair;
                ctx.font = '10px monospace';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillText(formatPrice(tickPrice), w - RIGHT + 9, yOf(tickPrice));
            }
        };

        const schedule = () => {
            dirty = true;
            if (!raf) raf = requestAnimationFrame(draw);
        };
        redrawRef.current = schedule;

        let previous = '';
        const append = () => {
            const { book: nextBook, tick } = current.current;
            if (!nextBook) return;
            const identity = JSON.stringify(nextBook);
            if (identity === previous) return;
            previous = identity;
            const tickTime = marketTime(tick?.date, tick?.time);
            const bookTime = marketTime(nextBook.time);
            const alignedLast = tick && Number.isFinite(tickTime) && Number.isFinite(bookTime)
                && Math.abs(tickTime - bookTime) <= 2_000 ? Number(tick.close) : null;
            colsRef.current = appendDepthColumn(colsRef.current, nextBook, alignedLast);
            schedule();
        };
        appendRef.current = append;
        append();
        const resize = new ResizeObserver(schedule);
        if (canvasRef.current) resize.observe(canvasRef.current);
        return () => {
            appendRef.current = () => undefined;
            redrawRef.current = () => undefined;
            resize.disconnect();
            if (raf) cancelAnimationFrame(raf);
        };
    }, [contract.code]);

    useEffect(() => { appendRef.current(); }, [book]);
    useEffect(() => { redrawRef.current(); }, [quote?.tick, themeSettings]);

    const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        const range = depthTimeRange(colsRef.current);
        if (!canvas || !range) return;
        const rect = canvas.getBoundingClientRect();
        const width = rect.width - LEFT - RIGHT;
        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        if (mouseX < LEFT || mouseX > LEFT + width || mouseY < TOP || mouseY > rect.height - BOTTOM) {
            setHover(null);
            return;
        }
        const time = range.start + (mouseX - LEFT) / width * (range.end - range.start);
        let nearest: DepthColumn | undefined;
        let distance = Infinity;
        for (const sample of colsRef.current) {
            const dx = Math.abs(sample.timeMs - time) / (range.end - range.start) * width;
            if (dx < distance) { distance = dx; nearest = sample; }
        }
        if (!nearest || distance > 14) { setHover(null); return; }
        setHover({
            sample: nearest,
            x: Math.max(5, Math.min(mouseX + 12, rect.width - 186)),
            y: Math.max(5, Math.min(mouseY + 12, rect.height - 84)),
        });
    };

    return (
        <div className={styles.wrap}>
            <div className={styles.chartFrame}>
                <canvas
                    ref={canvasRef}
                    className={styles.canvas}
                    onPointerMove={onPointerMove}
                    onPointerLeave={() => setHover(null)}
                    aria-label="五檔委託簿熱圖，橫軸為台北時間、縱軸為價格，顏色依目前漲跌配色分別代表買賣掛量"
                />
                {hover && (
                    <div className={styles.hover} style={{ left: hover.x, top: hover.y }} role="status">
                        <div>{formatTime(hover.sample.timeMs)} · {hover.sample.source === 'snapshot' ? '第一檔快照' : '即時五檔'}</div>
                        <div>買盤：{hover.sample.bids.map(x => `${formatPrice(x.price)} × ${x.vol}`).join(' / ') || '無'}</div>
                        <div>賣盤：{hover.sample.asks.map(x => `${formatPrice(x.price)} × ${x.vol}`).join(' / ') || '無'}</div>
                    </div>
                )}
            </div>
            <span className={styles.hint}>
                {book?.source === 'snapshot'
                    ? '快照僅第一檔；等待即時五檔，沒有歷史深度'
                    : '即時五檔掛量（非成交量）· 台北時間 · 開啟面板後開始記錄；無事件區間不推定掛單持續'}
            </span>
        </div>
    );
}
