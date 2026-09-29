// Research-chart calculations are deliberately presentation-only.  The chart
// keeps its raw OHLC bars for indicators, fills and later review.

import type { Candle } from '../types/market';
import type { SecurityType } from '../types/contract';
import { v8CompositeTrend, v9AtrDefense } from '../indicators';
import { sessionWindowFor } from '../intraday-session';
import { aggregate } from './kbars';
import { researchOpening } from '../research-visuals';

export type TrendSide = 1 | -1 | 0;

export type ResearchLevelKind = 'open' | 'opening-range' | 'previous';

export interface ResearchLevel {
    id: string;
    title: string;
    price: number;
    kind: ResearchLevelKind;
}

/** Convert regular OHLC bars into Heikin-Ashi / average candles. */
export function toHeikinAshi(bars: Candle[]): Candle[] {
    let previous: Candle | undefined;
    return bars.map((bar) => {
        const close = (bar.open + bar.high + bar.low + bar.close) / 4;
        const open = previous
            ? (previous.open + previous.close) / 2
            : (bar.open + bar.close) / 2;
        const next: Candle = {
            time: bar.time,
            open,
            high: Math.max(bar.high, open, close),
            low: Math.min(bar.low, open, close),
            close,
            volume: bar.volume,
        };
        previous = next;
        return next;
    });
}

function sessionKey(time: number, securityType: SecurityType): string {
    // A futures night session that crosses midnight has one opening timestamp,
    // so 00:00–05:00 belongs to the prior 15:00 session rather than a fake
    // new day. Stocks/warrants remain their regular calendar-date session.
    return String(sessionWindowFor(securityType, time).start);
}

/**
 * Stable research reference levels: prior-day H/L/C plus today's open and
 * opening-range H/L.  These are levels, not trading recommendations.
 */
export function researchLevels(
    rawBars: Candle[],
    openingRangeMinutes = 5,
    securityType: SecurityType = 'STK',
): ResearchLevel[] {
    if (rawBars.length === 0) return [];
    const latestSession = sessionKey(rawBars[rawBars.length - 1]!.time, securityType);
    const current = rawBars.filter((bar) => sessionKey(bar.time, securityType) === latestSession);
    if (current.length === 0) return [];
    const previous = rawBars.filter((bar) => sessionKey(bar.time, securityType) !== latestSession);
    const previousSession = previous.length > 0
        ? sessionKey(previous[previous.length - 1]!.time, securityType)
        : undefined;
    const priorSession = previousSession
        ? previous.filter((bar) => sessionKey(bar.time, securityType) === previousSession)
        : [];
    const opening = researchOpening(rawBars, securityType);
    const openingEnd = (opening?.start ?? 0) + openingRangeMinutes * 60;
    const range = current.filter((bar) => opening && bar.time >= opening.start && bar.time <= openingEnd);
    const levels: ResearchLevel[] = opening && range.length ? [
        { id: 'open', title: '開盤', price: opening.price, kind: 'open' },
        {
            id: 'or-high',
            title: `開盤${openingRangeMinutes}分高`,
            price: Math.max(...range.map((bar) => bar.high)),
            kind: 'opening-range',
        },
        {
            id: 'or-low',
            title: `開盤${openingRangeMinutes}分低`,
            price: Math.min(...range.map((bar) => bar.low)),
            kind: 'opening-range',
        },
    ] : [];
    if (priorSession.length > 0) {
        levels.push(
            {
                id: 'prev-high',
                title: '昨高',
                price: Math.max(...priorSession.map((bar) => bar.high)),
                kind: 'previous',
            },
            {
                id: 'prev-low',
                title: '昨低',
                price: Math.min(...priorSession.map((bar) => bar.low)),
                kind: 'previous',
            },
            {
                id: 'prev-close',
                title: '昨收',
                price: priorSession[priorSession.length - 1]!.close,
                kind: 'previous',
            },
        );
    }
    return levels;
}

export type V9ResonanceSide = 'long' | 'short' | 'neutral' | 'insufficient';

export interface V9ResonanceFrame {
    minutes: 1 | 5 | 60 | 1440;
    label: '1分' | '5分' | '60分' | '日K';
    side: V9ResonanceSide;
    score?: number;
    bars: number;
    requiredBars: number;
}

export interface V9Resonance {
    frames: V9ResonanceFrame[];
    summary: string;
    asOf?: number;
}

const V9_RESOLUTION = [
    { minutes: 1, label: '1分' },
    { minutes: 5, label: '5分' },
    { minutes: 60, label: '60分' },
    { minutes: 1440, label: '日K' },
] as const;

// V8's slow MACD leg uses EMA117; make the display conservative instead of
// calling an early seed a full multi-timeframe signal.
export const V9_RESONANCE_REQUIRED_BARS = 117;

/** Read-only multi-timeframe V9 state. It aggregates bars already held by
 * the chart and deliberately makes no kbar request or subscription. */
export function v9Resonance(
    rawBars: Candle[],
    securityType: SecurityType = 'STK',
    now = Number.POSITIVE_INFINITY,
    dailyCandles?: Candle[],
): V9Resonance {
    const valid = rawBars.filter(bar =>
        [bar.time, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite),
    ).sort((a, b) => a.time - b.time);
    const closedDaily = (bars: Candle[]): Candle[] =>
        bars
            .filter(bar =>
                [bar.time, bar.open, bar.high, bar.low, bar.close].every(
                    Number.isFinite,
                ),
            )
            .sort((a, b) => a.time - b.time)
            .filter(bar => {
                if (securityType === 'FUT' || securityType === 'OPT')
                    return bar.time + 86400 + 5 * 3600 <= now;
                return bar.time + 13.5 * 3600 <= now;
            });
    const frames = V9_RESOLUTION.map(({ minutes, label }): V9ResonanceFrame => {
        // Daily frame is fed from the cached daily-candles feed (~180 calendar
        // days); the radar's 60-day 1-min window can only build ~40 daily bars.
        const bars =
            minutes === 1440 && dailyCandles
                ? closedDaily(dailyCandles)
                : aggregate(valid, minutes, securityType).filter(bar => {
                      if (minutes < 1440) return bar.time <= now;
                      if (securityType === 'FUT' || securityType === 'OPT')
                          return bar.time + 86400 + 5 * 3600 <= now;
                      return bar.time + 13.5 * 3600 <= now;
                  });
        if (bars.length < V9_RESONANCE_REQUIRED_BARS) {
            return { minutes, label, side: 'insufficient', bars: bars.length, requiredBars: V9_RESONANCE_REQUIRED_BARS };
        }
        const score = v8CompositeTrend(bars).at(-1)?.value;
        const side: V9ResonanceSide = score === undefined
            ? 'insufficient'
            : score >= 55 ? 'long' : score <= 45 ? 'short' : 'neutral';
        return { minutes, label, side, score, bars: bars.length, requiredBars: V9_RESONANCE_REQUIRED_BARS };
    });
    const ready = frames.filter(frame => frame.side !== 'insufficient');
    const long = ready.filter(frame => frame.side === 'long').length;
    const short = ready.filter(frame => frame.side === 'short').length;
    const neutral = ready.filter(frame => frame.side === 'neutral').length;
    const missing = frames.length - ready.length;
    const summary = ready.length === 4 && long === 4 ? '四週期同多'
        : ready.length === 4 && short === 4 ? '四週期同空'
        : '多' + long + '／空' + short + '／中' + neutral + (missing ? '／資料不足' + missing : '');
    const asOf = valid.filter(bar => bar.time <= now).at(-1)?.time;
    return { frames, summary, asOf };
}

/**
 * Long/short background tint for each closed bar, sourced from the same
 * V8-confirmed side as the ATR 防守線 (`v9AtrDefense`): 1 = long side holds,
 * -1 = short side holds, 0 = neutral / warm-up (left uncoloured). Tint is
 * presentation-only; it creates no orders and predicts no reversal.
 */
export function v9TrendTint(
    rawBars: Candle[],
    period = 14,
    multiple = 2,
    securityType: SecurityType = 'STK',
    timeframeMinutes = 1,
): Array<{ time: number; side: TrendSide }> {
    const { up, down } = v9AtrDefense(rawBars, period, multiple, securityType, timeframeMinutes);
    return rawBars.map((bar, index) => {
        const side: TrendSide = up[index]?.value !== undefined
            ? 1
            : down[index]?.value !== undefined ? -1 : 0;
        return { time: bar.time, side };
    });
}
