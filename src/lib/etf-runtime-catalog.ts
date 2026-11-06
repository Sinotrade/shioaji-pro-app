// Shared public name metadata only. Never use these identities as tradable contracts.
import bundled from './data/etf-catalog.json';
import { isTauri } from './runtime';
import { todayStr } from './utils/date';
import { ETF_SOURCE_ROUTES } from './public-metadata-routes';
import { fetchPublicJson, isPublicMetadataUnavailable } from './public-metadata';
import { buildEtfCatalog, type EtfNameCatalog, type EtfNameEntry } from './etf-catalog-normalizer.mjs';

export type { EtfNameCatalog, EtfNameEntry } from './etf-catalog-normalizer.mjs';
const FRESH_MS = 60 * 60_000;
const RETRY_MS = 30_000;
export interface EtfNamesStatus {
    readonly usingSnapshot: boolean;
}

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

let current = immutable(bundled as EtfNameCatalog);
let byIdentity = new Map(current.entries.map(entry => [`${entry.exchange}:${entry.code}`, entry]));
let version = 0;
let usingSnapshot = true;
let lastAttempt = 0;
let attemptDay = '';
let nextAttempt = 0;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function etfNameForLive(code: string, exchange: string): EtfNameEntry | undefined {
    return byIdentity.get(`${exchange}:${code}`);
}
export function getEtfNamesVersion(): number { return version; }
export function getEtfNamesStatus(): EtfNamesStatus { return { usingSnapshot }; }
export function subscribeEtfNames(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
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
    // Checked before the day rollover below, which would otherwise retry every day.
    if (isTauri || isPublicMetadataUnavailable()) return Promise.resolve();
    if (pending) return pending;
    const now = Date.now();
    const day = todayStr();
    if (attemptDay === day && now >= lastAttempt && now < nextAttempt) return Promise.resolve();
    lastAttempt = now;
    attemptDay = day;
    const controller = new AbortController();
    const refresh = (async () => {
        let changed = false;
        try {
            const [tse, otc, daily] = await Promise.all([
                fetchPublicJson(ETF_SOURCE_ROUTES.tseFunds, { signal: controller.signal }),
                fetchPublicJson(ETF_SOURCE_ROUTES.otcFunds, { signal: controller.signal }),
                fetchPublicJson(ETF_SOURCE_ROUTES.tseNames, { signal: controller.signal }),
            ]);
            // The daily stock table supplies names, never ETF membership.
            const next = buildEtfCatalog(tse, otc, new Date().toISOString(), daily, current);
            // Broker names keep display authority, so a refresh equal to the snapshot changes nothing.
            changed = !sameContent(current.entries, next.entries);
            current = next;
            if (changed) {
                byIdentity = new Map(current.entries.map(entry => [`${entry.exchange}:${entry.code}`, entry]));
                version += 1;
            }
            usingSnapshot = false;
            nextAttempt = Date.now() + FRESH_MS;
        } catch {
            controller.abort(); // A failed source must release unfinished sibling transports too.
            nextAttempt = Date.now() + RETRY_MS;
        } finally {
            pending = null;
        }
        if (changed) for (const listener of [...listeners]) {
            // A consumer callback is not a source failure and must not prevent other readers.
            try { listener(); } catch { /* isolated */ }
        }
    })();
    pending = refresh;
    return refresh;
}
