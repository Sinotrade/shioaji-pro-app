import type { Candle } from './types/market';

export interface DailyBreakoutSettings {
    trendType: 'sma' | 'ema';
    trendPeriod: number;
    breakoutLookback: number;
    volumeLookback: number;
    volumeMultiple: number;
}

/** Research defaults, not the unknown formula in the reference screenshots. */
export const DEFAULT_DAILY_BREAKOUT_SETTINGS: Readonly<DailyBreakoutSettings> = Object.freeze({
    trendType: 'sma', trendPeriod: 20, breakoutLookback: 10,
    volumeLookback: 20, volumeMultiple: 1.5,
});

export interface DailyBreakoutEvent {
    time: number;
    type: 'start' | 'exit';
    /** Confirmed daily close; never an assumed execution/fill price. */
    close: number;
    trend: number;
    level: number;
    volumeRatio: number | null;
    reason: string;
}

export interface DailyBreakoutSnapshot {
    asOf: number;
    close: number;
    trend: number | null;
    prevHigh: number | null;
    volumeRatio: number | null;
    rsi14: number | null;
    ma20: number | null;
    changePct: number | null;
    gapPct: number | null;
    chg3Pct: number | null;
    biasPct: number | null;
    exclusionReasons: string[];
    status: 'warming-up' | 'start' | 'tracking' | 'exit' | 'excluded' | 'waiting';
}

export interface DailyBreakoutStudy {
    candles: Candle[];
    trendLine: { time: number; value: number }[];
    events: DailyBreakoutEvent[];
    latest: DailyBreakoutSnapshot | null;
    tracking: boolean;
    trackingSince: number | null;
    dataError: string | null;
}

const empty = (dataError: string | null): DailyBreakoutStudy => ({
    candles: [], trendLine: [], events: [], latest: null,
    tracking: false, trackingSince: null, dataError,
});

// Roundoff tolerance only (not a market-price buffer): exact exclusion limits
// retain their stated strict > or inclusive >= semantics for decimal prices.
const tolerance = (a: number, b: number) => Number.EPSILON * 64 * Math.max(1, Math.abs(a), Math.abs(b));
const greater = (a: number, b: number) => a - b > tolerance(a, b);
const atLeast = (a: number, b: number) => a - b >= -tolerance(a, b);
const pct = (current: number, base: number) => (current / base - 1) * 100;

function validate(bars: Candle[], settings: DailyBreakoutSettings): string | null {
    if (settings.trendType !== 'sma' && settings.trendType !== 'ema') return '趨勢線種類無效';
    if (!Number.isInteger(settings.trendPeriod) || settings.trendPeriod < 2 || settings.trendPeriod > 500) {
        return '趨勢線週期須為 2～500 的整數';
    }
    for (const key of ['breakoutLookback', 'volumeLookback'] as const) {
        if (!Number.isInteger(settings[key]) || settings[key] < 1 || settings[key] > 500) {
            return '前高／均量週期須為 1～500 的整數';
        }
    }
    if (!Number.isFinite(settings.volumeMultiple) || settings.volumeMultiple <= 0 || settings.volumeMultiple > 20) {
        return '放量倍數須大於 0 且不超過 20';
    }
    let previousTime = -Infinity;
    for (let i = 0; i < bars.length; i++) {
        const bar = bars[i]!;
        if (!bar || !Number.isSafeInteger(bar.time) || bar.time < 0 || bar.time <= previousTime) {
            return `第 ${i + 1} 根日K時間無效、重複或未遞增`;
        }
        // Daily chart labels are Taiwan calendar dates encoded as UTC midnight,
        // not intraday bars or real-time instants to be shifted another +8h.
        if (bar.time % 86400 !== 0) return `第 ${i + 1} 根資料不是午夜日期標籤的日K`;
        if (![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)
            || Math.min(bar.open, bar.high, bar.low, bar.close) <= 0 || bar.volume < 0
            || bar.high < Math.max(bar.open, bar.close, bar.low)
            || bar.low > Math.min(bar.open, bar.close, bar.high)) {
            return `第 ${i + 1} 根日K價量資料無效`;
        }
        previousTime = bar.time;
    }
    return null;
}

function simpleAverage(values: number[], period: number): (number | null)[] {
    const out: (number | null)[] = [];
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
        sum += values[i]!;
        if (i >= period) sum -= values[i - period]!;
        out.push(i >= period - 1 ? sum / period : null);
    }
    return out;
}

/** EMA starts at the mean of its first full window, not the first price. */
function exponentialAverage(values: number[], period: number): (number | null)[] {
    const out: (number | null)[] = Array(values.length).fill(null);
    if (values.length < period) return out;
    let previous = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
    out[period - 1] = previous;
    const alpha = 2 / (period + 1);
    for (let i = period; i < values.length; i++) {
        previous += alpha * (values[i]! - previous);
        out[i] = previous;
    }
    return out;
}

/** Wilder RSI14: seed 14 price changes, then causal recursive smoothing. */
function wilderRsi14(values: number[]): (number | null)[] {
    const out: (number | null)[] = Array(values.length).fill(null);
    let gain = 0;
    let loss = 0;
    for (let i = 1; i < values.length; i++) {
        const change = values[i]! - values[i - 1]!;
        if (i <= 14) {
            gain += Math.max(change, 0) / 14;
            loss += Math.max(-change, 0) / 14;
        } else {
            gain = (gain * 13 + Math.max(change, 0)) / 14;
            loss = (loss * 13 + Math.max(-change, 0)) / 14;
        }
        if (i >= 14) out[i] = gain === 0 && loss === 0 ? 50
            : loss === 0 ? 100 : gain === 0 ? 0 : 100 - 100 / (1 + gain / loss);
    }
    return out;
}

/** Inspect already-completed stock daily candles. No requests, clock, orders,
 * persistence, actual holding state, future pivots or retrospective markers.
 * The adapter must exclude the unclosed trading day before calling this.
 * Historical windows exclude today; the trend/RSI include today's close.
 */
export function buildDailyBreakoutStudy(
    completedDaily: Candle[],
    settings: DailyBreakoutSettings = DEFAULT_DAILY_BREAKOUT_SETTINGS,
): DailyBreakoutStudy {
    const dataError = validate(completedDaily, settings);
    if (dataError) return empty(dataError);
    if (!completedDaily.length) return empty(null);
    const candles = completedDaily.map(bar => ({ ...bar }));
    const closes = candles.map(bar => bar.close);
    const trends = settings.trendType === 'sma' ? simpleAverage(closes, settings.trendPeriod)
        : exponentialAverage(closes, settings.trendPeriod);
    const ma20Values = simpleAverage(closes, 20);
    const rsiValues = wilderRsi14(closes);
    const study: DailyBreakoutStudy = { ...empty(null), candles };

    for (let i = 0; i < candles.length; i++) {
        const bar = candles[i]!;
        const trend = trends[i] ?? null;
        const previousTrend = trends[i - 1] ?? null;
        const ma20 = ma20Values[i] ?? null;
        const rsi14 = rsiValues[i] ?? null;
        const previous = candles[i - 1];
        const changePct = previous ? pct(bar.close, previous.close) : null;
        const gapPct = previous ? pct(bar.open, previous.close) : null;
        const chg3Pct = i >= 3 ? pct(bar.close, candles[i - 3]!.close) : null;
        const biasPct = ma20 === null ? null : pct(bar.close, ma20);
        const prevHigh = i >= settings.breakoutLookback
            ? Math.max(...candles.slice(i - settings.breakoutLookback, i).map(item => item.high)) : null;
        const meanVolume = i >= settings.volumeLookback
            ? candles.slice(i - settings.volumeLookback, i).reduce((sum, item) => sum + item.volume, 0)
                / settings.volumeLookback : null;
        const volumeRatio = meanVolume !== null && meanVolume > 0 ? bar.volume / meanVolume : null;
        if ([trend, previousTrend, ma20, rsi14, changePct, gapPct, chg3Pct, biasPct,
            prevHigh, meanVolume, volumeRatio].some(value => value !== null && !Number.isFinite(value))) {
            return empty(`第 ${i + 1} 根日K衍生價量數值超出可計算範圍`);
        }
        const exclusionReasons: string[] = [];
        if (rsi14 !== null && greater(rsi14, 85)) exclusionReasons.push('RSI > 85');
        if (biasPct !== null && greater(biasPct, 15)) exclusionReasons.push('20MA 乖離 > 15%');
        if (changePct !== null && atLeast(changePct, 9)) exclusionReasons.push('單日漲幅 ≥ 9%');
        if (gapPct !== null && atLeast(gapPct, 8)) exclusionReasons.push('跳空 ≥ 8%');
        if (chg3Pct !== null && atLeast(chg3Pct, 22)) exclusionReasons.push('3日漲幅 ≥ 22%');
        const warmed = trend !== null && previousTrend !== null && ma20 !== null
            && rsi14 !== null && prevHigh !== null && meanVolume !== null && chg3Pct !== null;
        let status: DailyBreakoutSnapshot['status'] = warmed ? 'waiting' : 'warming-up';
        if (trend !== null) study.trendLine.push({ time: bar.time, value: trend });
        if (study.tracking) {
            // The exit gate has priority over every entry filter (incl. heat
            // and zero volume). A SELL marker does not imply an actual fill.
            if (trend !== null && greater(trend, bar.close)) {
                study.events.push({ time: bar.time, type: 'exit', close: bar.close,
                    trend, level: trend, volumeRatio, reason: '日K收盤跌破趨勢線，研究追蹤結束' });
                study.tracking = false;
                study.trackingSince = null;
                status = 'exit';
            } else status = 'tracking';
        } else if (warmed) {
            if (exclusionReasons.length) status = 'excluded';
            else if (volumeRatio !== null && greater(bar.close, prevHigh!)
                && atLeast(volumeRatio, settings.volumeMultiple)
                && greater(trend!, previousTrend!) && greater(bar.close, trend!)) {
                study.events.push({ time: bar.time, type: 'start', close: bar.close,
                    trend: trend!, level: prevHigh!, volumeRatio,
                    reason: `收盤突破前 ${settings.breakoutLookback} 日高點、放量且趨勢線上揚` });
                study.tracking = true;
                study.trackingSince = bar.time;
                status = 'start';
            }
        }
        study.latest = { asOf: bar.time, close: bar.close, trend, prevHigh, volumeRatio,
            rsi14, ma20, changePct, gapPct, chg3Pct, biasPct, exclusionReasons, status };
    }
    return study;
}
