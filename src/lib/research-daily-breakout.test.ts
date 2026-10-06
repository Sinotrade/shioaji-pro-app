import { describe, expect, it } from 'vitest';
import type { Candle } from './types/market';
import { buildDailyBreakoutStudy, DEFAULT_DAILY_BREAKOUT_SETTINGS } from './research-daily-breakout';

const day = Date.UTC(2026, 0, 1) / 1000;
function bars(closes: number[], volume = 100): Candle[] {
    return closes.map((close, i) => ({ time: day + i * 86400,
        open: close, high: close + 0.25, low: close - 0.25, close, volume }));
}
const baseline = () => bars(Array.from({ length: 30 }, (_, i) => i % 2 ? 101 : 100));
function append(input: Candle[], close: number, volume = 150, open = close): Candle[] {
    return [...input, { time: input.at(-1)!.time + 86400, open,
        high: Math.max(open, close) + 0.25, low: Math.min(open, close) - 0.25, close, volume }];
}
const startBars = () => append(baseline(), 104);

describe('daily breakout research: causal completed daily candles only', () => {
    it('has explicit independent research defaults', () => {
        expect(DEFAULT_DAILY_BREAKOUT_SETTINGS).toEqual({ trendType: 'sma', trendPeriod: 20,
            breakoutLookback: 10, volumeLookback: 20, volumeMultiple: 1.5 });
        expect(Object.isFrozen(DEFAULT_DAILY_BREAKOUT_SETTINGS)).toBe(true);
    });

    it('returns an empty non-error study when no completed days exist', () => {
        expect(buildDailyBreakoutStudy([])).toEqual({ candles: [], trendLine: [], events: [],
            latest: null, tracking: false, trackingSince: null, dataError: null });
    });

    it('waits for all warmup windows and a previous trend point', () => {
        expect(buildDailyBreakoutStudy(baseline().slice(0, 20)).latest?.status).toBe('warming-up');
        expect(buildDailyBreakoutStudy(baseline().slice(0, 20)).events).toEqual([]);
        expect(buildDailyBreakoutStudy(baseline().slice(0, 21)).latest?.status).toBe('waiting');
        expect(buildDailyBreakoutStudy(baseline().slice(0, 19)).trendLine).toEqual([]);
    });

    it('starts at the confirmed close with prior-window high and exact 1.5x volume', () => {
        const study = buildDailyBreakoutStudy(startBars());
        expect(study.latest).toMatchObject({ status: 'start', close: 104,
            prevHigh: 101.25, volumeRatio: 1.5, exclusionReasons: [] });
        expect(study.events).toHaveLength(1);
        expect(study.events[0]).toMatchObject({ type: 'start', close: 104, level: 101.25, volumeRatio: 1.5 });
        expect(study.tracking).toBe(true);
        expect(study.trackingSince).toBe(startBars().at(-1)!.time);
    });

    it('excludes today from both breakout and mean-volume windows', () => {
        const input = startBars();
        input.at(-1)!.high = 1000;
        const study = buildDailyBreakoutStudy(input);
        expect(study.latest?.prevHigh).toBe(101.25);
        expect(study.latest?.volumeRatio).toBe(1.5);
        expect(study.latest?.status).toBe('start');
    });

    it('requires closing above the prior high, not merely touching/intraday wicking', () => {
        expect(buildDailyBreakoutStudy(append(baseline(), 101.25)).events).toEqual([]);
        const wick = append(baseline(), 100.5);
        wick.at(-1)!.high = 110;
        expect(buildDailyBreakoutStudy(wick).events).toEqual([]);
    });

    it('does not start on sub-threshold volume or a non-rising trend line', () => {
        expect(buildDailyBreakoutStudy(append(baseline(), 104, 149.99)).events).toEqual([]);
        const down = bars([...Array(20).fill(110), ...Array(9).fill(100), 100.1]);
        const input = append(down, 104);
        expect(buildDailyBreakoutStudy(input).latest?.prevHigh).toBe(100.35);
        expect(buildDailyBreakoutStudy(input).events).toEqual([]);
    });

    it('never invents an infinite volume ratio when prior volume is zero', () => {
        const input = baseline().map(bar => ({ ...bar, volume: 0 }));
        const study = buildDailyBreakoutStudy(append(input, 104, 10000));
        expect(study.latest?.volumeRatio).toBeNull();
        expect(study.latest?.status).toBe('waiting');
        expect(study.events).toEqual([]);
    });

    it('does not repeat a start while already tracking', () => {
        const study = buildDailyBreakoutStudy(append(startBars(), 105, 180));
        expect(study.events.map(event => event.type)).toEqual(['start']);
        expect(study.latest?.status).toBe('tracking');
        expect(study.trackingSince).toBe(startBars().at(-1)!.time);
    });

    it('exits on a zero-volume close below the trend, without MACD or volume confirmation', () => {
        const study = buildDailyBreakoutStudy(append(startBars(), 99, 0));
        expect(study.events.map(event => event.type)).toEqual(['start', 'exit']);
        expect(study.events[1]?.volumeRatio).toBe(0);
        expect(study.events[1]?.level).toBe(study.latest?.trend);
        expect(study.latest?.status).toBe('exit');
        expect(study.tracking).toBe(false);
        expect(study.trackingSince).toBeNull();
    });

    it('does not exit when close exactly equals the SMA trend', () => {
        const input = startBars();
        const next = input.slice(-19).reduce((sum, bar) => sum + bar.close, 0) / 19;
        const study = buildDailyBreakoutStudy(append(input, next, 0));
        expect(study.latest?.trend).toBeCloseTo(next, 12);
        expect(study.latest?.status).toBe('tracking');
        expect(study.events).toHaveLength(1);
    });

    it('allows a fresh start after a previous exit on a different day', () => {
        const input = append(append(append(startBars(), 105, 180), 99, 0), 106, 180);
        const study = buildDailyBreakoutStudy(input);
        expect(study.events.map(event => event.type)).toEqual(['start', 'exit', 'start']);
        expect(study.latest?.status).toBe('start');
        expect(study.trackingSince).toBe(input.at(-1)!.time);
    });

    it('overheat gates only new starts, never tracking or exits', () => {
        const hot = buildDailyBreakoutStudy(append(startBars(), 114, 180));
        expect(hot.latest?.exclusionReasons).toContain('單日漲幅 ≥ 9%');
        expect(hot.latest?.status).toBe('tracking');
        const exit = buildDailyBreakoutStudy(append(startBars(), 99, 0, 104 * 1.08));
        expect(exit.latest?.exclusionReasons).toContain('跳空 ≥ 8%');
        expect(exit.latest?.status).toBe('exit');
    });

    it('is prefix-stable: appending future candles never moves or backfills past events', () => {
        const input = append(append(append(startBars(), 105, 180), 99, 0), 106, 180);
        const full = buildDailyBreakoutStudy(input);
        for (let count = 1; count <= input.length; count++) {
            const prefix = buildDailyBreakoutStudy(input.slice(0, count));
            const time = input[count - 1]!.time;
            expect(prefix.events).toEqual(full.events.filter(event => event.time <= time));
            expect(prefix.trendLine).toEqual(full.trendLine.filter(point => point.time <= time));
        }
    });

    it('does not mutate caller candles or settings', () => {
        const input = startBars();
        const before = JSON.stringify(input);
        const settings = { ...DEFAULT_DAILY_BREAKOUT_SETTINGS };
        const study = buildDailyBreakoutStudy(input, settings);
        expect(JSON.stringify(input)).toBe(before);
        expect(study.candles[0]).not.toBe(input[0]);
        expect(settings).toEqual(DEFAULT_DAILY_BREAKOUT_SETTINGS);
    });

    it('seeds EMA at its full-window SMA and then uses alpha 2/(period+1)', () => {
        const input = bars(Array.from({ length: 24 }, (_, i) => 100 + i));
        const study = buildDailyBreakoutStudy(input, { ...DEFAULT_DAILY_BREAKOUT_SETTINGS, trendType: 'ema' });
        expect(study.trendLine[0]).toEqual({ time: input[19]!.time, value: 109.5 });
        expect(study.trendLine[1]?.value).toBeCloseTo(109.5 + 2 / 21 * (120 - 109.5), 12);
        expect(study.trendLine).toHaveLength(5);
    });

    it('keeps a flat Wilder RSI at neutral 50 and monotonic RSI at 100/0', () => {
        expect(buildDailyBreakoutStudy(bars(Array(30).fill(100))).latest?.rsi14).toBe(50);
        expect(buildDailyBreakoutStudy(bars(Array.from({ length: 30 }, (_, i) => 100 + i))).latest?.rsi14).toBe(100);
        expect(buildDailyBreakoutStudy(bars(Array.from({ length: 30 }, (_, i) => 100 - i))).latest?.rsi14).toBe(0);
    });

    it('uses Wilder smoothing after its initial 14 price changes', () => {
        const closes = [100, ...Array.from({ length: 14 }, (_, i) => 100 + i + 1), 113,
            ...Array(6).fill(113)];
        const study = buildDailyBreakoutStudy(bars(closes));
        expect(study.latest?.rsi14).toBeCloseTo(100 - 100 / (1 + 13), 10);
    });
});

describe('daily breakout extreme OR gates and decimal boundaries', () => {
    it.each([9, 9.000001])('excludes a daily rise of %s percent (inclusive 9)', change => {
        const input = append(baseline(), 101 * (1 + change / 100), 150, 101);
        const study = buildDailyBreakoutStudy(input);
        expect(study.latest?.exclusionReasons).toContain('單日漲幅 ≥ 9%');
        expect(study.latest?.status).toBe('excluded');
        expect(study.events).toEqual([]);
    });
    it('allows just under the 9 percent daily exclusion', () => {
        expect(buildDailyBreakoutStudy(append(baseline(), 101 * 1.08999999, 150, 101))
            .latest?.exclusionReasons).not.toContain('單日漲幅 ≥ 9%');
    });
    it.each([8, 8.000001])('excludes an opening gap of %s percent (inclusive 8)', gap => {
        const study = buildDailyBreakoutStudy(append(baseline(), 104, 150, 101 * (1 + gap / 100)));
        expect(study.latest?.exclusionReasons).toContain('跳空 ≥ 8%');
        expect(study.events).toEqual([]);
    });
    it('allows just under the 8 percent opening-gap exclusion', () => {
        expect(buildDailyBreakoutStudy(append(baseline(), 104, 150, 101 * 1.07999999))
            .latest?.exclusionReasons).not.toContain('跳空 ≥ 8%');
    });
    it('excludes a 3-day rise of exactly 22 percent but not just below', () => {
        const input = bars([...Array(27).fill(100), 100, 107, 115]);
        expect(buildDailyBreakoutStudy(append(input, 122)).latest?.exclusionReasons).toContain('3日漲幅 ≥ 22%');
        expect(buildDailyBreakoutStudy(append(input, 121.999999)).latest?.exclusionReasons).not.toContain('3日漲幅 ≥ 22%');
    });
    it('does not exclude SMA20 bias exactly 15 percent; any meaningful excess excludes', () => {
        const input = bars([...Array(29).fill(100), 115]);
        const close = 1.15 * (18 * 100 + 115) / (20 - 1.15);
        expect(buildDailyBreakoutStudy(append(input, close)).latest?.biasPct).toBeCloseTo(15, 10);
        expect(buildDailyBreakoutStudy(append(input, close)).latest?.exclusionReasons).not.toContain('20MA 乖離 > 15%');
        expect(buildDailyBreakoutStudy(append(input, close + 0.000001)).latest?.exclusionReasons).toContain('20MA 乖離 > 15%');
    });
    it('does not exclude RSI exactly 85 but excludes just above 85', () => {
        const sample = (gain: number) => {
            const closes = [100];
            for (let i = 0; i < 14; i++) closes.push(closes.at(-1)!
                + (i % 2 ? -(100 - gain) / 700 : gain / 700));
            return bars([...closes, ...Array(10).fill(closes.at(-1)!)]);
        };
        expect(buildDailyBreakoutStudy(sample(85)).latest?.rsi14).toBeCloseTo(85, 10);
        expect(buildDailyBreakoutStudy(sample(85)).latest?.exclusionReasons).not.toContain('RSI > 85');
        expect(buildDailyBreakoutStudy(sample(85.0001)).latest?.exclusionReasons).toContain('RSI > 85');
    });
    it('always computes the bias exclusion against SMA20, even with a different trend setting', () => {
        const input = append(baseline(), 125);
        const expected = buildDailyBreakoutStudy(input).latest;
        const alternate = buildDailyBreakoutStudy(input, { ...DEFAULT_DAILY_BREAKOUT_SETTINGS,
            trendType: 'ema', trendPeriod: 5 }).latest;
        expect(alternate?.ma20).toBe(expected?.ma20);
        expect(alternate?.biasPct).toBe(expected?.biasPct);
        expect(alternate?.exclusionReasons).toEqual(expected?.exclusionReasons);
        expect(alternate?.trend).not.toBe(expected?.trend);
    });
});

describe('daily breakout fail-closed quality checks', () => {
    it.each(['price', 'volume'])('rejects derived %s overflow even when individual inputs are finite', field => {
        const input = bars(Array(30).fill(field === 'price' ? 1e308 : 100), field === 'volume' ? 1e308 : 100);
        const study = buildDailyBreakoutStudy(input);
        expect(study.dataError).not.toBeNull();
        expect(study.events).toEqual([]);
        expect(study.trendLine).toEqual([]);
        expect(study.latest).toBeNull();
    });
    it.each([
        ['nonfinite close', (input: Candle[]) => { input[2]!.close = NaN; }],
        ['nonfinite volume', (input: Candle[]) => { input[2]!.volume = Infinity; }],
        ['negative volume', (input: Candle[]) => { input[2]!.volume = -1; }],
        ['zero price', (input: Candle[]) => { input[2]!.low = 0; }],
        ['high below close', (input: Candle[]) => { input[2]!.high = 99; }],
        ['low above open', (input: Candle[]) => { input[2]!.low = 102; }],
        ['duplicate timestamp', (input: Candle[]) => { input[2]!.time = input[1]!.time; }],
        ['unsorted timestamp', (input: Candle[]) => { input[2]!.time = input[0]!.time; }],
        ['invalid timestamp', (input: Candle[]) => { input[2]!.time = Infinity; }],
        ['intraday timestamp', (input: Candle[]) => { input[2]!.time += 60; }],
    ] as const)('rejects %s before emitting even earlier events', (_, mutate) => {
        const input = append(startBars(), 99, 0);
        mutate(input);
        const study = buildDailyBreakoutStudy(input);
        expect(study.dataError).not.toBeNull();
        expect(study.candles).toEqual([]);
        expect(study.trendLine).toEqual([]);
        expect(study.events).toEqual([]);
        expect(study.latest).toBeNull();
        expect(study.tracking).toBe(false);
    });
    it.each([
        { trendType: 'unknown' }, { trendPeriod: 1 }, { trendPeriod: 2.5 },
        { trendPeriod: 501 }, { breakoutLookback: 0 }, { volumeLookback: NaN },
        { volumeMultiple: 0 }, { volumeMultiple: Infinity }, { volumeMultiple: 21 },
    ])('rejects invalid settings %j', invalid => {
        const settings = { ...DEFAULT_DAILY_BREAKOUT_SETTINGS, ...invalid };
        const study = buildDailyBreakoutStudy(startBars(), settings as typeof DEFAULT_DAILY_BREAKOUT_SETTINGS);
        expect(study.dataError).not.toBeNull();
        expect(study.events).toEqual([]);
    });
});
