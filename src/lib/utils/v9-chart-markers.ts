// Presentation-only markers used by the V9 research chart.  They describe
// observable K-bar/volume patterns; they are not entries, exits or forecasts.

import type { Candle } from '../types/market';
import type { SecurityType } from '../types/contract';
import { sessionWindowFor } from '../intraday-session';
import { supertrend } from '../indicators';
import type { EntrySignal, ShortSignal } from '../stock-picker';

export interface V9ChartMarker {
    time: number;
    position: 'aboveBar' | 'belowBar';
    shape: 'circle' | 'square' | 'arrowUp' | 'arrowDown';
    color: string;
    text: string;
    group: 'volume' | 'divergence' | 'flow' | 'trend' | 'trendShort' | 'entry' | 'shortEntry';
}

export interface FlowTick {
    time: number;
    volume: number;
    tickType: number; // Shioaji 1 = buy, 2 = sell
    id?: string; // full exchange timestamp + cumulative volume, for SSE replay dedup
}

function ema(values: number[], period: number) {
    const alpha = 2 / (period + 1);
    const out: number[] = [];
    for (let i = 0; i < values.length; i++) {
        out.push(i === 0 ? values[i]! : values[i]! * alpha + out[i - 1]! * (1 - alpha));
    }
    return out;
}

function partialSma(values: number[], period: number) {
    return values.map((_, index) => {
        const start = Math.max(0, index - period + 1);
        let sum = 0;
        for (let i = start; i <= index; i++) sum += values[i]!;
        return sum / (index - start + 1);
    });
}

function v9KdjK(bars: Candle[]) {
    const rsv = bars.map((bar, index) => {
        if (index < 44) return 50;
        let high = -Infinity;
        let low = Infinity;
        for (let i = index - 44; i <= index; i++) {
            high = Math.max(high, bars[i]!.high);
            low = Math.min(low, bars[i]!.low);
        }
        return high > low ? ((bar.close - low) / (high - low)) * 100 : 50;
    });
    return ema(rsv, 9);
}

function weightedMacdHistogram(bars: Candle[]) {
    const weighted = bars.map((bar) => (bar.high + bar.low + 2 * bar.close) / 4);
    const fast = ema(weighted, 45);
    const slow = ema(weighted, 117);
    const dif = fast.map((value, index) => value - slow[index]!);
    const dea = ema(dif, 17);
    return dif.map((value, index) => value - dea[index]!);
}

interface Slot {
    above?: { text: string; color: string; shape: V9ChartMarker['shape']; group: V9ChartMarker['group'] };
    below?: { text: string; color: string; shape: V9ChartMarker['shape']; group: V9ChartMarker['group'] };
}

function append(
    slot: Slot,
    side: 'above' | 'below',
    text: string,
    color: string,
    shape: V9ChartMarker['shape'],
    group: V9ChartMarker['group'],
) {
    const existing = slot[side];
    if (existing) {
        existing.text = `${existing.text}·${text}`;
        return;
    }
    slot[side] = { text, color, shape, group };
}

/** Matches the original V9 visual rules: attack/wash/volume divergence plus price-momentum divergence. */
export function v9KbarMarkers(bars: Candle[]): V9ChartMarker[] {
    bars = bars.filter(bar => [bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)
        && bar.volume > 0 && bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close));
    if (bars.length < 6) return [];
    const closes = bars.map((bar) => bar.close);
    const volumes = bars.map((bar) => Math.max(0, bar.volume));
    const ema8 = ema(closes, 8);
    const volMa5 = partialSma(volumes, 5);
    const k = v9KdjK(bars);
    const hist = weightedMacdHistogram(bars);
    const divergenceSlots = bars.map((): Slot => ({}));
    const volumeSlots = bars.map((): Slot => ({}));

    // Warm up the slow MACD + signal before comparing a complete 20-bar window.
    for (let i = 152; i < bars.length; i++) {
        let high = -Infinity;
        let low = Infinity;
        let kHigh = -Infinity;
        let kLow = Infinity;
        let histHigh = -Infinity;
        let histLow = Infinity;
        for (let j = i - 19; j <= i; j++) {
            high = Math.max(high, bars[j]!.high);
            low = Math.min(low, bars[j]!.low);
            kHigh = Math.max(kHigh, k[j]!);
            kLow = Math.min(kLow, k[j]!);
            histHigh = Math.max(histHigh, hist[j]!);
            histLow = Math.min(histLow, hist[j]!);
        }
        const bar = bars[i]!;
        const top = bar.high >= high && (k[i]! < kHigh || hist[i]! < histHigh);
        const bottom = bar.low <= low && (k[i]! > kLow || hist[i]! > histLow);
        if (top) append(divergenceSlots[i]!, 'above', '頂背', '#f472b6', 'arrowDown', 'divergence');
        if (bottom) append(divergenceSlots[i]!, 'below', '底背', '#22d3ee', 'arrowUp', 'divergence');
    }

    for (let i = 5; i < bars.length; i++) {
        const bar = bars[i]!;
        const range = bar.high - bar.low;
        const closePos = range > 0 ? (bar.close - bar.low) / range : 0.5;
        const up = bar.close >= bar.open;
        const highVolume = bar.volume > volMa5[i]! * 1.5 && bar.volume > 0;
        const lowVolume = bar.volume < volMa5[i]! * 0.7;
        if (highVolume && ((up && closePos >= 0.7) || (!up && closePos <= 0.3))) {
            append(volumeSlots[i]!, up ? 'below' : 'above', '攻', '#fbbf24', up ? 'arrowUp' : 'arrowDown', 'volume');
            continue;
        }
        if (lowVolume && ((closes[i]! > ema8[i]! && !up) || (closes[i]! < ema8[i]! && up))) {
            append(volumeSlots[i]!, up ? 'below' : 'above', '洗', '#a78bfa', up ? 'arrowUp' : 'arrowDown', 'volume');
            continue;
        }
        let priceHigh = -Infinity;
        let priceLow = Infinity;
        let volumeHigh = -Infinity;
        let volumeLow = Infinity;
        for (let j = Math.max(0, i - 19); j <= i; j++) {
            priceHigh = Math.max(priceHigh, bars[j]!.high);
            priceLow = Math.min(priceLow, bars[j]!.low);
            volumeHigh = Math.max(volumeHigh, volumes[j]!);
            volumeLow = Math.min(volumeLow, volumes[j]!);
        }
        if (bar.high >= priceHigh && bar.volume < volumeHigh) {
            append(volumeSlots[i]!, 'above', '量背', '#f9a8d4', 'circle', 'volume');
        } else if (bar.low <= priceLow && bar.volume > volumeLow) {
            append(volumeSlots[i]!, 'below', '量背', '#f9a8d4', 'circle', 'volume');
        }
    }

    return [divergenceSlots, volumeSlots].flatMap(slots => slots.flatMap((slot, index) => {
        const time = bars[index]!.time;
        const result: V9ChartMarker[] = [];
        if (slot.above) result.push({ time, position: 'aboveBar', ...slot.above });
        if (slot.below) result.push({ time, position: 'belowBar', ...slot.below });
        return result;
    })).sort((a, b) => a.time - b.time);
}

/**
 * SuperTrend(10,3) trend flips as 買／平 markers — a long-only entry/exit
 * reference that mirrors the V9 default 多空趨勢線. 買 = the confirmed close
 * reclaimed the upper band (bear→bull); 平 = the close broke the lower band
 * (bull→bear). Markers land on closed bars only and never place orders; the
 * live (unclosed) bar can still move the flip.
 */
export function supertrendTradeMarkers(
    bars: Candle[],
    period = 10,
    mult = 3,
): V9ChartMarker[] {
    const { flips } = supertrend(bars, period, mult);
    return flips.map((flip) => (flip.direction === 1
        ? {
            time: flip.time, group: 'trend',
            position: 'belowBar' as const, shape: 'arrowUp' as const,
            color: '#1fd286', text: '買',
        }
        : {
            time: flip.time, group: 'trend',
            position: 'aboveBar' as const, shape: 'arrowDown' as const,
            color: '#ff4d6a', text: '平',
        }));
}

/**
 * Short-side mirror of {@link supertrendTradeMarkers}. 賣 = the confirmed close
 * broke the lower band (bull→bear, open short); 補 = the close reclaimed the
 * upper band (bear→bull, cover short). Same flips, opposite trade direction.
 * When both sides are on, the same-bar/same-side labels merge as 平·賣 / 買·補.
 */
export function supertrendShortTradeMarkers(
    bars: Candle[],
    period = 10,
    mult = 3,
): V9ChartMarker[] {
    const { flips } = supertrend(bars, period, mult);
    return flips.map((flip) => (flip.direction === -1
        ? {
            time: flip.time, group: 'trendShort',
            position: 'aboveBar' as const, shape: 'arrowDown' as const,
            color: '#ff4d6a', text: '賣',
        }
        : {
            time: flip.time, group: 'trendShort',
            position: 'belowBar' as const, shape: 'arrowUp' as const,
            color: '#1fd286', text: '補',
        }));
}
/**
 * 把選股「強勢上車」日 K 信號對到主圖 marker：主圖日 K 直接標在信號日；
 * 主圖分 K 標在當日首次收盤越過突破位那根，找不到就標當日最後一根。
 */
export function entrySignalsToMarkers(
    signals: EntrySignal[],
    visibleBars: Candle[],
    tfMinutes: number,
): V9ChartMarker[] {
    const out: V9ChartMarker[] = [];
    for (const sig of signals) {
        let at: number | null = null;
        if (tfMinutes >= 1440) {
            at = sig.time;
        } else {
            const dayBars = visibleBars.filter(
                (b) => b.time >= sig.time && b.time < sig.time + 86400,
            );
            const hit = dayBars.find((b) => b.close >= sig.level) ?? dayBars.at(-1);
            at = hit ? hit.time : null;
        }
        if (at === null) continue;
        out.push({ time: at, group: 'entry', position: 'belowBar',
            shape: 'arrowUp', color: '#f5c451', text: '強勢上車' });
    }
    return out;
}

/**
 * 把選股「弱勢放空」日 K 信號對到主圖 marker（空方鏡像）：主圖日 K 標信號日；
 * 主圖分 K 標在當日首次收盤跌破前低那根，找不到就標當日最後一根。
 */
export function shortSignalsToMarkers(
    signals: ShortSignal[],
    visibleBars: Candle[],
    tfMinutes: number,
): V9ChartMarker[] {
    const out: V9ChartMarker[] = [];
    for (const sig of signals) {
        let at: number | null = null;
        if (tfMinutes >= 1440) {
            at = sig.time;
        } else {
            const dayBars = visibleBars.filter(
                (b) => b.time >= sig.time && b.time < sig.time + 86400,
            );
            const hit = dayBars.find((b) => b.close <= sig.level) ?? dayBars.at(-1);
            at = hit ? hit.time : null;
        }
        if (at === null) continue;
        out.push({ time: at, group: 'shortEntry', position: 'aboveBar',
            shape: 'arrowDown', color: '#f5c451', text: '弱勢放空' });
    }
    return out;
}

// Same session-aligned close labels as aggregate(), with closing trades kept
// in the session's last bucket. Futures night bars belong to the next trade date.
export function researchTickBucket(time: number, minutes: number, securityType: SecurityType = 'STK'): number {
    const session = sessionWindowFor(securityType, time);
    if (minutes >= 1440) {
        const day = securityType === 'FUT' || securityType === 'OPT'
            ? session.night ? session.end - 5 * 3600 : session.start
            : time;
        return Math.floor(day / 86400) * 86400;
    }
    const end = session.end;
    const minuteEnd = Math.min(Math.floor(time / 60) * 60 + 60, end);
    const bucketSec = Math.max(1, minutes) * 60;
    return Math.min(end, session.start + Math.max(1, Math.ceil((minuteEnd - session.start) / bucketSec)) * bucketSec);
}

export interface FlowSnapshot {
    sampleCount: number;
    threshold: number | null;
    qualifiedCount: number;
    lastTime: number | null;
    markers: V9ChartMarker[];
}

export const EMPTY_FLOW: FlowSnapshot = {
    sampleCount: 0, threshold: null, qualifiedCount: 0, lastTime: null, markers: [],
};

/** Classify each tick ONCE against its preceding 20–120 ticks, never future data.
 * Only a 120-tick baseline, replay IDs and session minute totals are retained.
 * Neither this tracker nor its consumers request market history or place orders.
 */
export class V9FlowTracker {
    private baseline: number[] = [];
    private baselineSum = 0;
    private seen = new Set<string>();
    private buckets = new Map<string, { time: number; day: number; buy: number; sell: number }>();
    private session = -Infinity;
    private lastTime: number | null = null;
    private qualifiedCount = 0;

    constructor(private securityType: SecurityType = 'STK') {}

    push(tick: FlowTick): boolean {
        if (!Number.isFinite(tick.time) || !Number.isFinite(tick.volume) || tick.volume <= 0) return false;
        const win = sessionWindowFor(this.securityType, tick.time);
        if (tick.time < win.start || tick.time > win.end || tick.time < (this.lastTime ?? -Infinity)) return false;
        if (this.session !== win.start) {
            this.session = win.start;
            this.baseline = [];
            this.baselineSum = 0;
            this.seen.clear();
            this.buckets.clear();
            this.qualifiedCount = 0;
        }
        if (tick.id && this.seen.has(tick.id)) return false;
        if (tick.id) {
            this.seen.add(tick.id);
            if (this.seen.size > 1024) this.seen.delete(this.seen.values().next().value!);
        }
        const threshold = this.threshold();
        if (threshold !== null && tick.volume >= threshold && (tick.tickType === 1 || tick.tickType === 2)) {
            const time = researchTickBucket(tick.time, 1, this.securityType);
            const day = Math.floor(tick.time / 86400) * 86400;
            const key = `${day}|${time}`;
            const bucket = this.buckets.get(key) ?? { time, day, buy: 0, sell: 0 };
            if (tick.tickType === 1) bucket.buy += tick.volume;
            else bucket.sell += tick.volume;
            this.buckets.set(key, bucket);
            this.qualifiedCount++;
        }
        this.baseline.push(tick.volume);
        this.baselineSum += tick.volume;
        if (this.baseline.length > 120) this.baselineSum -= this.baseline.shift()!;
        this.lastTime = tick.time;
        return true;
    }

    private threshold(): number | null {
        return this.baseline.length >= 20 ? Math.max(5, this.baselineSum / this.baseline.length * 3) : null;
    }

    snapshot(minutes: number): FlowSnapshot {
        const buckets = new Map<number, { buy: number; sell: number }>();
        const seconds = Math.max(1, minutes) * 60;
        for (const minute of this.buckets.values()) {
            const time = minutes >= 1440 ? minute.day : Math.ceil(minute.time / seconds) * seconds;
            const bucket = buckets.get(time) ?? { buy: 0, sell: 0 };
            bucket.buy += minute.buy;
            bucket.sell += minute.sell;
            buckets.set(time, bucket);
        }
        const markers = [...buckets.entries()].flatMap(([time, flow]): V9ChartMarker[] => {
            if (flow.buy === flow.sell) return [];
            const buy = flow.buy > flow.sell;
            return [{
                time, group: 'flow',
                position: buy ? 'belowBar' : 'aboveBar',
                shape: buy ? 'arrowUp' : 'arrowDown',
                color: buy ? '#f87171' : '#34d399',
                text: buy ? '大單偏買' : '大單偏賣',
            }];
        }).sort((a, b) => a.time - b.time);
        return { sampleCount: this.baseline.length, threshold: this.threshold(),
            qualifiedCount: this.qualifiedCount, lastTime: this.lastTime, markers };
    }
}

/** Pure replay helper for offline tests. Production keeps one incremental tracker. */
export function v9LargeOrderFlowMarkers(
    ticks: FlowTick[],
    timeframeMinutes: number,
    securityType: SecurityType = 'STK',
): V9ChartMarker[] {
    const tracker = new V9FlowTracker(securityType);
    ticks.forEach(tick => tracker.push(tick));
    return tracker.snapshot(timeframeMinutes).markers;
}

/** K bars use end labels except daily bars, which use date-start labels.
 * Future/current bars are not presented as confirmed pattern observations.
 */
export function completedResearchBars(
    bars: Candle[],
    minutes: number,
    now: number,
    securityType: SecurityType = 'STK',
): Candle[] {
    return bars.filter(bar => {
        if (minutes < 1440) return bar.time <= now;
        if (securityType === 'FUT' || securityType === 'OPT') return bar.time + 86400 + 5 * 3600 <= now;
        return bar.time + 13.5 * 3600 <= now;
    });
}

export interface ResearchMarkerOptions {
    volume: boolean;
    divergence: boolean;
    flow: boolean;
    trend: boolean;
    trendShort: boolean;
    entry: boolean;
    shortEntry: boolean;
    tint: boolean;
    levels: boolean;
    opening: boolean;
    transitions: boolean;
    pivot: boolean;
    compact: boolean;
}
export const DEFAULT_MARKER_OPTIONS: ResearchMarkerOptions = {
    volume: true, divergence: true, flow: true, trend: true, trendShort: true, entry: true, shortEntry: true, tint: true, levels: true, opening: true, transitions: true, pivot: true, compact: true,
};

export function researchMarkerGap(visibleBars: number, width: number): number {
    return Math.max(5, Math.ceil(Math.max(1, visibleBars) * 64 / Math.max(100, width)));
}

/** Compact mode spaces volume labels and each price-side lane to fit the viewport.
 * A stronger volume pattern can replace a nearby weak DISPLAY label; the raw
 * observations and Tick classifications are unchanged. Full mode keeps all.
 * Exact bar membership prevents the library snapping missing-time markers onto
 * an unrelated old candle. Options are presentation-only, with no history calls.
 */
export function selectResearchMarkers(
    markers: V9ChartMarker[], barTimes: number[], options: ResearchMarkerOptions, minimumGap = 5,
): V9ChartMarker[] {
    const indices = new Map(barTimes.map((time, index) => [time, index]));
    const last = new Map<string, { index: number; slot: number }>();
    const selected: V9ChartMarker[] = [];
    const weight = (marker: V9ChartMarker) => marker.text === '攻' ? 3 : marker.text === '洗' ? 2 : 1;
    const sorted = [...markers].sort((a, b) => a.time - b.time
        || Number(b.group === 'flow') - Number(a.group === 'flow'));
    for (const marker of sorted) {
        const index = indices.get(marker.time);
        if (index === undefined || !options[marker.group]) continue;
        const key = marker.group === 'volume' ? 'volume' : marker.position;
        const previous = last.get(key);
        // Same-bar, same-side markers (e.g. long 平 + short 賣 on one flip) are
        // stacked labels that mergeResearchMarkerLabels combines later, so they
        // must bypass gap thinning instead of dropping each other.
        const sameBar = previous?.index === index;
        if (options.compact && previous && !sameBar && index - previous.index < Math.max(5, minimumGap)) {
            if (marker.group === 'volume' && weight(marker) > weight(selected[previous.slot]!)) {
                selected[previous.slot] = marker;
                last.set(key, { index, slot: previous.slot });
            }
            continue;
        }
        last.set(key, { index, slot: selected.length });
        selected.push(marker);
    }
    return selected.sort((a, b) => a.time - b.time);
}

/** Full mode keeps every observation but combines same-candle, same-side text. */
export function mergeResearchMarkerLabels(markers: V9ChartMarker[]): V9ChartMarker[] {
    const slots = new Map<string, V9ChartMarker>();
    for (const marker of markers) {
        const key = `${marker.time}|${marker.position}`;
        const slot = slots.get(key);
        if (slot) slot.text += `·${marker.text}`;
        else slots.set(key, { ...marker });
    }
    return [...slots.values()];
}
