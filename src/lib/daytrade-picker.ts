import type { ContractInfo } from './types/contract';
import type { Candle, Snapshot } from './types/market';

/** Research defaults, not calibrated performance claims or order instructions. */
export const DAYTRADE_DEFAULTS = {
    maxPool: 40,
    maxPerSide: 10,
    minimumDailyBars: 22,
    maximumPriorDayAge: 7,
    maximumReferenceMismatchPct: 0.5,
    minimumDailyAmount: 100_000_000,
    minimumAtrPct: 1,
    maximumAtrPct: 8,
    observationVolumeRatio: 1.2,
    minimumRvol: 1.5,
    minimumRvolSessions: 14,
    quoteAgeSeconds: 180,
    maximumSpreadPct: 0.4,
    maximumVwapDistancePct: 3,
    maximumBreakoutDistancePct: 2,
    minimumLimitDistancePct: 0.5,
    minimumLiveScore: 65,
} as const;

export type DaytradeSide = 'long' | 'short';

export interface DaytradeInput {
    contract: ContractInfo;
    daily: Candle[];
    minutes: Candle[];
    snapshot?: Snapshot;
    shortSource?: { quantity: number; datetime: string };
}

export interface DaytradeRow {
    contract: ContractInfo;
    side: DaytradeSide;
    score: number;
    price: number;
    changeRate: number;
    /** Previous completed session volume / its preceding five-session mean. */
    volumeRatio: number | null;
    /** Same-clock cumulative volume / at least 14 previous complete prefixes. */
    rvol: number | null;
    /** Minute HLC3 volume-weighted approximation, reset at 09:00. */
    vwap: number | null;
    spreadPct: number | null;
    atrPct: number | null;
    signal: string;
    reasons: string[];
    asOf: string | null;
    qualificationDate: string;
}

export interface DaytradeResult {
    long: DaytradeRow[];
    short: DaytradeRow[];
    observationsLong: DaytradeRow[];
    observationsShort: DaytradeRow[];
    excluded: { code: string; name: string; reasons: string[] }[];
    phase: 'preopen' | 'live' | 'closed';
    tradeDate: string;
}

type StockMetadata = ContractInfo & {
    unit?: number;
    trading_suspended?: boolean;
    disposition_level?: number;
    attention_flag?: boolean;
};

const DAY = 86_400;
const OPEN = 9 * 3_600;
const CLOSE = 13 * 3_600 + 25 * 60;
const TAIPEI_OFFSET_MS = 8 * 3_600_000;
const finite = (n: number) => Number.isFinite(n);
const positive = (n: number) => finite(n) && n > 0;
const mean = (values: number[]) => values.reduce((sum, n) => sum + n, 0) / values.length;
const pct = (value: number, base: number) => (value / base - 1) * 100;
const atLeast = (value: number, threshold: number) => value >= threshold - 1e-9;
const atMost = (value: number, threshold: number) => value <= threshold + 1e-9;
const above = (value: number, threshold: number) => value > threshold + 1e-9;
const dayLabel = (time: number) => Math.floor(time / DAY) * DAY;
const dateLabel = (time: number) => new Date(time * 1_000).toISOString().slice(0, 10);

function validCandle(bar: Candle): boolean {
    return Number.isInteger(bar.time) && positive(bar.open) && positive(bar.high)
        && positive(bar.low) && positive(bar.close) && finite(bar.volume) && bar.volume >= 0
        && bar.high >= Math.max(bar.open, bar.low, bar.close)
        && bar.low <= Math.min(bar.open, bar.high, bar.close);
}

/** Timestamp strings without a zone are documented by this adapter as Taipei. */
function timestampMs(value: string): number | null {
    if (typeof value !== 'string' || !value.trim()) return null;
    const normalized = value.trim().replace(' ', 'T');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(normalized)) return null;
    const parsed = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized)
        ? normalized : `${normalized}+08:00`);
    return finite(parsed) ? parsed : null;
}

function freshTimestamp(value: string, nowMs: number, tradeDate: string): boolean {
    const parsed = timestampMs(value);
    return parsed !== null && parsed <= nowMs
        && nowMs - parsed <= DAYTRADE_DEFAULTS.quoteAgeSeconds * 1_000
        && dateLabel((parsed + TAIPEI_OFFSET_MS) / 1_000) === tradeDate;
}

function rsi(closes: number[]): number {
    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= 14; i++) {
        const move = closes[i]! - closes[i - 1]!;
        gain += Math.max(0, move);
        loss += Math.max(0, -move);
    }
    gain /= 14;
    loss /= 14;
    for (let i = 15; i < closes.length; i++) {
        const move = closes[i]! - closes[i - 1]!;
        gain = (gain * 13 + Math.max(0, move)) / 14;
        loss = (loss * 13 + Math.max(0, -move)) / 14;
    }
    return gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}

function extremes(side: DaytradeSide, bars: Candle[]): string[] {
    const last = bars.at(-1)!;
    const previous = bars.at(-2)!;
    const closes = bars.map(bar => bar.close);
    const relativeStrength = rsi(closes);
    const bias = pct(last.close, mean(closes.slice(-20)));
    const change = pct(last.close, previous.close);
    const gap = pct(last.open, previous.close);
    const threeDayChange = pct(last.close, bars.at(-4)!.close);
    const reasons: string[] = [];
    if (side === 'long') {
        if (relativeStrength > 85) reasons.push('RSI > 85，排除過熱');
        if (above(bias, 15)) reasons.push('20MA 正乖離 > 15%，排除追高');
        if (atLeast(change, 9)) reasons.push('單日漲幅 ≥ 9%，排除追高');
        if (atLeast(gap, 8)) reasons.push('向上跳空 ≥ 8%，排除追高');
        if (atLeast(threeDayChange, 22)) reasons.push('3 日漲幅 ≥ 22%，排除追高');
    } else {
        if (relativeStrength < 15) reasons.push('RSI < 15，排除過冷');
        if (above(-bias, 15)) reasons.push('20MA 負乖離 < -15%，排除追空');
        if (atMost(change, -9)) reasons.push('單日跌幅 ≥ 9%，排除追空');
        if (atMost(gap, -8)) reasons.push('向下跳空 ≥ 8%，排除追空');
        if (atMost(threeDayChange, -22)) reasons.push('3 日跌幅 ≥ 22%，排除追空');
    }
    return reasons;
}

interface DailyContext {
    bars: Candle[];
    side: DaytradeSide | null;
    fullAlignment: boolean;
    averageAmount: number;
    atrPct: number;
    volumeRatio: number | null;
}

function dailyContext(input: DaytradeInput, today: number): DailyContext | string {
    // Never let today's partial/full session or a future row enter prior history.
    if (input.daily.some(bar => !finite(bar.time))) return '歷史日K日期不明，無法辨別已收盤資料';
    const bars = input.daily.filter(bar => bar.time < today);
    if (bars.length < DAYTRADE_DEFAULTS.minimumDailyBars) return '已收盤歷史日K不足 22 根';
    if (bars.some((bar, i) => !validCandle(bar) || bar.time % DAY !== 0
        || (i > 0 && bar.time <= bars[i - 1]!.time))) return '歷史日K格式、順序或來源不完整';
    const last = bars.at(-1)!;
    if (today - last.time > DAYTRADE_DEFAULTS.maximumPriorDayAge * DAY) return '前交易日日K超過 7 個自然日未更新，僅等待新資料';
    if (!positive(input.contract.reference)
        || above(Math.abs(pct(last.close, input.contract.reference)), DAYTRADE_DEFAULTS.maximumReferenceMismatchPct)) {
        return '歷史收盤與今日參考價差異超過 0.5% 或不明，待確認除權息／資料更新';
    }
    const unit = (input.contract as StockMetadata).unit;
    if (unit === undefined || !positive(unit)) return '缺少成交單位，無法驗證歷史成交金額';
    const averageAmount = mean(bars.slice(-20).map(bar => bar.close * bar.volume * unit));
    if (averageAmount < DAYTRADE_DEFAULTS.minimumDailyAmount) return '前 20 交易日平均成交金額估值不足 1 億元';
    const trueRanges = bars.slice(-14).map((bar, i) => {
        const previous = bars[bars.length - 15 + i]!.close;
        return Math.max(bar.high - bar.low, Math.abs(bar.high - previous), Math.abs(bar.low - previous));
    });
    const atrPct = mean(trueRanges) / last.close * 100;
    if (atrPct < DAYTRADE_DEFAULTS.minimumAtrPct || atrPct > DAYTRADE_DEFAULTS.maximumAtrPct) {
        return '14 日平均真實波幅不在 1%～8% 研究範圍';
    }
    const closes = bars.map(bar => bar.close);
    const ma5 = mean(closes.slice(-5));
    const ma10 = mean(closes.slice(-10));
    const ma20 = mean(closes.slice(-20));
    const previousMa20 = mean(closes.slice(-21, -1));
    const side = last.close > ma20 && ma5 > ma10 && ma20 > previousMa20 ? 'long'
        : last.close < ma20 && ma5 < ma10 && ma20 < previousMa20 ? 'short' : null;
    const fullAlignment = side === 'long' ? ma5 > ma10 && ma10 > ma20
        : side === 'short' && ma5 < ma10 && ma10 < ma20;
    const averageVolume = mean(bars.slice(-6, -1).map(bar => bar.volume));
    return { bars, side, fullAlignment, averageAmount, atrPct,
        volumeRatio: averageVolume > 0 ? last.volume / averageVolume : null };
}

function metadataReasons(contract: StockMetadata, tradeDate: string): string[] {
    const reasons: string[] = [];
    if (contract.region !== 'TW' || contract.security_type !== 'STK'
        || !['TSE', 'OTC'].includes(contract.exchange ?? '')
        || !/^[1-9]\d{3}$/.test(contract.code) || contract.currency !== 'TWD') {
        reasons.push('不在台灣上市／上櫃普通股研究範圍');
    }
    if (contract.update_date !== tradeDate) reasons.push('券商當沖資格日期未更新至今日');
    if (contract.day_trade !== 'Yes' && contract.day_trade !== 'OnlyBuy') reasons.push('當沖資格為否或不明');
    if (contract.trading_suspended !== false) reasons.push('暫停交易狀態不明或已暫停');
    if (contract.disposition_level !== 0) reasons.push('處置狀態不明或為處置股票');
    return reasons;
}

function sideEligibility(contract: ContractInfo, side: DaytradeSide): string[] {
    return side === 'short' && contract.day_trade !== 'Yes' ? ['僅可先買後賣，不列空方候選'] : [];
}

function rowBase(input: DaytradeInput, context: DailyContext, side: DaytradeSide): DaytradeRow {
    const last = context.bars.at(-1)!;
    return {
        contract: input.contract, side, score: 0, price: last.close,
        changeRate: pct(last.close, context.bars.at(-2)!.close),
        volumeRatio: context.volumeRatio, rvol: null, vwap: null, spreadPct: null,
        atrPct: context.atrPct, signal: '', reasons: [],
        asOf: `${dateLabel(last.time)}T13:30:00+08:00`,
        qualificationDate: input.contract.update_date,
    };
}

function observation(input: DaytradeInput, context: DailyContext, side: DaytradeSide): DaytradeRow | string[] {
    const issues = [...sideEligibility(input.contract, side), ...extremes(side, context.bars)];
    if (context.volumeRatio === null || context.volumeRatio < DAYTRADE_DEFAULTS.observationVolumeRatio) issues.push('前交易日量比未達 1.2 倍');
    const last = context.bars.at(-1)!;
    const change = pct(last.close, context.bars.at(-2)!.close);
    if ((side === 'long' && change <= 0) || (side === 'short' && change >= 0)) issues.push('前交易日價格未延續日趨勢方向');
    if (issues.length) return issues;
    const row = rowBase(input, context, side);
    const earlier = context.bars.slice(-11, -1);
    const boundary = side === 'long' ? Math.max(...earlier.map(bar => bar.high)) : Math.min(...earlier.map(bar => bar.low));
    const distance = Math.abs(pct(last.close, boundary));
    row.score = (context.averageAmount >= 500_000_000 ? 15 : 10)
        + (context.fullAlignment ? 25 : 20)
        + Math.min(25, Math.round(15 + (context.volumeRatio! - 1.2) * 10))
        + Math.min(15, Math.round(Math.abs(change) * 5))
        + (distance <= 3 ? 15 : distance <= 6 ? 10 : 5) + 5;
    row.signal = side === 'long' ? '前交易日轉強・待盤中確認' : '前交易日轉弱・待盤中確認';
    row.reasons = ['僅以前交易日收盤資料排序，非今日進場確認',
        `前交易日量比 ${context.volumeRatio!.toFixed(2)} 倍`,
        context.fullAlignment ? '5／10／20MA 完整方向排列' : 'MA20 方向與 MA5／10 轉強弱一致',
        '開盤後仍須重新檢查報價、價差、同時段 RVOL 與 5 分K',
        ...(side === 'short' ? ['今日可供券尚未驗證，非可放空保證'] : []),
        ...((input.contract as StockMetadata).attention_flag ? ['券商標註注意股，需額外審視風險'] : [])];
    return row;
}

function aggregateFive(minutes: Candle[]): Candle[] {
    const bars: Candle[] = [];
    for (let i = 0; i < minutes.length; i += 5) {
        const group = minutes.slice(i, i + 5);
        if (group.length !== 5) break;
        bars.push({ time: group[4]!.time, open: group[0]!.open,
            high: Math.max(...group.map(bar => bar.high)), low: Math.min(...group.map(bar => bar.low)),
            close: group[4]!.close, volume: group.reduce((sum, bar) => sum + bar.volume, 0) });
    }
    return bars;
}

function ema(values: number[], period: number): number {
    let value = mean(values.slice(0, period));
    for (const next of values.slice(period)) value += (next - value) * 2 / (period + 1);
    return value;
}

/** Missing no-trade minutes may be legitimate; conservatively not confirmed. */
function completePrefix(bars: Candle[], day: number, count: number): Candle[] | null {
    const prefix = bars.filter(bar => bar.time > day + OPEN && bar.time <= day + OPEN + count * 60);
    if (prefix.length !== count) return null;
    for (let i = 0; i < count; i++) {
        if (prefix[i]!.time !== day + OPEN + (i + 1) * 60 || !validCandle(prefix[i]!)) return null;
    }
    return prefix;
}

function liveCandidate(input: DaytradeInput, context: DailyContext, side: DaytradeSide,
    nowMs: number, wallNow: number, tradeDate: string, indexChangeRate: number | undefined,
    minimumRvol: number): DaytradeRow | string[] {
    const issues = sideEligibility(input.contract, side);
    const tod = wallNow - dayLabel(wallNow);
    if (tod < OPEN + 15 * 60 || tod > 13 * 3_600 + 25 * 60) issues.push('盤中確認時段為 09:15～13:25');
    const snap = input.snapshot;
    if (!snap || snap.code !== input.contract.code || snap.exchange !== input.contract.exchange
        || !freshTimestamp(snap.datetime, nowMs, tradeDate)) issues.push('報價不匹配、過期、未更新或在未來');
    if (issues.length || !snap) return issues;
    if (![snap.open, snap.high, snap.low, snap.close, snap.buy_price, snap.sell_price,
        snap.buy_volume, snap.sell_volume, snap.total_volume, snap.total_amount].every(positive)
        || snap.high < Math.max(snap.open, snap.close, snap.low)
        || snap.low > Math.min(snap.open, snap.close, snap.high)) return ['報價、買賣價量或累積成交資料不完整'];
    if (snap.sell_price <= snap.buy_price) return ['買賣價差鎖定或交叉，不確認當沖候選'];
    const spreadPct = (snap.sell_price - snap.buy_price) / ((snap.sell_price + snap.buy_price) / 2) * 100;
    if (above(spreadPct, DAYTRADE_DEFAULTS.maximumSpreadPct)) return ['買賣價差 > 0.4%，排除交易摩擦'];
    const today = dayLabel(wallNow);
    const liveRiskBar = { time: today, open: snap.open, high: snap.high, low: snap.low, close: snap.close, volume: snap.total_volume };
    issues.push(...extremes(side, [...context.bars, liveRiskBar]));
    const change = pct(snap.close, context.bars.at(-1)!.close);
    if ((side === 'long' && change <= 0) || (side === 'short' && change >= 0)) issues.push('當日價格方向未延續日趨勢');
    const limit = side === 'long' ? input.contract.limit_up : input.contract.limit_down;
    if (!positive(limit)) issues.push('缺少今日漲跌停界線');
    else if (atMost(side === 'long' ? pct(limit, snap.close) : pct(snap.close, limit), DAYTRADE_DEFAULTS.minimumLimitDistancePct)) {
        issues.push('距漲跌停不足 0.5%，排除成交受限');
    }
    if (side === 'short' && (!input.shortSource || !positive(input.shortSource.quantity)
        || !freshTimestamp(input.shortSource.datetime, nowMs, tradeDate))) issues.push('今日可供券數量不足、過期或未確認');
    if (issues.length) return issues;
    const count = Math.floor((Math.floor(wallNow / 60) * 60 - today - OPEN) / 300) * 5;
    if (count < 40) return ['等待至少 8 根完整 5 分K（最早 09:40）'];
    // Filter future/partial bars before all calculations. Do not stitch gaps.
    const knownMinutes = input.minutes.filter(bar => finite(bar.time) && bar.time <= today + OPEN + count * 60);
    const current = completePrefix(knownMinutes, today, count);
    if (!current) return ['開盤至最近封閉 5 分K的分鐘資料不足；不拼接缺漏'];
    const totalVolume = current.reduce((sum, bar) => sum + bar.volume, 0);
    if (!positive(totalVolume)) return ['封閉分鐘累積量為零，無法計算 VWAP'];
    const vwap = current.reduce((sum, bar) => sum + (bar.high + bar.low + bar.close) / 3 * bar.volume, 0) / totalVolume;
    const five = aggregateFive(current);
    const closes = five.map(bar => bar.close);
    const ema3 = ema(closes, 3);
    const ema8 = ema(closes, 8);
    const latest = five.at(-1)!;
    const opening = five[0]!;
    const boundary = side === 'long' ? opening.high : opening.low;
    const confirmed = side === 'long'
        ? latest.close > boundary && latest.close > vwap && ema3 > ema8 && snap.close > boundary && snap.close > vwap
        : latest.close < boundary && latest.close < vwap && ema3 < ema8 && snap.close < boundary && snap.close < vwap;
    if (!confirmed) return ['封閉 5 分K、VWAP、EMA3／8 與開盤區間尚未同向'];
    const vwapDistance = Math.abs(pct(snap.close, vwap));
    const breakoutDistance = Math.abs(pct(snap.close, boundary));
    if (above(vwapDistance, DAYTRADE_DEFAULTS.maximumVwapDistancePct)) issues.push('距 VWAP > 3%，不追價');
    if (above(breakoutDistance, DAYTRADE_DEFAULTS.maximumBreakoutDistancePct)) issues.push('距開盤突破點 > 2%，不追價');
    // A complete but ancient minute prefix is not a current relative-volume baseline.
    // Restrict to the last 20 validated completed daily sessions; weekends cannot
    // silently count as extra trading sessions when handed malformed history.
    const recentDailyLabels = new Set(context.bars.slice(-20).map(bar => bar.time));
    const previousDays = [...new Set(knownMinutes.filter(bar => {
        const label = dayLabel(bar.time);
        const weekday = new Date(label * 1_000).getUTCDay();
        return bar.time < today && recentDailyLabels.has(label) && weekday !== 0 && weekday !== 6;
    }).map(bar => dayLabel(bar.time)))]
        .sort((a, b) => b - a);
    const historicalVolumes: number[] = [];
    for (const priorDay of previousDays) {
        const prefix = completePrefix(knownMinutes, priorDay, count);
        if (!prefix) continue;
        const volume = prefix.reduce((sum, bar) => sum + bar.volume, 0);
        if (positive(volume)) historicalVolumes.push(volume);
        if (historicalVolumes.length >= 20) break;
    }
    if (historicalVolumes.length < DAYTRADE_DEFAULTS.minimumRvolSessions) issues.push('同時段完整分鐘歷史不足 14 個交易日，RVOL 不明');
    const rvol = historicalVolumes.length >= DAYTRADE_DEFAULTS.minimumRvolSessions
        ? totalVolume / mean(historicalVolumes) : null;
    if (rvol !== null && rvol < minimumRvol) issues.push(`同時段 RVOL 未達 ${minimumRvol} 倍`);
    if (issues.length || rvol === null) return issues;
    const relative = indexChangeRate !== undefined && finite(indexChangeRate)
        ? (side === 'long' ? change - indexChangeRate : indexChangeRate - change) : null;
    const row = rowBase(input, context, side);
    row.score = (context.averageAmount >= 500_000_000 ? 15 : context.averageAmount >= 300_000_000 ? 12 : 8)
        + Math.min(25, Math.round(15 + (rvol - 1.5) * 10))
        + 20 + 15 + (context.fullAlignment ? 15 : 10)
        + (relative === null ? 0 : relative >= 0.5 ? 10 : relative >= 0 ? 5 : 0);
    if (row.score < DAYTRADE_DEFAULTS.minimumLiveScore) return ['研究分數未達 65 分，不補滿名單'];
    row.price = snap.close;
    row.changeRate = change;
    row.rvol = rvol;
    row.vwap = vwap;
    row.spreadPct = spreadPct;
    row.asOf = snap.datetime;
    row.signal = side === 'long' ? '多方盤中條件確認・研究候選' : '空方盤中條件確認・研究候選';
    row.reasons = [`同時段 RVOL ${rvol.toFixed(2)} 倍（${historicalVolumes.length} 個完整歷史時段）`,
        '完整 5 分K突破開盤 5 分區間，與 VWAP／EMA3／8 同向',
        `VWAP 為分鐘 HLC3 量加權近似；距 VWAP ${vwapDistance.toFixed(2)}%`,
        `買賣價差 ${spreadPct.toFixed(3)}%；前 20 日成交金額為收盤價×量×單位估值`,
        '研究分數不是勝率；資格、可供券與實際可成交數量不同',
        ...(relative === null ? ['指數即時方向資料不足，相對強弱不加分'] : [`相對指數方向差 ${relative.toFixed(2)} 個百分點`]),
        ...((input.contract as StockMetadata).attention_flag ? ['券商標註注意股，需額外審視風險'] : [])];
    return row;
}

/** Pure, causal research ranking. Never places orders or changes subscriptions. */
export function evaluateDaytrade(inputs: DaytradeInput[], nowMs: number, indexChangeRate?: number,
    options: { minimumRvol?: number } = {}): DaytradeResult {
    if (!finite(nowMs)) throw new Error('evaluateDaytrade requires a finite current timestamp');
    const minimumRvol = options.minimumRvol ?? DAYTRADE_DEFAULTS.minimumRvol;
    if (![1.5, 2, 2.5].includes(minimumRvol)) throw new Error('minimumRvol must be 1.5, 2, or 2.5');
    const wallNow = (nowMs + TAIPEI_OFFSET_MS) / 1_000;
    const today = dayLabel(wallNow);
    const tradeDate = dateLabel(today);
    const weekday = new Date(today * 1_000).getUTCDay();
    const tod = wallNow - today;
    const phase = weekday === 0 || weekday === 6 || tod > CLOSE ? 'closed' : tod < OPEN + 15 * 60 ? 'preopen' : 'live';
    const result: DaytradeResult = { long: [], short: [], observationsLong: [], observationsShort: [], excluded: [], phase, tradeDate };
    const seen = new Set<string>();
    for (const input of inputs.slice(0, DAYTRADE_DEFAULTS.maxPool)) {
        if (seen.has(input.contract.code)) continue;
        seen.add(input.contract.code);
        const reasons = metadataReasons(input.contract as StockMetadata, tradeDate);
        const context = reasons.length ? null : dailyContext(input, today);
        if (typeof context === 'string') reasons.push(context);
        else if (context && context.side === null) reasons.push('歷史日趨勢未形成一致多空方向');
        if (!reasons.length && context && typeof context !== 'string' && context.side !== null) {
            const obs = observation(input, context, context.side);
            if (!Array.isArray(obs)) (context.side === 'long' ? result.observationsLong : result.observationsShort).push(obs);
            else reasons.push(...obs);
            if (phase === 'live') {
                const live = liveCandidate(input, context, context.side, nowMs, wallNow, tradeDate, indexChangeRate, minimumRvol);
                if (!Array.isArray(live)) {
                    (context.side === 'long' ? result.long : result.short).push(live);
                    reasons.length = 0;
                } else reasons.push(...live);
            } else reasons.push(phase === 'preopen' ? '尚未進入當沖確認時段；只有前交易日觀察，非盤中確認' : '當沖確認時段已結束／非平日；只有前交易日觀察，非現在可當沖');
        }
        if (reasons.length) result.excluded.push({ code: input.contract.code, name: input.contract.name, reasons: [...new Set(reasons)] });
    }
    const rank = (rows: DaytradeRow[]) => rows.sort((a, b) => b.score - a.score
        || (b.rvol ?? b.volumeRatio ?? 0) - (a.rvol ?? a.volumeRatio ?? 0)
        || a.contract.code.localeCompare(b.contract.code)).slice(0, DAYTRADE_DEFAULTS.maxPerSide);
    result.long = rank(result.long);
    result.short = rank(result.short);
    result.observationsLong = rank(result.observationsLong);
    result.observationsShort = rank(result.observationsShort);
    return result;
}
