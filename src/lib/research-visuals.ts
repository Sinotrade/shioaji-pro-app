import type { IndicatorPoint } from './indicators';
import type { Candle } from './types/market';
import type { SecurityType } from './types/contract';
import { sessionWindowFor } from './intraday-session';

export const RESEARCH_COLORS = { long: '#fb7185', short: '#4ade80', neutral: '#facc15', open: '#fbbf24' };

/** Each contiguous rail is a distinct series, so a gap never draws a diagonal
 * connector through candles when a defense fails or the session changes. */
export function defenseSegments(points: IndicatorPoint[]): IndicatorPoint[][] {
    const segments: IndicatorPoint[][] = [];
    let current: IndicatorPoint[] = [];
    for (const point of points) {
        if (point.value === undefined) {
            if (current.length) segments.push(current);
            current = [];
        } else current.push(point);
    }
    if (current.length) segments.push(current);
    return segments;
}

export function researchOpening(raw: Candle[], securityType: SecurityType) {
    const tail = raw.at(-1);
    if (!tail) return null;
    const session = sessionWindowFor(securityType, tail.time);
    // Require the real first minute. A partial historical page is not an open.
    const first = raw.find(bar => bar.time >= session.start && bar.time <= session.start + 60
        && bar.volume > 0 && Number.isFinite(bar.open));
    return first ? { time: first.time, start: session.start, end: session.end, price: first.open,
        title: session.night ? '夜盤開盤' : '日盤開盤' } : null;
}

export interface DefenseEvent {
    time: number;
    side: 1 | -1;
    kind: 'confirmed' | 'flip' | 'invalidated';
    text: string;
    color: string;
}

/** Input must contain closed candles; never anticipate a later confirmation. */
export function defenseEvents(bars: Candle[], rails: { up: IndicatorPoint[]; down: IndicatorPoint[] },
    securityType: SecurityType, minutes: number): DefenseEvent[] {
    const events: DefenseEvent[] = [];
    let previousSide = 0;
    let lastConfirmedSide = 0;
    let previousPrice: number | undefined;
    let session: number | undefined;
    bars.forEach((bar, index) => {
        const key = minutes >= 1440 ? 0 : sessionWindowFor(securityType, bar.time).start;
        if (key !== session) {
            previousSide = 0; lastConfirmedSide = 0; previousPrice = undefined; session = key;
        }
        const long = rails.up[index]?.value;
        const short = rails.down[index]?.value;
        const side = long !== undefined ? 1 : short !== undefined ? -1 : 0;
        if (previousPrice !== undefined && previousSide !== 0 && side !== previousSide
            && (previousSide === 1 ? bar.close <= previousPrice : bar.close >= previousPrice)) {
            events.push({ time: bar.time, side: previousSide as 1 | -1, kind: 'invalidated',
                text: previousSide === 1 ? '多防失效' : '空防失效', color: '#fbbf24' });
        }
        if (side !== 0 && side !== previousSide) {
            const flip = lastConfirmedSide !== 0 && lastConfirmedSide !== side;
            events.push({ time: bar.time, side, kind: flip ? 'flip' : 'confirmed',
                text: flip ? (side === 1 ? '翻多' : '翻空') : (side === 1 ? '多方確認' : '空方確認'),
                color: side === 1 ? RESEARCH_COLORS.long : RESEARCH_COLORS.short });
            lastConfirmedSide = side;
        }
        previousSide = side;
        previousPrice = long ?? short;
    });
    return events;
}
