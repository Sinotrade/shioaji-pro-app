import { describe, expect, it } from 'vitest';
import { projectResearchVwap, researchSessionVwap, validResearchMinutes } from './research-vwap';
import type { Candle } from './types/market';
import { aggregate } from './utils/kbars';

const time = (text: string) => Date.parse(`${text}Z`) / 1000;
const open = time('2026-10-02T09:00:00');
const night = time('2026-10-01T15:00:00');
const minute = (label: number, price = 100, volume = 10): Candle => ({
    time: label, open: price, high: price, low: price, close: price, volume,
});
const series = (start: number, count: number) => Array.from({ length: count }, (_, index) => minute(start + (index + 1) * 60, 100 + index / 10));

describe('researchSessionVwap: fixed raw-minute session anchors', () => {
    it('uses HLC3 times volume, excludes future minutes and makes no partial-5m approximation', () => {
        const bars = [minute(open + 60, 100, 100), minute(open + 120, 102, 1), minute(open + 180, 500, 100)];
        const result = researchSessionVwap(bars, 'STK', open + 120);
        expect(result.status).toBe('ready');
        expect(result.points.at(-1)?.value).toBeCloseTo(10102 / 101);
        expect(result.points).toHaveLength(2);
        const projected = projectResearchVwap(result.points, [{ ...bars[1]!, time: open + 300 }], 'STK');
        expect(projected.at(-1)?.value).toBeCloseTo(10102 / 101);
    });
    it('de-duplicates and sorts valid minute-end bars without mutating the source', () => {
        const bars = [minute(open + 120, 102), minute(open + 60, 100), minute(open + 120, 104)];
        const copy = JSON.stringify(bars);
        const result = researchSessionVwap(bars, 'STK', open + 120);
        expect(result.points.map(point => point.time)).toEqual([open + 60, open + 120]);
        expect(result.points.at(-1)?.value).toBe(102);
        expect(JSON.stringify(bars)).toBe(copy);
    });
    it('counts explicit zero-volume minutes as coverage, never assumes a missing minute has no trades', () => {
        const bars = [minute(open + 60, 100), minute(open + 120, 500, 0), minute(open + 180, 102)];
        expect(researchSessionVwap(bars, 'STK', open + 180)).toMatchObject({ status: 'ready' });
        expect(researchSessionVwap(bars, 'STK', open + 180).points.at(-1)?.value).toBe(101);
        expect(researchSessionVwap([bars[0]!, bars[2]!], 'STK', open + 180)).toMatchObject({ status: 'partial' });
    });
    it('never calculates an opening-anchored value if the first minute is absent', () => {
        const result = researchSessionVwap([minute(open + 120), minute(open + 180)], 'STK', open + 180);
        expect(result.status).toBe('partial');
        expect(result.reason).toContain('第一分鐘');
        expect(result.points).toEqual([{ time: open + 60 }]);
    });
    it('ends the known prefix at the first missing internal minute', () => {
        const result = researchSessionVwap([minute(open + 60), minute(open + 180, 200)], 'STK', open + 180);
        expect(result.reason).toContain('缺分鐘');
        expect(result.points).toEqual([{ time: open + 60, value: 100 }, { time: open + 120 }]);
        expect(projectResearchVwap(result.points, [minute(open + 60), minute(open + 180)], 'STK'))
            .toEqual([{ time: open + 60, value: 100 }, { time: open + 180 }]);
    });
    it('reports missing tail coverage and does not label old data as ready', () => {
        const result = researchSessionVwap([minute(open + 60)], 'STK', open + 180);
        expect(result.status).toBe('partial');
        expect(result.reason).toContain('最新');
        expect(result.points.at(-1)).toEqual({ time: open + 120 });
    });
    it('is empty before open, on an unknown clock and when every provided minute has zero volume', () => {
        expect(researchSessionVwap([], 'STK', open - 30).status).toBe('empty');
        expect(researchSessionVwap(series(open, 2), 'STK', NaN).points).toEqual([]);
        const result = researchSessionVwap([minute(open + 60, 100, 0)], 'STK', open + 60);
        expect(result.status).toBe('empty');
        expect(result.points).toEqual([{ time: open + 60 }]);
    });
    it('filters invalid OHLC, negative volume, non-minute and out-of-session bars', () => {
        const valid = minute(open + 60);
        const invalid = [minute(open), minute(open + 61), { ...minute(open + 120), volume: -1 },
            { ...minute(open + 120), low: 200 }, minute(open + 17 * 3600), { ...minute(open + 120), close: NaN }];
        expect(validResearchMinutes([...invalid, valid], 'STK', open + 20 * 3600)).toEqual([valid]);
    });
    it('continues a futures night over midnight rather than resetting at a calendar day', () => {
        const bars = series(night, 541); // 15:01 ... next-day 00:01
        const result = researchSessionVwap(bars, 'FUT', bars.at(-1)!.time);
        expect(result.status).toBe('ready');
        expect(result.sessionStart).toBe(night);
        expect(result.points.at(-1)?.value).toBeCloseTo((100 + 154) / 2);
        expect(result.points.find(point => point.time === time('2026-10-02T00:00:00'))?.value)
            .toBeCloseTo((100 + 153.9) / 2);
    });
    it('resets between futures day and night and projection has a boundary whitespace', () => {
        const day = time('2026-10-01T08:45:00');
        const dayBars = Array.from({ length: 300 }, (_, index) => minute(day + (index + 1) * 60, 100));
        const nightBars = [minute(night + 60, 200), minute(night + 120, 220)];
        const result = researchSessionVwap([...dayBars, ...nightBars], 'FUT', night + 120);
        expect(result.status).toBe('ready');
        expect(result.points.at(-1)?.value).toBe(210);
        const projected = projectResearchVwap(result.points, [dayBars.at(-1)!, ...nightBars], 'FUT');
        expect(projected).toEqual([
            { time: day + 300 * 60, value: 100 }, { time: night },
            { time: night + 60, value: 200 }, { time: night + 120, value: 210 },
        ]);
    });
    it('uses the same raw VWAP values on 1m and 5m chart labels, without future peeking', () => {
        const bars = series(open, 15);
        const result = researchSessionVwap(bars, 'STK', open + 15 * 60);
        const one = projectResearchVwap(result.points, bars, 'STK');
        const five = projectResearchVwap(result.points, aggregate(bars, 5, 'STK'), 'STK');
        expect(five).toEqual(one.filter(point => (point.time - open) % 300 === 0));
        const futureOnly = projectResearchVwap([{ time: open + 600, value: 900 }], [minute(open + 300)], 'STK');
        expect(futureOnly).toEqual([{ time: open + 300 }]);
    });
    it('does not borrow an old session value into a new session missing its opening minute', () => {
        const previous = series(open - 86400, 270);
        const bars = [...previous, minute(open + 120, 500)];
        const result = researchSessionVwap(bars, 'STK', open + 120);
        const projected = projectResearchVwap(result.points, [previous.at(-1)!, minute(open + 120, 500)], 'STK');
        expect(result.status).toBe('partial');
        expect(projected.at(-1)).toEqual({ time: open + 120 });
        expect(projected.at(-2)).toEqual({ time: open });
    });
    it('is prefix causal even when future input is already available', () => {
        const bars = series(open, 20);
        for (let count = 1; count <= bars.length; count++) {
            const now = bars[count - 1]!.time;
            expect(researchSessionVwap(bars, 'STK', now)).toEqual(researchSessionVwap(bars.slice(0, count), 'STK', now));
        }
    });
});
