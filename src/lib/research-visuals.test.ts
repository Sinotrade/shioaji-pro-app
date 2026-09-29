import { describe, expect, it } from 'vitest';
import { defenseEvents, defenseSegments, researchOpening } from './research-visuals';
import { v9AtrDefense } from './indicators';
import type { Candle } from './types/market';

const start = Date.UTC(2026, 8, 24, 15) / 1000;
const bar = (time: number, close: number): Candle => ({ time, open: close, high: close + 1, low: close - 1, close, volume: 10 });

describe('research visual references', () => {
    it('keeps the night open across midnight and refuses a partial history page', () => {
        const bars = [bar(start + 60, 100), bar(start + 10 * 3600, 110)];
        expect(researchOpening(bars, 'FUT')).toMatchObject({ price: 100, start, title: '夜盤開盤' });
        expect(researchOpening(bars.slice(1), 'FUT')).toBeNull();
        const nextDay = start + 86400 - 6.25 * 3600;
        expect(researchOpening([...bars, bar(nextDay + 60, 120)], 'FUT')).toMatchObject({ price: 120, title: '日盤開盤' });
    });

    it('separates invalidation from a confirmed reversal and clears state at a new session', () => {
        const bars = [bar(start + 60, 105), bar(start + 120, 99), bar(start + 180, 97), bar(start + 86400 + 60, 96)];
        const up = bars.map((b, i) => ({ time: b.time, value: i === 0 ? 100 : undefined }));
        const down = bars.map((b, i) => ({ time: b.time, value: i >= 2 ? 102 : undefined }));
        expect(defenseEvents(bars, { up, down }, 'FUT', 1).map(e => e.text)).toEqual(['多方確認', '多防失效', '翻空', '空方確認']);
        expect(defenseSegments([up[0]!, up[1]!, { time: bars[2]!.time, value: 90 }])).toHaveLength(2);
    });

    it('keeps actual ATR rails on the correct side despite long wicks, ratchets and future bars', () => {
        const bars = Array.from({ length: 230 }, (_, i) => {
            const close = i < 100 ? 100 + i * .3 : 130 - (i - 100) * .45;
            return { ...bar(start + (i + 1) * 60, close), high: close + (i % 31 === 0 ? 25 : 1),
                low: close - (i % 37 === 0 ? 25 : 1) };
        });
        const rails = v9AtrDefense(bars, 14, 2, 'FUT', 1);
        expect(rails.up.some(p => p.value !== undefined)).toBe(true);
        expect(rails.down.some(p => p.value !== undefined)).toBe(true);
        for (let i = 0; i < bars.length; i++) {
            if (rails.up[i]!.value !== undefined) expect(rails.up[i]!.value!).toBeLessThan(bars[i]!.close);
            if (rails.down[i]!.value !== undefined) expect(rails.down[i]!.value!).toBeGreaterThan(bars[i]!.close);
        }
        for (const segment of defenseSegments(rails.up)) segment.forEach((point, i) => {
            if (i) expect(point.value!).toBeGreaterThanOrEqual(segment[i - 1]!.value!);
        });
        for (const segment of defenseSegments(rails.down)) segment.forEach((point, i) => {
            if (i) expect(point.value!).toBeLessThanOrEqual(segment[i - 1]!.value!);
        });
        const prefix = v9AtrDefense(bars.slice(0, 150), 14, 2, 'FUT', 1);
        expect(prefix.up).toEqual(rails.up.slice(0, 150));
        expect(prefix.down).toEqual(rails.down.slice(0, 150));
    });
});
