// Pure display-only geometry for the five-level order-book heatmap.
// Never publish these sampled values to trading or strategy stores.
import { marketTime, type BookLevel, type DisplayBook } from './display-book';

export interface DepthColumn {
    timeMs: number;
    source: DisplayBook['source'];
    bids: BookLevel[];
    asks: BookLevel[];
    last: number | null;
}

export const MAX_DEPTH_COLUMNS = 360;
export const MIN_VIEW_MS = 60_000;
export const MAX_OBSERVED_SPAN_MS = 2_000;
const RESET_GAP_MS = 15 * 60_000;

export function appendDepthColumn(
    columns: readonly DepthColumn[],
    book: DisplayBook,
    last: number | null,
): DepthColumn[] {
    const timeMs = marketTime(book.time);
    if (!Number.isFinite(timeMs)) return [...columns];
    const sample: DepthColumn = {
        timeMs,
        source: book.source,
        bids: book.bids,
        asks: book.asks,
        last: last !== null && Number.isFinite(last) ? last : null,
    };
    const previous = columns[columns.length - 1];
    if (!previous) return [sample];

    // A first L1 snapshot is not fabricated history, and must not linger
    // when the actual five-level BidAsk stream starts.
    if (previous.source === 'snapshot' && book.source === 'stream') return [sample];
    if (previous.source === 'stream' && book.source === 'snapshot') return [...columns];
    if (timeMs < previous.timeMs) return [...columns];
    if (timeMs - previous.timeMs > RESET_GAP_MS) return [sample];

    // Timestamps can have only second resolution: keep the latest observed
    // state instead of inventing spacing between events within that second.
    if (timeMs === previous.timeMs) return [...columns.slice(0, -1), sample];
    return [...columns.slice(-(MAX_DEPTH_COLUMNS - 1)), sample];
}

export function depthTimeRange(columns: readonly DepthColumn[]): { start: number; end: number } | null {
    const first = columns[0]?.timeMs;
    const last = columns[columns.length - 1]?.timeMs;
    if (first === undefined || last === undefined) return null;
    return { start: Math.min(first, last - MIN_VIEW_MS), end: last };
}

export function observedSpanMs(current: DepthColumn, next?: DepthColumn): number {
    if (!next || next.timeMs <= current.timeMs) return 0;
    // No updates for a long period do not prove resting volume persisted.
    return Math.min(next.timeMs - current.timeMs, MAX_OBSERVED_SPAN_MS);
}

export function depthPriceTicks(min: number, max: number, desired = 5): number[] {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max || desired < 2) return [];
    const rough = (max - min) / (desired - 1);
    const power = Math.pow(10, Math.floor(Math.log10(rough)));
    const scaled = rough / power;
    const step = (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * power;
    const ticks: number[] = [];
    for (let i = Math.ceil(min / step); i * step <= max && ticks.length < 20; i++) {
        ticks.push(Number((i * step).toPrecision(12)));
    }
    return ticks;
}
