// Shared public name metadata only. Never use these identities as tradable contracts.
import bundled from './data/etf-catalog.json';
import { isTauri } from './runtime';
import { ETF_SOURCE_ROUTES, type PublicMetadataRoute } from './public-metadata-routes';
import { fetchPublicJson } from './public-metadata';
import { buildEtfCatalog, type EtfNameCatalog, type EtfNameEntry, type EtfNameSource } from './etf-catalog-normalizer.mjs';

export type { EtfNameCatalog, EtfNameEntry } from './etf-catalog-normalizer.mjs';
const FRESH_MS = 5 * 60_000;
const RETRY_MS = 30_000;
export interface EtfNamesStatus {
    readonly phase: 'snapshot' | 'refreshing' | 'ready' | 'error' | 'gated';
    readonly usingSnapshot: boolean;
    readonly retrievedAt: string;
    readonly sources: readonly EtfNameSource[];
    readonly count: number;
    readonly lastAttemptAt: string | null;
    readonly lastSuccessAt: string | null;
    readonly retryAt: string | null;
    readonly error: string | null;
    readonly listenerError: string | null;
    readonly cleanupError: string | null;
}

const taiwanDay = (now: number) => new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
function immutable(catalog: EtfNameCatalog): EtfNameCatalog {
    return Object.freeze({
        schemaVersion: 1,
        retrievedAt: catalog.retrievedAt,
        sources: Object.freeze(catalog.sources.map(source => Object.freeze({ ...source }))),
        entries: Object.freeze(catalog.entries.map(entry => Object.freeze({
            code: entry.code, exchange: entry.exchange, name: entry.name,
            ...(entry.aliases?.length ? { aliases: Object.freeze([...entry.aliases]) } : {}),
        }))),
    });
}
const initialCatalog = immutable(bundled as EtfNameCatalog);

/** Pure validation/normalization. The daily stock table supplies names, never ETF membership. */
export function buildEtfRuntimeCatalog(
    tsePayload: unknown, otcPayload: unknown, dailyPayload: unknown, retrievedAt: string,
    previous: EtfNameCatalog = initialCatalog,
): EtfNameCatalog {
    return buildEtfCatalog(tsePayload, otcPayload, retrievedAt, dailyPayload, previous);
}

let current = initialCatalog;
let byIdentity = new Map(current.entries.map(entry => [`${entry.exchange}:${entry.code}`, entry]));
let version = 0;
let lastAttempt = 0;
let attemptDay = '';
let nextAttempt = 0;
let pending: Promise<void> | null = null;
let activeRound = 0;
const listeners = new Set<() => void>();
let status: EtfNamesStatus = {
    phase: 'snapshot', usingSnapshot: true, retrievedAt: current.retrievedAt, sources: current.sources,
    count: current.entries.length, lastAttemptAt: null, lastSuccessAt: null, retryAt: null, error: null, listenerError: null, cleanupError: null,
};

export function etfNameForLive(code: string, exchange: string): EtfNameEntry | undefined {
    return byIdentity.get(`${exchange}:${code}`);
}
export function getEtfNamesVersion(): number { return version; }
export function getEtfNamesStatus(): EtfNamesStatus { return { ...status }; }
export function subscribeEtfNames(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

// Each round owns cleanup diagnostics, so a late failure cannot overwrite a newer round.
function publicJson(route: PublicMetadataRoute, signal: AbortSignal, round: number): Promise<unknown> {
    return fetchPublicJson(route, { signal, onCleanupError: error => {
        if (round === activeRound) status = { ...status, cleanupError: error instanceof Error ? error.message : 'ETF body cleanup failed' };
    } });
}
function sameContent(left: readonly EtfNameEntry[], right: readonly EtfNameEntry[]) {
    return left.length === right.length && left.every((entry, index) => {
        const next = right[index];
        return next?.code === entry.code && next.exchange === entry.exchange && next.name === entry.name &&
            (entry.aliases?.length ?? 0) === (next.aliases?.length ?? 0) &&
            (entry.aliases ?? []).every((alias, aliasIndex) => alias === next.aliases?.[aliasIndex]);
    });
}

/** Triggered by catalog reads, not a poller or a single search reader's lifecycle. */
export function refreshEtfNames(): Promise<void> {
    if (isTauri) {
        status = { ...status, phase: 'gated', error: '原生版官方名稱來源未啟用，使用內建快照' };
        return Promise.resolve();
    }
    if (pending) return pending;
    const now = Date.now();
    const day = taiwanDay(now);
    if (attemptDay === day && now >= lastAttempt && now < nextAttempt) return Promise.resolve();
    lastAttempt = now;
    attemptDay = day;
    status = { ...status, phase: 'refreshing', lastAttemptAt: new Date(now).toISOString(), retryAt: null, error: null, listenerError: null, cleanupError: null };
    const controller = new AbortController();
    const round = ++activeRound;
    const refresh = (async () => {
        let changed = false;
        try {
            const [tse, otc, daily] = await Promise.all([
                publicJson(ETF_SOURCE_ROUTES.tseFunds, controller.signal, round),
                publicJson(ETF_SOURCE_ROUTES.otcFunds, controller.signal, round),
                publicJson(ETF_SOURCE_ROUTES.tseNames, controller.signal, round),
            ]);
            const next = buildEtfRuntimeCatalog(tse, otc, daily, new Date().toISOString(), current);
            // The first successful refresh changes display authority even when the
            // names equal the snapshot. Later unchanged successes must not loop.
            changed = status.usingSnapshot || !sameContent(current.entries, next.entries);
            current = next;
            if (changed) {
                byIdentity = new Map(current.entries.map(entry => [`${entry.exchange}:${entry.code}`, entry]));
                version += 1;
            }
            nextAttempt = Date.now() + FRESH_MS;
            status = { ...status, phase: 'ready', usingSnapshot: false, retrievedAt: current.retrievedAt, sources: current.sources,
                count: current.entries.length, lastSuccessAt: new Date().toISOString(), error: null };
        } catch (error) {
            controller.abort(); // A failed source must release unfinished sibling transports too.
            nextAttempt = Date.now() + RETRY_MS;
            status = { ...status, phase: 'error', retryAt: new Date(nextAttempt).toISOString(),
                error: error instanceof Error ? error.message : 'ETF public metadata refresh failed' };
        } finally {
            pending = null;
        }
        if (changed) for (const listener of [...listeners]) {
            try { listener(); }
            catch (error) {
                // A consumer callback is not a source failure and must not prevent other readers.
                status = { ...status, listenerError: error instanceof Error ? error.message : 'ETF name listener failed' };
            }
        }
    })();
    pending = refresh;
    return refresh;
}
