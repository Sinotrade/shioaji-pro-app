import { isTauri } from './runtime';
import { todayStr } from './utils/date';
import { fetchPublicJson, isPublicMetadataUnavailable } from './public-metadata';
import { EQUITY_SOURCE_ROUTES } from './public-metadata-routes';
import { normalizeStockNames, type EquityExchange, type EquityNameSource } from './stock-name-normalizer';

const FRESH_MS = 60 * 60_000;
const RETRY_MS = 30_000;
const exchanges = ['TSE', 'OTC', 'OES'] as const;
const routes = {
    TSE: EQUITY_SOURCE_ROUTES.tseCompanies,
    OTC: EQUITY_SOURCE_ROUTES.otcCompanies,
    OES: EQUITY_SOURCE_ROUTES.oesCompanies,
};
interface DisplayName { readonly name: string; readonly aliases: readonly string[] }
let lastGood: Partial<Record<EquityExchange, EquityNameSource>> = {};
let byIdentity = new Map<string, DisplayName>();
let version = 0;
let pending: Promise<void> | null = null;
let controller: AbortController | undefined;
let activeRound = 0;
let attemptDay = '';
let lastAttempt = 0;
let nextAttempt = 0;
const listeners = new Set<() => void>();

export function equityNameForLive(exchange: EquityExchange, code: string): DisplayName | undefined {
    return byIdentity.get(`${exchange}:${code}`);
}
export function getEquityNamesVersion(): number { return version; }
/** Subscriptions and reads never start IO; catalog reads explicitly refresh. */
export function subscribeEquityNames(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** One background batch across all catalog readers; no polling or native IO. */
export function ensureEquityNamesFresh(): void {
    // Checked before the day rollover below, which would otherwise retry every day.
    if (isTauri || isPublicMetadataUnavailable()) return;
    const now = Date.now();
    const day = todayStr();
    if (pending && attemptDay === day) return;
    if (attemptDay === day && now >= lastAttempt && now < nextAttempt) return;
    controller?.abort();
    const roundController = new AbortController();
    controller = roundController;
    const round = ++activeRound;
    attemptDay = day;
    lastAttempt = now;
    const current = () => round === activeRound && !roundController.signal.aborted && todayStr() === day;
    const refresh = async () => {
        const outcomes = await Promise.allSettled(exchanges.map(async exchange => {
            const payload = await fetchPublicJson(routes[exchange], { signal: roundController.signal });
            const previous = lastGood[exchange];
            const result = normalizeStockNames(payload, exchange, day, previous?.entries.length);
            if (previous && result.sourceDate < previous.sourceDate) throw new Error('Equity source became older');
            return result;
        }));
        if (!current()) return;
        // Each failed source keeps its last good names; the successful ones publish together.
        const nextGood = { ...lastGood };
        outcomes.forEach((outcome, index) => {
            if (outcome.status === 'fulfilled') nextGood[exchanges[index]!] = outcome.value;
        });
        const nextNames = new Map<string, DisplayName>();
        for (const exchange of exchanges) for (const entry of nextGood[exchange]?.entries ?? []) {
            nextNames.set(`${exchange}:${entry.code}`, Object.freeze({ name: entry.name, aliases: entry.aliases }));
        }
        const changed = nextNames.size !== byIdentity.size || [...nextNames].some(([key, next]) => {
            const previous = byIdentity.get(key);
            return previous?.name !== next.name || previous.aliases.length !== next.aliases.length ||
                next.aliases.some((alias, index) => alias !== previous.aliases[index]);
        });
        lastGood = nextGood;
        if (changed) { byIdentity = nextNames; version++; }
        nextAttempt = Date.now() + (outcomes.some(outcome => outcome.status === 'rejected') ? RETRY_MS : FRESH_MS);
        if (changed) for (const listener of [...listeners]) {
            // A consumer callback is not a source failure and must not prevent other readers.
            try { listener(); } catch { /* isolated */ }
        }
    };
    pending = refresh().catch(() => {
        if (current()) nextAttempt = Date.now() + RETRY_MS;
    }).finally(() => {
        if (round === activeRound) pending = null;
    });
}

if (import.meta.hot) import.meta.hot.dispose(() => {
    activeRound++;
    controller?.abort();
    listeners.clear();
});
