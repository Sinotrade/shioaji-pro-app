import {
    fetchContractInfo,
    fetchFutures,
    fetchFuturesRoots,
    fetchOptionRoots,
    fetchOptions,
    fetchWarrants,
    normalizeContractCode,
    resolveContract,
    type ContractRoot,
} from './shioaji';
import { loadStockCatalog, normalizeStockSearchText, searchStocks, stockDisplayMeta, type StockMeta } from './stock-index';
import { indexSearchSuggestions } from './index-search';
import { todayStr } from './utils/date';
import type { ContractInfo, SecurityType } from './types/contract';
import { etfNameForLive } from './etf-runtime-catalog';
import { getProductNamesVersion } from './product-names-version';
import { SearchRequestCache } from './search-request';
import { getProductCatalogVersion, subscribeProductCatalog } from './product-catalog-version';
import { loadIndexSuggestions } from './index-catalog';

export interface ProductSuggestion {
    code: string;
    name: string;
    security_type: Exclude<SecurityType, null>;
    exchange: string;
    detail: string;
    kind?: 'ETF';
    contract?: ContractInfo;
}

const CACHE_TTL_MS = 60_000;
const CACHE_LIMIT = 16;
const SOURCE_DEADLINE_MS = 1200;
const cacheOptions = { ttlMs: CACHE_TTL_MS, limit: CACHE_LIMIT, deadlineMs: SOURCE_DEADLINE_MS };
const rootsCache = new SearchRequestCache<ContractRoot[]>(cacheOptions);
const contractsCache = new SearchRequestCache<ContractInfo[]>(cacheOptions);
// Only a validated name is retained here; quotes and catalog identities stay
// with their existing sources. This fallback never enriches the stock catalog.
const stockNamesCache = new SearchRequestCache<string>(cacheOptions);
// Direct Info can change intraday. Share only the in-flight resolution, not
// successful values or 404s, and retain the typed identity in the key.
const directRequests = new SearchRequestCache<ContractInfo>({ ...cacheOptions, ttlMs: 0 });
let activeCatalogVersion = getProductCatalogVersion();
function currentCatalogVersion(): number {
    const version = getProductCatalogVersion();
    if (version !== activeCatalogVersion) {
        activeCatalogVersion = version;
        rootsCache.clear();
        contractsCache.clear();
        stockNamesCache.clear();
        directRequests.clear();
    }
    return version;
}
const unsubscribeCatalog = subscribeProductCatalog(() => { currentCatalogVersion(); });
if (import.meta.hot) import.meta.hot.dispose(unsubscribeCatalog);

// The catalog is a composite of two independently shared sources. Bound this
// search's wait for both with one deadline.
function withDeadline<T>(request: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason ?? new DOMException('aborted', 'AbortError'));
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(controller.signal.reason ?? new DOMException('aborted', 'AbortError'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new Error('商品資料來源回應逾時，請重試')), SOURCE_DEADLINE_MS);
    return Promise.race([Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException('aborted', 'AbortError');
        return request(controller.signal);
    }), aborted]).finally(() => {
        clearTimeout(timer);
        // If one catalog source fails early, release this composite's other
        // reader too. It must not outlive the search or cancel shared readers.
        controller.abort();
        signal?.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', onAbort);
    });
}

function asSuggestion(contract: ContractInfo, detail?: string): ProductSuggestion {
    return {
        code: contract.code,
        name: contract.name || contract.code,
        security_type: contract.security_type ?? 'STK',
        exchange: contract.exchange ?? '',
        detail: detail ?? contract.spec_kind ?? contract.root ?? contract.security_type ?? '',
        contract,
    };
}

function stockSuggestion(stock: StockMeta): ProductSuggestion {
    return { ...stock, security_type: 'STK', detail: stock.kind === 'ETF' ? 'ETF' : stock.category ? `股票 · ${stock.category}` : '股票' };
}

const isContinuousFuture = (row: { code: string }) => /R[12]$/.test(row.code);

// Explicit priority, independent of root letters or missing month metadata:
// near: regular → small → micro; then the same sizes in the next month.
function futureRank(row: ContractInfo, month: number) {
    const name = normalizeStockSearchText(row.name);
    // Weekly mini futures share the same underlying, but must not evict
    // the six regular/small/micro monthly identities.
    const weekly = !!row.week_of_month || /(?:^|\s)W\d+(?:\s|$)/.test(name);
    return (weekly ? 6 : 0) + month * 3 + (name.includes('微型') ? 2 : name.includes('小型') ? 1 : 0);
}

// One specification (TXF, MXF, TMF, or a stock's regular or small contract)
// lists only its near and next month. Keep the continuous identity and its
// full target metadata; fill a missing one with that specification's actual
// month, never with a second dated row for a covered contract.
function frontMonths(rows: ContractInfo[]): [ContractInfo, number][] {
    const near = rows.find(row => row.code.endsWith('R1'));
    const next = rows.find(row => row.code.endsWith('R2'));
    const covered = new Set([near?.target_code, next?.target_code]);
    const dated = rows.filter(row => !isContinuousFuture(row) && row.delivery_month && !covered.has(row.code))
        .sort((a, b) => a.delivery_month!.localeCompare(b.delivery_month!) || a.code.localeCompare(b.code));
    const nearRow = near ?? dated[0];
    const nearMonth = nearRow?.delivery_month ?? '';
    const nextRow = next ?? dated.find(row => row.delivery_month! > nearMonth);
    return [[nearRow, 0], [nextRow, 1]].filter((pair): pair is [ContractInfo, number] => !!pair[0]);
}

function orderedFutures(rows: ContractInfo[]) {
    const specs = new Map<string, ContractInfo[]>();
    for (const row of rows) {
        const key = `${row.exchange}:${row.root || row.code.slice(0, -2)}`;
        const group = specs.get(key);
        if (group) group.push(row);
        else specs.set(key, [row]);
    }
    // Never sort the shared source in place.
    return [...specs.values()].flatMap(frontMonths)
        .map(([row, month]) => ({ row, rank: futureRank(row, month) }))
        .sort((a, b) => a.rank - b.rank ||
            (a.row.delivery_month ?? '').localeCompare(b.row.delivery_month ?? '') ||
            a.row.code.localeCompare(b.row.code))
        .slice(0, 6).map(({ row }) => row);
}

const futureSuggestion = (row: ContractInfo) => asSuggestion(row,
    row.code.endsWith('R1') ? '期貨 · 近月' : row.code.endsWith('R2') ? '期貨 · 次月' : `期貨 · ${row.delivery_month ?? ''}`);

function matchingRoots(roots: ContractRoot[], lookup: string, raw: string) {
    return roots.filter((root) => normalizeStockSearchText(root.root) === lookup || normalizeStockSearchText(root.name).includes(lookup))
        .sort((a, b) => {
            const rank = (root: ContractRoot) => normalizeStockSearchText(root.root) === lookup ? 0 : normalizeStockSearchText(root.name) === raw ? 1 : 2;
            return rank(a) - rank(b) || a.name.length - b.name.length || a.root.localeCompare(b.root);
        }).slice(0, 4);
}

// Round-robin rather than concatenation keeps one product family from filling
// every slot (e.g. monthly options hiding weekly options, or warrants hiding futures).
function interleave<T>(groups: T[][], limit: number): T[] {
    const result: T[] = [];
    for (let i = 0; result.length < limit && groups.some((group) => i < group.length); i++) {
        for (const group of groups) {
            if (i < group.length) result.push(group[i]!);
            if (result.length === limit) break;
        }
    }
    return result;
}

function dateField(value?: string): string | undefined {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : undefined;
}

function currentWarrant(row: ContractInfo, day: string) {
    const expiry = dateField(row.expiry_date);
    const lastTrading = dateField(row.last_trading_date);
    return (!expiry || expiry >= day) && (!lastTrading || lastTrading >= day);
}

function warrantDateWarning(row: ContractInfo) {
    return !dateField(row.last_trading_date) || !dateField(row.expiry_date)
        ? ' · 交易日期待確認' : '';
}

/** What the typed text asks for, before any source is read. */
export interface ProductQuery {
    raw: string;
    lookup: string;
    exactIndex: boolean;
    wantsFutures: boolean;
    wantsOptions: boolean;
    wantsWarrants: boolean;
}

export function parseProductQuery(rawQuery: string): ProductQuery {
    const raw = normalizeStockSearchText(rawQuery);
    return {
        raw,
        lookup: raw.replace(/(?:權證|warrant|期貨|個股期|future|選擇權|option)/gi, '').replace(/期$/, '').trim() || raw,
        // Match the complete name before interpreting type words: an index such
        // as 臺指選擇權波動率指數 is not an option-contract query. Index codes use
        // the direct lookup, so a slow IND batch cannot hide them.
        exactIndex: indexSearchSuggestions(raw).some(row => normalizeStockSearchText(row.name) === raw),
        wantsFutures: /(?:期貨|個股期|future)/i.test(raw) || /期$/.test(raw),
        wantsOptions: /(?:選擇權|option)/i.test(raw),
        wantsWarrants: /(?:權證|warrant)/i.test(raw),
    };
}

export interface ProductAnchor {
    query: ProductQuery;
    /** The one stock whose related futures, options and warrants are listed. */
    exactStock?: StockMeta;
    indexFutureUnderlying?: string;
    /** Related futures lead; other matching stocks follow them. */
    futuresFirst: boolean;
}

export function pickAnchor(parsed: ProductQuery, catalog: StockMeta[], direct: ContractInfo | null): ProductAnchor {
    const { raw } = parsed;
    const matches = (value: string, target: string) => normalizeStockSearchText(value) === target;
    // Official fund names can themselves contain 「期貨」. An exact ETF
    // identity is not a request to strip that word and search futures roots.
    const exactEtfName = catalog.some(stock => stock.kind === 'ETF' &&
        (matches(stock.name, raw) || stock.aliases?.some(alias => matches(alias, raw))));
    const query = exactEtfName ? { ...parsed, lookup: raw, wantsFutures: false, wantsOptions: false } : parsed;
    const { lookup } = query;
    // These are verified names for the IX0001 family, not stock-name guesses.
    const indexFutureUnderlying = lookup === '台指' || lookup === '台股' ? 'IX0001' : undefined;
    const prefixMatches = indexFutureUnderlying ? [] : catalog.filter(stock =>
        !matches(stock.name, normalizeStockSearchText(stock.code)) && normalizeStockSearchText(stock.name).startsWith(lookup));
    const exactStock = catalog.find(stock => matches(stock.code, lookup) || matches(stock.name, lookup) ||
        stock.aliases?.some(alias => matches(alias, lookup))) ??
        (direct?.security_type === 'STK' ? { ...direct, category: direct.category ?? '', exchange: direct.exchange ?? '' } : undefined) ??
        (prefixMatches.length === 1 ? prefixMatches[0] : undefined);
    return { query, exactStock, indexFutureUnderlying, futuresFirst: !!exactStock || query.wantsFutures || !!indexFutureUnderlying };
}

/** Rows of each source. An omitted source is still loading. */
export interface ResultParts {
    priority: ProductSuggestion[];
    stocks: StockMeta[];
    futures?: ContractInfo[];
    options?: ProductSuggestion[];
    warrants?: ProductSuggestion[];
    indices?: ProductSuggestion[];
}

/**
 * The final order. Only the stable prefix before the first still-loading
 * source is returned, so every progressive result is a prefix of the last.
 */
export function orderResults(anchor: ProductAnchor, parts: ResultParts, limit: number): ProductSuggestion[] {
    const stocks = parts.stocks.map(stockSuggestion);
    let segments: (ProductSuggestion[] | undefined)[];
    if (anchor.query.wantsOptions || anchor.query.wantsWarrants) {
        const primary = anchor.query.wantsOptions ? parts.options : parts.warrants;
        segments = [parts.priority, primary && parts.indices && interleave([primary, parts.indices, stocks], limit * 3)];
    } else {
        // Same-prefix stocks (南亞科 for 南亞) follow the related futures, not
        // every warrant of the exact stock.
        segments = [
            parts.priority, anchor.futuresFirst ? [] : stocks,
            parts.futures && orderedFutures(parts.futures).map(futureSuggestion),
            anchor.futuresFirst ? stocks : [], parts.warrants, parts.indices,
        ];
    }
    const seen = new Set<string>();
    const rows: ProductSuggestion[] = [];
    for (const segment of segments) {
        if (!segment) break;
        for (const row of segment) {
            const key = `${row.security_type}:${row.exchange}:${row.code}`;
            if (seen.has(key)) continue;
            seen.add(key);
            rows.push(row);
        }
    }
    return rows.slice(0, limit);
}

interface ProductSearchOptions {
    includeWarrants?: boolean;
    signal?: AbortSignal;
    onUpdate?: (rows: ProductSuggestion[]) => void;
}

export async function searchProducts(
    rawQuery: string,
    limit = 10,
    options: ProductSearchOptions = {},
): Promise<ProductSuggestion[]> {
    // Own only this search's readers. A fatal branch failure must detach its
    // siblings without aborting a source still shared by another search.
    const controller = new AbortController();
    const { signal } = controller;
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
        const assertActive = () => {
            if (signal.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');
        };
        assertActive();
        const parsed = parseProductQuery(rawQuery);
        const { raw } = parsed;
        if (!raw || !Number.isFinite(limit) || limit < 1) return [];
        limit = Math.floor(limit);
        if (parsed.wantsWarrants && !options.includeWarrants) return [];
        const day = todayStr();
        // The epoch also advances when the API base or the Taiwan date changes.
        const version = currentCatalogVersion();
        const nameVersion = getProductNamesVersion();
        const assertServer = () => {
            if (getProductCatalogVersion() !== version) {
                throw new Error('商品搜尋期間伺服器已切換或商品目錄已更新，請重新搜尋');
            }
        };
        const assertScope = () => {
            assertActive();
            assertServer();
            if (getProductNamesVersion() !== nameVersion) throw new Error('商品搜尋期間名稱目錄已更新，請重新搜尋');
        };
        const failures: unknown[] = [];
        const read = async <T,>(request: () => Promise<T>, fallback: T, allowNotFound = false): Promise<T> => {
            try {
                assertScope();
                return await request();
            } catch (error) {
                assertScope();
                if (!allowNotFound || !error || typeof error !== 'object' || !('status' in error) || error.status !== 404) failures.push(error);
                return fallback;
            }
        };
        // Local names/aliases never establish availability. One shared live IND
        // Base query validates identities without fetching every index's Info.
        const indexRequest = read<ProductSuggestion[]>(() => loadIndexSuggestions(raw, { signal }), []);
        // Observe rejection immediately even while direct/catalog reads are waiting.
        // Only exact index queries must await this before publishing primary rows.
        const indexOutcome = indexRequest.then(rows => ({ rows }), error => {
            // A fatal background failure must stop this search's other readers
            // immediately, not wait for their individual source deadlines.
            controller.abort(error);
            return { error };
        });
        if (parsed.exactIndex) {
            const outcome = await indexOutcome;
            assertScope();
            if ('error' in outcome) throw outcome.error;
            if (!outcome.rows.length && failures.length) {
                throw new Error('指數目錄暫時無法載入，請稍後重試', { cause: failures[0] });
            }
            return outcome.rows.slice(0, limit);
        }
        const direct = /^[A-Z0-9]+$/.test(raw)
            ? await read(() => {
                const code = normalizeContractCode(raw, 'IND');
                const type = code !== raw ? 'IND' : undefined;
                return directRequests.read(JSON.stringify([version, code, type]), source => {
                    assertServer();
                    return resolveContract(code, type, { signal: source });
                }, signal);
            }, null as ContractInfo | null, true)
            : null;
        // A successful non-stock direct code is its own authoritative identity.
        // Unrelated stock-catalog loading must not delay it. A stock code still
        // lists same-prefix stocks (2881A, 2881B), and a legacy index alias (020)
        // still lists the codes it prefixes.
        const catalog = direct && direct.security_type !== 'STK' && direct.code === raw
            ? []
            : await read(() => withDeadline(source => loadStockCatalog({ signal: source }), signal), [] as StockMeta[]);
        assertScope();
        const anchor = pickAnchor(parsed, catalog, direct);
        const { exactStock, indexFutureUnderlying } = anchor;
        const { lookup, wantsFutures, wantsOptions, wantsWarrants } = anchor.query;
        const stockMatches = searchStocks(catalog, lookup, limit);
        const inScope = async <T,>(request: () => Promise<T>) => {
            // This closure belongs to a shared source, not its first consumer.
            // One consumer leaving must not fail the other readers of this entry.
            assertServer();
            const result = await request();
            assertServer();
            return result;
        };
        const roots = (kind: 'futures' | 'options') => read(() => rootsCache.read(JSON.stringify([version, kind]),
            source => inScope(() => kind === 'futures' ? fetchFuturesRoots({ signal: source }) : fetchOptionRoots({ signal: source })), signal), [] as ContractRoot[]);
        const contracts = (key: string, request: (source: AbortSignal) => Promise<ContractInfo[]>) =>
            read(() => contractsCache.read(JSON.stringify([version, key]), source => inScope(() => request(source)), signal), [] as ContractInfo[]);

        const loadFutures = async () => {
            if (wantsOptions || wantsWarrants || (direct && direct.security_type !== 'STK')) return [];
            const underlying = exactStock?.code ?? indexFutureUnderlying;
            if (underlying) {
                return (await contracts(`future-underlying:${underlying}`, source => fetchFutures({ underlyingCode: underlying }, { signal: source })))
                    .filter((row) => row.underlying_code === underlying);
            }
            const matches = matchingRoots(await roots('futures'), lookup, raw);
            const groups = await Promise.all(matches.map(root =>
                contracts(`future-root:${root.root}`, source => fetchFutures({ root: root.root }, { signal: source }))));
            return groups.flat();
        };
        const loadOptions = async () => {
            if (!wantsOptions) return [];
            const rootLookup = exactStock ? normalizeStockSearchText(exactStock.name) || lookup : lookup;
            const codeMatches = catalog.filter(stock => normalizeStockSearchText(stock.code) === lookup);
            const needsName = exactStock && codeMatches.length === 1 && codeMatches[0] === exactStock &&
                (!rootLookup || rootLookup === normalizeStockSearchText(exactStock.code)) &&
                ['TSE', 'OTC', 'OES'].includes(exactStock.exchange);
            const nameRequest = needsName
                ? read(() => stockNamesCache.read(JSON.stringify([version, 'STK', exactStock.exchange, exactStock.code]),
                    source => inScope(async () => {
                        const info = await fetchContractInfo(exactStock.code, 'STK', { signal: source });
                        if (!info || info.code !== exactStock.code || info.security_type !== 'STK' ||
                            info.exchange !== exactStock.exchange || info.region !== 'TW' ||
                            !info.name?.trim() || normalizeStockSearchText(info.name) === normalizeStockSearchText(info.code)) {
                            throw new Error('股票名稱查詢回傳身分或名稱不符');
                        }
                        return info.name;
                    }), signal), rootLookup)
                : Promise.resolve(rootLookup);
            // Start roots and the optional name together: a degraded source adds at
            // most one source deadline, rather than serial root/name waits.
            const [optionRoots, name] = await Promise.all([roots('options'), nameRequest]);
            assertScope();
            const matches = matchingRoots(optionRoots, normalizeStockSearchText(name), raw);
            return interleave(await Promise.all(matches.map(async (root) => {
                const rows = (await contracts(`option-root:${root.root}`, source => fetchOptions(root.root, {}, { signal: source })))
                    .filter((row) => !exactStock || row.underlying_code === exactStock.code);
                const frontMonth = rows.map((row) => row.delivery_month).filter((month): month is string => !!month).sort()[0];
                return rows.filter((row) => !frontMonth || row.delivery_month === frontMonth)
                    .sort((a, b) => (a.strike_price ?? 0) - (b.strike_price ?? 0) || a.code.localeCompare(b.code)).slice(0, 8);
            })), 8).map((row) => asSuggestion(row, `選擇權 · ${row.root ?? ''} · ${row.delivery_month ?? ''}`));
        };
        const loadWarrants = async () => {
            if (!exactStock || !options.includeWarrants || wantsFutures || wantsOptions) return [];
            return (await contracts(`warrant:${exactStock.code}`, source => fetchWarrants(exactStock.code, { expiryFrom: day }, { signal: source })))
                .filter((row) => row.name && row.underlying_code === exactStock.code && currentWarrant(row, day))
                .sort((a, b) => (a.expiry_date ?? '9999').localeCompare(b.expiry_date ?? '9999') || a.code.localeCompare(b.code)).slice(0, 8)
                .map((row) => asSuggestion(row,
                    `${row.call_put === 'P' ? '認售' : row.call_put === 'C' ? '認購' : '權證'} · ${row.expiry_date ?? ''}${warrantDateWarning(row)}`));
        };
        const priority: ProductSuggestion[] = [];
        if (direct && (direct.security_type !== 'WRT' || options.includeWarrants && currentWarrant(direct, day))) {
            const etf = direct.security_type === 'STK' && etfNameForLive(direct.code, direct.exchange ?? '');
            const suggestion = asSuggestion(direct, `${etf ? 'ETF · ' : ''}直接代碼${direct.security_type === 'WRT' ? warrantDateWarning(direct) : ''}`);
            if (direct.security_type === 'STK') {
                const display = stockDisplayMeta(direct.code, direct.exchange ?? '', direct.name);
                suggestion.name = display.name;
                if (display.kind) suggestion.kind = display.kind;
            }
            priority.push(suggestion);
        }
        if (exactStock) priority.push(stockSuggestion(exactStock));
        // Publish only stable prefixes. Even if warrants return first, do not
        // show them ahead of futures which are still loading.
        let published = 0;
        const publish = (parts: Omit<ResultParts, 'priority' | 'stocks'>) => {
            assertScope();
            const rows = orderResults(anchor, { priority, stocks: stockMatches, ...parts }, limit);
            if (options.onUpdate && rows.length > published) {
                published = rows.length;
                options.onUpdate(rows);
            }
        };
        publish({});
        const primaryRequest = Promise.all([loadFutures(), loadOptions()]).then(([futures, optionRows]) => {
            publish({ futures, options: optionRows });
            return [futures, optionRows] as const;
        });
        const [[futures, optionRows], warrants, indices] = await Promise.all([primaryRequest, loadWarrants(), indexOutcome]);
        assertScope();
        if ('error' in indices) throw indices.error;
        const result = orderResults(anchor, {
            priority, stocks: stockMatches, futures, options: optionRows, warrants, indices: indices.rows,
        }, limit);
        // A failed primary futures source must not pass a lone index as complete.
        if (failures.length && (!result.length || (wantsFutures || indexFutureUnderlying) && !futures.length)) {
            throw new Error('商品搜尋暫時無法完成，請稍後重試', { cause: failures[0] });
        }
        return result;
    } finally {
        options.signal?.removeEventListener('abort', abort);
        controller.abort();
    }
}
