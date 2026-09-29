import { describe, expect, it } from 'vitest';
import { bbi, v8CompositeTrend, v9AtrDefense, v9Kdj, supertrend } from './indicators';
import type { Candle } from './types/market';

const bars: Candle[] = Array.from({ length: 150 }, (_, index) => {
    const close = 100 + index * 0.35 + (index % 7 - 3) * 0.2;
    return {
        time: 1_726_704_000 + index * 60,
        open: close - 0.1,
        high: close + 0.8,
        low: close - 0.7,
        close,
        volume: 1000 + index,
    };
});

describe('V9 research indicators', () => {
    it('calculates BBI from the partial SMA values used by the original V9 chart', () => {
        const result = bbi(bars.slice(0, 4));
        const closes = bars.slice(0, 4).map(bar => bar.close);
        const expected = (
            closes.slice(1).reduce((sum, value) => sum + value, 0) / 3
            + closes.reduce((sum, value) => sum + value, 0) / 4
            + closes.reduce((sum, value) => sum + value, 0) / 4
            + closes.reduce((sum, value) => sum + value, 0) / 4
        ) / 4;
        expect(result).toHaveLength(4);
        expect(result[3]!.value).toBeCloseTo(expected, 10);
    });

    it('keeps the V9 KDJ 45/9/9 series aligned and exposes J', () => {
        const result = v9Kdj(bars);
        expect(result.k).toHaveLength(bars.length);
        expect(result.d).toHaveLength(bars.length);
        expect(result.j).toHaveLength(bars.length);
        const last = bars.length - 1;
        expect(result.j[last]!.value).toBeCloseTo(
            3 * result.k[last]!.value! - 2 * result.d[last]!.value!,
            10,
        );
    });

    it('returns presentation-only V8 trend and ATR-defense lines for every bar', () => {
        const trend = v8CompositeTrend(bars);
        const defense = v9AtrDefense(bars);
        expect(trend).toHaveLength(bars.length);
        expect(trend.every(point => point.value !== undefined && point.value! >= 0 && point.value! <= 100)).toBe(true);
        expect(defense.up).toHaveLength(bars.length);
        expect(defense.down).toHaveLength(bars.length);
    });

    it('emits no ATR-defense line on flat (zero-range / ATR=0) session bars', () => {
        // 處置/停牌或歷史分鐘 K 缺失被扁平回填成 high=low=close 時 ATR=0；
        // 此時不得輸出防守軌，否則多方軌會退化貼在 high、空方軌貼在 low。
        const base = Date.UTC(2026, 8, 21, 1, 0) / 1000; // Taiwan 09:00
        const flat: Candle[] = Array.from({ length: 60 }, (_, i) => ({
            time: base + i * 60, open: 34.2, high: 34.2, low: 34.2, close: 34.2, volume: 0,
        }));
        const defense = v9AtrDefense(flat);
        expect(defense.up).toHaveLength(flat.length);
        expect(defense.down).toHaveLength(flat.length);
        expect(defense.up.every(point => point.value === undefined)).toBe(true);
        expect(defense.down.every(point => point.value === undefined)).toBe(true);
    });

    it('keeps the bullish ATR-defense line below the bar high once ATR warms up', () => {
        const base = Date.UTC(2026, 8, 21, 1, 0) / 1000;
        const climb: Candle[] = Array.from({ length: 80 }, (_, i) => {
            const close = 30 + i * 0.06;
            return {
                time: base + i * 60, open: close - 0.05, high: close + 0.3,
                low: close - 0.3, close, volume: 1000,
            };
        });
        const defense = v9AtrDefense(climb);
        const longPoints = defense.up
            .map((point, i) => ({ value: point.value, high: climb[i]!.high }))
            .filter(point => point.value !== undefined);
        expect(longPoints.length).toBeGreaterThan(0);
        // 多方防守軌必須落在 K 棒高點之下；貼到 high 之上即為 ATR=0 退化缺陷。
        expect(longPoints.every(point => point.value! < point.high)).toBe(true);
    });

    it('keeps the bearish ATR-defense line above the closing price once ATR warms up', () => {
        const base = Date.UTC(2026, 8, 21, 1, 0) / 1000;
        const decline: Candle[] = Array.from({ length: 80 }, (_, i) => {
            const close = 50 - i * 0.08;
            return {
                time: base + i * 60, open: close + 0.05, high: close + 0.3,
                low: close - 0.3, close, volume: 1000,
            };
        });
        const defense = v9AtrDefense(decline);
        const shortPoints = defense.down
            .map((point, i) => ({ value: point.value, close: decline[i]!.close }))
            .filter(point => point.value !== undefined);
        expect(shortPoints.length).toBeGreaterThan(0);
        expect(shortPoints.every(point => point.value! > point.close)).toBe(true);
    });

    it('emits SuperTrend flips only when the confirmed close flips the trend', () => {
        const base = 1_700_000_000;
        // Persistent downtrend (must flip bearish) followed by a persistent
        // uptrend (must flip bullish), each bar carrying a finite true range.
        const down: Candle[] = Array.from({ length: 60 }, (_, i) => {
            const close = 100 - i * 0.5;
            return { time: base + i * 60, open: close + 0.1, high: close + 0.3, low: close - 0.6, close, volume: 1000 };
        });
        const up: Candle[] = Array.from({ length: 60 }, (_, i) => {
            const close = 70 + i * 0.6;
            return { time: base + (60 + i) * 60, open: close - 0.1, high: close + 0.8, low: close - 0.3, close, volume: 1000 };
        });
        const result = supertrend([...down, ...up]);
        expect(result.up).toHaveLength(120);
        expect(result.down).toHaveLength(120);
        const directions = result.flips.map(flip => flip.direction);
        expect(directions).toContain(-1);
        expect(directions).toContain(1);
        // Flips must alternate between bull and bear.
        directions.forEach((direction, i) => {
            if (i > 0) expect(direction).not.toBe(directions[i - 1]);
        });
        const firstExit = result.flips.find(flip => flip.direction === -1)!;
        const firstEntry = result.flips.find(flip => flip.direction === 1)!;
        expect(firstExit.time).toBeLessThan(firstEntry.time);
        // The bullish flip happens inside the advancing leg, not the decline.
        expect(firstEntry.time).toBeGreaterThan(down[down.length - 1]!.time);
    });
});
