import { getStreamBase } from './runtime';
import type {
    CalculatedIndexEvent,
    IndexContributionEvent,
    IndustryContributionEvent,
    ScannerGapEvent,
    ScannerSignalEvent,
} from './types/market';

type Listener = () => void;

export interface MarketPulseSnapshot {
    version: number;
    calculated: ReadonlyMap<string, CalculatedIndexEvent>;
    indexContribution: ReadonlyMap<string, IndexContributionEvent>;
    industryContribution: ReadonlyMap<string, IndustryContributionEvent>;
    signals: readonly ScannerSignalEvent[];
    gap?: ScannerGapEvent;
}

const calculated = new Map<string, CalculatedIndexEvent>();
const indexContribution = new Map<string, IndexContributionEvent>();
const industryContribution = new Map<string, IndustryContributionEvent>();
const signals: ScannerSignalEvent[] = [];
const listeners = new Set<Listener>();
const seenSignals = new Set<string>();
let version = 0;
let gap: ScannerGapEvent | undefined;
let snapshot: MarketPulseSnapshot = {
    version,
    calculated,
    indexContribution,
    industryContribution,
    signals,
};

function emitPulse() {
    version += 1;
    snapshot = {
        version,
        calculated,
        indexContribution,
        industryContribution,
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

export function parseCalculatedIndexEvent(raw: string) {
    return JSON.parse(raw) as CalculatedIndexEvent;
}

export function parseIndexContributionEvent(raw: string) {
    return JSON.parse(raw) as IndexContributionEvent;
}

export function parseIndustryContributionEvent(raw: string) {
    return JSON.parse(raw) as IndustryContributionEvent;
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

function handleIndexContribution(raw: string) {
    const event = parseIndexContributionEvent(raw);
    if (!event.code || !event.ranking) return;
    indexContribution.set(`${event.code}:${event.ranking}`, event);
    emitPulse();
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

const sources = new Map<string, EventSource>();
let marketStreamRefs = 0;

function ensureSource(
    channel: string,
    eventName: string,
    handler: (raw: string) => void,
    onOpen?: () => void,
) {
    if (sources.has(channel)) return;
    const source = new EventSource(
        `${getStreamBase()}/api/v1/stream/data/${channel}`,
    );
    source.addEventListener(eventName, (event) =>
        handler((event as MessageEvent).data),
    );
    if (onOpen) source.onopen = onOpen;
    sources.set(channel, source);
}

function ensureMarketPulseStreams() {
    ensureSource('calculated_index', 'calculated_index', (raw) =>
        setMapEvent(calculated, raw, parseCalculatedIndexEvent),
    );
    ensureSource(
        'index_contribution',
        'index_contribution',
        handleIndexContribution,
    );
    ensureSource('industry_contribution', 'industry_contribution', (raw) =>
        setMapEvent(industryContribution, raw, parseIndustryContributionEvent),
    );
    ensureSource('scanner', 'scanner', handleScanner);
}

function closeSources(channels: string[]) {
    for (const channel of channels) {
        sources.get(channel)?.close();
        sources.delete(channel);
    }
}

export function retainMarketPulseStreams() {
    marketStreamRefs += 1;
    ensureMarketPulseStreams();
    return () => {
        marketStreamRefs = Math.max(0, marketStreamRefs - 1);
        if (marketStreamRefs === 0) {
            closeSources([
                'calculated_index',
                'index_contribution',
                'industry_contribution',
                'scanner',
            ]);
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
