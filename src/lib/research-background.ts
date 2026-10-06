import { getApiBase } from './runtime';
import type { ContractBase } from './types/contract';
import type { Candle } from './types/market';

export interface ResearchBackground {
    minutes: Candle[];
    daily: Candle[];
}
const EMPTY: ResearchBackground = { minutes: [], daily: [] };
const same = (a: Candle, b: Candle) => a.time === b.time && a.open === b.open
    && a.high === b.high && a.low === b.low && a.close === b.close && a.volume === b.volume;
const valid = (bar: Candle) => [bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)
    && bar.volume >= 0 && bar.high >= Math.max(bar.open, bar.close)
    && bar.low <= Math.min(bar.open, bar.close);

/** View-independent identity includes API source and the actual futures month. */
export function researchBackgroundKey(contract: ContractBase, apiBase = getApiBase()): string {
    return JSON.stringify([apiBase, contract.region, contract.security_type, contract.exchange, contract.code, contract.target_code]);
}

/** Memory-only reuse of already requested history; no downloads or persistence.
 * Per-minute revisions reject an older in-flight request after a newer update.
 * Snapshot replacement never adds duplicated history volume. */
export function createResearchBackgroundStore(maxMinutes = 120_000, maxSymbols = 24) {
    type Entry = { snapshot: ResearchBackground; revisions: Map<number, number>; dailyRevision: number };
    const entries = new Map<string, Entry>();
    const listeners = new Map<string, Set<() => void>>();
    let revision = 0;
    const emit = (key: string) => listeners.get(key)?.forEach(listener => listener());
    const ensure = (key: string) => {
        let entry = entries.get(key);
        if (!entry) {
            entry = { snapshot: EMPTY, revisions: new Map(), dailyRevision: -Infinity };
            entries.set(key, entry);
            if (entries.size > maxSymbols) {
                // Active charts must not lose their background when another
                // symbol loads. Unobserved least-recent entries can be evicted.
                const oldest = [...entries.keys()].find(value => value !== key && !listeners.get(value)?.size);
                if (oldest !== undefined) entries.delete(oldest);
            }
        }
        return entry;
    };
    return {
        nextRevision: () => ++revision,
        get: (key: string): ResearchBackground => entries.get(key)?.snapshot ?? EMPTY,
        subscribe(key: string, listener: () => void) {
            const set = listeners.get(key) ?? new Set<() => void>();
            set.add(listener); listeners.set(key, set);
            return () => { set.delete(listener); if (!set.size) listeners.delete(key); };
        },
        mergeMinutes(key: string, bars: Candle[], sourceRevision = ++revision) {
            const incoming = bars.filter(valid);
            if (!incoming.length) return;
            const entry = ensure(key);
            const merged = new Map(entry.snapshot.minutes.map(bar => [bar.time, bar]));
            let changed = false;
            for (const bar of incoming) {
                if (sourceRevision < (entry.revisions.get(bar.time) ?? -Infinity)) continue;
                entry.revisions.set(bar.time, sourceRevision);
                const previous = merged.get(bar.time);
                if (!previous || !same(previous, bar)) { merged.set(bar.time, { ...bar }); changed = true; }
            }
            if (!changed) return;
            const minutes = [...merged.values()].sort((a, b) => a.time - b.time).slice(-maxMinutes);
            const retained = new Set(minutes.map(bar => bar.time));
            for (const time of entry.revisions.keys()) if (!retained.has(time)) entry.revisions.delete(time);
            entry.snapshot = { ...entry.snapshot, minutes };
            emit(key);
        },
        replaceDaily(key: string, confirmed: Candle[], sourceRevision = ++revision) {
            const entry = ensure(key);
            if (sourceRevision < entry.dailyRevision) return;
            entry.dailyRevision = sourceRevision;
            const byTime = new Map(confirmed.filter(valid).map(bar => [bar.time, { ...bar }]));
            const daily = [...byTime.values()].sort((a, b) => a.time - b.time).slice(-150);
            if (daily.length === entry.snapshot.daily.length && daily.every((bar, i) => same(bar, entry.snapshot.daily[i]!))) return;
            entry.snapshot = { ...entry.snapshot, daily };
            emit(key);
        },
    };
}

export const researchBackgroundStore = createResearchBackgroundStore();
