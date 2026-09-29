import type { Candle } from './types/market';

export interface FibAnchor { time: number; price: number; }
export interface FibDrawing { start: FibAnchor; end: FibAnchor; }
export const FIB_RATIOS = [0.382, 0.5, 0.618] as const;
export const FIB_COLORS = ['#38bdf8', '#facc15', '#c084fc'] as const;

export function validFib(value: unknown): value is FibDrawing {
    if (!value || typeof value !== 'object') return false;
    const { start, end } = value as FibDrawing;
    return Boolean(start && end && [start.time, end.time, start.price, end.price].every(Number.isFinite)
        && start.time > 0 && end.time > start.time && start.price > 0 && end.price > 0 && start.price !== end.price);
}

/** Retrace from the END toward the START, for both rising and falling waves. */
export function fibLevels(drawing: FibDrawing) {
    if (!validFib(drawing)) return [];
    return FIB_RATIOS.map((ratio, i) => ({ ratio, color: FIB_COLORS[i]!,
        price: drawing.end.price + (drawing.start.price - drawing.end.price) * ratio }));
}

/** Snap to an actual, completed OHLC high/low, never Heikin-Ashi prices. */
export function pickFibAnchor(bars: Candle[], time: number, clickedPrice: number): FibAnchor | null {
    const bar = bars.find(b => b.time === time && b.volume > 0);
    if (!bar || ![bar.high, bar.low, clickedPrice].every(Number.isFinite) || bar.low <= 0) return null;
    return { time: bar.time, price: Math.abs(clickedPrice - bar.high) < Math.abs(clickedPrice - bar.low) ? bar.high : bar.low };
}

export function readFib(key: string): FibDrawing | null {
    try {
        const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
        return validFib(value) ? value : null;
    } catch { return null; }
}
