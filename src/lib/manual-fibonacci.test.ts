import { afterEach, expect, it, vi } from 'vitest';
import { fibLevels, pickFibAnchor, readFib, validFib } from './manual-fibonacci';
afterEach(() => vi.unstubAllGlobals());
it('measures rising retracements from high back toward low', () => {
    expect(fibLevels({ start: { time: 1, price: 100 }, end: { time: 2, price: 200 } }).map(p => p.price))
        .toEqual([161.8, 150, 138.2]);
});
it('measures falling rebounds from low back toward high', () => {
    expect(fibLevels({ start: { time: 1, price: 200 }, end: { time: 2, price: 100 } }).map(p => p.price))
        .toEqual([138.2, 150, 161.8]);
});
it.each([null, {}, { start: { time: 1, price: 100 }, end: { time: 1, price: 200 } },
    { start: { time: 2, price: 100 }, end: { time: 1, price: 200 } },
    { start: { time: 1, price: 100 }, end: { time: 2, price: 100 } },
    { start: { time: 1, price: NaN }, end: { time: 2, price: 200 } }])('rejects invalid anchors %j', value => {
    expect(validFib(value)).toBe(false);
});
it('snaps only to actual traded OHLC extremes in the supplied closed candles', () => {
    const bars = [{ time: 10, open: 100, high: 110, low: 90, close: 101, volume: 20 }];
    expect(pickFibAnchor(bars, 10, 107)).toEqual({ time: 10, price: 110 });
    expect(pickFibAnchor(bars, 10, 94)).toEqual({ time: 10, price: 90 });
    expect(pickFibAnchor(bars, 11, 100)).toBeNull();
    expect(pickFibAnchor([{ ...bars[0]!, volume: 0 }], 10, 100)).toBeNull();
});
it('loads only valid drawings and survives blocked or corrupt storage', () => {
    vi.stubGlobal('localStorage', { getItem: () => '{corrupt' });
    expect(readFib('one')).toBeNull();
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); } });
    expect(readFib('one')).toBeNull();
});
