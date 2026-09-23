// src/lib/bracket-event-ledger.ts — Shioaji 1.7.6 `event_id` delivery
// dedup and sequence-gap observation for protection (bracket) tracking.
//
// Rules (Shioaji skill ORDERS.md "event_id: Deduplication and Sequence Gaps"):
// - dedup uses the COMPLETE nonempty ID within one environment;
// - a supported `v1:` ID splits at its last two colons into
//   `<stream>:<reset>:<sequence>`; sequences compare (BigInt) only within
//   (environment, stream, reset) — a new reset gets its own baseline;
// - a gap means "possibly missing", never confirmed loss; a smaller unseen
//   sequence can be a late report (dedup still decides by the full ID);
// - unsupported/empty IDs keep the report but skip sequence inference.
//
// Pure data structure: no timers, no HTTP. Bounded so a long session cannot
// grow without limit; eviction only forgets the oldest delivery IDs.

export interface ParsedEventId {
    stream: string;
    reset: string;
    sequence: bigint;
}

export function parseEventId(eventId: string): ParsedEventId | null {
    if (!eventId.startsWith('v1:')) return null;
    const last = eventId.lastIndexOf(':');
    const prev = last > 0 ? eventId.lastIndexOf(':', last - 1) : -1;
    if (prev <= 0) return null;
    const stream = eventId.slice(0, prev);
    const reset = eventId.slice(prev + 1, last);
    const seqText = eventId.slice(last + 1);
    if (!stream || stream === 'v1' || !reset || !/^\d+$/.test(seqText)) return null;
    return { stream, reset, sequence: BigInt(seqText) };
}

/** `v1:FD:x` → 'futures'; `v1:SO:x` → 'stock'; otherwise null. */
export function streamMarket(stream: string): 'stock' | 'futures' | null {
    const kind = stream.split(':')[1] ?? '';
    if (kind === 'SO' || kind === 'SD') return 'stock';
    if (kind === 'FO' || kind === 'FD') return 'futures';
    return null;
}

export type EventVerdict =
    | { kind: 'new'; gap: null | { stream: string; reset: string; expected: bigint; received: bigint } }
    | { kind: 'duplicate' }
    | { kind: 'untrackable' };

export class EventLedger {
    private readonly seen = new Map<string, true>();
    // `${env}\u0000${stream}\u0000${reset}` → highest observed sequence
    private readonly highest = new Map<string, bigint>();

    constructor(private readonly limit = 20000) {}

    observe(env: string, eventId: string): EventVerdict {
        if (!eventId) return { kind: 'untrackable' };
        const key = `${env}\u0000${eventId}`;
        if (this.seen.has(key)) return { kind: 'duplicate' };
        this.seen.set(key, true);
        if (this.seen.size > this.limit) {
            const oldest = this.seen.keys().next().value;
            if (oldest !== undefined) this.seen.delete(oldest);
        }
        const parsed = parseEventId(eventId);
        if (!parsed) return { kind: 'untrackable' };
        const streamKey = `${env}\u0000${parsed.stream}\u0000${parsed.reset}`;
        const high = this.highest.get(streamKey);
        if (high === undefined) {
            this.highest.set(streamKey, parsed.sequence); // baseline
            return { kind: 'new', gap: null };
        }
        if (parsed.sequence > high) {
            this.highest.set(streamKey, parsed.sequence);
            if (parsed.sequence > high + 1n) {
                return { kind: 'new', gap: { stream: parsed.stream, reset: parsed.reset,
                    expected: high + 1n, received: parsed.sequence } };
            }
        }
        // sequence <= high and unseen: a late report — new, not a gap.
        return { kind: 'new', gap: null };
    }
}
