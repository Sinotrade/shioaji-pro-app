import { afterEach, describe, expect, it, vi } from 'vitest';
import * as indicators from './indicators';
import * as markers from './utils/v9-chart-markers';
import { researchEntry, type ResearchEntryContext } from './research-entry';
import type { Candle } from './types/market';

const open = Date.parse('2026-10-02T09:00:00Z') / 1000;
function series(count = 25, start = open): Candle[] {
    return Array.from({ length: count }, (_, index) => ({
        time: start + (index + 1) * 300, open: 100 + index, close: 101 + index,
        high: 102 + index, low: 99 + index, volume: 100,
    }));
}
function context(bars = series()): ResearchEntryContext {
    return { closedFiveMinuteBars: bars, securityType: 'STK', now: bars.at(-1)!.time + 30 };
}
function alignedMocks(bars: Candle[], side: 'long' | 'short') {
    vi.spyOn(indicators, 'ema').mockImplementation((input, period) => input.map(bar => ({ time: bar.time,
        value: period === 3 ? side === 'long' ? 102 : 98 : 100,
    })));
    vi.spyOn(indicators, 'v9AtrDefense').mockReturnValue({
        up: bars.map(bar => side === 'long' ? { time: bar.time, value: 90 } : { time: bar.time }),
        down: bars.map(bar => side === 'short' ? { time: bar.time, value: 200 } : { time: bar.time }),
    });
}
afterEach(() => vi.restoreAllMocks());

describe('researchEntry: existing indicators on a fixed closed 5-minute series', () => {
    it('uses the existing ATR14 session warmup and exposes the exact count', () => {
        const result = researchEntry(context(series(14)), 'long');
        expect(result.label).toBe('等待資料');
        expect(result.checks[0]).toMatchObject({ state: 'missing', detail: 'ATR暖機：本時段 14/15 根已收5分K' });
        expect(result.checks.slice(1).every(check => check.state === 'missing')).toBe(true);
    });
    it('does not reuse a previous session or old closed bar as the current trigger', () => {
        const ctx = context();
        ctx.now += 300;
        const result = researchEntry(ctx, 'long');
        expect(result.label).toBe('等待資料');
        expect(result.checks[0]!.detail).toContain('不沿用舊觸發');
    });
    it('does not turn a zero-volume latest bar into an entry trigger', () => {
        const bars = series();
        bars.at(-1)!.volume = 0;
        expect(researchEntry(context(bars), 'long').checks[0]!.detail).toContain('無成交量');
    });
    it('keeps a genuine one-way trend waiting for a NEW flip, not authorizing entry', () => {
        const result = researchEntry(context(), 'long');
        expect(result.label).toBe('等待觸發');
        expect(result.checks.find(check => check.id === 'ema')!.state).toBe('pass');
        expect(result.checks.find(check => check.id === 'atr')!.state).toBe('pass');
        expect(result.checks.find(check => check.id === 'trigger')!.state).toBe('wait');
    });
    it('requires latest-bar buy/sell flip and every same-side inspection to pass', () => {
        for (const side of ['long', 'short'] as const) {
            const bars = series();
            alignedMocks(bars, side);
            vi.spyOn(markers, side === 'long' ? 'supertrendTradeMarkers' : 'supertrendShortTradeMarkers')
                .mockReturnValue([{ time: bars.at(-1)!.time, position: 'belowBar', shape: 'arrowUp',
                    color: '', text: side === 'long' ? '買' : '賣', group: side === 'long' ? 'trend' : 'trendShort' }]);
            const result = researchEntry(context(bars), side);
            expect(result.label).toBe(side === 'long' ? '研究觸發多' : '研究觸發空');
            expect(result.checks.every(check => check.state === 'pass')).toBe(true);
            expect(indicators.v9AtrDefense).toHaveBeenLastCalledWith(bars, 14, 2, 'STK', 5);
            vi.restoreAllMocks();
        }
    });
    it('does not recycle a historical flip when the latest bar has no new flip', () => {
        const bars = series();
        alignedMocks(bars, 'long');
        vi.spyOn(markers, 'supertrendTradeMarkers').mockReturnValue([{ time: bars.at(-2)!.time,
            position: 'belowBar', shape: 'arrowUp', color: '', text: '買', group: 'trend' }]);
        expect(researchEntry(context(bars), 'long').label).toBe('等待觸發');
    });
    it('does not let a new flip bypass opposite EMA or ineffective ATR', () => {
        const bars = series();
        alignedMocks(bars, 'short');
        vi.spyOn(markers, 'supertrendTradeMarkers').mockReturnValue([{ time: bars.at(-1)!.time,
            position: 'belowBar', shape: 'arrowUp', color: '', text: '買', group: 'trend' }]);
        const result = researchEntry(context(bars), 'long');
        expect(result.label).toBe('等待確認');
        expect(result.checks.find(check => check.id === 'ema')!.state).toBe('wait');
        expect(result.checks.find(check => check.id === 'atr')!.state).toBe('wait');
        expect(result.checks.find(check => check.id === 'trigger')!.state).toBe('pass');
    });
    it('filters future and malformed bars before indicator calculation', () => {
        const bars = series();
        const ctx = context(bars);
        alignedMocks(bars, 'long');
        const bad = { ...bars.at(-1)!, time: bars.at(-1)!.time - 1, close: 1000 };
        const future = { ...bars.at(-1)!, time: bars.at(-1)!.time + 300 };
        researchEntry({ ...ctx, closedFiveMinuteBars: [...bars, bad, future] }, 'long');
        expect(indicators.ema).toHaveBeenLastCalledWith(bars, 8);
        expect(indicators.v9AtrDefense).toHaveBeenLastCalledWith(bars, 14, 2, 'STK', 5);
    });
    it('carries futures session warmup across midnight without resetting at the date boundary', () => {
        const start = Date.parse('2026-10-01T15:00:00Z') / 1000;
        const bars = series(130, start); // through next-day 01:50
        const result = researchEntry({ ...context(bars), securityType: 'FUT' }, 'long');
        expect(result.checks[0]).toMatchObject({ state: 'pass' });
        expect(result.checks[0]!.detail).toContain('130 根');
    });
    it('treats zero-wave flat bars as no effective ATR rather than a research entry', () => {
        const bars = series().map(bar => ({ ...bar, open: 100, high: 100, low: 100, close: 100 }));
        const result = researchEntry(context(bars), 'long');
        expect(result.label).toBe('等待確認');
        expect(result.checks.find(check => check.id === 'ema')!.detail).toContain('方向中性');
        expect(result.checks.find(check => check.id === 'atr')!.state).toBe('missing');
    });
    it('reaches both research-trigger states using actual indicators, not mocked formulas', () => {
        // Fixed causal fixtures exercise a reachable joint state. These are
        // not a parameter search, backtest, win-rate result or market advice.
        const prices = {
            short: [99, 97.9, 95.6, 95.1, 96, 97.4, 97.3, 97.3, 97.4, 94.8, 92.6, 91.4, 92.9, 93.1, 92.3, 94.6,
                91.9, 94.3, 92, 91.3, 89.1, 89.6, 91.2, 91, 88.8, 91, 92.5, 92, 89.6, 90.9, 89.5, 91.5,
                94.3, 93.4, 91.4, 93.3, 92.3, 92.3, 90.6, 88.4],
            long: [97.8, 100.3, 102.7, 104.1, 105, 107.4, 104.8, 104.4, 107.2, 108.6, 107, 109.5, 112.3,
                114.1, 113.4, 110.7, 110.6, 113.6, 114, 116.5, 118.9, 121.5, 119.9, 121.5, 120.6, 119.5,
                119, 116.8, 115.6, 116.4, 117.1, 119.2, 116.8, 117, 114.6, 112.2, 113, 114.6, 117.7, 118],
        };
        for (const side of ['long', 'short'] as const) {
            const bars = prices[side].map((close, index) => {
                const prior = prices[side][index - 1] ?? 100;
                return { time: open + (index + 1) * 300, open: prior, close,
                    high: Math.max(prior, close) + 0.1, low: Math.min(prior, close) - 0.1, volume: 100 };
            });
            const ctx = context(bars);
            const result = researchEntry(ctx, side);
            expect(result.label).toBe(side === 'long' ? '研究觸發多' : '研究觸發空');
            expect(result.checks.every(check => check.state === 'pass')).toBe(true);
            const future = { ...bars.at(-1)!, time: bars.at(-1)!.time + 300, open: 1000, close: 1000, high: 1001, low: 999 };
            expect(researchEntry({ ...ctx, closedFiveMinuteBars: [...bars, future] }, side)).toEqual(result);
        }
    });
});
