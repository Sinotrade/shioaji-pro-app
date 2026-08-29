import { ensureStream, onStreamEvent } from './stream';
import type {
    CalculatedIndexEvent,
    ScannerGapEvent,
    ScannerSignalEvent,
} from './types/market';

type Listener = () => void;

export interface MarketPulseSnapshot {
    version: number;
    calculated: ReadonlyMap<string, CalculatedIndexEvent>;
    signals: readonly ScannerSignalEvent[];
    gap?: ScannerGapEvent;
}

const calculated = new Map<string, CalculatedIndexEvent>();
const signals: ScannerSignalEvent[] = [];
const listeners = new Set<Listener>();
const seenSignals = new Set<string>();
let version = 0;
let gap: ScannerGapEvent | undefined;
let snapshot: MarketPulseSnapshot = {
    version,
    calculated,
    signals,
};

function emitPulse() {
    version += 1;
    snapshot = {
        version,
        calculated,
        signals,
        gap,
    };
    listeners.forEach((listener) => listener());
}

function setMapEvent<T extends { code: string }>(
    map: Map<string, T>,
    raw: string,
    parse: (raw: string) => T,
) {
    const event = parse(raw);
    if (!event.code) return;
    map.set(event.code, event);
    emitPulse();
}

// 1.7.4 起 calculated_index 的數值欄位與其他行情串流一致改為 decimal
// 字串（1.7.2/1.7.3 是裸數字）— 統一 Number() 正規化，兩版 wire 都吃
export function parseCalculatedIndexEvent(raw: string): CalculatedIndexEvent {
    const event = JSON.parse(raw) as Record<string, unknown>;
    return {
        code: String(event.code ?? ''),
        date: String(event.date ?? ''),
        time: String(event.time ?? ''),
        open: Number(event.open),
        high: Number(event.high),
        low: Number(event.low),
        close: Number(event.close),
        total_amount: Number(event.total_amount),
        price_chg: Number(event.price_chg),
        pct_chg: Number(event.pct_chg),
        simtrade: Boolean(event.simtrade),
    };
}

export function exchangeTimeDifferenceSeconds(
    left: string,
    right: string,
): number | null {
    const parse = (value: string) => {
        const match = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(value);
        if (!match) return null;
        const [, hours, minutes, seconds, fraction = ''] = match;
        const millis = Number((fraction + '000').slice(0, 3));
        return (
            Number(hours) * 3_600_000 +
            Number(minutes) * 60_000 +
            Number(seconds) * 1_000 +
            millis
        );
    };
    const leftMs = parse(left);
    const rightMs = parse(right);
    return leftMs === null || rightMs === null
        ? null
        : (leftMs - rightMs) / 1_000;
}

export function futuresIndexBasis(
    futuresPrice: number | null | undefined,
    indexValue: number | null | undefined,
): number | null {
    return Number.isFinite(futuresPrice) && Number.isFinite(indexValue)
        ? Number(futuresPrice) - Number(indexValue)
        : null;
}

export function scannerSignalKey(signal: ScannerSignalEvent) {
    return `${signal.exchange}:${signal.scanner}:${signal.quote.code}:${signal.quote.date}:${signal.quote.time}`;
}

export function parseScannerMessages(
    raw: string,
    receivedAt = Date.now(),
): (ScannerSignalEvent | ScannerGapEvent)[] {
    const event = JSON.parse(raw) as Record<string, unknown>;
    if (typeof event.dropped_count === 'number') {
        return [
            {
                ...event,
                received_at: receivedAt,
            } as unknown as ScannerGapEvent,
        ];
    }
    if (!event.quote) return [];
    const scanners =
        typeof event.scanner === 'string'
            ? [event.scanner]
            : Array.isArray(event.scanners)
              ? event.scanners.filter(
                    (scanner): scanner is string => typeof scanner === 'string',
                )
              : [];
    return scanners.map(
        (scanner) =>
            ({
                ...event,
                scanner,
                extra: event.extra ?? {},
                received_at: receivedAt,
            }) as unknown as ScannerSignalEvent,
    );
}

export function parseScannerMessage(
    raw: string,
    receivedAt = Date.now(),
) {
    return parseScannerMessages(raw, receivedAt)[0];
}

function handleScanner(raw: string) {
    const events = parseScannerMessages(raw);
    let changed = false;
    for (const event of events) {
        if ('dropped_count' in event) {
            gap = event;
            changed = true;
            continue;
        }
        const key = scannerSignalKey(event);
        if (seenSignals.has(key)) continue;
        seenSignals.add(key);
        signals.unshift(event);
        changed = true;
    }
    if (signals.length > 250) signals.length = 250;
    if (seenSignals.size > 500) {
        seenSignals.clear();
        for (const item of signals) {
            seenSignals.add(scannerSignalKey(item));
        }
    }
    if (changed) emitPulse();
}

// Pulse events arrive on the app's single aggregate SSE connection
// (stream.ts) — shioaji 1.7.2 carries enriched-index and scanner events
// there, so no dedicated per-channel EventSources are needed.
let marketStreamRefs = 0;
let detachListeners: (() => void)[] = [];

function ensureMarketPulseStreams() {
    if (detachListeners.length > 0) return;
    ensureStream();
    detachListeners = [
        onStreamEvent('calculated_index', (raw) =>
            setMapEvent(calculated, raw, parseCalculatedIndexEvent),
        ),
        onStreamEvent('scanner', handleScanner),
    ];
}

export function retainMarketPulseStreams() {
    marketStreamRefs += 1;
    ensureMarketPulseStreams();
    return () => {
        marketStreamRefs = Math.max(0, marketStreamRefs - 1);
        if (marketStreamRefs === 0) {
            detachListeners.forEach((detach) => detach());
            detachListeners = [];
        }
    };
}

export function subscribeMarketPulse(listener: Listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function getMarketPulseSnapshot() {
    return snapshot;
}
