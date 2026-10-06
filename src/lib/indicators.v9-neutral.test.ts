import { describe, expect, it } from 'vitest';
import { v8CompositeTrend, v9AtrDefense, v9Kdj } from './indicators';
import { v9Resonance, v9TrendTint } from './utils/research-chart';
import type { Candle } from './types/market';

// Chart time is Taiwan wall-clock encoded as UTC seconds (no extra +8 shift).
const opening = Date.UTC(2026, 9, 2, 9, 1) / 1000;
const candles = (closes: number[], volume = 1, range = 0): Candle[] =>
    closes.map((close, index) => ({
        time: opening + index * 60,
        open: close,
        high: close + range,
        low: close - range,
        close,
        volume,
    }));

function seededEma(values: number[], period: number): number[] {
    const alpha = 2 / (period + 1);
    return values.reduce<number[]>((out, value) => {
        out.push(out.length ? value * alpha + out.at(-1)! * (1 - alpha) : value);
        return out;
    }, []);
}

/** Recover just the RSI contribution through V8's public output. This avoids
 * exporting a private helper solely for tests, and pins the existing 35/35/30
 * weights, EMA3 smoothing and MACD45/117/17 rather than changing their defaults. */
function compositeRsiAt(bars: Candle[], index: number): number {
    const trend = v8CompositeTrend(bars).map(point => point.value!);
    const raw = index === 0 ? trend[0]! : 2 * trend[index]! - trend[index - 1]!;
    const weighted = bars.map(bar => (bar.high + bar.low + 2 * bar.close) / 4);
    const fast = seededEma(weighted, 45);
    const slow = seededEma(weighted, 117);
    const dif = fast.map((value, i) => value - slow[i]!);
    const dea = seededEma(dif, 17);
    const osc = dif.map((value, i) => value - dea[i]!);
    const scale = Math.max(0.000001, ...osc.slice(Math.max(0, index - 29), index + 1).map(Math.abs));
    const macdScore = Math.max(0, Math.min(100, 50 + osc[index]! / scale * 42));
    const kd = v9Kdj(bars);
    const k = kd.k[index]!.value!;
    const d = kd.d[index]!.value!;
    const kdjScore = Math.max(0, Math.min(100, 50 + (k - d) * 1.8 + (k - 50) * 0.35));
    return (raw - kdjScore * 0.35 - macdScore * 0.30) / 0.35;
}

describe('V9 RSI neutral and Wilder seed regression', () => {
    it.each([0, 0.001, 1])('keeps 200 unchanged zero-range bars neutral with volume %s', volume => {
        const flat = candles(Array(200).fill(100), volume);
        const trend = v8CompositeTrend(flat);
        expect(trend).toHaveLength(200);
        trend.forEach(point => expect(point.value).toBeCloseTo(50, 10));
        const defense = v9AtrDefense(flat);
        expect(defense.up.every(point => point.value === undefined)).toBe(true);
        expect(defense.down.every(point => point.value === undefined)).toBe(true);
        expect(v9TrendTint(flat).every(point => point.side === 0)).toBe(true);
        expect(v9Resonance(flat).frames.every(frame =>
            frame.side === 'neutral' || frame.side === 'insufficient',
        )).toBe(true);
    });

    it('does not create a bullish ATR rail when unchanged closes still have a positive intrabar range', () => {
        // ATR > 0 here, so zero-ATR suppression alone cannot hide the RSI bug.
        const flat = candles(Array(200).fill(100), 0, 1);
        v8CompositeTrend(flat).forEach(point => expect(point.value).toBeCloseTo(50, 10));
        const defense = v9AtrDefense(flat);
        expect(defense.up.every(point => point.value === undefined)).toBe(true);
        expect(defense.down.every(point => point.value === undefined)).toBe(true);
        expect(v9TrendTint(flat).every(point => point.side === 0)).toBe(true);
    });

    it('keeps every sufficiently sampled flat timeframe neutral instead of four-timeframe long resonance', () => {
        const flatDaily = candles(Array(200).fill(100), 1, 1).map((bar, index) => ({
            ...bar,
            time: Date.UTC(2025, 0, 1 + index, 9, 1) / 1000,
        }));
        const result = v9Resonance(flatDaily);
        expect(result.frames.every(frame => frame.side === 'neutral')).toBe(true);
        expect(result.summary).toBe('多0／空0／中4');
    });

    it.each([1, -1] as const)('preserves one-sided RSI and direction for a %s slope', direction => {
        const ramp = candles(Array.from({ length: 200 }, (_, i) => 100 + direction * i * 0.1), 1, 0.2);
        expect(compositeRsiAt(ramp, 9)).toBeCloseTo(direction === 1 ? 100 : 0, 10);
        expect(compositeRsiAt(ramp, 10)).toBeCloseTo(direction === 1 ? 100 : 0, 10);
        const last = v8CompositeTrend(ramp).at(-1)!.value!;
        expect(direction === 1 ? last >= 55 : last <= 45).toBe(true);
        const defense = v9AtrDefense(ramp);
        expect((direction === 1 ? defense.up : defense.down).some(point => point.value !== undefined)).toBe(true);
        expect((direction === 1 ? defense.down : defense.up).every(point => point.value === undefined)).toBe(true);
    });

    it.each([1, -1] as const)('averages the initial nine RSI changes before the first opposite move (%s)', direction => {
        const closes = Array.from({ length: 10 }, (_, i) => 100 + direction * i);
        closes.push(closes.at(-1)! - direction);
        closes.push(closes.at(-1)!);
        const bars = candles(closes);
        // Nine +1 changes seed avgGain=1; the next -1 gives avgGain=8/9,
        // avgLoss=1/9, RSI=88.888... (the bearish mirror is 11.111...).
        const expected = direction === 1 ? 800 / 9 : 100 / 9;
        expect(compositeRsiAt(bars, 10)).toBeCloseTo(expected, 10);
        expect(compositeRsiAt(bars, 11)).toBeCloseTo(expected, 10);
    });

    it('uses averaged gain and loss seeds with mixed initial moves, not accumulated sums', () => {
        const closes = Array.from({ length: 10 }, (_, i) => 100 + i % 2);
        closes.push(99);
        const bars = candles(closes);
        // Seed gains=5/9 and losses=4/9. A new -2 makes the two averages
        // 40/81 and 50/81, so the next RSI is 100*40/(40+50).
        expect(compositeRsiAt(bars, 9)).toBeCloseTo(500 / 9, 10);
        expect(compositeRsiAt(bars, 10)).toBeCloseTo(400 / 9, 10);
    });

    it('remains causal: appending a later reversal never changes prior V8 or ATR values', () => {
        const prefix = candles(Array.from({ length: 160 }, (_, i) => 100 + i * 0.1), 1, 0.2);
        const later = candles(Array.from({ length: 20 }, (_, i) => 115 - i), 1, 0.2).map((bar, i) => ({
            ...bar,
            time: prefix.at(-1)!.time + (i + 1) * 60,
        }));
        expect(v8CompositeTrend([...prefix, ...later]).slice(0, prefix.length)).toEqual(v8CompositeTrend(prefix));
        const fullDefense = v9AtrDefense([...prefix, ...later]);
        const prefixDefense = v9AtrDefense(prefix);
        expect(fullDefense.up.slice(0, prefix.length)).toEqual(prefixDefense.up);
        expect(fullDefense.down.slice(0, prefix.length)).toEqual(prefixDefense.down);
    });
});
