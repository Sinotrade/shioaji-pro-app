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

export interface ProductSuggestion {
    code: string;
    name: string;
    security_type: Exclude<SecurityType, null>;
    exchange: string;
    detail: string;
    contract?: ContractInfo;
}

interface CachedRequest<T> {
    request: Promise<T>;
    expiresAt: number;
}
const CACHE_TTL_MS = 60_000;
const CACHE_LIMIT = 16;
const rootsCache = new Map<string, CachedRequest<ContractRoot[]>>();
const contractsCache = new Map<string, CachedRequest<ContractInfo[]>>();

// A search often revisits the same underlying via its name, code and type
// suffix. Share pending requests, cache successes briefly and retry failures.
function cached<T>(
    cache: Map<string, CachedRequest<T>>,
    scope: string,
    query: string,
    load: () => Promise<T>,
): Promise<T> {
    const key = JSON.stringify([scope, query]);
    const found = cache.get(key);
    if (found && found.expiresAt > Date.now()) {
        cache.delete(key);
        cache.set(key, found);
        return found.request;
    }
    cache.delete(key);
    const entry: CachedRequest<T> = { request: Promise.resolve().then(load), expiresAt: Infinity };
    entry.request = entry.request.then((value) => {
        entry.expiresAt = Date.now() + CACHE_TTL_MS;
        return value;
    }, (error) => {
        if (cache.get(key) === entry) cache.delete(key);
        throw error;
    });
    cache.set(key, entry);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    return entry.request;
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
    return { ...stock, security_type: 'STK', detail: stock.category ? `股票 · ${stock.category}` : '股票' };
}

function derivativeSort(a: ContractInfo, b: ContractInfo) {
    const aliasA = /R[12]$/.test(a.code) ? 0 : 1;
    const aliasB = /R[12]$/.test(b.code) ? 0 : 1;
    return aliasA - aliasB ||
        (a.delivery_month ?? '').localeCompare(b.delivery_month ?? '') ||
        a.code.localeCompare(b.code);
}

function normalizeSearchText(value: string) {
    return value.trim().replace(/臺/g, '台').toUpperCase();
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
    return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
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
    options: { includeWarrants?: boolean } = {},
): Promise<ProductSuggestion[]> {
    const raw = normalizeSearchText(rawQuery);
    if (!raw || !Number.isFinite(limit) || limit < 1) return [];
    limit = Math.floor(limit);
    // Match the complete name before interpreting type words: an index such
    // as 臺指選擇權波動率指數 is not an option-contract query.
    const indexSuggestions = indexSearchSuggestions(raw);
    const exactIndex = indexSuggestions.find((row) => normalizeSearchText(row.name) === raw || row.code === normalizeContractCode(raw, 'IND'));
    const wantsWarrants = !exactIndex && /(?:權證|warrant)/i.test(raw);
    if (wantsWarrants && !options.includeWarrants) return [];
    const wantsFutures = !exactIndex && (/(?:期貨|個股期|future)/i.test(raw) || /期$/.test(raw));
    const wantsOptions = !exactIndex && /(?:選擇權|option)/i.test(raw);
    const lookup = exactIndex ? raw : raw.replace(/(?:權證|warrant|期貨|個股期|future|選擇權|option)/gi, '').replace(/期$/, '').trim() || raw;
    const day = todayStr();
    const base = getApiBase();
    const scope = JSON.stringify([base, day]);
    const failures: unknown[] = [];
    const read = async <T,>(request: () => Promise<T>, fallback: T, allowNotFound = false): Promise<T> => {
        try {
            return await request();
        } catch (error) {
            if (!allowNotFound || !error || typeof error !== 'object' || !('status' in error) || error.status !== 404) failures.push(error);
            return fallback;
        }
    };
    const [catalog, direct] = await Promise.all([
        read(loadStockCatalog, [] as StockMeta[]),
        /^[A-Z0-9]+$/.test(raw)
            ? read(() => {
                const code = normalizeContractCode(raw, 'IND');
                return resolveContract(code, code !== raw ? 'IND' : undefined);
            }, null as ContractInfo | null, true)
            : Promise.resolve(null),
    ]);
    const stockMatches = searchStocks(catalog, lookup, limit);
    const exactStock = catalog.find((stock) => normalizeSearchText(stock.code) === lookup || normalizeSearchText(stock.name) === lookup) ??
        (direct?.security_type === 'STK' ? { ...direct, category: direct.category ?? '', exchange: direct.exchange ?? '' } : undefined);
    const inScope = async <T,>(request: () => Promise<T>) => {
        if (getApiBase() !== base) throw new Error('商品搜尋期間伺服器已切換，請重新搜尋');
        const result = await request();
        if (getApiBase() !== base) throw new Error('商品搜尋期間伺服器已切換，請重新搜尋');
        return result;
    };
    const roots = (kind: 'futures' | 'options') => read(() => cached(rootsCache, scope, kind,
        () => inScope(kind === 'futures' ? fetchFuturesRoots : fetchOptionRoots)), [] as ContractRoot[]);
    const contracts = (key: string, request: () => Promise<ContractInfo[]>) =>
        read(() => cached(contractsCache, scope, key, () => inScope(request)), [] as ContractInfo[]);

    const loadFutures = async () => {
        if (exactIndex || wantsOptions || wantsWarrants) return [];
        if (exactStock) {
            return (await contracts(`future-underlying:${exactStock.code}`, () => fetchFutures({ underlyingCode: exactStock.code })))
                .filter((row) => row.underlying_code === exactStock.code).sort(derivativeSort).slice(0, 6);
        }
        const matches = matchingRoots(await roots('futures'), lookup, raw);
        return interleave(await Promise.all(matches.map(async (root) =>
            (await contracts(`future-root:${root.root}`, () => fetchFutures({ root: root.root }))).sort(derivativeSort).slice(0, 6))), 6);
    };
    const loadOptions = async () => {
        if (!wantsOptions) return [];
        const rootLookup = exactStock ? normalizeSearchText(exactStock.name) : lookup;
        const matches = matchingRoots(await roots('options'), rootLookup, raw);
        return interleave(await Promise.all(matches.map(async (root) => {
            const rows = (await contracts(`option-root:${root.root}`, () => fetchOptions(root.root)))
                .filter((row) => !exactStock || row.underlying_code === exactStock.code);
            const frontMonth = rows.map((row) => row.delivery_month).filter((month): month is string => !!month).sort()[0];
            return rows.filter((row) => !frontMonth || row.delivery_month === frontMonth)
                .sort((a, b) => (a.strike_price ?? 0) - (b.strike_price ?? 0) || a.code.localeCompare(b.code)).slice(0, 8);
        })), 8);
    };
    const loadWarrants = async () => {
        if (!exactStock || !options.includeWarrants || wantsFutures || wantsOptions) return [];
        return (await contracts(`warrant:${exactStock.code}`, () => fetchWarrants(exactStock.code, { expiryFrom: day })))
            .filter((row) => row.name && row.underlying_code === exactStock.code && currentWarrant(row, day))
            .sort((a, b) => (a.expiry_date ?? '9999').localeCompare(b.expiry_date ?? '9999') || a.code.localeCompare(b.code)).slice(0, 8);
    };
    const [futures, optionRows, warrants] = await Promise.all([loadFutures(), loadOptions(), loadWarrants()]);
    if (getApiBase() !== base) throw new Error('商品搜尋期間伺服器已切換，請重新搜尋');

    const futureSuggestions = futures.map((row) => asSuggestion(row, row.code.endsWith('R1') ? '期貨 · 近月' : row.code.endsWith('R2') ? '期貨 · 次月' : `期貨 · ${row.delivery_month ?? ''}`));
    const optionSuggestions = optionRows.map((row) => asSuggestion(row, `選擇權 · ${row.root ?? ''} · ${row.delivery_month ?? ''}`));
    const warrantSuggestions = warrants.map((row) => asSuggestion(row,
        `${row.call_put === 'P' ? '認售' : row.call_put === 'C' ? '認購' : '權證'} · ${row.expiry_date ?? ''}${warrantDateWarning(row)}`));
    const priority: ProductSuggestion[] = [];
    if (direct && (direct.security_type !== 'WRT' || options.includeWarrants && currentWarrant(direct, day))) {
        priority.push(asSuggestion(direct, `直接代碼${direct.security_type === 'WRT' ? warrantDateWarning(direct) : ''}`));
    }
    if (exactIndex) priority.push(exactIndex);
    if (exactStock) priority.push(stockSuggestion(exactStock));
    const groups = wantsOptions ? [optionSuggestions, indexSuggestions, stockMatches.map(stockSuggestion)] : wantsWarrants
        ? [warrantSuggestions, indexSuggestions, stockMatches.map(stockSuggestion)]
        : [futureSuggestions, warrantSuggestions, indexSuggestions, stockMatches.map(stockSuggestion)];
    const seen = new Set<string>();
    const result = [...priority, ...interleave(groups, limit * groups.length)].filter((row) => {
        const key = `${row.security_type}:${row.exchange}:${row.code}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, limit);
    if (!result.length && failures.length) throw new Error('商品搜尋暫時無法完成，請稍後重試', { cause: failures[0] });
    return result;
}
