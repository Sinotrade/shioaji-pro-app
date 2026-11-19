// src/lib/chart-trade.ts — 即時成交 → 圖表時間（K 線、走勢共用）
//
// 一筆成交進圖前要做的事都在這裡，兩種圖表用同一套，免得一邊修了另一邊沒修：
// - 時間：牆鐘編碼秒數，保留小數秒（台股台北、美股紐約）
// - 時段：美股只收一般盤＋收盤競價（isUsChartTrade）
// - 1 分 K 標籤：close-label-right（ceil，整秒落在分界時歸自己那一分鐘），
//   開盤那一刻的成交歸第一根，收盤後 CLOSE_GRACE 內的成交（收盤競價、
//   美股 16:00:01 的 closing cross）歸最後一根
// - N 分 K／日 K：由 1 分 K 標籤聚合，與 utils/kbars.aggregate 同一套

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

/** 成交所屬的 1 分 K 標籤（含開盤／收盤夾回，見檔頭） */
export function tradeMinuteLabel(kind: SessionKind, t: number): number {
    // 收盤後的寬限內：歸剛收的那一段的最後一根
    const prev = sessionWindowFor(kind, t - CLOSE_GRACE);
    if (t > prev.end && t <= prev.end + CLOSE_GRACE) return prev.end;
    const win = sessionWindowFor(kind, t);
    if (t >= win.start && t <= win.end) return tickBucket(win, t);
    // 時段外（全盤模式的零星成交等）：照 close-label-right
    return Math.ceil(t / 60) * 60;
}

/** 1 分 K 標籤 → N 分 K／日 K 的標籤（與 aggregate 相同） */
export function barTimeOfLabel(label: number, minutes: number): number {
    if (minutes <= 1) return label;
    if (minutes >= 1440) return Math.floor(label / 86400) * 86400;
    const bucketSec = minutes * 60;
    return Math.ceil(label / bucketSec) * bucketSec;
}
