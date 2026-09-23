// src/lib/report-ledger.ts — Shioaji 1.7.6 order/deal report `event_id`
// bookkeeping: duplicate delivery and possible sequence gaps.
//
// Contract (Shioaji 1.7.6 skill ORDERS.md "event_id: Deduplication and
// Sequence Gaps"; verified on a 1.7.6 simulation sidecar):
// - event_id is an opaque string. Deduplicate by the complete nonempty ID
//   within one environment. Different IDs do not prove different operations.
// - A supported ID starts with `v1:`; split at its last two colons into
//   `<stream>:<reset>:<sequence>`, compare decimal sequences with BigInt only
//   within (environment, stream, reset). The first observation is a baseline;
//   a new reset gets its own baseline.
// - A skipped sequence is a *possible* missing report, not a confirmed loss:
//   a smaller unseen sequence may still arrive late. Nothing here calls the
//   broker; reconciliation stays an explicit caller action.
// - Historical records and pre-1.7.6 servers carry "" → no dedup/sequence.
//   Unsupported formats keep the raw report and skip sequence inference.

export type ReportKind = 'order' | 'deal';

export interface ParsedEventId {
    stream: string;
    reset: string;
    sequence: bigint;
}

export function parseEventId(id: string): ParsedEventId | null {
    if (!id.startsWith('v1:')) return null;
    const last = id.lastIndexOf(':');
    const middle = last > 0 ? id.lastIndexOf(':', last - 1) : -1;
    if (middle < 2) return null;
    const stream = id.slice(0, middle);
    const reset = id.slice(middle + 1, last);
    const sequence = id.slice(last + 1);
    if (!stream || !reset || !/^\d+$/.test(sequence)) return null;
    return { stream, reset, sequence: BigInt(sequence) };
}

export interface ReportEnvironment {
    /** API base of the sidecar that delivered the report. */
    base: string;
    /** From /api/v1/info when known; a different known value resets the env. */
    simulation?: boolean;
}

export interface AdmitResult {
    /** Same complete ID already admitted in this environment. */
    duplicate: boolean;
    /** Nonempty ID that was not a supported v1 sequence. */
    unsupported: boolean;
    /** This report skipped at least one sequence in its stream/reset. */
    gapOpened: boolean;
    /** Sequence at or below the stream maximum (late or pre-baseline). */
    late: boolean;
}

interface Gap { lo: bigint; hi: bigint; opened: number }
interface StreamState { kind: ReportKind; max: bigint; gaps: Gap[] }
interface EnvState {
    simulation?: boolean;
    ids: Set<string>;
    order: string[];
    streams: Map<string, StreamState>;
}

const NONE: AdmitResult = { duplicate: false, unsupported: false, gapOpened: false, late: false };

export function createReportLedger(limits: { maxIds?: number; maxGapsPerStream?: number } = {}) {
    const maxIds = limits.maxIds ?? 20000;
    const maxGaps = limits.maxGapsPerStream ?? 64;
    const envs = new Map<string, EnvState>();
    const gapListeners = new Set<(base: string, opened: number) => void>();
    let clock = 0;

    function env(target: ReportEnvironment): EnvState {
        let state = envs.get(target.base);
        if (state && target.simulation !== undefined && state.simulation !== undefined
            && state.simulation !== target.simulation) state = undefined;
        if (!state) {
            state = { ids: new Set(), order: [], streams: new Map() };
            envs.set(target.base, state);
        }
        if (target.simulation !== undefined) state.simulation = target.simulation;
        return state;
    }

    function admit(target: ReportEnvironment, eventId: string, kind: ReportKind): AdmitResult {
        if (!eventId) return NONE;
        const state = env(target);
        if (state.ids.has(eventId)) return { ...NONE, duplicate: true };
        state.ids.add(eventId);
        state.order.push(eventId);
        if (state.order.length > maxIds) state.ids.delete(state.order.shift()!);
        const parsed = parseEventId(eventId);
        if (!parsed) return { ...NONE, unsupported: true };
        const key = `${parsed.stream}\u0000${parsed.reset}`;
        const stream = state.streams.get(key);
        if (!stream) {
            state.streams.set(key, { kind, max: parsed.sequence, gaps: [] });
            return NONE;
        }
        const seq = parsed.sequence;
        if (seq > stream.max) {
            const gapOpened = seq > stream.max + 1n;
            if (gapOpened) {
                const gap = { lo: stream.max + 1n, hi: seq - 1n, opened: ++clock };
                if (stream.gaps.length >= maxGaps) {
                    // Bounded memory: coarsen into the newest range. It stays
                    // open until the caller takes it; a late fill can no longer
                    // prove the whole range arrived.
                    const newest = stream.gaps[stream.gaps.length - 1]!;
                    newest.hi = gap.hi;
                    newest.opened = gap.opened;
                } else stream.gaps.push(gap);
            }
            stream.max = seq;
            if (gapOpened) gapListeners.forEach(listener => listener(target.base, clock));
            return { ...NONE, gapOpened };
        }
        const index = stream.gaps.findIndex(g => g.lo <= seq && seq <= g.hi);
        if (index >= 0) {
            const gap = stream.gaps[index]!;
            const parts: Gap[] = [];
            if (gap.lo < seq) parts.push({ lo: gap.lo, hi: seq - 1n, opened: gap.opened });
            if (seq < gap.hi) parts.push({ lo: seq + 1n, hi: gap.hi, opened: gap.opened });
            stream.gaps.splice(index, 1, ...parts);
        }
        return { ...NONE, late: true };
    }

    /** Open gaps of `base` opened at or before `through` (all when omitted).
     *  Taking them removes them: once surfaced as a reconciliation reason the
     *  ledger no longer tracks them, and a later arrival is just `late`. */
    function takeGaps(base: string, through = Number.POSITIVE_INFINITY): Set<ReportKind> {
        const kinds = new Set<ReportKind>();
        for (const stream of envs.get(base)?.streams.values() ?? []) {
            const remaining = stream.gaps.filter(g => g.opened > through);
            if (remaining.length !== stream.gaps.length) kinds.add(stream.kind);
            stream.gaps = remaining;
        }
        return kinds;
    }

    function openGapCount(base: string) {
        let count = 0;
        for (const stream of envs.get(base)?.streams.values() ?? []) count += stream.gaps.length;
        return count;
    }

    return {
        admit,
        takeGaps,
        openGapCount,
        clock: () => clock,
        onGap(listener: (base: string, opened: number) => void) {
            gapListeners.add(listener);
            return () => { gapListeners.delete(listener); };
        },
        clear: () => { envs.clear(); clock = 0; },
    };
}

export type ReportLedger = ReturnType<typeof createReportLedger>;

/** One ledger per WebView: SSE fan-out (stream.ts) admits every report. */
export const reportLedger = createReportLedger();
