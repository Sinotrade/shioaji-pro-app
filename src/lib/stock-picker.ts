// src/lib/stock-picker.ts — 短線選股評分引擎（純函數、可單測）。
// 重現網路「短線 V3.1」日 K 邏輯：多頭排列／放量突破前 10 日高／
// 量價轉強／多頭續強，外層再做「過熱排除」，並產生「強勢上車」信號。
// 輸入為已聚合的日 K（Candle[]，time 為台灣日、含當日 partial 亦可）。

import type { Candle } from './types/market';

export interface PickerThresholds {
    volNeed: number; // 放量門檻（量比）
    rsiPeriod: number;
    rsiOver: number; // 多方過熱 RSI
    rsiUnder: number; // 空方過冷 RSI
    biasOver: number; // 多方正乖離過大
    biasUnder: number; // 空方負乖離過大
    dayOver: number; // 多方單日暴漲
    dayUnder: number; // 空方單日暴跌
    gapOver: number; // 多方向上跳空
    gapUnder: number; // 空方向下跳空
    chg3Over: number; // 多方 3 日暴漲
    chg3Under: number; // 空方 3 日暴跌
}

export const DEFAULT_PICKER_THRESHOLDS: PickerThresholds = {
    volNeed: 1.5,
    rsiPeriod: 14,
    rsiOver: 85,
    rsiUnder: 15,
    biasOver: 0.15,
    biasUnder: -0.15,
    dayOver: 0.09,
    dayUnder: -0.09,
    gapOver: 0.08,
    gapUnder: -0.08,
    chg3Over: 0.22,
    chg3Under: -0.22,
};

export interface EntrySignal {
    time: number; // 信號日（日 K time）
    level: number; // 突破的前 10 日高（多方）／跌破的前 10 日低（空方）
}
export type ShortSignal = EntrySignal;

export interface PickerScore {
    asOf: number;
    side: 'long' | 'short';
    score: number;
    status: '強轉' | '弱轉' | '蓄勢' | '觀望';
    pattern: string;
    volumeRatio: number;
    changePct: number;
    rsi: number;
    biasPct: number;
    excluded: boolean;
    excludeReasons: string[];
    isEntry: boolean; // 多＝可做多、空＝可放空
    level: number;
}

// 需用到 MA20 與其前值、前 10 日高 → 最早可評估的 index
const MIN_INDEX = 21;

function smaField(
    daily: Candle[],
    field: 'close' | 'volume',
    n: number,
    endIndex: number,
): number {
    if (endIndex < n - 1) return Number.NaN;
    let s = 0;
    for (let k = endIndex - n + 1; k <= endIndex; k++) s += daily[k]![field];
    return s / n;
}

// Wilder RSI，以全域最早 period 個變化為種子、平滑到 endIndex
function rsiAt(daily: Candle[], period: number, endIndex: number): number {
    if (endIndex < period) return Number.NaN;
    let gain = 0;
    let loss = 0;
    for (let k = 1; k <= period; k++) {
        const d = daily[k]!.close - daily[k - 1]!.close;
        if (d > 0) gain += d;
        else loss -= d;
    }
    let ag = gain / period;
    let al = loss / period;
    for (let k = period + 1; k <= endIndex; k++) {
        const d = daily[k]!.close - daily[k - 1]!.close;
        const g = d > 0 ? d : 0;
        const l = d < 0 ? -d : 0;
        ag = (ag * (period - 1) + g) / period;
        al = (al * (period - 1) + l) / period;
    }
    if (al === 0) return 100;
    return 100 - 100 / (1 + ag / al);
}

function clamp(v: number, lo: number, hi: number) {
    return Math.max(lo, Math.min(hi, v));
}

export function evaluateAt(
    daily: Candle[],
    i: number,
    t: PickerThresholds = DEFAULT_PICKER_THRESHOLDS,
): PickerScore | null {
    if (i < MIN_INDEX || i >= daily.length) return null;
    const c = daily[i]!;
    const prev = daily[i - 1]!;

    const ma5 = smaField(daily, 'close', 5, i);
    const ma10 = smaField(daily, 'close', 10, i);
    const ma20 = smaField(daily, 'close', 20, i);
    const ma20Prev = smaField(daily, 'close', 20, i - 1);

    const rsi = rsiAt(daily, t.rsiPeriod, i);

    let prevHigh10 = -Infinity;
    for (let k = i - 10; k <= i - 1; k++)
        prevHigh10 = Math.max(prevHigh10, daily[k]!.high);

    const volT = c.volume;
    const volAvg5 = smaField(daily, 'volume', 5, i - 1);
    const volAvg10 = smaField(daily, 'volume', 10, i - 1);
    const volumeRatio = volAvg5 > 0 ? volT / volAvg5 : 0;

    const changePct = prev.close > 0 ? c.close / prev.close - 1 : 0;
    const gapPct = prev.close > 0 ? c.open / prev.close - 1 : 0;
    const chg3 =
        daily[i - 3]!.close > 0 ? c.close / daily[i - 3]!.close - 1 : 0;
    const biasPct = ma20 > 0 ? c.close / ma20 - 1 : 0;

    // ---- 條件旗標 ----
    const ma20Up = ma20 > ma20Prev;
    const bullAlign = ma5 > ma10 && ma10 > ma20;
    const trendUp = c.close > ma20 && ma20Up;
    const priorVolShrink = volAvg5 < volAvg10;
    const volExpand = volumeRatio >= t.volNeed;
    const breakout = c.close > prevHigh10;
    const highBreak = c.high >= prevHigh10;
    const nearHigh = c.close >= prevHigh10 * 0.97;
    const volPriceUp = priorVolShrink && volExpand && changePct > 0;
    const contStrong = bullAlign && ma20Up && changePct > 0;
    const rsiHealthy = rsi >= 50 && rsi <= 75;
    const momentum = changePct > 0 && changePct <= 0.05;

    // ---- 過熱排除 ----
    const excludeReasons: string[] = [];
    if (rsi > t.rsiOver) excludeReasons.push('RSI>85');
    if (biasPct > t.biasOver) excludeReasons.push('乖離>15%');
    if (changePct >= t.dayOver) excludeReasons.push('單日漲≥9%');
    if (gapPct >= t.gapOver) excludeReasons.push('跳空≥8%');
    if (chg3 >= t.chg3Over) excludeReasons.push('3日漲≥22%');
    const excluded = excludeReasons.length > 0;

    // ---- 加權評分 ----
    let s = 0;
    if (trendUp) s += 12;
    if (bullAlign) s += 18;
    if (volExpand) s += 15;
    if (breakout) s += 20;
    else if (nearHigh) s += 8;
    if (volPriceUp) s += 12;
    if (contStrong) s += 10;
    if (rsiHealthy) s += 8;
    if (momentum) s += 5;
    if (rsi < 50) s -= 10;
    if (c.close < ma20) s -= 15;
    if (changePct < 0 && volumeRatio < 1) s -= 8;
    const score = Math.round(clamp(s, 0, 100));

    const isEntry =
        (breakout || highBreak) &&
        volExpand &&
        (bullAlign || trendUp) &&
        !excluded;

    const status: PickerScore['status'] = excluded
        ? '觀望'
        : score >= 75 && (breakout || volExpand)
          ? '強轉'
          : score >= 55
            ? '蓄勢'
            : '觀望';

    const pattern = excluded
        ? '過熱排除'
        : breakout && volExpand
          ? '放量突破'
          : contStrong
            ? '多頭續強'
            : volPriceUp
              ? '量價轉強'
              : trendUp && nearHigh
                ? '整理蓄勢'
                : '—';

    return {
        asOf: c.time,
        side: 'long',
        score,
        status,
        pattern,
        volumeRatio,
        changePct,
        rsi,
        biasPct,
        excluded,
        excludeReasons,
        isEntry,
        level: prevHigh10,
    };
}

/** 對最後一根日 K 評分（資料不足回 null）。 */
export function scoreStock(
    daily: Candle[],
    t: PickerThresholds = DEFAULT_PICKER_THRESHOLDS,
): PickerScore | null {
    return evaluateAt(daily, daily.length - 1, t);
}

/** 掃描整段日 K，回所有「強勢上車」信號（給 K 線標記用）。 */
export function collectEntrySignals(
    daily: Candle[],
    t: PickerThresholds = DEFAULT_PICKER_THRESHOLDS,
): EntrySignal[] {
    const out: EntrySignal[] = [];
    for (let i = MIN_INDEX; i < daily.length; i++) {
        const e = evaluateAt(daily, i, t);
        if (e?.isEntry) out.push({ time: daily[i]!.time, level: e.level });
    }
    return out;
}

/**
 * 空方鏡像：空頭排列／放量跌破前 10 日低／量價轉弱／空頭續弱，
 * 外層做「過冷排除」（極端超賣易急彈被軋），產生「弱勢放空」信號。
 */
export function evaluateShortAt(
    daily: Candle[],
    i: number,
    t: PickerThresholds = DEFAULT_PICKER_THRESHOLDS,
): PickerScore | null {
    if (i < MIN_INDEX || i >= daily.length) return null;
    const c = daily[i]!;
    const prev = daily[i - 1]!;

    const ma5 = smaField(daily, 'close', 5, i);
    const ma10 = smaField(daily, 'close', 10, i);
    const ma20 = smaField(daily, 'close', 20, i);
    const ma20Prev = smaField(daily, 'close', 20, i - 1);

    const rsi = rsiAt(daily, t.rsiPeriod, i);

    let prevLow10 = Infinity;
    for (let k = i - 10; k <= i - 1; k++)
        prevLow10 = Math.min(prevLow10, daily[k]!.low);

    const volT = c.volume;
    const volAvg5 = smaField(daily, 'volume', 5, i - 1);
    const volAvg10 = smaField(daily, 'volume', 10, i - 1);
    const volumeRatio = volAvg5 > 0 ? volT / volAvg5 : 0;

    const changePct = prev.close > 0 ? c.close / prev.close - 1 : 0;
    const gapPct = prev.close > 0 ? c.open / prev.close - 1 : 0;
    const chg3 =
        daily[i - 3]!.close > 0 ? c.close / daily[i - 3]!.close - 1 : 0;
    const biasPct = ma20 > 0 ? c.close / ma20 - 1 : 0;

    // ---- 條件旗標（方向反轉）----
    const ma20Down = ma20 < ma20Prev;
    const bearAlign = ma5 < ma10 && ma10 < ma20;
    const trendDown = c.close < ma20 && ma20Down;
    const priorVolShrink = volAvg5 < volAvg10;
    const volExpand = volumeRatio >= t.volNeed;
    const breakdown = c.close < prevLow10;
    const lowBreak = c.low <= prevLow10;
    const nearLow = c.close <= prevLow10 * 1.03;
    const volPriceDown = priorVolShrink && volExpand && changePct < 0;
    const contWeak = bearAlign && ma20Down && changePct < 0;
    const rsiHealthy = rsi <= 50 && rsi >= 25;
    const momentum = changePct < 0 && changePct >= -0.05;

    // ---- 過冷排除（極端超賣不追空）----
    const excludeReasons: string[] = [];
    if (rsi < t.rsiUnder) excludeReasons.push('RSI<15');
    if (biasPct < t.biasUnder) excludeReasons.push('乖離<-15%');
    if (changePct <= t.dayUnder) excludeReasons.push('單日跌≥9%');
    if (gapPct <= t.gapUnder) excludeReasons.push('跳空<-8%');
    if (chg3 <= t.chg3Under) excludeReasons.push('3日跌≥22%');
    const excluded = excludeReasons.length > 0;

    // ---- 加權評分（鏡像）----
    let s = 0;
    if (trendDown) s += 12;
    if (bearAlign) s += 18;
    if (volExpand) s += 15;
    if (breakdown) s += 20;
    else if (nearLow) s += 8;
    if (volPriceDown) s += 12;
    if (contWeak) s += 10;
    if (rsiHealthy) s += 8;
    if (momentum) s += 5;
    if (rsi > 50) s -= 10;
    if (c.close > ma20) s -= 15;
    if (changePct > 0 && volumeRatio < 1) s -= 8;
    const score = Math.round(clamp(s, 0, 100));

    const isEntry =
        (breakdown || lowBreak) &&
        volExpand &&
        (bearAlign || trendDown) &&
        !excluded;

    const status: PickerScore['status'] = excluded
        ? '觀望'
        : score >= 75 && (breakdown || volExpand)
          ? '弱轉'
          : score >= 55
            ? '蓄勢'
            : '觀望';

    const pattern = excluded
        ? '過冷排除'
        : breakdown && volExpand
          ? '放量破底'
          : contWeak
            ? '空頭續弱'
            : volPriceDown
              ? '量價轉弱'
              : trendDown && nearLow
                ? '盤弱蓄勢'
                : '—';

    return {
        asOf: c.time,
        side: 'short',
        score,
        status,
        pattern,
        volumeRatio,
        changePct,
        rsi,
        biasPct,
        excluded,
        excludeReasons,
        isEntry,
        level: prevLow10,
    };
}

/** 對最後一根日 K 做空方評分（資料不足回 null）。 */
export function scoreStockShort(
    daily: Candle[],
    t: PickerThresholds = DEFAULT_PICKER_THRESHOLDS,
): PickerScore | null {
    return evaluateShortAt(daily, daily.length - 1, t);
}

/** 掃描整段日 K，回所有「弱勢放空」信號（給 K 線標記用）。 */
export function collectShortSignals(
    daily: Candle[],
    t: PickerThresholds = DEFAULT_PICKER_THRESHOLDS,
): ShortSignal[] {
    const out: ShortSignal[] = [];
    for (let i = MIN_INDEX; i < daily.length; i++) {
        const e = evaluateShortAt(daily, i, t);
        if (e?.isEntry) out.push({ time: daily[i]!.time, level: e.level });
    }
    return out;
}
