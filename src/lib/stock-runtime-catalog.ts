import { isTauri } from './runtime';
import { fetchPublicJson } from './public-metadata';
import { EQUITY_SOURCE_ROUTES, EQUITY_SOURCES } from './public-metadata-routes';
import { normalizeStockNames, type EquityExchange, type EquityNameSource } from './stock-name-normalizer';

const FRESH_MS = 300_000;
const RETRY_MS = 30_000;
const exchanges = ['TSE', 'OTC', 'OES'] as const;
const routes = {
    TSE: EQUITY_SOURCE_ROUTES.tseCompanies,
    OTC: EQUITY_SOURCE_ROUTES.otcCompanies,
    OES: EQUITY_SOURCE_ROUTES.oesCompanies,
};
export interface EquitySourceStatus {
    readonly exchange: EquityExchange;
    readonly url: string;
    readonly count: number;
    readonly sourceDate: string | null;
    readonly invalidRows: number;
    readonly conflictingCodes: number;
    readonly lastSuccessAt: string | null;
    readonly error: string | null;
}
export interface EquityNamesStatus {
    readonly phase: 'idle' | 'loading' | 'ready' | 'error' | 'gated';
    readonly sources: readonly EquitySourceStatus[];
    readonly lastAttemptAt: string | null;
    readonly lastSuccessAt: string | null;
    readonly retryAt: string | null;
    readonly error: string | null;
    readonly listenerError: string | null;
    readonly cleanupError: string | null;
}
interface DisplayName { readonly name: string; readonly aliases: readonly string[] }
let status: EquityNamesStatus = {
    phase: 'idle', sources: exchanges.map(exchange => ({ exchange, url: EQUITY_SOURCES[exchange],
        count: 0, sourceDate: null, invalidRows: 0, conflictingCodes: 0, lastSuccessAt: null, error: null })),
    lastAttemptAt: null, lastSuccessAt: null, retryAt: null, error: null, listenerError: null, cleanupError: null,
};
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
const dayAt = (now: number) => new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
const message = (error: unknown) => error instanceof Error ? error.message : '一般股官方名稱更新失敗';

export function equityNameForLive(exchange: EquityExchange, code: string): DisplayName | undefined {
    return byIdentity.get(`${exchange}:${code}`);
}
export function getEquityNamesVersion(): number { return version; }
export function getEquityNamesStatus(): EquityNamesStatus {
    return { ...status, sources: status.sources.map(source => ({ ...source })) };
}
/** Subscriptions and reads never start IO; catalog reads explicitly refresh. */
export function subscribeEquityNames(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** One background batch across all catalog readers; no polling or native IO. */
export function ensureEquityNamesFresh(): void {
    if (isTauri) {
        if (status.phase !== 'gated') {
            activeRound++;
            controller?.abort();
            pending = null;
            status = { ...status, phase: 'gated', retryAt: null, error: '原生版官方一般股名稱來源未啟用，使用券商名稱或代碼' };
        }
        return;
    }
    const now = Date.now();
    const day = dayAt(now);
    if (pending && attemptDay === day) return;
    if (attemptDay === day && now >= lastAttempt && now < nextAttempt) return;
    controller?.abort();
    const roundController = new AbortController();
    controller = roundController;
    const round = ++activeRound;
    attemptDay = day;
    lastAttempt = now;
    status = { ...status, phase: 'loading', lastAttemptAt: new Date(now).toISOString(), retryAt: null,
        error: null, cleanupError: null, listenerError: null };
    const current = () => round === activeRound && !roundController.signal.aborted && dayAt(Date.now()) === day;
    const refresh = async () => {
        const outcomes = await Promise.allSettled(exchanges.map(async exchange => {
            const payload = await fetchPublicJson(routes[exchange], {
                signal: roundController.signal,
                onCleanupError: error => {
                    if (current()) status = { ...status, cleanupError: message(error) };
                },
            });
            const previous = lastGood[exchange];
            const result = normalizeStockNames(payload, exchange, day, previous?.entries.length);
            if (previous && result.sourceDate < previous.sourceDate) throw new Error('Equity source became older');
            return result;
        }));
        if (!current()) return;
        const completedAt = new Date().toISOString();
        const nextGood = { ...lastGood };
        let failed = false;
        const sources = outcomes.map((outcome, index): EquitySourceStatus => {
            const exchange = exchanges[index]!;
            const previous = status.sources[index]!;
            if (outcome.status === 'rejected') {
                failed = true;
                return { ...previous, error: message(outcome.reason) };
            }
            const source = outcome.value;
            nextGood[exchange] = source;
            return { exchange, url: EQUITY_SOURCES[exchange], count: source.entries.length, sourceDate: source.sourceDate,
                invalidRows: source.invalidRows, conflictingCodes: source.conflictingCodes, lastSuccessAt: completedAt, error: null };
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
        nextAttempt = Date.now() + (failed ? RETRY_MS : FRESH_MS);
        status = { ...status, phase: failed ? 'error' : 'ready', sources,
            lastSuccessAt: outcomes.some(outcome => outcome.status === 'fulfilled') ? completedAt : status.lastSuccessAt,
            retryAt: failed ? new Date(nextAttempt).toISOString() : null,
            error: failed ? sources.filter(source => source.error).map(source => `${source.exchange}: ${source.error}`).join('; ') : null };
        if (changed) for (const listener of [...listeners]) {
            try { listener(); }
            catch (error) { status = { ...status, listenerError: message(error) }; }
        }
    };
    pending = refresh().catch(error => {
        if (!current()) return;
        nextAttempt = Date.now() + RETRY_MS;
        status = { ...status, phase: 'error', error: message(error), retryAt: new Date(nextAttempt).toISOString() };
    }).finally(() => {
        if (round === activeRound) pending = null;
    });
}

if (import.meta.hot) import.meta.hot.dispose(() => {
    activeRound++;
    controller?.abort();
    listeners.clear();
});
