import { marketTime } from './display-book';
import type { Snapshot, SseTick, SseIndexQuote } from './types/market';

/** Display only: choose a complete, timestamped range, never merge sessions. */
export function displayDayRange(code: string, target: string | null | undefined, snapshot?: Snapshot, stream?: SseTick | SseIndexQuote) {
    const matches = (value: string) => value === code || (!!target && value === target);
    const candidates = [
        ...(snapshot && matches(snapshot.code) ? [{ high: snapshot.high, low: snapshot.low, close: snapshot.close, time: marketTime(snapshot.datetime), source: '快照' }] : []),
        ...(stream && matches(stream.code) && !('simtrade' in stream && stream.simtrade) ? [{ high: stream.high, low: stream.low, close: stream.close, time: marketTime(stream.date, stream.time), source: '即時' }] : []),
    ].sort((a, b) => b.time - a.time || (a.source === '即時' ? -1 : 1));
    const latest = candidates.filter(c => Number.isFinite(c.time))[0];
    if (!latest) return null;
    const high = Number(latest.high), low = Number(latest.low), close = Number(latest.close);
    // Do not silently substitute an older session for a malformed fresh range.
    if (!(high > 0 && low > 0 && Number.isFinite(high + low) && high >= low) || (close > 0 && (close > high || close < low))) return null;
    return { high, low, time: latest.time, source: latest.source };
}
