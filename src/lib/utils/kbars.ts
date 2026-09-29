// src/lib/utils/kbars.ts — KBars column arrays -> candles, aggregation

import type { Candle, KBars } from '../types/market';
import type { SecurityType } from '../types/contract';
import { sessionWindowFor } from '../intraday-session';

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
    // Repeated history rows are snapshots, not additional trades. Keep the
    // last row for a timestamp without adding its volume a second time.
    const byTime = new Map<number, Candle>();
    for (let i = 0; i < k.datetime.length; i++) {
        const dt = k.datetime[i];
        if (!dt) continue;
        const time = wallClockToUtc(dt);
        if (!Number.isFinite(time)) continue;
        byTime.set(time, {
            time,
            open: k.Open[i] ?? 0,
            high: k.High[i] ?? 0,
            low: k.Low[i] ?? 0,
            close: k.Close[i] ?? 0,
            volume: k.Volume[i] ?? 0,
        });
    }
    return [...byTime.values()].sort((a, b) => a.time - b.time);
}

// Aggregate 1-minute candles into session-aligned N-minute or daily bars.
// 1 分 K 是 close-label-right（label 08:46 = 08:45:00–08:45:59 成交），
// N 分 K 必須沿用同一慣例：ceil 到桶的收盤 label（5 分 K = 08:50、
// 08:55…13:45，08:50 那根 = label 08:46–08:50）。floor 會整體早移
// 一分鐘且開盤桶只剩 4 根。期貨日 K 依夜盤結束日歸屬交易日。
export function aggregate(candles: Candle[], minutes: number, securityType: SecurityType = 'STK'): Candle[] {
    // rawRef and barsRef are updated independently by the live tick handler.
    // Both the array AND its Candle objects must be independent, even at 1m.
    if (minutes <= 1) return candles.map(c => ({ ...c }));
    const out: Candle[] = [];
    let cur: Candle | null = null;
    const bucketSec = minutes * 60;
    for (const c of candles) {
        const session = sessionWindowFor(securityType, c.time);
        const bucket = minutes >= 1440
            ? securityType === 'FUT' || securityType === 'OPT'
                ? Math.floor((session.night ? session.end - 5 * 3600 : session.start) / 86400) * 86400
                : Math.floor(c.time / 86400) * 86400
            : Math.min(
                session.end,
                session.start + Math.max(1, Math.ceil((c.time - session.start) / bucketSec)) * bucketSec,
            );
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

// 現在時刻的台灣牆鐘時間，用 wallClockToUtc 同款編碼（本機時區
// 即台灣 — dateStrOffset 同一假設）
export function nowWallClockUtc(): number {
    const d = new Date();
    return (
        Date.UTC(
            d.getFullYear(),
            d.getMonth(),
            d.getDate(),
            d.getHours(),
            d.getMinutes(),
            d.getSeconds(),
        ) / 1000
    );
}

export function dateStrOffset(daysAgo: number): string {
    const d = new Date(Date.now() - daysAgo * 86400_000);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}
