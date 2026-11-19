// src/lib/chart-trade.ts — 即時成交 → 圖表時間（K 線、走勢共用）
//
// 一筆成交進圖前要做的事都在這裡，兩種圖表用同一套入口：
// - 時間：牆鐘編碼秒數，保留小數秒（台股台北、美股紐約）
// - 時段：美股只收一般盤＋收盤競價（isUsChartTrade）
// - 分鐘標籤（K 棒結束時間）：
//   · 美股：close-label-right（ceil）；09:30 開盤那一刻歸 09:31，收盤後
//     CLOSE_GRACE 內（16:00:01 的 closing cross）歸 16:00。美股時段固定
//     09:30–16:00，收盤時間一定知道
//   · 台股 K 線：沿用 main 的 [m, m+60) → m+60（kbars.ts 的慣例；與 21391
//     歷史比對，盤中整秒成交如 TXF 09:36:00.000000 歸 09:37）。不做收盤
//     夾回 — 期/選有日盤到 16:15 的商品（BRF、GDF、RHF…），SessionKind
//     不知道個別合約的收盤時間
//   · 台股走勢：沿用 main 的 tickBucket（在走勢元件內，依當段時段框架）
// - N 分 K／日 K：美股由分鐘標籤聚合（與 utils/kbars.aggregate 同一套）；
//   台股照 main（N 分 floor+N、日 K 依成交時間的日期）

import { CLOSE_GRACE, isUsChartTrade, sessionWindowFor, tickBucket, type SessionKind } from './intraday-session';
import { nyWallClockSec, type UsTickMeta } from './us/us-quotes';
import { wallClockToUtcPrecise } from './utils/kbars';

export interface ChartTrade {
    /** 牆鐘編碼秒數（含小數秒） */
    time: number;
    price: number;
    volume: number;
}

/** 台股（行情 store 的 tick／指數 quote）：date＋time 字串，time 可帶小數秒 */
export function twChartTrade(date: string, time: string, price: number, volume: number): ChartTrade | null {
    const t = wallClockToUtcPrecise(`${date}T${time}`);
    if (!Number.isFinite(t) || !Number.isFinite(price)) return null;
    return { time: t, price, volume: Number.isFinite(volume) ? volume : 0 };
}

/** 美股逐筆：用 µs 時間；盤前、盤後（收盤競價以外）不畫，回 null */
export function usChartTrade(meta: Pick<UsTickMeta, 'ts' | 'tsUs' | 'session' | 'price' | 'volume'>): ChartTrade | null {
    const t = nyWallClockSec(meta.tsUs !== undefined ? meta.tsUs / 1000 : meta.ts);
    const price = Number(meta.price);
    if (!Number.isFinite(t) || !Number.isFinite(price) || !(meta.volume > 0)) return null;
    if (!isUsChartTrade(meta.session, t)) return null;
    return { time: t, price, volume: meta.volume };
}

/** 美股成交所屬的 1 分 K 標籤（含開盤／收盤夾回） */
export function usTradeMinuteLabel(t: number): number {
    const win = sessionWindowFor('US', t);
    if (t > win.end && t <= win.end + CLOSE_GRACE) return win.end;
    if (t >= win.start && t <= win.end) return tickBucket(win, t);
    return Math.ceil(t / 60) * 60;
}

/** 台股 K 線的 1 分 K 標籤（main 慣例：[m, m+60) → m+60） */
export function twCandleMinuteLabel(t: number): number {
    return Math.floor(t / 60) * 60 + 60;
}

/** K 線：成交所屬的 1 分 K 標籤（「僅日盤」判斷、載入期間的涵蓋判斷用） */
export function candleMinuteLabel(kind: SessionKind, t: number): number {
    return kind === 'US' ? usTradeMinuteLabel(t) : twCandleMinuteLabel(t);
}

/** 1 分 K 標籤 → N 分 K／日 K 的標籤（與 aggregate 相同） */
export function barTimeOfLabel(label: number, minutes: number): number {
    if (minutes <= 1) return label;
    if (minutes >= 1440) return Math.floor(label / 86400) * 86400;
    const bucketSec = minutes * 60;
    return Math.ceil(label / bucketSec) * bucketSec;
}

/** K 線：成交所屬的 K 棒標籤 */
export function candleBarTime(kind: SessionKind, t: number, minutes: number): number {
    if (kind === 'US') return barTimeOfLabel(usTradeMinuteLabel(t), minutes);
    // 台股照 main：日 K 依成交時間的日期，N 分 K floor+N
    if (minutes >= 1440) return Math.floor(t / 86400) * 86400;
    const bucketSec = minutes * 60;
    return Math.floor(t / bucketSec) * bucketSec + bucketSec;
}
