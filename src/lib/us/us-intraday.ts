// src/lib/us/us-intraday.ts — 美股走勢的資料組合（歷史 1 分 K 收盤＋即時一般盤逐筆）
//
// x 軸固定一般盤 09:30–16:00（美東時間，牆鐘當 UTC 的秒數）。有歷史時：歷史
// 的 K 棒收盤（K 棒結束時間）接上同一交易日、比最後一根還新的一般盤逐筆。
// 即時逐筆若已是更新的交易日（例如歷史抓在開盤前），改畫那一天、只用逐筆。

import type { Candle } from '../types/market';
import { nyDateTime, type UsTickMeta } from './us-quotes';
import { usRegularSessionRange } from './us-history';
import { wallClockToUtc } from '../utils/kbars';

export interface UsIntradayPoint {
    /** 紐約牆鐘當 UTC 的秒數 */
    t: number;
    price: number;
}

export interface UsIntradaySeries {
    date: string;
    start: number;
    end: number;
    points: UsIntradayPoint[];
    /** 有用到歷史 */
    fromHistory: boolean;
}

function tickWall(t: UsTickMeta): { date: string; wall: number } {
    const { date, time } = nyDateTime(t.ts * 1000);
    return { date, wall: date ? wallClockToUtc(`${date}T${time}`) : NaN };
}

/** 沒有可用的一般盤資料回 null（呼叫端退回只畫本時段逐筆） */
export function usIntradaySeries(
    history: { date: string; bars: readonly Candle[] } | null,
    live: readonly UsTickMeta[],
): UsIntradaySeries | null {
    const regular = live
        .filter(t => t.session === 'Regular')
        .map(t => ({ ...tickWall(t), price: Number(t.price) }))
        .filter(t => t.date && Number.isFinite(t.wall) && Number.isFinite(t.price));
    const liveDate = regular.length ? regular[regular.length - 1]!.date : null;
    let date = history?.date ?? liveDate;
    if (liveDate && date && liveDate > date) date = liveDate;
    if (!date) return null;
    const { start, end } = usRegularSessionRange(date);
    const points: UsIntradayPoint[] = [];
    let fromHistory = false;
    if (history && history.date === date) {
        for (const b of history.bars) {
            if (Number.isFinite(b.close)) points.push({ t: Math.min(b.time, end), price: b.close });
        }
        fromHistory = points.length > 0;
    }
    const lastT = points.length ? points[points.length - 1]!.t : -Infinity;
    for (const t of regular) {
        if (t.date !== date || t.wall < lastT) continue;
        points.push({ t: Math.max(start, Math.min(t.wall, end)), price: t.price });
    }
    if (!points.length) return null;
    return { date, start, end, points, fromHistory };
}

/**
 * 合約的參考價能不能當這個交易日的參考線：reference_date 是參考價來源的
 * 收盤日，參考價適用於下一個交易日，所以 reference_date 必須早於畫的交易日
 * （等於或晚於時，那是這一天或之後的收盤價，不畫）。沒有日期時照用。
 */
export function usSessionReference(ref: number | null, referenceDate: string | undefined, sessionDate: string): number | null {
    if (!ref || !(ref > 0)) return null;
    if (referenceDate && referenceDate >= sessionDate) return null;
    return ref;
}

export const US_INTRADAY_W = 600;
export const US_INTRADAY_H = 240;

/** 走勢 → SVG polyline 點（x 依一般盤時段） */
export function usIntradaySessionPath(series: UsIntradaySeries, ref: number | null) {
    const prices = series.points.map(p => p.price);
    let lo = Math.min(...prices, ...(ref ? [ref] : []));
    let hi = Math.max(...prices, ...(ref ? [ref] : []));
    if (hi === lo) { hi += 0.01; lo -= 0.01; }
    const W = US_INTRADAY_W;
    const H = US_INTRADAY_H;
    const span = Math.max(1, series.end - series.start);
    const x = (t: number) => ((t - series.start) / span) * W;
    const y = (p: number) => H - ((p - lo) / (hi - lo)) * (H - 12) - 6;
    const points = series.points.map(p => `${x(p.t).toFixed(1)},${y(p.price).toFixed(1)}`).join(' ');
    return { points, refY: ref ? y(ref) : null, lo, hi, last: series.points[series.points.length - 1]!.price };
}
