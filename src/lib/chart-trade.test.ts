import { describe, expect, it } from 'vitest';
import { barTimeOfLabel, candleBarTime, candleMinuteLabel, twChartTrade, usChartTrade, usTradeMinuteLabel } from './chart-trade';
import { aggregate } from './utils/kbars';

const D = Date.UTC(2026, 10, 18) / 1000; // 牆鐘編碼的當天 00:00
const hm = (h: number, m: number, s = 0) => D + h * 3600 + m * 60 + s;

describe('US minute labels', () => {
    it('puts the closing cross (16:00:00–16:00:15) in the 16:00 bar for every timeframe', () => {
        const t = hm(16, 0, 1.445);
        expect(usTradeMinuteLabel(t)).toBe(hm(16, 0));
        for (const m of [1, 5, 60]) expect(candleBarTime('US', t, m)).toBe(hm(16, 0));
        expect(candleBarTime('US', hm(16, 0, 14.9), 1)).toBe(hm(16, 0));
    });
    it('uses close-label-right with precise seconds and puts the 09:30 open in 09:31', () => {
        expect(usTradeMinuteLabel(hm(10, 18, 30))).toBe(hm(10, 19));
        expect(usTradeMinuteLabel(hm(10, 19, 0))).toBe(hm(10, 19));
        expect(usTradeMinuteLabel(hm(10, 19, 0.2))).toBe(hm(10, 20));
        expect(usTradeMinuteLabel(hm(9, 30))).toBe(hm(9, 31));
    });
    it('matches aggregate() for the labels history uses', () => {
        const labels = [hm(9, 31), hm(9, 35), hm(9, 36), hm(10, 0), hm(10, 1), hm(16, 0)];
        for (const minutes of [1, 5, 60, 1440]) {
            const agg = aggregate(labels.map((time) => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 1 })), minutes);
            const times = new Set(agg.map((b) => b.time));
            for (const l of labels) expect(times.has(barTimeOfLabel(l, minutes))).toBe(true);
        }
    });
});

describe('TW candle buckets stay as main', () => {
    it('[m, m+60) → m+60: an exact-minute trade goes to the next bar', () => {
        expect(candleMinuteLabel('STK', hm(10, 5, 0))).toBe(hm(10, 6));
        expect(candleBarTime('STK', hm(10, 5, 0), 1)).toBe(hm(10, 6));
        expect(candleBarTime('FUT', hm(9, 36, 0), 1)).toBe(hm(9, 37));
        expect(candleBarTime('STK', hm(10, 4, 59.9), 1)).toBe(hm(10, 5));
        expect(candleBarTime('STK', hm(10, 5, 0), 5)).toBe(hm(10, 10));
    });
    it('never clamps futures to 13:45 (long day products trade until 16:15)', () => {
        expect(candleMinuteLabel('FUT', hm(13, 46, 10))).toBe(hm(13, 47));
        expect(candleBarTime('FUT', hm(13, 46, 10), 1)).toBe(hm(13, 47));
        expect(candleBarTime('FUT', hm(13, 46, 10), 5)).toBe(hm(13, 50));
    });
    it('daily bars follow the trade time (main)', () => {
        expect(candleBarTime('FUT', hm(23, 59, 30), 1440)).toBe(D);
    });
});

describe('trade adapters', () => {
    it('TW keeps sub-second time', () => {
        expect(twChartTrade('2026-11-18', '10:19:00.500000', 100, 2)).toEqual({ time: hm(10, 19, 0.5), price: 100, volume: 2 });
    });
    it('US accepts regular and closing-cross trades only', () => {
        const ms = (h: number, m: number, s: number) => Date.UTC(2026, 10, 18, h + 5, m) + s * 1000; // 11/18 紐約 = UTC-5
        expect(usChartTrade({ ts: ms(16, 0, 1.445), session: 'AfterHours', price: '352.45', volume: 5_000_000 })?.time)
            .toBeCloseTo(hm(16, 0, 1.445), 3);
        expect(usChartTrade({ ts: ms(16, 5, 0), session: 'AfterHours', price: '352', volume: 1 })).toBeNull();
        expect(usChartTrade({ ts: ms(9, 0, 0), session: 'PreMarket', price: '352', volume: 1 })).toBeNull();
        expect(usChartTrade({ ts: ms(10, 0, 0), session: 'Regular', price: '352', volume: 0 })).toBeNull();
    });
});
