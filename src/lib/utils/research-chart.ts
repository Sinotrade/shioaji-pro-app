// Research-chart calculations are deliberately presentation-only.  The chart
// keeps its raw OHLC bars for indicators, fills and later review.

import type { Candle } from '../types/market';
import { v9AtrDefense } from '../indicators';

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

function dateKey(time: number): string {
    // Shioaji chart times are normalized to UTC seconds. Taiwan stock hours
    // remain in the same UTC calendar day, including the 09:00 opening bar.
    return new Date(time * 1000).toISOString().slice(0, 10);
}

/**
 * Stable research reference levels: prior-day H/L/C plus today's open and
 * opening-range H/L.  These are levels, not trading recommendations.
 */
export function researchLevels(
    rawBars: Candle[],
    openingRangeMinutes = 5,
): ResearchLevel[] {
    if (rawBars.length === 0) return [];
    const latestDate = dateKey(rawBars[rawBars.length - 1]!.time);
    const current = rawBars.filter((bar) => dateKey(bar.time) === latestDate);
    if (current.length === 0) return [];
    const previous = rawBars.filter((bar) => dateKey(bar.time) !== latestDate);
    const previousDate = previous.length > 0
        ? dateKey(previous[previous.length - 1]!.time)
        : undefined;
    const priorSession = previousDate
        ? previous.filter((bar) => dateKey(bar.time) === previousDate)
        : [];
    const first = current[0]!;
    const openingEnd = first.time + openingRangeMinutes * 60;
    const openingBars = current.filter((bar) => bar.time <= openingEnd);
    const range = openingBars.length > 0 ? openingBars : [first];
    const levels: ResearchLevel[] = [
        { id: 'open', title: '開盤', price: first.open, kind: 'open' },
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
    ];
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
): Array<{ time: number; side: TrendSide }> {
    const { up, down } = v9AtrDefense(rawBars, period, multiple);
    return rawBars.map((bar, index) => {
        const side: TrendSide = up[index]?.value !== undefined
            ? 1
            : down[index]?.value !== undefined ? -1 : 0;
        return { time: bar.time, side };
    });
}
