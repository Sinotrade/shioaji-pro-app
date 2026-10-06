import { describe, expect, it } from 'vitest';
import { researchSetups } from './research-setups';
import type { Candle } from './types/market';

const open = Date.parse('2026-10-02T09:00:00Z') / 1000;
function prices(closes: number[], start = open): Candle[] {
    return closes.flatMap((close, index) => Array.from({ length: 5 }, (_, minute) => ({
        time: start + index * 300 + (minute + 1) * 60,
        open: close, high: close + 0.1, low: close - 0.1, close, volume: 10,
    })));
}
function pullback(count = 11): Candle[] {
    const bars = prices(Array.from({ length: count }, (_, index) => 100 + index));
    for (let index = 45; index < 50 && index < bars.length; index++) {
        bars[index]!.low = 105;
        bars[index]!.high = 109.5;
    }
    return bars;
}
function mirror(bars: Candle[]): Candle[] {
    return bars.map(bar => ({ ...bar, open: 200 - bar.open, high: 200 - bar.low,
        low: 200 - bar.high, close: 200 - bar.close }));
}
const nowFor = (bars: Candle[]) => bars.at(-1)!.time + 10;

describe('researchSetups: independent closed-5m shadow states', () => {
    it('confirms failed VWAP reclaim only AFTER a later closed bar loses it again', () => {
        const bars = prices([100, 98, 103, 97]);
        const pending = researchSetups(bars.slice(0, 15), 'STK', open + 900);
        expect(pending).toMatchObject({ state: 'waiting-confirmation', side: 'short', setup: 'failed-reclaim', patternTime: open + 900 });
        expect(pending.confirmedAt).toBeUndefined();
        const confirmed = researchSetups(bars, 'STK', nowFor(bars));
        expect(confirmed).toMatchObject({ state: 'confirmed', side: 'short', setup: 'failed-reclaim',
            patternTime: open + 900, confirmedAt: open + 1200 });
    });
    it('supports the mirror: lost VWAP then later reclaimed', () => {
        const bars = prices([100, 102, 97, 103]);
        expect(researchSetups(bars, 'STK', nowFor(bars))).toMatchObject({
            state: 'confirmed', side: 'long', setup: 'failed-reclaim', label: '跌破VWAP後收復',
        });
    });
    it('never calls the initial crossing a same-bar confirmation', () => {
        const bars = prices([100, 98, 103]);
        expect(researchSetups(bars, 'STK', nowFor(bars)).state).toBe('waiting-confirmation');
    });
    it('expires a failed-reclaim after three subsequent closed bars', () => {
        const bars = prices([100, 98, 103, 104, 105, 106, 97]);
        const result = researchSetups(bars, 'STK', nowFor(bars));
        expect(result.state).not.toBe('confirmed');
        expect(result.confirmedAt).toBeUndefined();
    });
    it('does not keep a historical failed-reclaim confirmation lit', () => {
        const bars = prices([100, 98, 103, 97, 96]);
        expect(researchSetups(bars, 'STK', nowFor(bars))).toMatchObject({ state: 'observing' });
    });
    it('arms an EMA8 pullback only after two prior same-side aligned EMA3/8 bars', () => {
        const bars = pullback(10);
        const result = researchSetups(bars, 'STK', nowFor(bars));
        expect(result).toMatchObject({ state: 'waiting-confirmation', side: 'long', setup: 'pullback', patternTime: open + 3000 });
        expect(result.confirmedAt).toBeUndefined();
    });
    it('confirms a pullback on a later close through its high, never on its low/initial bar', () => {
        const bars = pullback();
        const result = researchSetups(bars, 'STK', nowFor(bars));
        expect(result).toMatchObject({ state: 'confirmed', setup: 'pullback', side: 'long',
            patternTime: open + 3000, confirmedAt: open + 3300, asOf: open + 3300 });
    });
    it('supports short trend rebound followed by a later close below its low', () => {
        const bars = mirror(pullback());
        expect(researchSetups(bars, 'STK', nowFor(bars))).toMatchObject({
            state: 'confirmed', setup: 'pullback', side: 'short', confirmedAt: open + 3300,
        });
    });
    it('cancels a pullback when its VWAP side is lost, rather than confirming the old trend', () => {
        const bars = [...pullback(10), ...prices([90], open + 3000)];
        const result = researchSetups(bars, 'STK', nowFor(bars));
        expect(result.state).not.toBe('confirmed');
        expect(result.setup).not.toBe('pullback');
    });
    it('does not recycle historical pullback confirmation after more closed bars', () => {
        const bars = pullback(13);
        expect(researchSetups(bars, 'STK', nowFor(bars))).toMatchObject({ state: 'observing' });
    });
    it('allows the third later closed bar, but expires before the fourth can confirm', () => {
        const timely = [...pullback(10), ...prices([108.8, 109, 110], open + 3000)];
        expect(researchSetups(timely, 'STK', nowFor(timely))).toMatchObject({
            state: 'confirmed', setup: 'pullback', confirmedAt: open + 3900,
        });
        const expired = [...pullback(10), ...prices([108.8, 109, 109.4, 110], open + 3000)];
        expect(researchSetups(expired, 'STK', nowFor(expired)).state).not.toBe('confirmed');
    });
    it('a flat zero-volatility price is neutral observation, never a direction or confirmation', () => {
        const bars = prices(Array(15).fill(100));
        const result = researchSetups(bars, 'STK', nowFor(bars));
        expect(result).toMatchObject({ state: 'observing', label: '觀察中' });
        expect(result.side).toBeUndefined();
        expect(result.detail).toContain('中性');
    });
    it('fails closed for missing first minute, interior gap, stale latest minute and unknown clock', () => {
        const bars = pullback();
        const cases = [bars.slice(1), bars.filter((_, index) => index !== 10), bars.slice(0, -1)];
        for (const input of cases) expect(researchSetups(input, 'STK', nowFor(bars)).state).toBe('waiting-data');
        expect(researchSetups(bars, 'STK', NaN).state).toBe('waiting-data');
        expect(researchSetups(bars, 'STK', nowFor(bars) + 300).state).toBe('waiting-data');
    });
    it('does not use an unfinished 5m confirmation, even if those future minutes are provided', () => {
        const bars = pullback();
        expect(researchSetups(bars, 'STK', open + 3299).state).not.toBe('confirmed');
        expect(researchSetups(bars, 'STK', open + 3300).state).toBe('confirmed');
    });
    it('is waiting when the latest closed 5m has no trades', () => {
        const bars = pullback();
        bars.slice(-5).forEach(bar => { bar.volume = 0; });
        const result = researchSetups(bars, 'STK', nowFor(bars));
        expect(result.state).toBe('waiting-data');
        expect(result.detail).toContain('無成交量');
    });
    it('historical zero-volume 5m breaks a pending sequence, without permanently disabling later new setups', () => {
        const interrupted = prices([100, 98, 103, 100, 97]);
        interrupted.slice(15, 20).forEach(bar => { bar.volume = 0; });
        expect(researchSetups(interrupted, 'STK', nowFor(interrupted)).state).not.toBe('confirmed');
        const later = [...interrupted, ...prices([103, 96], open + 1500)];
        expect(researchSetups(later, 'STK', nowFor(later))).toMatchObject({
            state: 'confirmed', setup: 'failed-reclaim', patternTime: open + 1800, confirmedAt: open + 2100,
        });
    });
    it('does not confirm outside the session or reuse prior-day observations', () => {
        const bars = prices([100, 98, 103, 97]);
        expect(researchSetups(bars, 'STK', open + 5 * 3600).state).toBe('waiting-data');
        expect(researchSetups(bars, 'STK', open + 86400 + 1200).state).toBe('waiting-data');
    });
    it('keeps the night anchor through midnight and uses completed5m across that boundary', () => {
        const night = Date.parse('2026-10-01T15:00:00Z') / 1000;
        const bars = prices([...Array(108).fill(100), 98, 103, 97], night);
        const result = researchSetups(bars, 'FUT', nowFor(bars));
        expect(result).toMatchObject({ state: 'confirmed', setup: 'failed-reclaim', side: 'short',
            confirmedAt: night + 111 * 300 });
    });
    it('uses prior same-security closed5m background to seed EMA3/8, without resetting the lines at open', () => {
        const previous = prices(Array.from({ length: 20 }, (_, index) => 80 + index), open - 86400);
        const current = prices([100, 101, 102, 103]);
        current.forEach(bar => { bar.low = bar.close - 0.2; }); // first close is strictly above its HLC3 VWAP
        current.slice(10, 15).forEach(bar => { bar.low = 98; bar.high = 102.5; });
        expect(researchSetups(current, 'STK', nowFor(current)).state).not.toBe('confirmed');
        const result = researchSetups([...previous, ...current], 'STK', nowFor(current));
        expect(result).toMatchObject({ state: 'confirmed', setup: 'pullback', side: 'long',
            patternTime: open + 900, confirmedAt: open + 1200 });
    });
    it('does not carry a previous-session reclaim candidate or historical confirmation into a new session', () => {
        const priorPending = prices([100, 98, 103], open - 86400);
        const priorConfirmed = prices([100, 98, 103, 97], open - 86400);
        const current = prices([97, 96]);
        for (const previous of [priorPending, priorConfirmed]) {
            const result = researchSetups([...previous, ...current], 'STK', nowFor(current));
            expect(result.state).toBe('observing');
            expect(result.patternTime).toBeUndefined();
            expect(result.confirmedAt).toBeUndefined();
        }
    });
    it('background EMA seeding and current-session setup evaluation remain causal with future input appended', () => {
        const previous = prices(Array.from({ length: 20 }, (_, index) => 80 + index), open - 86400);
        const current = prices([100, 101, 102, 103, 104, 105]);
        current.forEach(bar => { bar.low = bar.close - 0.2; });
        current.slice(10, 15).forEach(bar => { bar.low = 98; bar.high = 102.5; });
        const all = [...previous, ...current, ...prices([1000, 999], open + 86400)];
        for (let count = 5; count <= current.length; count += 5) {
            const now = current[count - 1]!.time;
            expect(researchSetups(all, 'STK', now)).toEqual(researchSetups([...previous, ...current.slice(0, count)], 'STK', now));
        }
    });
    it('is prefix causal for every closed-bar evaluation; appending future bars cannot change the past', () => {
        for (const bars of [pullback(13), prices([100, 98, 103, 97, 96]), mirror(pullback())]) {
            for (let count = 5; count <= bars.length; count += 5) {
                const now = bars[count - 1]!.time;
                expect(researchSetups(bars, 'STK', now)).toEqual(researchSetups(bars.slice(0, count), 'STK', now));
            }
        }
    });
});
