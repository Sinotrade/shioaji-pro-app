// src/lib/indicators.ts — pure indicator computations on candles.
// Rendering/registry lives in indicator-defs.ts; this file is math only.
// Points may carry value: undefined to encode a gap (whitespace data).

import type { Candle } from './types/market';
import type { SecurityType } from './types/contract';
import { sessionWindowFor } from './intraday-session';

export interface IndicatorPoint {
    time: number;
    value?: number;
    color?: string;
}

const tp = (b: Candle) => (b.high + b.low + b.close) / 3;

export function sma(bars: Candle[], period: number): IndicatorPoint[] {
    const out: IndicatorPoint[] = [];
    let sum = 0;
    for (let i = 0; i < bars.length; i++) {
        sum += bars[i]!.close;
        if (i >= period) sum -= bars[i - period]!.close;
        if (i >= period - 1) {
            out.push({ time: bars[i]!.time, value: sum / period });
        }
    }
    return out;
}

// EMA seeded with the SMA of the first `period` closes (standard seeding)
export function ema(bars: Candle[], period: number): IndicatorPoint[] {
    return emaOf(
        bars.map((b) => ({ time: b.time, value: b.close })),
        period,
    );
}

function emaOf(points: IndicatorPoint[], period: number): IndicatorPoint[] {
    const out: IndicatorPoint[] = [];
    const k = 2 / (period + 1);
    let prev: number | null = null;
    let seedSum = 0;
    let seedCount = 0;
    for (const p of points) {
        if (p.value === undefined) continue;
        if (prev === null) {
            seedSum += p.value;
            seedCount += 1;
            if (seedCount === period) {
                prev = seedSum / period;
                out.push({ time: p.time, value: prev });
            }
            continue;
        }
        prev = p.value * k + prev * (1 - k);
        out.push({ time: p.time, value: prev });
    }
    return out;
}

export function wma(bars: Candle[], period: number): IndicatorPoint[] {
    const out: IndicatorPoint[] = [];
    const denom = (period * (period + 1)) / 2;
    for (let i = period - 1; i < bars.length; i++) {
        let sum = 0;
        for (let j = 0; j < period; j++) {
            sum += bars[i - j]!.close * (period - j);
        }
        out.push({ time: bars[i]!.time, value: sum / denom });
    }
    return out;
}

export function bollinger(
    bars: Candle[],
    period = 20,
    mult = 2,
): { mid: IndicatorPoint[]; upper: IndicatorPoint[]; lower: IndicatorPoint[] } {
    const mid: IndicatorPoint[] = [];
    const upper: IndicatorPoint[] = [];
    const lower: IndicatorPoint[] = [];
    let sum = 0;
    let sqSum = 0;
    for (let i = 0; i < bars.length; i++) {
        const c = bars[i]!.close;
        sum += c;
        sqSum += c * c;
        if (i >= period) {
            const o = bars[i - period]!.close;
            sum -= o;
            sqSum -= o * o;
        }
        if (i >= period - 1) {
            const mean = sum / period;
            const sd = Math.sqrt(Math.max(0, sqSum / period - mean * mean));
            const t = bars[i]!.time;
            mid.push({ time: t, value: mean });
            upper.push({ time: t, value: mean + mult * sd });
            lower.push({ time: t, value: mean - mult * sd });
        }
    }
    return { mid, upper, lower };
}

// VWAP resets at each trading day boundary
export function vwap(bars: Candle[]): IndicatorPoint[] {
    const out: IndicatorPoint[] = [];
    let pv = 0;
    let vol = 0;
    let day = -1;
    for (const b of bars) {
        const d = Math.floor(b.time / 86400);
        if (d !== day) {
            day = d;
            pv = 0;
            vol = 0;
        }
        pv += tp(b) * b.volume;
        vol += b.volume;
        if (vol > 0) out.push({ time: b.time, value: pv / vol });
    }
    return out;
}

// V9 畫面使用的 BBI：MA(3)、MA(6)、MA(12)、MA(24) 的平均。
// 原 V9 對前段資料採用「可用根數」的 SMA，因此這裡也從第一根開始
// 回傳數值，讓歷史不足 24 根時畫面不會留一大片空白。
export function bbi(
    bars: Candle[],
    periods: readonly number[] = [3, 6, 12, 24],
): IndicatorPoint[] {
    if (periods.length === 0) return [];
    const closes = bars.map((bar) => bar.close);
    return bars.map((bar, index) => {
        const value = periods.reduce((total, period) => {
            const start = Math.max(0, index - period + 1);
            let sum = 0;
            for (let i = start; i <= index; i++) sum += closes[i]!;
            return total + sum / (index - start + 1);
        }, 0) / periods.length;
        return { time: bar.time, value };
    });
}

// Parabolic SAR (Wilder)
export function sar(bars: Candle[], step = 0.02, max = 0.2): IndicatorPoint[] {
    const out: IndicatorPoint[] = [];
    if (bars.length < 2) return out;
    let rising = bars[1]!.close >= bars[0]!.close;
    let cur = rising ? bars[0]!.low : bars[0]!.high;
    let ep = rising ? bars[0]!.high : bars[0]!.low;
    let af = step;
    for (let i = 1; i < bars.length; i++) {
        const b = bars[i]!;
        cur = cur + af * (ep - cur);
        if (rising) {
            cur = Math.min(cur, bars[i - 1]!.low, bars[i - 2]?.low ?? Infinity);
            if (b.low < cur) {
                rising = false;
                cur = ep;
                ep = b.low;
                af = step;
            } else if (b.high > ep) {
                ep = b.high;
                af = Math.min(max, af + step);
            }
        } else {
            cur = Math.max(
                cur,
                bars[i - 1]!.high,
                bars[i - 2]?.high ?? -Infinity,
            );
            if (b.high > cur) {
                rising = true;
                cur = ep;
                ep = b.high;
                af = step;
            } else if (b.low < ep) {
                ep = b.low;
                af = Math.min(max, af + step);
            }
        }
        out.push({ time: b.time, value: cur });
    }
    return out;
}

export function donchian(
    bars: Candle[],
    period = 20,
): { upper: IndicatorPoint[]; mid: IndicatorPoint[]; lower: IndicatorPoint[] } {
    const upper: IndicatorPoint[] = [];
    const mid: IndicatorPoint[] = [];
    const lower: IndicatorPoint[] = [];
    for (let i = period - 1; i < bars.length; i++) {
        let hi = -Infinity;
        let lo = Infinity;
        for (let j = i - period + 1; j <= i; j++) {
            hi = Math.max(hi, bars[j]!.high);
            lo = Math.min(lo, bars[j]!.low);
        }
        const t = bars[i]!.time;
        upper.push({ time: t, value: hi });
        lower.push({ time: t, value: lo });
        mid.push({ time: t, value: (hi + lo) / 2 });
    }
    return { upper, mid, lower };
}

// true range series (index-aligned with bars, first bar = high-low)
function trueRanges(bars: Candle[]): number[] {
    const tr: number[] = [];
    for (let i = 0; i < bars.length; i++) {
        const b = bars[i]!;
        if (i === 0) {
            tr.push(b.high - b.low);
            continue;
        }
        const pc = bars[i - 1]!.close;
        tr.push(
            Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)),
        );
    }
    return tr;
}

// Wilder smoothing (RMA)
function rma(values: number[], period: number): (number | undefined)[] {
    const out: (number | undefined)[] = [];
    let prev: number | null = null;
    let seed = 0;
    for (let i = 0; i < values.length; i++) {
        if (prev === null) {
            seed += values[i]!;
            if (i === period - 1) {
                prev = seed / period;
                out.push(prev);
            } else {
                out.push(undefined);
            }
            continue;
        }
        prev = (prev * (period - 1) + values[i]!) / period;
        out.push(prev);
    }
    return out;
}

export function atr(bars: Candle[], period = 14): IndicatorPoint[] {
    const smoothed = rma(trueRanges(bars), period);
    const out: IndicatorPoint[] = [];
    for (let i = 0; i < bars.length; i++) {
        const v = smoothed[i];
        if (v !== undefined) out.push({ time: bars[i]!.time, value: v });
    }
    return out;
}

export function keltner(
    bars: Candle[],
    emaPeriod = 20,
    atrPeriod = 10,
    mult = 2,
): { mid: IndicatorPoint[]; upper: IndicatorPoint[]; lower: IndicatorPoint[] } {
    const midLine = ema(bars, emaPeriod);
    const atrLine = atr(bars, atrPeriod);
    const atrAt = new Map(atrLine.map((p) => [p.time, p.value!]));
    const mid: IndicatorPoint[] = [];
    const upper: IndicatorPoint[] = [];
    const lower: IndicatorPoint[] = [];
    for (const p of midLine) {
        const a = atrAt.get(p.time);
        if (a === undefined || p.value === undefined) continue;
        mid.push(p);
        upper.push({ time: p.time, value: p.value + mult * a });
        lower.push({ time: p.time, value: p.value - mult * a });
    }
    return { mid, upper, lower };
}

// SuperTrend — two series (up-trend line below price / down-trend line above)
// with whitespace gaps so the inactive side isn't drawn. `flips` records the
// first bar whose confirmed close flips the trend; presentation-only.
export interface SuperTrendFlip {
    time: number;
    /** 1 = close reclaimed the upper band (bear→bull, long entry); -1 = close broke the lower band (bull→bear, long exit) */
    direction: 1 | -1;
}

export function supertrend(
    bars: Candle[],
    period = 10,
    mult = 3,
): { up: IndicatorPoint[]; down: IndicatorPoint[]; flips: SuperTrendFlip[] } {
    const atrLine = rma(trueRanges(bars), period);
    const up: IndicatorPoint[] = [];
    const down: IndicatorPoint[] = [];
    const flips: SuperTrendFlip[] = [];
    // Standard SuperTrend ratchet vs the previous *closed* bar: the lower band
    // (support) only rises and the upper band (resistance) only falls; once the
    // prior close breaks a band, that band is allowed to reset instead of being
    // pinned at the old level (pinning it whipsaws flips inside a strong trend).
    let prevUpper = NaN;
    let prevLower = NaN;
    let trend: 1 | -1 = 1;
    let prevClose = NaN;
    for (let i = 0; i < bars.length; i++) {
        const b = bars[i]!;
        const a = atrLine[i];
        if (a === undefined) {
            up.push({ time: b.time });
            down.push({ time: b.time });
            prevClose = b.close;
            continue;
        }
        const mid = (b.high + b.low) / 2;
        const basicUpper = mid + mult * a;
        const basicLower = mid - mult * a;
        let upper: number;
        let lower: number;
        if (Number.isNaN(prevUpper)) {
            upper = basicUpper;
            lower = basicLower;
        } else {
            lower = basicLower > prevLower || prevClose < prevLower ? basicLower : prevLower;
            upper = basicUpper < prevUpper || prevClose > prevUpper ? basicUpper : prevUpper;
        }
        // Flip only on this bar's confirmed close; the 買/平 marker is a long
        // entry/exit reference for the following bar, never an order.
        let nextTrend: 1 | -1 = trend;
        if (trend === -1 && b.close > upper) {
            nextTrend = 1;
        } else if (trend === 1 && b.close < lower) {
            nextTrend = -1;
        }
        if (nextTrend !== trend) {
            flips.push({ time: b.time, direction: nextTrend });
        }
        trend = nextTrend;
        up.push(trend === 1 ? { time: b.time, value: lower } : { time: b.time });
        down.push(trend === 1 ? { time: b.time } : { time: b.time, value: upper });
        prevUpper = upper;
        prevLower = lower;
        prevClose = b.close;
    }
    return { up, down, flips };
}

function v9Ema(values: number[], period: number): number[] {
    const alpha = 2 / (period + 1);
    const out: number[] = [];
    for (let index = 0; index < values.length; index++) {
        const value = values[index]!;
        out.push(index === 0 ? value : value * alpha + out[index - 1]! * (1 - alpha));
    }
    return out;
}

function taiwanSessionKey(time: number, securityType: SecurityType): string {
    // Chart timestamps encode Taiwan wall-clock as UTC seconds. Use the same
    // exchange session window as bar aggregation so futures 15:00–05:00 stays
    // intact across midnight without a second timezone shift.
    return String(sessionWindowFor(securityType, time).start);
}

/** V9 KDJ: RSV then EMA smoothing, matching the original V9 chart formula. */
export function v9Kdj(
    bars: Candle[],
    rsvPeriod = 45,
    kPeriod = 9,
    dPeriod = 9,
): { k: IndicatorPoint[]; d: IndicatorPoint[]; j: IndicatorPoint[] } {
    const rsv = bars.map((bar, index) => {
        if (index < rsvPeriod - 1) return 50;
        let high = -Infinity;
        let low = Infinity;
        for (let i = index - rsvPeriod + 1; i <= index; i++) {
            high = Math.max(high, bars[i]!.high);
            low = Math.min(low, bars[i]!.low);
        }
        return high > low ? ((bar.close - low) / (high - low)) * 100 : 50;
    });
    const kValues = v9Ema(rsv, kPeriod);
    const dValues = v9Ema(kValues, dPeriod);
    return {
        k: bars.map((bar, index) => ({ time: bar.time, value: kValues[index] })),
        d: bars.map((bar, index) => ({ time: bar.time, value: dValues[index] })),
        j: bars.map((bar, index) => ({ time: bar.time, value: 3 * kValues[index]! - 2 * dValues[index]! })),
    };
}

function v9Rsi(values: number[], period = 9): number[] {
    const out = new Array(values.length).fill(50);
    let gain = 0;
    let loss = 0;
    for (let index = 1; index < values.length; index++) {
        const change = values[index]! - values[index - 1]!;
        const up = Math.max(0, change);
        const down = Math.max(0, -change);
        if (index <= period) {
            gain += up;
            loss += down;
        } else {
            gain = (gain * (period - 1) + up) / period;
            loss = (loss * (period - 1) + down) / period;
        }
        if (index >= period) out[index] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
}

/** V8 多空線：V9 的視覺確認分數，非進出場策略。 */
export function v8CompositeTrend(bars: Candle[]): IndicatorPoint[] {
    const weighted = bars.map((bar) => (bar.high + bar.low + 2 * bar.close) / 4);
    const fast = v9Ema(weighted, 45);
    const slow = v9Ema(weighted, 117);
    const dif = fast.map((value, index) => value - slow[index]!);
    const dea = v9Ema(dif, 17);
    const osc = dif.map((value, index) => value - dea[index]!);
    const kd = v9Kdj(bars);
    const kValues = kd.k.map((point) => point.value!);
    const dValues = kd.d.map((point) => point.value!);
    const rsiValues = v9Rsi(bars.map((bar) => bar.close));
    const raw = bars.map((_, index) => {
        const recent = osc.slice(Math.max(0, index - 29), index + 1).map(Math.abs);
        const scale = Math.max(0.000001, ...recent);
        const macdScore = Math.max(0, Math.min(100, 50 + (osc[index]! / scale) * 42));
        const kdjScore = Math.max(0, Math.min(100,
            50 + (kValues[index]! - dValues[index]!) * 1.8 + (kValues[index]! - 50) * 0.35,
        ));
        return Math.max(0, Math.min(100,
            rsiValues[index]! * 0.35 + kdjScore * 0.35 + macdScore * 0.30,
        ));
    });
    const smoothed = v9Ema(raw, 3);
    return bars.map((bar, index) => ({ time: bar.time, value: smoothed[index] }));
}

/**
 * V9 ATR 防守線的研究版圖層。只根據 V8 多空線的確認方向繪製防守軌，
 * 不產生下單、警示或回測訊號。
 */
export function v9AtrDefense(
    bars: Candle[],
    period = 14,
    multiple = 2,
    securityType: SecurityType = 'STK',
    timeframeMinutes = 1,
): { up: IndicatorPoint[]; down: IndicatorPoint[] } {
    const trend = v8CompositeTrend(bars).map((point) => point.value ?? 50);
    const up: IndicatorPoint[] = [];
    const down: IndicatorPoint[] = [];
    const alpha = 2 / (period + 1);
    let atrValue = 0;
    let sessionBar = 0;
    let previousKey = '';
    let previousClose = 0;
    let visualSide = 0;
    let pending = 0;
    let pendingCount = 0;
    let side = 0;
    let defense = 0;
    let blockedSide = 0;
    for (let index = 0; index < bars.length; index++) {
        const bar = bars[index]!;
        // Intraday rails restart at each exchange session. Daily candles are
        // already session-complete observations, so their ATR/trend state must
        // carry across days to warm up and produce a usable daily rail.
        const key = timeframeMinutes >= 1440 ? 'daily-series' : taiwanSessionKey(bar.time, securityType);
        const newSession = key !== previousKey;
        const tr = newSession || index === 0
            ? bar.high - bar.low
            : Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
        atrValue = newSession ? tr : tr * alpha + atrValue * (1 - alpha);
        if (newSession) {
            visualSide = 0;
            pending = 0;
            pendingCount = 0;
            side = 0;
            defense = 0;
            blockedSide = 0;
            sessionBar = 0;
            previousKey = key;
        }
        sessionBar += 1;
        const rawSide = trend[index]! >= 55 ? 1 : trend[index]! <= 45 ? -1 : 0;
        if (rawSide === visualSide) {
            pending = 0;
            pendingCount = 0;
        } else if (rawSide === pending) {
            pendingCount += 1;
        } else {
            pending = rawSide;
            pendingCount = 1;
        }
        if (pendingCount >= 2) {
            visualSide = pending;
            pending = 0;
            pendingCount = 0;
        }
        if (blockedSide !== 0 && visualSide !== blockedSide) blockedSide = 0;
        // ATR 防守軌只在 ATR 已完成暖機且為正時才輸出。開盤前 period 根 ATR
        // 尚未收斂；零波動（ATR≈0，見於處置/停牌股、或歷史分鐘 K 缺失被扁平
        // 回填成 high=low=close）會讓 candidate = high - 2*ATR 退化為 high，使
        // 多方軌貼到 K 棒最高價（空方對稱貼最低價），看似跑到價格另一側。這些
        // 情況一律留白（不更新 ratchet、不輸出該根），底色也隨之保持中性。
        const atrReady = sessionBar > period && atrValue > 1e-9;
        if (atrReady) {
            if (side === 1 && defense > 0 && bar.close <= defense) {
                blockedSide = 1;
                side = 0;
                defense = 0;
            } else if (side === -1 && defense > 0 && bar.close >= defense) {
                blockedSide = -1;
                side = 0;
                defense = 0;
            }
            if (visualSide === 1 && blockedSide !== 1) {
                const candidate = Math.min(bar.high - atrValue * multiple, bar.close - atrValue * 0.1);
                defense = side === 1 && defense > 0 ? Math.max(defense, candidate) : candidate;
                side = 1;
            } else if (visualSide === -1 && blockedSide !== -1) {
                const candidate = Math.max(bar.low + atrValue * multiple, bar.close + atrValue * 0.1);
                defense = side === -1 && defense > 0 ? Math.min(defense, candidate) : candidate;
                side = -1;
            }
        }
        const drawSide = atrReady ? side : 0;
        // Draw the actual invalidation boundary: no hidden offset between
        // the displayed rail and the close used to invalidate it.
        up.push(drawSide === 1 ? { time: bar.time, value: defense } : { time: bar.time });
        down.push(drawSide === -1 ? { time: bar.time, value: defense } : { time: bar.time });
        previousClose = bar.close;
    }
    return { up, down };
}

// ---- oscillators（副圖）----

export function rsi(bars: Candle[], period = 14): IndicatorPoint[] {
    const gains: number[] = [];
    const losses: number[] = [];
    for (let i = 1; i < bars.length; i++) {
        const chg = bars[i]!.close - bars[i - 1]!.close;
        gains.push(Math.max(0, chg));
        losses.push(Math.max(0, -chg));
    }
    const avgG = rma(gains, period);
    const avgL = rma(losses, period);
    const out: IndicatorPoint[] = [];
    for (let i = 0; i < gains.length; i++) {
        const g = avgG[i];
        const l = avgL[i];
        if (g === undefined || l === undefined) continue;
        const v = l === 0 ? 100 : 100 - 100 / (1 + g / l);
        out.push({ time: bars[i + 1]!.time, value: v });
    }
    return out;
}

export function macd(
    bars: Candle[],
    fast = 12,
    slow = 26,
    signalPeriod = 9,
): { macd: IndicatorPoint[]; signal: IndicatorPoint[]; hist: IndicatorPoint[] } {
    const fastE = ema(bars, fast);
    const slowE = ema(bars, slow);
    const fastAt = new Map(fastE.map((p) => [p.time, p.value!]));
    const macdLine: IndicatorPoint[] = [];
    for (const p of slowE) {
        const f = fastAt.get(p.time);
        if (f === undefined || p.value === undefined) continue;
        macdLine.push({ time: p.time, value: f - p.value });
    }
    const signal = emaOf(macdLine, signalPeriod);
    const sigAt = new Map(signal.map((p) => [p.time, p.value!]));
    const hist: IndicatorPoint[] = [];
    for (const p of macdLine) {
        const s = sigAt.get(p.time);
        if (s === undefined || p.value === undefined) continue;
        hist.push({ time: p.time, value: p.value - s });
    }
    return { macd: macdLine, signal, hist };
}

// KD（Stochastic）台股慣用 (9,3,3)：RSV 的 SMA 平滑
export function stoch(
    bars: Candle[],
    kPeriod = 9,
    kSmooth = 3,
    dPeriod = 3,
): { k: IndicatorPoint[]; d: IndicatorPoint[]; j: IndicatorPoint[] } {
    const rsv: IndicatorPoint[] = [];
    for (let i = kPeriod - 1; i < bars.length; i++) {
        let hi = -Infinity;
        let lo = Infinity;
        for (let j = i - kPeriod + 1; j <= i; j++) {
            hi = Math.max(hi, bars[j]!.high);
            lo = Math.min(lo, bars[j]!.low);
        }
        const range = hi - lo;
        rsv.push({
            time: bars[i]!.time,
            value: range === 0 ? 50 : ((bars[i]!.close - lo) / range) * 100,
        });
    }
    const k = smaOf(rsv, kSmooth);
    const d = smaOf(k, dPeriod);
    const dAt = new Map(d.map((p) => [p.time, p.value]));
    const j = k.flatMap((point) => {
        const dValue = dAt.get(point.time);
        if (point.value === undefined || dValue === undefined) return [];
        return [{ time: point.time, value: 3 * point.value - 2 * dValue }];
    });
    return { k, d, j };
}

function smaOf(points: IndicatorPoint[], period: number): IndicatorPoint[] {
    const out: IndicatorPoint[] = [];
    let sum = 0;
    const vals: number[] = [];
    for (const p of points) {
        if (p.value === undefined) continue;
        vals.push(p.value);
        sum += p.value;
        if (vals.length > period) sum -= vals[vals.length - period - 1]!;
        if (vals.length >= period) {
            out.push({ time: p.time, value: sum / period });
        }
    }
    return out;
}

export function stochRsi(
    bars: Candle[],
    rsiPeriod = 14,
    stochPeriod = 14,
    kSmooth = 3,
    dSmooth = 3,
): { k: IndicatorPoint[]; d: IndicatorPoint[] } {
    const r = rsi(bars, rsiPeriod);
    const raw: IndicatorPoint[] = [];
    for (let i = stochPeriod - 1; i < r.length; i++) {
        let hi = -Infinity;
        let lo = Infinity;
        for (let j = i - stochPeriod + 1; j <= i; j++) {
            hi = Math.max(hi, r[j]!.value!);
            lo = Math.min(lo, r[j]!.value!);
        }
        const range = hi - lo;
        raw.push({
            time: r[i]!.time,
            value: range === 0 ? 50 : ((r[i]!.value! - lo) / range) * 100,
        });
    }
    const k = smaOf(raw, kSmooth);
    const d = smaOf(k, dSmooth);
    return { k, d };
}

export function cci(bars: Candle[], period = 20): IndicatorPoint[] {
    const out: IndicatorPoint[] = [];
    for (let i = period - 1; i < bars.length; i++) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += tp(bars[j]!);
        const mean = sum / period;
        let dev = 0;
        for (let j = i - period + 1; j <= i; j++) {
            dev += Math.abs(tp(bars[j]!) - mean);
        }
        const md = dev / period;
        out.push({
            time: bars[i]!.time,
            value: md === 0 ? 0 : (tp(bars[i]!) - mean) / (0.015 * md),
        });
    }
    return out;
}

export function obv(bars: Candle[]): IndicatorPoint[] {
    const out: IndicatorPoint[] = [];
    let acc = 0;
    for (let i = 0; i < bars.length; i++) {
        if (i > 0) {
            const chg = bars[i]!.close - bars[i - 1]!.close;
            if (chg > 0) acc += bars[i]!.volume;
            else if (chg < 0) acc -= bars[i]!.volume;
        }
        out.push({ time: bars[i]!.time, value: acc });
    }
    return out;
}

export function mfi(bars: Candle[], period = 14): IndicatorPoint[] {
    const out: IndicatorPoint[] = [];
    const pos: number[] = [];
    const neg: number[] = [];
    for (let i = 1; i < bars.length; i++) {
        const cur = tp(bars[i]!);
        const prev = tp(bars[i - 1]!);
        const flow = cur * bars[i]!.volume;
        pos.push(cur > prev ? flow : 0);
        neg.push(cur < prev ? flow : 0);
        if (pos.length > period) {
            pos.shift();
            neg.shift();
        }
        if (pos.length === period) {
            const p = pos.reduce((a, b) => a + b, 0);
            const n = neg.reduce((a, b) => a + b, 0);
            out.push({
                time: bars[i]!.time,
                value: n === 0 ? 100 : 100 - 100 / (1 + p / n),
            });
        }
    }
    return out;
}

export function willr(bars: Candle[], period = 14): IndicatorPoint[] {
    const out: IndicatorPoint[] = [];
    for (let i = period - 1; i < bars.length; i++) {
        let hi = -Infinity;
        let lo = Infinity;
        for (let j = i - period + 1; j <= i; j++) {
            hi = Math.max(hi, bars[j]!.high);
            lo = Math.min(lo, bars[j]!.low);
        }
        const range = hi - lo;
        out.push({
            time: bars[i]!.time,
            value: range === 0 ? -50 : ((hi - bars[i]!.close) / range) * -100,
        });
    }
    return out;
}

export function dmi(
    bars: Candle[],
    period = 14,
    adxPeriod = 14,
): { plus: IndicatorPoint[]; minus: IndicatorPoint[]; adx: IndicatorPoint[] } {
    const plusDM: number[] = [];
    const minusDM: number[] = [];
    const tr: number[] = [];
    for (let i = 1; i < bars.length; i++) {
        const upMove = bars[i]!.high - bars[i - 1]!.high;
        const downMove = bars[i - 1]!.low - bars[i]!.low;
        plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
        minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
        const pc = bars[i - 1]!.close;
        tr.push(
            Math.max(
                bars[i]!.high - bars[i]!.low,
                Math.abs(bars[i]!.high - pc),
                Math.abs(bars[i]!.low - pc),
            ),
        );
    }
    const sTR = rma(tr, period);
    const sPlus = rma(plusDM, period);
    const sMinus = rma(minusDM, period);
    const plus: IndicatorPoint[] = [];
    const minus: IndicatorPoint[] = [];
    const dx: IndicatorPoint[] = [];
    for (let i = 0; i < tr.length; i++) {
        const t = sTR[i];
        const p = sPlus[i];
        const m = sMinus[i];
        if (t === undefined || p === undefined || m === undefined || t === 0) {
            continue;
        }
        const time = bars[i + 1]!.time;
        const pdi = (p / t) * 100;
        const mdi = (m / t) * 100;
        plus.push({ time, value: pdi });
        minus.push({ time, value: mdi });
        const sum = pdi + mdi;
        dx.push({ time, value: sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100 });
    }
    // ADX = RMA of DX
    const adxVals = rma(
        dx.map((p) => p.value!),
        adxPeriod,
    );
    const adx: IndicatorPoint[] = [];
    for (let i = 0; i < dx.length; i++) {
        const v = adxVals[i];
        if (v !== undefined) adx.push({ time: dx[i]!.time, value: v });
    }
    return { plus, minus, adx };
}

export function roc(bars: Candle[], period = 12): IndicatorPoint[] {
    const out: IndicatorPoint[] = [];
    for (let i = period; i < bars.length; i++) {
        const base = bars[i - period]!.close;
        if (base === 0) continue;
        out.push({
            time: bars[i]!.time,
            value: ((bars[i]!.close - base) / base) * 100,
        });
    }
    return out;
}

// 乖離率 BIAS = (close - MA) / MA × 100
export function bias(bars: Candle[], period = 20): IndicatorPoint[] {
    const ma = sma(bars, period);
    const out: IndicatorPoint[] = [];
    const maAt = new Map(ma.map((p) => [p.time, p.value!]));
    for (const b of bars) {
        const m = maAt.get(b.time);
        if (m === undefined || m === 0) continue;
        out.push({ time: b.time, value: ((b.close - m) / m) * 100 });
    }
    return out;
}
