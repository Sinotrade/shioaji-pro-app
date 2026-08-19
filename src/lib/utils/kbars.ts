// src/lib/utils/kbars.ts — KBars column arrays -> candles, aggregation

import type { Candle, KBars } from '../types/market';

// kbar datetimes are Taiwan local; encode wall-clock as UTC so the chart
// axis shows Taiwan session times regardless of viewer timezone.
export function wallClockToUtc(dt: string): number {
    const y = Number(dt.slice(0, 4));
    const mo = Number(dt.slice(5, 7));
    const d = Number(dt.slice(8, 10));
    const h = Number(dt.slice(11, 13)) || 0;
    const mi = Number(dt.slice(14, 16)) || 0;
    const s = Number(dt.slice(17, 19)) || 0;
    return Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
}

export function kbarsToCandles(k: KBars): Candle[] {
    const byTime = new Map<number, Candle>();
    for (let i = 0; i < k.datetime.length; i++) {
        const dt = k.datetime[i];
        if (!dt) continue;
        const time = wallClockToUtc(dt);
        byTime.set(time, {
            time: wallClockToUtc(dt),
            open: k.Open[i] ?? 0,
            high: k.High[i] ?? 0,
            low: k.Low[i] ?? 0,
            close: k.Close[i] ?? 0,
            volume: k.Volume[i] ?? 0,
        });
    }
    const out = [...byTime.values()];
    out.sort((a, b) => a.time - b.time);
    return out;
}

// Aggregate 1-minute candles into N-minute or daily bars.
export function aggregate(candles: Candle[], minutes: number): Candle[] {
    if (minutes <= 1) return candles;
    const out: Candle[] = [];
    let cur: Candle | null = null;
    const bucketSec = minutes * 60;
    for (const c of candles) {
        const bucket =
            minutes >= 1440
                ? Math.floor(c.time / 86400) * 86400
                : Math.floor(c.time / bucketSec) * bucketSec;
        if (!cur || cur.time !== bucket) {
            if (cur) out.push(cur);
            cur = { ...c, time: bucket };
        } else {
            cur.high = Math.max(cur.high, c.high);
            cur.low = Math.min(cur.low, c.low);
            cur.close = c.close;
            cur.volume += c.volume;
        }
    }
    if (cur) out.push(cur);
    return out;
}

export function dateStrOffset(daysAgo: number): string {
    const d = new Date(Date.now() - daysAgo * 86400_000);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}
