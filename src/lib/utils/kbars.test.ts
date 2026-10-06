// src/lib/utils/kbars.test.ts — aggregate() 必須沿用 shioaji 1 分 K 的
// close-label-right 慣例：N 分 K 的 label 是桶的收盤分鐘（5 分 K =
// 08:50、08:55…13:45），不是開盤分鐘。

import { describe, expect, it } from 'vitest';
import type { Candle } from '../types/market';
import { aggregate, kbarsToCandles, wallClockToUtc } from './kbars';

const t = (s: string) => wallClockToUtc(s);

// labels (from, to] 的 1 分 K，價格遞增方便驗 OHLC
function minBars(from: string, to: string): Candle[] {
    const out: Candle[] = [];
    let i = 0;
    for (let m = t(from) + 60; m <= t(to); m += 60) {
        i += 1;
        out.push({
            time: m,
            open: i,
            high: i + 0.5,
            low: i - 0.5,
            close: i + 0.25,
            volume: 10,
        });
    }
    return out;
}

describe('aggregate close-label-right', () => {
    it('combines Friday night and Monday day in one Monday daily candle', () => {
        const rows = [
            ...minBars('2026-09-25T15:00:00', '2026-09-25T15:02:00'),
            ...minBars('2026-09-26T04:58:00', '2026-09-26T05:00:00'),
            ...minBars('2026-09-28T08:45:00', '2026-09-28T08:47:00'),
        ];
        const result = aggregate(rows, 1440, 'FUT');
        expect(result).toHaveLength(1);
        expect(result[0]!.time).toBe(t('2026-09-28T00:00:00'));
        expect(result[0]!.volume).toBe(60);
        expect(result[0]!.open).toBe(rows[0]!.open);
        expect(result[0]!.close).toBe(rows.at(-1)!.close);
    });

    it('day-session open: labels 08:46-08:50 form the 08:50 bar', () => {
        const bars = aggregate(
            minBars('2026-08-12T08:45:00', '2026-08-12T08:55:00'),
            5, 'FUT',
        );
        expect(bars.map((b) => b.time)).toEqual([
            t('2026-08-12T08:50:00'),
            t('2026-08-12T08:55:00'),
        ]);
        // 08:50 bar = 五根 1 分 K（08:46-08:50）
        expect(bars[0]!.open).toBe(1); // label 08:46 的 open
        expect(bars[0]!.close).toBe(5.25); // label 08:50 的 close
        expect(bars[0]!.volume).toBe(50);
    });

    it('boundary label lands in its own closing bucket (08:50→08:50)', () => {
        const one = minBars('2026-08-12T08:49:00', '2026-08-12T08:50:00');
        const bars = aggregate(one, 5, 'FUT');
        expect(bars).toHaveLength(1);
        expect(bars[0]!.time).toBe(t('2026-08-12T08:50:00'));
    });

    it('full TXF day session yields 60 bars ending 13:45', () => {
        const bars = aggregate(
            minBars('2026-08-12T08:45:00', '2026-08-12T13:45:00'),
            5, 'FUT',
        );
        expect(bars).toHaveLength(60);
        expect(bars[0]!.time).toBe(t('2026-08-12T08:50:00'));
        expect(bars[bars.length - 1]!.time).toBe(t('2026-08-12T13:45:00'));
        // 每桶滿 5 根
        expect(bars.every((b) => b.volume === 50)).toBe(true);
    });

    it('stock session 09:01-13:30 → 09:05 … 13:30', () => {
        const bars = aggregate(
            minBars('2026-08-12T09:00:00', '2026-08-12T13:30:00'),
            5,
        );
        expect(bars[0]!.time).toBe(t('2026-08-12T09:05:00'));
        expect(bars[bars.length - 1]!.time).toBe(t('2026-08-12T13:30:00'));
    });

    it('daily keeps calendar-day floor labels', () => {
        const bars = aggregate(
            minBars('2026-08-12T09:00:00', '2026-08-12T10:00:00'),
            1440,
        );
        expect(bars).toHaveLength(1);
        expect(bars[0]!.time).toBe(t('2026-08-12T00:00:00'));
    });

    it('1-minute values unchanged, but storage is independent', () => {
        const src = minBars('2026-08-12T09:00:00', '2026-08-12T09:03:00');
        const bars = aggregate(src, 1);
        expect(bars).toEqual(src);
        expect(bars).not.toBe(src);
        bars.forEach((bar, i) => expect(bar).not.toBe(src[i]));
    });

    it('live minute rollover does not append the same timestamp twice', () => {
        const raw = minBars('2026-09-29T09:00:00', '2026-09-29T09:03:00');
        const bars = aggregate(raw, 1);
        const next = { time: t('2026-09-29T09:04:00'), open: 25.7, high: 25.7, low: 25.7, close: 25.7, volume: 3 };
        raw.push({ ...next });
        bars.push({ ...next });
        expect(raw).toHaveLength(4);
        expect(bars).toHaveLength(4);
        expect(bars.every((bar, i) => i === 0 || bar.time > bars[i - 1]!.time)).toBe(true);
    });

    it('same-minute tick volume is added once to each independent series', () => {
        const raw = minBars('2026-09-29T09:00:00', '2026-09-29T09:01:00');
        const bars = aggregate(raw, 1);
        raw[0]!.volume += 3;
        bars[0]!.volume += 3;
        expect(raw[0]!.volume).toBe(13);
        expect(bars[0]!.volume).toBe(13);
    });

    it('history duplicates keep the latest snapshot and strict time order', () => {
        const bars = kbarsToCandles({
            datetime: ['2026-09-29T09:02:00', '2026-09-29T09:01:00', '2026-09-29T09:02:00'],
            Open: [20, 19, 20], High: [21, 20, 22], Low: [20, 18, 19],
            Close: [21, 20, 22], Volume: [10, 5, 13], Amount: [210, 100, 286],
        });
        expect(bars.map(bar => bar.time)).toEqual([t('2026-09-29T09:01:00'), t('2026-09-29T09:02:00')]);
        expect(bars[1]).toMatchObject({ close: 22, volume: 13 });
        expect(aggregate(bars, 5)[0]!.volume).toBe(18);
    });
});
