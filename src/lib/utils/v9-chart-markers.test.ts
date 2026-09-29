import { describe, expect, it } from 'vitest';
import type { Candle } from '../types/market';
import {
    v9KbarMarkers, v9LargeOrderFlowMarkers, V9FlowTracker, researchTickBucket,
    completedResearchBars, selectResearchMarkers, DEFAULT_MARKER_OPTIONS,
    researchMarkerGap, mergeResearchMarkerLabels, supertrendTradeMarkers,
    supertrendShortTradeMarkers,
} from './v9-chart-markers';
const day = Date.UTC(2026, 8, 18) / 1000;
const open = day + 9 * 3600;

function bars(volume = 100): Candle[] {
    return Array.from({ length: 30 }, (_, index) => {
        const close = 100 + index * 0.2;
        return {
            time: 1_726_704_000 + index * 60,
            open: close - 0.08,
            high: close + 0.2,
            low: close - 0.2,
            close,
            volume,
        };
    });
}

describe('V9 chart markers', () => {
    it('marks a high-volume close at the range extreme as attack volume', () => {
        const rows = bars();
        rows[29] = { ...rows[29]!, open: 105, low: 104.9, high: 106, close: 105.9, volume: 260 };
        const marker = v9KbarMarkers(rows).find(item => item.time === rows[29]!.time && item.text.includes('攻'));
        expect(marker).toMatchObject({ position: 'belowBar', shape: 'arrowUp' });
    });

    it('marks a low-volume pullback above EMA8 as wash volume', () => {
        const rows = bars();
        rows[29] = { ...rows[29]!, open: 106.2, high: 106.25, low: 105.8, close: 105.9, volume: 20 };
        const marker = v9KbarMarkers(rows).find(item => item.time === rows[29]!.time && item.text.includes('洗'));
        expect(marker).toBeDefined();
    });

    it('waits for a Tick baseline before marking a live large-order flow estimate', () => {
        const small = Array.from({ length: 20 }, (_, index) => ({ time: open + index, volume: 1, tickType: 1 }));
        expect(v9LargeOrderFlowMarkers(small, 1)).toEqual([]);
        const result = v9LargeOrderFlowMarkers([...small, { time: open + 60, volume: 10, tickType: 1 }], 1);
        expect(result).toEqual([expect.objectContaining({ text: '大單偏買', position: 'belowBar' })]);
    });

    it('draws a downward attack with a downward arrow', () => {
        const rows = bars();
        rows[29] = { ...rows[29]!, open: 106, high: 106.1, low: 104.9, close: 105, volume: 260 };
        expect(v9KbarMarkers(rows).find(marker => marker.text === '攻'))
            .toMatchObject({ position: 'aboveBar', shape: 'arrowDown', group: 'volume' });
    });

    it('never labels zero-volume or malformed bars as patterns', () => {
        const rows = bars();
        rows.push({ ...rows[29]!, time: open, volume: 0 }, { ...rows[29]!, time: open + 60, close: NaN });
        expect(v9KbarMarkers(rows).some(marker => marker.time >= open)).toBe(false);
    });

    it('warms up divergence and leaves closed-bar decisions stable as data is appended', () => {
        const rows = Array.from({ length: 180 }, (_, i) => ({
            time: open + i * 60, open: 100 + Math.sin(i / 8), close: 100.1 + Math.sin(i / 8),
            high: 101 + Math.sin(i / 8), low: 99 + Math.sin(i / 8), volume: 100 + i % 9,
        }));
        expect(v9KbarMarkers(rows.slice(0, 152)).every(marker => marker.group !== 'divergence')).toBe(true);
        const before = v9KbarMarkers(rows.slice(0, 170));
        expect(v9KbarMarkers(rows).filter(marker => marker.time < rows[170]!.time)).toEqual(before);
        expect(v9KbarMarkers(rows).some(marker => marker.group === 'divergence')).toBe(true);
    });

    it('uses only completed bars, including past days but not the current daily candle', () => {
        const rows = bars().map((bar, i) => ({ ...bar, time: open + i * 60 }));
        expect(completedResearchBars(rows, 1, open + 28 * 60).length).toBe(29);
        const daily = [day - 86400, day].map(time => ({ ...rows[0]!, time }));
        expect(completedResearchBars(daily, 1440, open).map(bar => bar.time)).toEqual([day - 86400]);
    });

    it('sparsifies repeated labels without moving them and honors switches/exact candle membership', () => {
        const times = Array.from({ length: 12 }, (_, i) => open + i * 60);
        const markers = times.map(time => ({
            time, group: 'volume' as const, text: '攻', color: '#fff', position: 'belowBar' as const, shape: 'arrowUp' as const,
        }));
        expect(selectResearchMarkers(markers, times, DEFAULT_MARKER_OPTIONS).map(marker => marker.time))
            .toEqual([times[0], times[5], times[10]]);
        expect(selectResearchMarkers(markers, times, { ...DEFAULT_MARKER_OPTIONS, volume: false })).toEqual([]);
        expect(selectResearchMarkers(markers, times.slice(1), { ...DEFAULT_MARKER_OPTIONS, compact: false })).toHaveLength(11);
        expect(selectResearchMarkers(markers.slice(0, 8), times, DEFAULT_MARKER_OPTIONS))
            .toEqual(selectResearchMarkers(markers, times, DEFAULT_MARKER_OPTIONS).filter(marker => marker.time < times[8]!));
    });

    it('adapts spacing to width and keeps attacks instead of crowded weaker volume labels', () => {
        expect(researchMarkerGap(270, 500)).toBeGreaterThan(researchMarkerGap(270, 1200));
        const times = [open, open + 60, open + 120];
        const markers = times.map((time, i) => ({
            time, group: 'volume' as const, text: ['量背', '攻', '洗'][i]!, color: '#fff',
            position: 'belowBar' as const, shape: 'arrowUp' as const,
        }));
        expect(selectResearchMarkers(markers, times, DEFAULT_MARKER_OPTIONS).map(marker => marker.text)).toEqual(['攻']);
        expect(selectResearchMarkers(markers, times, { ...DEFAULT_MARKER_OPTIONS, compact: false })).toHaveLength(3);
    });

    it('combines same-bar labels without mutating source observations', () => {
        const a = { time: open, group: 'flow' as const, text: '大單偏賣', color: '#fff',
            position: 'aboveBar' as const, shape: 'arrowDown' as const };
        const b = { ...a, group: 'divergence' as const, text: '頂背' };
        expect(mergeResearchMarkerLabels([a, b])).toEqual([{ ...a, text: '大單偏賣·頂背' }]);
        expect(a.text).toBe('大單偏賣');
    });

    it('turns SuperTrend flips into long-only 買／平 markers and honors the trend switch', () => {
        const base = 1_700_000_000;
        const down: Candle[] = Array.from({ length: 60 }, (_, i) => {
            const close = 100 - i * 0.5;
            return { time: base + i * 60, open: close + 0.1, high: close + 0.3, low: close - 0.6, close, volume: 1000 };
        });
        const up: Candle[] = Array.from({ length: 60 }, (_, i) => {
            const close = 70 + i * 0.6;
            return { time: base + (60 + i) * 60, open: close - 0.1, high: close + 0.8, low: close - 0.3, close, volume: 1000 };
        });
        const rows = [...down, ...up];
        const markers = supertrendTradeMarkers(rows);
        const buy = markers.find(marker => marker.text === '買');
        const exit = markers.find(marker => marker.text === '平');
        expect(buy).toMatchObject({ group: 'trend', position: 'belowBar', shape: 'arrowUp', color: '#1fd286' });
        expect(exit).toMatchObject({ group: 'trend', position: 'aboveBar', shape: 'arrowDown', color: '#ff4d6a' });
        expect(exit!.time).toBeLessThan(buy!.time);
        const times = rows.map(bar => bar.time);
        expect(selectResearchMarkers(markers, times, { ...DEFAULT_MARKER_OPTIONS, trend: false })).toEqual([]);
        expect(selectResearchMarkers(markers, times, DEFAULT_MARKER_OPTIONS).length).toBeGreaterThan(0);
        expect(DEFAULT_MARKER_OPTIONS.trend).toBe(true);
    });

    it('maps the same flips to short 賣／補 markers and merges both sides on a flip', () => {
        const base = 1_700_000_000;
        const down: Candle[] = Array.from({ length: 60 }, (_, i) => {
            const close = 100 - i * 0.5;
            return { time: base + i * 60, open: close + 0.1, high: close + 0.3, low: close - 0.6, close, volume: 1000 };
        });
        const up: Candle[] = Array.from({ length: 60 }, (_, i) => {
            const close = 70 + i * 0.6;
            return { time: base + (60 + i) * 60, open: close - 0.1, high: close + 0.8, low: close - 0.3, close, volume: 1000 };
        });
        const rows = [...down, ...up];
        const times = rows.map(bar => bar.time);
        const shortMarkers = supertrendShortTradeMarkers(rows);
        const openShort = shortMarkers.find(marker => marker.text === '賣');
        const cover = shortMarkers.find(marker => marker.text === '補');
        expect(openShort).toMatchObject({ group: 'trendShort', position: 'aboveBar', shape: 'arrowDown', color: '#ff4d6a' });
        expect(cover).toMatchObject({ group: 'trendShort', position: 'belowBar', shape: 'arrowUp', color: '#1fd286' });
        expect(openShort!.time).toBeLessThan(cover!.time);
        expect(selectResearchMarkers(shortMarkers, times, { ...DEFAULT_MARKER_OPTIONS, trendShort: false })).toEqual([]);
        expect(DEFAULT_MARKER_OPTIONS.trendShort).toBe(true);

        // Both sides enabled: same-bar/same-side labels survive compact thinning
        // and merge into 平·賣 (bear flip) / 買·補 (bull flip).
        const longMarkers = supertrendTradeMarkers(rows);
        const merged = mergeResearchMarkerLabels(
            selectResearchMarkers([...longMarkers, ...shortMarkers], times, DEFAULT_MARKER_OPTIONS),
        );
        const exitText = merged.find(marker => marker.time === openShort!.time)?.text ?? '';
        const entryText = merged.find(marker => marker.time === cover!.time)?.text ?? '';
        expect(exitText).toContain('平');
        expect(exitText).toContain('賣');
        expect(entryText).toContain('買');
        expect(entryText).toContain('補');
    });
});

function warm(tracker: V9FlowTracker, start = open) {
    for (let i = 0; i < 20; i++) tracker.push({ time: start + i, volume: 1, tickType: 0, id: `warm-${start}-${i}` });
}
describe('incremental large-order flow', () => {
    it('does not let a large print raise its own threshold, or later ticks reclassify earlier prints', () => {
        const tracker = new V9FlowTracker();
        warm(tracker);
        expect(tracker.snapshot(1).threshold).toBe(5);
        tracker.push({ time: open + 60, volume: 1000, tickType: 1 });
        const original = tracker.snapshot(1).markers;
        expect(original).toHaveLength(1);
        for (let i = 0; i < 200; i++) tracker.push({ time: open + 120 + i, volume: 500, tickType: 0 });
        expect(tracker.snapshot(1).markers).toEqual(original);
        expect(tracker.snapshot(1).sampleCount).toBe(120);
    });
    it('rejects replay, invalid and older ticks without losing same-second distinct trades', () => {
        const tracker = new V9FlowTracker();
        warm(tracker);
        const tick = { time: open + 60.1234, volume: 10, tickType: 1, id: 'a' };
        expect(tracker.push(tick)).toBe(true);
        expect(tracker.push(tick)).toBe(false);
        expect(tracker.push({ ...tick, id: 'b' })).toBe(true);
        expect(tracker.push({ ...tick, id: 'c', time: open })).toBe(false);
        expect(tracker.push({ ...tick, id: 'd', volume: Infinity })).toBe(false);
        expect(tracker.snapshot(1).qualifiedCount).toBe(2);
    });
    it('keeps unknown direction in baseline only, and a balanced buy/sell bucket has no bias', () => {
        const tracker = new V9FlowTracker();
        warm(tracker);
        tracker.push({ time: open + 40, volume: 10, tickType: 1 });
        tracker.push({ time: open + 41, volume: 10, tickType: 2 });
        tracker.push({ time: open + 42, volume: 1000, tickType: 0 });
        expect(tracker.snapshot(1).markers).toEqual([]);
        expect(tracker.snapshot(1).qualifiedCount).toBe(2);
    });
    it('resets baseline and marker totals in the next session, rejecting late prior-day replays', () => {
        const tracker = new V9FlowTracker();
        warm(tracker);
        tracker.push({ time: open + 60, volume: 10, tickType: 2 });
        expect(tracker.snapshot(1).markers).toHaveLength(1);
        tracker.push({ time: open + 86400, volume: 10, tickType: 1 });
        expect(tracker.snapshot(1)).toMatchObject({ sampleCount: 1, qualifiedCount: 0, markers: [] });
        expect(tracker.push({ time: open + 70, volume: 10, tickType: 1 })).toBe(false);
    });
    it('keeps the same futures night session across midnight and buckets daily markers on the correct date', () => {
        const tracker = new V9FlowTracker('FUT');
        warm(tracker, day + 23 * 3600);
        tracker.push({ time: day + 86400 - 1, volume: 10, tickType: 1 });
        tracker.push({ time: day + 86400 + 1, volume: 20, tickType: 2 });
        expect(tracker.snapshot(1440).sampleCount).toBe(22);
        expect(tracker.snapshot(1440).markers.map(marker => marker.time)).toEqual([day, day + 86400]);
        tracker.push({ time: day + 86400 + 9 * 3600, volume: 1, tickType: 1 });
        expect(tracker.snapshot(1).sampleCount).toBe(1);
    });
    it('aligns intraday and daily buckets with the live chart, including the closing auction', () => {
        expect(researchTickBucket(open, 1)).toBe(open + 60);
        expect(researchTickBucket(open + 60, 5)).toBe(open + 300);
        expect(researchTickBucket(day + 13.5 * 3600, 1)).toBe(day + 13.5 * 3600);
        expect(researchTickBucket(day + 13.5 * 3600, 60)).toBe(day + 13.5 * 3600);
        expect(researchTickBucket(open + 100, 1440)).toBe(day);
    });
});
