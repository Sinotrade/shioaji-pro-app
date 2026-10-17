import {
    fetchFutures,
    fetchFuturesRoots,
    fetchOptionRoots,
    fetchOptions,
    fetchWarrants,
    normalizeContractCode,
    resolveContract,
    type ContractRoot,
} from './shioaji';
import { loadStockCatalog, searchStocks, type StockMeta } from './stock-index';
import { indexSearchSuggestions } from './index-search';
import { getApiBase } from './runtime';
import { todayStr } from './utils/date';
import type { ContractInfo, SecurityType } from './types/contract';
import { etfNameFor } from './etf-catalog';
import { SearchRequestCache } from './search-request';

export interface ProductSuggestion {
    code: string;
    name: string;
    security_type: Exclude<SecurityType, null>;
    exchange: string;
    detail: string;
    contract?: ContractInfo;
}

const CACHE_TTL_MS = 60_000;
const CACHE_LIMIT = 16;
const SOURCE_DEADLINE_MS = 1200;
const cacheOptions = { ttlMs: CACHE_TTL_MS, limit: CACHE_LIMIT, deadlineMs: SOURCE_DEADLINE_MS };
const rootsCache = new SearchRequestCache<ContractRoot[]>(cacheOptions);
const contractsCache = new SearchRequestCache<ContractInfo[]>(cacheOptions);
// Direct Info can change intraday. Share only the in-flight resolution, not
// successful values or 404s, and retain the typed identity in the key.
const directRequests = new SearchRequestCache<ContractInfo>({ ...cacheOptions, ttlMs: 0 });

// The catalog is a composite of two independently shared sources. Do not
// occupy a request slot while waiting for those sources to acquire theirs.
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

function derivativeSort(a: ContractInfo, b: ContractInfo) {
    // Explicit priority, independent of root letters or missing month metadata:
    // near: regular → small → micro; then the same sizes in the next month.
    const rank = (row: ContractInfo) => {
        const month = row.code.endsWith('R1') ? 0 : row.code.endsWith('R2') ? 1 : -1;
        if (month < 0) return 12;
        const name = normalizeSearchText(row.name);
        // Weekly mini futures share the same underlying, but must not evict
        // the six regular/small/micro monthly continuous identities.
        const weekly = !!row.week_of_month || /(?:^|\s)W\d+(?:\s|$)/.test(name);
        return (weekly ? 6 : 0) + month * 3 + (name.includes('微型') ? 2 : name.includes('小型') ? 1 : 0);
    };
    return rank(a) - rank(b) ||
        (a.delivery_month ?? '').localeCompare(b.delivery_month ?? '') ||
        a.code.localeCompare(b.code);
}

const isContinuousFuture = (row: { code: string }) => /R[12]$/.test(row.code);

function orderedFutures(rows: ContractInfo[]) {
    const covered = new Set(rows.filter(isContinuousFuture).filter(row => row.target_code)
        .map(row => `${row.exchange}:${row.target_code}`));
    // Keep the continuous identity and its full target metadata, not a second
    // dated row for the same contract. Never sort the shared source in place.
    return rows.filter(row => isContinuousFuture(row) || !covered.has(`${row.exchange}:${row.code}`))
        .sort(derivativeSort).slice(0, 6);
}

function normalizeSearchText(value: string) {
    return value.trim().normalize('NFKC').replace(/臺/g, '台').toUpperCase();
}

function matchingRoots(roots: ContractRoot[], lookup: string, raw: string) {
    return roots.filter((root) => normalizeSearchText(root.root) === lookup || normalizeSearchText(root.name).includes(lookup))
        .sort((a, b) => {
            const rank = (root: ContractRoot) => normalizeSearchText(root.root) === lookup ? 0 : normalizeSearchText(root.name) === raw ? 1 : 2;
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

export async function searchProducts(
    rawQuery: string,
    limit = 10,
    options: {
        includeWarrants?: boolean;
        signal?: AbortSignal;
        onUpdate?: (rows: ProductSuggestion[]) => void;
    } = {},
): Promise<ProductSuggestion[]> {
    const assertActive = () => {
        if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('aborted', 'AbortError');
    };
    assertActive();
    const raw = normalizeSearchText(rawQuery);
    if (!raw || !Number.isFinite(limit) || limit < 1) return [];
    limit = Math.floor(limit);
    // Match the complete name before interpreting type words: an index such
    // as 臺指選擇權波動率指數 is not an option-contract query.
    const indexSuggestions = indexSearchSuggestions(raw);
    const exactIndex = indexSuggestions.find((row) => normalizeSearchText(row.name) === raw || row.code === normalizeContractCode(raw, 'IND'));
    // Static identities are already sufficient for typed selection; the
    // consumer obtains fresh Info on selection rather than waiting for STK.
    if (exactIndex) return [exactIndex, ...indexSuggestions.filter(row => row.code !== exactIndex.code)].slice(0, limit);
    const wantsWarrants = /(?:權證|warrant)/i.test(raw);
    if (wantsWarrants && !options.includeWarrants) return [];
    let wantsFutures = /(?:期貨|個股期|future)/i.test(raw) || /期$/.test(raw);
    let wantsOptions = /(?:選擇權|option)/i.test(raw);
    let lookup = raw.replace(/(?:權證|warrant|期貨|個股期|future|選擇權|option)/gi, '').replace(/期$/, '').trim() || raw;
    const day = todayStr();
    const base = getApiBase();
    const scope = JSON.stringify([base, day]);
    const assertServer = () => {
        if (getApiBase() !== base) throw new Error('商品搜尋期間伺服器已切換，請重新搜尋');
    };
    const assertScope = () => {
        assertActive();
        assertServer();
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
    const direct = /^[A-Z0-9]+$/.test(raw)
        ? await read(() => {
            const code = normalizeContractCode(raw, 'IND');
            const type = code !== raw ? 'IND' : undefined;
            return directRequests.read(JSON.stringify([scope, code, type]), signal => {
                assertServer();
                return resolveContract(code, type, { signal });
            }, options.signal);
        }, null as ContractInfo | null, true)
        : null;
    // A successful direct lookup is its own authoritative identity/name.
    // Unrelated stock-catalog loading must not delay it or its related search.
    const catalog = direct ? [] : await read(() => withDeadline(signal => loadStockCatalog({ signal }), options.signal), [] as StockMeta[]);
    assertScope();
    // Official fund names can themselves contain 「期貨」. An exact ETF
    // identity is not a request to strip that word and search futures roots.
    const exactEtfName = catalog.find(stock => stock.kind === 'ETF' &&
        (normalizeSearchText(stock.name) === raw || stock.aliases?.some(alias => normalizeSearchText(alias) === raw)));
    if (exactEtfName) {
        lookup = raw;
        wantsFutures = false;
        wantsOptions = false;
    }
    const stockMatches = searchStocks(catalog, lookup, limit);
    // These are verified names for the IX0001 family, not stock-name guesses.
    const indexFutureUnderlying = lookup === '台指' || lookup === '台股' ? 'IX0001' : undefined;
    const prefixMatches = indexFutureUnderlying ? [] : catalog.filter(stock =>
        normalizeSearchText(stock.name) !== normalizeSearchText(stock.code) && normalizeSearchText(stock.name).startsWith(lookup));
    const exactStock = catalog.find((stock) => normalizeSearchText(stock.code) === lookup || normalizeSearchText(stock.name) === lookup || stock.aliases?.some(alias => normalizeSearchText(alias) === lookup)) ??
        (direct?.security_type === 'STK' ? { ...direct, category: direct.category ?? '', exchange: direct.exchange ?? '' } : undefined) ??
        (prefixMatches.length === 1 ? prefixMatches[0] : undefined);
    const inScope = async <T,>(request: () => Promise<T>) => {
        // This closure belongs to a shared source, not its first consumer.
        // One consumer leaving must not fail the other readers of this entry.
        assertServer();
        const result = await request();
        assertServer();
        return result;
    };
    const roots = (kind: 'futures' | 'options') => read(() => rootsCache.read(JSON.stringify([scope, kind]),
        signal => inScope(() => kind === 'futures' ? fetchFuturesRoots({ signal }) : fetchOptionRoots({ signal })), options.signal), [] as ContractRoot[]);
    const contracts = (key: string, request: (signal: AbortSignal) => Promise<ContractInfo[]>) =>
        read(() => contractsCache.read(JSON.stringify([scope, key]), signal => inScope(() => request(signal)), options.signal), [] as ContractInfo[]);

    const loadFutures = async () => {
        if (wantsOptions || wantsWarrants || (direct && direct.security_type !== 'STK')) return [];
        const underlying = exactStock?.code ?? indexFutureUnderlying;
        if (underlying) {
            return orderedFutures((await contracts(`future-underlying:${underlying}`, signal => fetchFutures({ underlyingCode: underlying }, { signal })))
                .filter((row) => row.underlying_code === underlying));
        }
        const matches = matchingRoots(await roots('futures'), lookup, raw);
        const groups = await Promise.all(matches.map(async (root) =>
            orderedFutures(await contracts(`future-root:${root.root}`, signal => fetchFutures({ root: root.root }, { signal })))));
        return orderedFutures(groups.flat());
    };
    const loadOptions = async () => {
        if (!wantsOptions) return [];
        const rootLookup = exactStock ? normalizeSearchText(exactStock.name) : lookup;
        const matches = matchingRoots(await roots('options'), rootLookup, raw);
        return interleave(await Promise.all(matches.map(async (root) => {
            const rows = (await contracts(`option-root:${root.root}`, signal => fetchOptions(root.root, {}, { signal })))
                .filter((row) => !exactStock || row.underlying_code === exactStock.code);
            const frontMonth = rows.map((row) => row.delivery_month).filter((month): month is string => !!month).sort()[0];
            return rows.filter((row) => !frontMonth || row.delivery_month === frontMonth)
                .sort((a, b) => (a.strike_price ?? 0) - (b.strike_price ?? 0) || a.code.localeCompare(b.code)).slice(0, 8);
        })), 8);
    };
    const loadWarrants = async () => {
        if (!exactStock || !options.includeWarrants || wantsFutures || wantsOptions) return [];
        return (await contracts(`warrant:${exactStock.code}`, signal => fetchWarrants(exactStock.code, { expiryFrom: day }, { signal })))
            .filter((row) => row.name && row.underlying_code === exactStock.code && currentWarrant(row, day))
            .sort((a, b) => (a.expiry_date ?? '9999').localeCompare(b.expiry_date ?? '9999') || a.code.localeCompare(b.code)).slice(0, 8);
    };
    const priority: ProductSuggestion[] = [];
    if (direct && (direct.security_type !== 'WRT' || options.includeWarrants && currentWarrant(direct, day))) {
        const etf = direct.security_type === 'STK' && etfNameFor(direct.code, direct.exchange ?? '');
        priority.push(asSuggestion(direct, `${etf ? 'ETF · ' : ''}直接代碼${direct.security_type === 'WRT' ? warrantDateWarning(direct) : ''}`));
    }
    if (exactStock) priority.push(stockSuggestion(exactStock));
    const futuresFirst = !!exactStock || wantsFutures || !!indexFutureUnderlying;
    const leadingStocks = !wantsOptions && !wantsWarrants && !futuresFirst ? stockMatches.map(stockSuggestion) : [];
    const unique = (rows: ProductSuggestion[]) => {
        const seen = new Set<string>();
        return rows.filter(row => {
            const key = `${row.security_type}:${row.exchange}:${row.code}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        }).slice(0, limit);
    };
    const publish = (rows: ProductSuggestion[]) => {
        assertScope();
        if (options.onUpdate && rows.length) options.onUpdate(unique(rows));
    };
    const futureRows = (rows: ContractInfo[]) => rows.map(row => asSuggestion(row,
        row.code.endsWith('R1') ? '期貨 · 近月' : row.code.endsWith('R2') ? '期貨 · 次月' : `期貨 · ${row.delivery_month ?? ''}`));
    // Publish only stable prefixes. Even if warrants return first, do not show
    // them ahead of futures which are still loading. Lower-priority dated
    // contracts and other matches wait for the complete, original ordering.
    publish([...priority, ...leadingStocks]);
    const primaryRequest = Promise.all([loadFutures(), loadOptions()]).then(([futures, optionRows]) => {
        const suggestions = futureRows(futures);
        const continuous = suggestions.filter(isContinuousFuture);
        if (!wantsOptions && !wantsWarrants) publish([...priority, ...leadingStocks,
            ...(continuous.length ? continuous : suggestions)]);
        return [futures, optionRows] as const;
    });
    const [[futures, optionRows], warrants] = await Promise.all([primaryRequest, loadWarrants()]);
    assertScope();

    const futureSuggestions = futureRows(futures);
    const optionSuggestions = optionRows.map((row) => asSuggestion(row, `選擇權 · ${row.root ?? ''} · ${row.delivery_month ?? ''}`));
    const warrantSuggestions = warrants.map((row) => asSuggestion(row,
        `${row.call_put === 'P' ? '認售' : row.call_put === 'C' ? '認購' : '權證'} · ${row.expiry_date ?? ''}${warrantDateWarning(row)}`));
    const continuous = futureSuggestions.filter(isContinuousFuture);
    const primaryFutures = continuous.length ? continuous : futureSuggestions;
    const additionalFutures = continuous.length ? futureSuggestions.filter(row => !isContinuousFuture(row)) : [];
    const groups = wantsOptions ? [optionSuggestions, indexSuggestions, stockMatches.map(stockSuggestion)] : wantsWarrants
        ? [warrantSuggestions, indexSuggestions, stockMatches.map(stockSuggestion)]
        : [futureSuggestions, warrantSuggestions, indexSuggestions, stockMatches.map(stockSuggestion)];
    const remainder = wantsOptions || wantsWarrants ? interleave(groups, limit * groups.length) : [
        ...(futuresFirst ? [] : stockMatches.map(stockSuggestion)),
        ...primaryFutures, ...warrantSuggestions, ...indexSuggestions,
        ...(futuresFirst ? stockMatches.map(stockSuggestion) : []), ...additionalFutures,
    ];
    const result = unique([...priority, ...remainder]);
    if (!result.length && failures.length) throw new Error('商品搜尋暫時無法完成，請稍後重試', { cause: failures[0] });
    return result;
}
