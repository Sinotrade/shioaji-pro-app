import { describe, expect, it } from 'vitest';
import { compareStrategyFrames, evaluateStrategyFrame } from './strategy-replay';
import { STRATEGY_ENGINE_VERSION, type StrategyFrame, type StrategySettings } from './strategy-lab-types';
import type { DaytradeInput } from './daytrade-picker';
import type { Candle } from './types/market';

const date = '2026-10-07';
const today = Date.parse(`${date}T00:00:00Z`) / 1_000;
const now = (time: string) => Date.parse(`${date}T${time}+08:00`);
const settings: StrategySettings = { candidateRvol: 2, feeBps: 14.25, taxBps: 15, slippageBps: 5, minFeeTwd: 20 };
const free: StrategySettings = { ...settings, feeBps: 0, taxBps: 0, slippageBps: 0, minFeeTwd: 0 };

function input(direction: 1 | -1 = 1, code = '2330'): DaytradeInput {
    const days: number[] = [];
    for (let day = today - 86_400; days.length < 40; day -= 86_400) {
        if (![0, 6].includes(new Date(day * 1_000).getUTCDay())) days.unshift(day);
    }
    const daily = days.map((time, i) => {
        const close = 100 + direction * (i * 0.2 + (i % 2 ? 0.4 : -0.4));
        return { time, open: close - direction * 0.3, high: close + 1.5,
            low: close - 1.5, close, volume: i === 39 ? 3_000 : 2_000 };
    });
    const previous = daily.at(-1)!.close;
    const session = (day: number, volume: number): Candle[] => Array.from({ length: 40 }, (_, i) => {
        const close = previous + direction * (0.12 + i * 0.018);
        const open = close - direction * 0.018;
        return { time: day + 9 * 3_600 + (i + 1) * 60, open,
            high: Math.max(open, close) + 0.04, low: Math.min(open, close) - 0.04, close, volume };
    });
    const price = previous + direction * 0.85;
    return {
        contract: { region: 'TW', security_type: 'STK', exchange: 'TSE', code, name: `測試${code}`, target_code: null,
            currency: 'TWD', day_trade: 'Yes', update_date: date, reference: previous,
            limit_up: previous * 1.1, limit_down: previous * 0.9, category: '24',
            margin_trading_balance: 0, short_selling_balance: 0, unit: 1_000, trading_suspended: false, disposition_level: 0 },
        daily, minutes: [...days.slice(-14).flatMap(day => session(day, 100)), ...session(today, 200)],
        snapshot: { code, exchange: 'TSE', datetime: `${date}T09:40:25+08:00`, open: previous + direction * 0.1,
            high: Math.max(previous, price) + 0.2, low: Math.min(previous, price) - 0.2, close: price,
            average_price: previous + direction * 0.5, buy_price: price - 0.1, sell_price: price + 0.1,
            buy_volume: 10, sell_volume: 12, volume: 100, total_volume: 8_000, amount: 100_000,
            total_amount: 850_000_000, change_price: direction * 0.85, change_rate: direction * 0.8,
            change_type: '1', tick_type: '1', volume_ratio: 99, yesterday_volume: 3_000 },
        shortSource: { quantity: 100, datetime: `${date}T09:40:25+08:00` },
    };
}

function frame(time: string, value = input(), quoteTime = time): StrategyFrame {
    const copy = structuredClone(value);
    copy.snapshot!.datetime = `${date}T${quoteTime}+08:00`;
    if (copy.shortSource) copy.shortSource.datetime = `${date}T${quoteTime}+08:00`;
    return { schemaVersion: 1, engineVersion: STRATEGY_ENGINE_VERSION, id: time, capturedAt: now(time),
        sourceKey: 'fixture:TSE', inputs: [copy], poolCodes: [copy.contract.code], warnings: [], decisions: [] };
}

function atPrice(value: DaytradeInput, price: number): DaytradeInput {
    const copy = structuredClone(value);
    Object.assign(copy.snapshot!, { close: price, buy_price: price - 0.1, sell_price: price + 0.1,
        high: Math.max(copy.snapshot!.open, price) + 0.2, low: Math.min(copy.snapshot!.open, price) - 0.2 });
    return copy;
}

function stopFrames(direction: 1 | -1 = 1): StrategyFrame[] {
    const value = input(direction);
    const stop = direction === 1 ? 105 : 94;
    return [frame('09:40:30', value, '09:40:25'), frame('09:41:00', value, '09:40:55'),
        frame('09:42:00', atPrice(value, stop), '09:41:55'), frame('09:42:30', atPrice(value, stop - direction * 0.1), '09:42:25')];
}

describe('causal strategy snapshot replay', () => {
    it('keeps identical baseline and candidate portfolios when RVOL is identical', () => {
        const result = compareStrategyFrames(stopFrames(), { ...settings, candidateRvol: 1.5 });
        expect(result.baseline).toEqual(result.candidate);
        expect(result.frames.every(item => !item.addedLong.length && !item.removedLong.length)).toBe(true);
        expect(result.baseline.trades).toHaveLength(1);
    });

    it('uses the same pool and allows only the candidate new-entry threshold to differ', () => {
        const result = compareStrategyFrames(stopFrames(), { ...free, candidateRvol: 2.5 });
        expect(result.frames[0]!.removedLong).toEqual(['2330']);
        expect(result.frames[0]!.addedLong).toEqual([]);
        expect(result.baseline.trades).toHaveLength(1);
        expect(result.candidate.trades).toHaveLength(0);
        expect(result.candidate.openPositions).toHaveLength(0);
    });

    it('never fills on the signal snapshot or repeated source timestamp', () => {
        const first = frame('09:40:30', input(), '09:40:25');
        const pending = compareStrategyFrames([first], free).baseline;
        expect(pending.openPositions).toHaveLength(0);
        expect(pending.pendingCount).toBe(1);
        const repeated = frame('09:41:00', input(), '09:40:25');
        const result = compareStrategyFrames([first, repeated], free).baseline;
        expect(result.openPositions).toHaveLength(0);
        expect(result.pendingCount).toBe(1);
        expect(result.skippedFills).toBe(1);
        const later = compareStrategyFrames([first, repeated, frame('09:41:30')], free).baseline;
        expect(later.openPositions[0]!.entryAt).toBe(now('09:41:30'));
        expect(later.pendingCount).toBe(0);
    });

    it('does not force-close a dataset ending with an open position or pending exit', () => {
        const frames = stopFrames();
        const open = compareStrategyFrames(frames.slice(0, 2), free).baseline;
        expect(open.openPositions).toHaveLength(1);
        expect(open.trades).toHaveLength(0);
        expect(open.netPnl).toBe(0);
        const pendingExit = compareStrategyFrames(frames.slice(0, 3), free).baseline;
        expect(pendingExit.pendingCount).toBe(1);
        expect(pendingExit.openPositions).toHaveLength(1);
        expect(pendingExit.trades).toHaveLength(0);
    });

    it.each([1, -1] as const)('applies bid/ask, both-side slippage and costs on side %s', direction => {
        const frames = stopFrames(direction);
        const result = compareStrategyFrames(frames, settings).baseline;
        const trade = result.trades[0]!;
        expect(result.trades).toHaveLength(1);
        const rawEntry = direction === 1 ? frames[1]!.inputs[0]!.snapshot!.sell_price : frames[1]!.inputs[0]!.snapshot!.buy_price;
        const rawExit = direction === 1 ? frames[3]!.inputs[0]!.snapshot!.buy_price : frames[3]!.inputs[0]!.snapshot!.sell_price;
        const entry = rawEntry * (1 + direction * 0.0005);
        const exit = rawExit * (1 - direction * 0.0005);
        const fees = Math.max(20, entry * 1_000 * 0.001425) + Math.max(20, exit * 1_000 * 0.001425);
        const tax = (direction === 1 ? exit : entry) * 1_000 * 0.0015;
        expect(trade.entryPrice).toBeCloseTo(entry, 10);
        expect(trade.exitPrice).toBeCloseTo(exit, 10);
        expect(trade.fees).toBeCloseTo(fees, 8);
        expect(trade.tax).toBeCloseTo(tax, 8);
        expect(trade.netPnl).toBeCloseTo((exit - entry) * 1_000 * direction - fees - tax, 8);
        expect(result.totalCosts).toBeCloseTo(fees + tax + (Math.abs(rawEntry - entry) + Math.abs(rawExit - exit)) * 1_000, 8);
        expect(result.maxRealizedDrawdown).toBeCloseTo(-trade.netPnl, 8);
        expect(result.winRate).toBe(0);
        expect(trade.exitReason).toContain('2%');
    });

    it('applies minimum commission separately to both legs', () => {
        const result = compareStrategyFrames(stopFrames(), { ...free, minFeeTwd: 20 }).baseline;
        expect(result.trades[0]!.fees).toBe(40);
        expect(result.totalCosts).toBe(40);
    });

    it('keeps past decisions and completed trades invariant when future frames are appended', () => {
        const frames = stopFrames();
        const prefix = compareStrategyFrames(frames, settings);
        const extended = compareStrategyFrames([...frames, frame('10:00:00', atPrice(input(), 106))], settings);
        expect(extended.frames.slice(0, frames.length)).toEqual(prefix.frames);
        expect(extended.baseline.trades.slice(0, prefix.baseline.trades.length)).toEqual(prefix.baseline.trades);
        const contaminated = structuredClone(frames[0]!);
        contaminated.inputs[0]!.daily.push({ ...input().daily.at(-1)!, time: today + 86_400, close: 10_000 });
        contaminated.inputs[0]!.minutes.push({ time: today + 14 * 3_600, open: 1, high: 1, low: 1, close: 1, volume: 1e9 });
        expect(evaluateStrategyFrame(contaminated, 1.5)).toEqual(evaluateStrategyFrame(frames[0]!, 1.5));
    });

    it('only uses index direction with a known fresh same-date timestamp', () => {
        const value = frame('09:40:30');
        const baseline = evaluateStrategyFrame(value, 1.5);
        value.indexChangeRate = 0;
        expect(evaluateStrategyFrame(value, 1.5)).toEqual(baseline);
        value.indexAsOf = now('09:40:00');
        expect(evaluateStrategyFrame(value, 1.5).long[0]!.score).toBe(baseline.long[0]!.score + 10);
        for (const at of [now('09:37:29'), now('09:40:31'), now('09:40:00') - 86_400_000]) {
            value.indexAsOf = at;
            expect(evaluateStrategyFrame(value, 1.5)).toEqual(baseline);
        }
    });

    it('sorts unique frames without mutating input and rejects duplicate IDs, times, engines and sources', () => {
        const frames = stopFrames();
        const reversed = [...frames].reverse();
        expect(compareStrategyFrames(reversed, settings)).toEqual(compareStrategyFrames(frames, settings));
        expect(reversed[0]!.id).toBe('09:42:30');
        expect(() => compareStrategyFrames([frames[0]!, { ...frames[1]!, id: frames[0]!.id }], settings)).toThrow('Duplicate');
        expect(() => compareStrategyFrames([frames[0]!, { ...frames[1]!, capturedAt: frames[0]!.capturedAt }], settings)).toThrow('Duplicate');
        expect(() => compareStrategyFrames([frames[0]!, { ...frames[1]!, sourceKey: 'other' }], settings)).toThrow('sourceKey');
        expect(() => compareStrategyFrames([{ ...frames[0]!, engineVersion: 'future' as typeof STRATEGY_ENGINE_VERSION }], settings)).toThrow('engineVersion');
        expect(() => compareStrategyFrames([{ ...frames[0]!, inputs: [...frames[0]!.inputs, ...frames[0]!.inputs] }], settings)).toThrow('Duplicate');
    });

    it('defaults comparisons to the current engine and records versions for traceability', () => {
        const frames = stopFrames();
        const comparison = compareStrategyFrames(frames, settings);
        for (const frame of comparison.frames) {
            expect(frame.baselineVersion).toBe(STRATEGY_ENGINE_VERSION);
            expect(frame.candidateVersion).toBe(STRATEGY_ENGINE_VERSION);
        }
        expect(comparison.warnings.join('\n')).toMatch(/比較引擎版本：固定版/);
    });

    it('rejects an unregistered engine version in comparison settings', () => {
        expect(() => compareStrategyFrames([frame('09:40:30')],
            { ...settings, candidateEngineVersion: 'future-engine' as never })).toThrow('candidateEngineVersion');
        expect(() => compareStrategyFrames([frame('09:40:30')],
            { ...settings, baselineEngineVersion: 'future-engine' as never })).toThrow('baselineEngineVersion');
    });

    it('accepts explicit registered engine versions for both sides of a comparison', () => {
        const frames = stopFrames();
        const cross = compareStrategyFrames(frames, {
            ...settings, baselineEngineVersion: STRATEGY_ENGINE_VERSION, candidateEngineVersion: STRATEGY_ENGINE_VERSION,
        });
        const same = compareStrategyFrames(frames, settings);
        expect(cross.frames).toEqual(same.frames);
        expect(cross.baseline).toEqual(same.baseline);
        expect(cross.candidate).toEqual(same.candidate);
        expect(cross.settings.baselineEngineVersion).toBe(STRATEGY_ENGINE_VERSION);
        expect(cross.settings.candidateEngineVersion).toBe(STRATEGY_ENGINE_VERSION);
    });

    it.each(['future', 'stale', 'limit', 'locked', 'missing', 'qualification', 'unit', 'wrong-code', 'wrong-exchange'] as const)
        ('never fills a %s entry quote', kind => {
            const first = frame('09:40:30');
            const second = frame('09:44:00');
            const value = second.inputs[0]!;
            if (kind === 'future') value.snapshot!.datetime = `${date}T09:44:01+08:00`;
            if (kind === 'stale') value.snapshot!.datetime = `${date}T09:40:31+08:00`;
            if (kind === 'limit') value.snapshot!.close = value.contract.limit_up;
            if (kind === 'locked') value.snapshot!.sell_price = value.snapshot!.buy_price;
            if (kind === 'missing') value.snapshot = undefined;
            if (kind === 'qualification') value.contract.trading_suspended = true;
            if (kind === 'unit') value.contract.unit = 1.5;
            if (kind === 'wrong-code') value.snapshot!.code = '9999';
            if (kind === 'wrong-exchange') value.snapshot!.exchange = 'OTC';
            const result = compareStrategyFrames([first, second], settings).baseline;
            expect(result.openPositions).toHaveLength(0);
            expect(result.skippedFills).toBe(1);
        });

    it('expires entry after five minutes and does not fill across sessions', () => {
        const first = frame('09:40:30');
        const result = compareStrategyFrames([first, frame('09:45:31')], free).baseline;
        expect(result.openPositions).toHaveLength(0);
        expect(result.pendingCount).toBe(0);
        const nextDay = frame('09:41:00');
        nextDay.capturedAt += 86_400_000;
        const overnight = compareStrategyFrames([first, nextDay], free).baseline;
        expect(overnight.openPositions).toHaveLength(0);
        expect(overnight.pendingCount).toBe(0);
    });

    it('rechecks a short source at fill, rather than trusting the earlier signal', () => {
        const frames = stopFrames(-1).slice(0, 2);
        frames[1]!.inputs[0]!.shortSource = { quantity: 0, datetime: `${date}T09:40:55+08:00` };
        expect(compareStrategyFrames(frames, free).baseline.openPositions).toHaveLength(0);
        frames[1]!.inputs[0]!.shortSource = { quantity: 100, datetime: `${date}T09:35:00+08:00` };
        expect(compareStrategyFrames(frames, free).baseline.openPositions).toHaveLength(0);
    });

    it('executes the previously scheduled 13:25 exit only with a new quote at/after cutoff', () => {
        const frames = stopFrames().slice(0, 2);
        const atCutoff = frame('13:25:00', atPrice(input(), 110));
        const result = compareStrategyFrames([...frames, atCutoff], free).baseline;
        expect(result.trades).toHaveLength(1);
        expect(result.trades[0]!.exitAt).toBe(now('13:25:00'));
        expect(result.trades[0]!.exitReason).toContain('13:25');
        expect(result.openPositions).toHaveLength(0);
        expect(result.pendingCount).toBe(0);
        expect(result.winRate).toBe(100);
        atCutoff.inputs[0]!.snapshot!.datetime = `${date}T13:24:59+08:00`;
        expect(compareStrategyFrames([...frames, atCutoff], free).baseline.openPositions).toHaveLength(1);
        const tooLate = frame('13:30:00');
        expect(compareStrategyFrames([...frames, tooLate], free).baseline.openPositions).toHaveLength(1);
        expect(compareStrategyFrames([...frames, frame('13:31:00')], free).baseline.openPositions).toHaveLength(1);
    });

    it('does not open new positions at cutoff or re-enter the event it just exited', () => {
        const value = frame('13:25:00');
        expect(compareStrategyFrames([value], free).baseline.pendingCount).toBe(0);
        const frames = stopFrames().slice(0, 3);
        frames.push(frame('09:42:30'));
        const result = compareStrategyFrames(frames, free).baseline;
        expect(result.trades).toHaveLength(1);
        expect(result.pendingCount).toBe(0);
    });

    it('does not evaluate partial/gapped bars for trend exits; a later complete break creates an intent', () => {
        const frames = stopFrames().slice(0, 2);
        const value = input();
        const tail = value.minutes.at(-1)!;
        for (let i = 1; i <= 5; i++) value.minutes.push({ ...tail, time: tail.time + i * 60,
            open: 107, high: 107.1, low: 106.9, close: 107 });
        const partial = frame('09:44:30', value);
        expect(compareStrategyFrames([...frames, partial], free).baseline.pendingCount).toBe(0);
        const closed = frame('09:45:00', value);
        expect(compareStrategyFrames([...frames, closed], free).baseline.pendingCount).toBe(1);
        closed.inputs[0]!.minutes.pop();
        expect(compareStrategyFrames([...frames, closed], free).baseline.pendingCount).toBe(0);
    });

    it('limits each side to ten open/pending one-lot positions and never adds while already pending', () => {
        const first = frame('09:40:30');
        first.inputs = Array.from({ length: 24 }, (_, i) => input(i < 12 ? 1 : -1, String(3000 + i)));
        first.poolCodes = first.inputs.map(value => value.contract.code);
        const second = structuredClone(first);
        second.id = 'next'; second.capturedAt = now('09:41:00');
        second.inputs.forEach(value => { value.snapshot!.datetime = `${date}T09:40:55+08:00`; });
        const result = compareStrategyFrames([first, second], free).baseline;
        expect(result.openPositions).toHaveLength(20);
        expect(result.openPositions.every(position => position.quantity === 1_000)).toBe(true);
        expect(result.pendingCount).toBe(0);
    });

    it('validates configurable assumptions and represents no-trade statistics without a fake win rate', () => {
        for (const mutation of [{ candidateRvol: 1 }, { feeBps: -1 }, { taxBps: Number.NaN }, { slippageBps: 1001 }, { minFeeTwd: Infinity }]) {
            expect(() => compareStrategyFrames([], { ...settings, ...mutation } as StrategySettings)).toThrow();
        }
        const result = compareStrategyFrames([], settings).baseline;
        expect(result).toMatchObject({ trades: [], openPositions: [], pendingCount: 0, winRate: null, netPnl: 0,
            totalCosts: 0, maxRealizedDrawdown: 0, skippedFills: 0 });
    });
});
