import type { IndicatorPoint } from './indicators';
import { sessionWindowFor, type SessionWindow } from './intraday-session';
import type { SecurityType } from './types/contract';
import type { Candle } from './types/market';

export interface ResearchSessionVwap {
    points: IndicatorPoint[];
    status: 'ready' | 'partial' | 'empty';
    reason: string;
    sessionStart?: number;
    asOf?: number;
}

/** Taiwan wall-clock encoded as UTC; input labels are minute END. A missing
 * bar is not evidence of zero trades. Explicit zero-volume bars are evidence
 * of coverage, but never add weight to the HLC3 approximation. */
export function validResearchMinutes(rawMinutes: readonly Candle[], securityType: SecurityType, now: number): Candle[] {
    if (!Number.isFinite(now)) return [];
    const unique = new Map<number, Candle>();
    for (const bar of rawMinutes) {
        if (![bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)
            || !Number.isInteger(bar.time) || bar.time % 60 !== 0 || bar.time > now || bar.volume < 0
            || Math.min(bar.open, bar.high, bar.low, bar.close) <= 0
            || bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close)
            || bar.high < bar.low) continue;
        const win = sessionWindowFor(securityType, bar.time);
        if (bar.time <= win.start || bar.time > win.end) continue;
        unique.set(bar.time, bar);
    }
    return [...unique.values()].sort((a, b) => a.time - b.time);
}

/** Fixed raw-1m, session-anchored HLC3*volume / volume. This is not an exact
 * tick turnover VWAP. Day and night are separate anchors; midnight does not
 * reset a night session. Only a continuous prefix from session open is known.
 * The first unknown minute is whitespace, so no later partial mean reconnects
 * a broken anchor. Status describes the session selected by the research clock.
 * Historical prefixes are retained for chart projection, not current triggers. */
export function researchSessionVwap(rawMinutes: readonly Candle[], securityType: SecurityType, now: number): ResearchSessionVwap {
    if (!Number.isFinite(now)) return { points: [], status: 'empty', reason: '研究時鐘未確認' };
    const current = sessionWindowFor(securityType, now);
    const groups = new Map<number, { win: SessionWindow; bars: Candle[] }>();
    for (const bar of validResearchMinutes(rawMinutes, securityType, now)) {
        const win = sessionWindowFor(securityType, bar.time);
        const group = groups.get(win.start) ?? { win, bars: [] };
        group.bars.push(bar);
        groups.set(win.start, group);
    }
    const points: IndicatorPoint[] = [];
    let status: ResearchSessionVwap['status'] = 'empty';
    let reason = now <= current.start ? '等待本時段開盤與第一根已收1分K' : '本時段尚無已收1分K';
    let asOf: number | undefined;
    for (const { win, bars } of groups.values()) {
        const expected = Math.min(win.end, Math.floor(now / 60) * 60);
        const byTime = new Map(bars.map(bar => [bar.time, bar]));
        let weighted = 0;
        let volume = 0;
        let missing: number | undefined;
        for (let time = win.start + 60; time <= expected; time += 60) {
            const bar = byTime.get(time);
            if (!bar) {
                missing = time;
                points.push({ time });
                break;
            }
            weighted += (bar.high + bar.low + bar.close) / 3 * bar.volume;
            volume += bar.volume;
            points.push(volume > 0 ? { time, value: weighted / volume } : { time });
        }
        if (win.start !== current.start) continue;
        asOf = bars.at(-1)?.time;
        if (missing !== undefined) {
            status = 'partial';
            reason = missing === win.start + 60 ? '缺開盤第一分鐘，無法確認整盤VWAP'
                : missing <= (asOf ?? 0) ? '本時段缺分鐘，缺口後不接續VWAP'
                  : '尚缺最新已收分鐘，VWAP資料未完整';
        } else if (volume <= 0) {
            status = 'empty';
            reason = '本時段尚無成交量，無法計算VWAP';
        } else {
            status = 'ready';
            reason = '固定原始1分K近似VWAP；本時段開盤至已收分鐘連續完整';
        }
    }
    return { points, status, reason, sessionStart: current.start, asOf };
}

/** Map the fixed raw-minute values onto already CLOSED chart labels. A value
 * must be no later than that label and from the same session. Whitespace is
 * meaningful: never search past it for an older value. A boundary whitespace
 * also prevents a day-session tail joining the next night's first value.
 * Daily charts must be excluded by the caller. */
export function projectResearchVwap(points: readonly IndicatorPoint[], chartClosedBars: readonly Candle[], securityType: SecurityType): IndicatorPoint[] {
    const uniquePoints = new Map<number, IndicatorPoint>();
    for (const point of points) {
        if (!Number.isFinite(point.time) || point.time % 60 !== 0
            || point.value !== undefined && !Number.isFinite(point.value)) continue;
        const win = sessionWindowFor(securityType, point.time);
        if (point.time <= win.start || point.time > win.end) continue;
        uniquePoints.set(point.time, point);
    }
    const bySession = new Map<number, IndicatorPoint[]>();
    for (const point of [...uniquePoints.values()].sort((a, b) => a.time - b.time)) {
        const start = sessionWindowFor(securityType, point.time).start;
        const group = bySession.get(start) ?? [];
        group.push(point);
        bySession.set(start, group);
    }
    const labels = [...new Set(chartClosedBars.map(bar => bar.time))]
        .filter(time => Number.isFinite(time) && time % 60 === 0).sort((a, b) => a - b);
    const out: IndicatorPoint[] = [];
    let priorStart: number | undefined;
    const cursors = new Map<number, number>();
    for (const time of labels) {
        const win = sessionWindowFor(securityType, time);
        if (time <= win.start || time > win.end) continue;
        if (priorStart !== undefined && priorStart !== win.start && (out.at(-1)?.time ?? Infinity) < win.start) {
            out.push({ time: win.start });
        }
        priorStart = win.start;
        const group = bySession.get(win.start) ?? [];
        let cursor = cursors.get(win.start) ?? -1;
        while (cursor + 1 < group.length && group[cursor + 1]!.time <= time) cursor++;
        cursors.set(win.start, cursor);
        const value = cursor >= 0 ? group[cursor]!.value : undefined;
        out.push(value === undefined ? { time } : { time, value });
    }
    return out;
}
