// src/lib/stock-index.ts — Contract V2 stock catalog and optional typed info.
// Base records stay lightweight; full StockInfo is loaded only by screens that
// genuinely need category/rule fields (for example the sector heatmap).

import {
    fetchContractInfo,
    fetchContracts,
    fetchWarrantUnderlyings,
} from './shioaji';
import { getApiBase } from './runtime';
import { todayStr } from './utils/date';
import { etfNameForLive, getEtfNamesStatus, getEtfNamesVersion, refreshEtfNames } from './etf-runtime-catalog';
import { equityNameForLive, ensureEquityNamesFresh, getEquityNamesVersion } from './stock-runtime-catalog';
import { SearchRequestCache } from './search-request';
import { getProductCatalogVersion, subscribeProductCatalog } from './product-catalog-version';

export interface StockMeta {
    code: string;
    name: string;
    category: string;
    exchange: string;
    day_trade?: string;
    kind?: 'ETF';
    aliases?: string[];
}

// Both name searches and direct codes use the same display policy. The broker
// ContractInfo object remains untouched; aliases never establish availability.
export function stockDisplayMeta(code: string, exchange: string, brokerName?: string,
    officialNamesReady = !getEtfNamesStatus().usingSnapshot): Pick<StockMeta, 'name' | 'kind' | 'aliases'> {
    const etf = etfNameForLive(code, exchange);
    const name = brokerName && brokerName !== code ? brokerName : undefined;
    if (!etf) {
        const official = /^[1-9]\d{3}$/.test(code) && (exchange === 'TSE' || exchange === 'OTC' || exchange === 'OES')
            ? equityNameForLive(exchange, code) : undefined;
        if (!official) return { name: name ?? code };
        return { name: official.name, aliases: [...new Set([...official.aliases, ...(name ? [name] : [])])]
            .filter(alias => alias !== official.name) };
    }
    return {
        name: officialNamesReady ? etf.name : name ?? etf.name,
        kind: 'ETF',
        aliases: [...new Set([etf.name, ...(etf.aliases ?? []), ...(name ? [name] : [])])],
    };
}

const CATALOG_TTL_MS = 60_000;
const CATALOG_DEADLINE_MS = 1000;
// These two shared sources also serve non-search panels. Keep their existing
// deadlines independent of search saturation; each still has one in-flight
// request per scope and independent readers.
const sourceOptions = { ttlMs: CATALOG_TTL_MS, limit: 2, deadlineMs: CATALOG_DEADLINE_MS, queue: 'none' as const };
const baseCache = new SearchRequestCache<Awaited<ReturnType<typeof fetchContracts>>>(sourceOptions);
const namesCache = new SearchRequestCache<Awaited<ReturnType<typeof fetchWarrantUnderlyings>>>(sourceOptions);
let activeSourceScope = '';
let catalogGeneration = 0;
let detailsCache: StockMeta[] | null = null;
let detailsExpiresAt = 0;
let detailsCatalog: StockMeta[] | undefined;
let detailsLoading: Promise<StockMeta[]> | null = null;
let detailsScope = '';
const detailByCode = new Map<string, { value: StockMeta; expiresAt: number }>();
const detailLoadingByCode = new Map<string, Promise<StockMeta | null>>();
let assembledCatalog: {
    scope: string;
    base: Awaited<ReturnType<typeof fetchContracts>>;
    names: Awaited<ReturnType<typeof fetchWarrantUnderlyings>>;
    namesVersion: string;
    rows: StockMeta[];
} | undefined;

const catalogScope = () => JSON.stringify([getApiBase(), todayStr(), getProductCatalogVersion()]);
const detailContext = () => JSON.stringify([catalogScope(), catalogGeneration]);

function ensureSourceScope() {
    const scope = catalogScope();
    if (scope !== activeSourceScope) {
        activeSourceScope = scope;
        catalogGeneration += 1;
        baseCache.clear();
        namesCache.clear();
        assembledCatalog = undefined;
        detailsCache = null;
        detailsExpiresAt = 0;
        detailsCatalog = undefined;
        detailsLoading = null;
        detailsScope = '';
        detailByCode.clear();
        detailLoadingByCode.clear();
    }
    return scope;
}

// Contract events invalidate all metadata immediately, including typed Info.
// A lazy scope read may already have moved this cache before its deferred
// notification; ensureSourceScope then deliberately does nothing a second time.
const unsubscribeCatalog = subscribeProductCatalog(() => { ensureSourceScope(); });
if (import.meta.hot) import.meta.hot.dispose(unsubscribeCatalog);

export async function loadStockCatalog(opts?: { signal?: AbortSignal }): Promise<StockMeta[]> {
    const scope = ensureSourceScope();
    // Public name refresh belongs to the mounted App, not to a keystroke's
    // cancellation. SSR callers can explicitly refresh; catalog reads stay local.
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        void refreshEtfNames();
        ensureEquityNamesFresh();
    }
    const generation = catalogGeneration;
    const assertScope = () => {
        if (catalogScope() !== scope || catalogGeneration !== generation) throw new Error('股票目錄載入期間伺服器已切換');
    };
    const [res, underlyings] = await Promise.all([
        baseCache.read(scope, signal => {
            assertScope();
            return fetchContracts('STK', undefined, undefined, { signal });
        }, opts?.signal),
        // Optional names may fail without hiding supported Base identities.
        // Failure is not cached: the next search retries names, not Base.
        namesCache.read(scope, signal => {
            assertScope();
            return fetchWarrantUnderlyings({ signal });
        }, opts?.signal).catch(error => {
            if (opts?.signal?.aborted) throw error;
            return [];
        }),
    ]).catch(error => {
        assertScope();
        throw error;
    });
    assertScope();
    const namesVersion = `${getEtfNamesVersion()}:${getEquityNamesVersion()}`;
    if (assembledCatalog?.scope === scope && assembledCatalog.base === res && assembledCatalog.names === underlyings
        && assembledCatalog.namesVersion === namesVersion) {
        return assembledCatalog.rows;
    }
    const names = new Map(underlyings.filter(row => row.name).map(row => [row.underlying_code, row.name!]));
    const officialNamesReady = !getEtfNamesStatus().usingSnapshot;
    const rows = res.contracts.filter(c => c.code).map(c => {
        const exchange = c.exchange ?? '';
        const brokerName = names.get(c.code);
        return {
            code: c.code,
            ...stockDisplayMeta(c.code, exchange, brokerName, officialNamesReady),
            category: '',
            exchange,
        };
    });
    assembledCatalog = { scope, base: res, names: underlyings, namesVersion, rows };
    return rows;
}

function ensureDetailsScope() {
    ensureSourceScope();
    const scope = detailContext();
    if (scope !== detailsScope) {
        detailsScope = scope;
        detailsCache = null;
        detailsExpiresAt = 0;
        detailsCatalog = undefined;
        detailsLoading = null;
        detailByCode.clear();
        detailLoadingByCode.clear();
    }
    return scope;
}

// 個股明細請求的並行上限：熱力圖一次可能要 400+ 檔名稱，原生 fallback
// transport 沒有自己的並行限制，不設上限會一口氣送出數百個請求
export const DETAIL_CONCURRENCY = 6;
let detailActive = 0;
const detailQueue: (() => void)[] = [];

function limitDetail<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const run = () => {
            detailActive += 1;
            task()
                .then(resolve, reject)
                .finally(() => {
                    detailActive -= 1;
                    detailQueue.shift()?.();
                });
        };
        if (detailActive < DETAIL_CONCURRENCY) run();
        else detailQueue.push(run);
    });
}

export async function loadStockDetails(codes: string[]): Promise<StockMeta[]> {
    const scope = ensureDetailsScope();
    const unique = [...new Set(codes.filter(Boolean))];
    const load = (code: string) => {
        const cached = detailByCode.get(code);
        if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
        detailByCode.delete(code);
        const pending = detailLoadingByCode.get(code);
        if (pending) return pending;
        const request = limitDetail(() => fetchContractInfo(code, 'STK'))
            .then((info) => {
                if (detailContext() !== scope) return null;
                const detail: StockMeta = {
                    code: info.code,
                    name: info.name,
                    category: info.category,
                    exchange: info.exchange ?? '',
                    day_trade: info.day_trade,
                };
                detailByCode.set(code, { value: detail, expiresAt: Date.now() + CATALOG_TTL_MS });
                return detail;
            })
            .catch(() => null)
            .finally(() => {
                if (detailLoadingByCode.get(code) === request) detailLoadingByCode.delete(code);
            });
        detailLoadingByCode.set(code, request);
        return request;
    };
    const rows = await Promise.all(unique.map(load));
    return rows.filter(
        (detail): detail is StockMeta => detail !== null,
    );
}

export function loadStockIndex(): Promise<StockMeta[]> {
    const scope = ensureDetailsScope();
    if (detailsLoading) return detailsLoading;
    const request = loadStockCatalog()
        .then(async (catalog) => {
            if (detailContext() !== scope) throw new Error('股票目錄載入期間伺服器已切換');
            // Do not let this aggregate cache extend an older Base/name TTL.
            if (detailsCatalog === catalog && detailsCache && detailsExpiresAt > Date.now()) return detailsCache;
            const details = await loadStockDetails(catalog.map((stock) => stock.code));
            if (detailContext() !== scope) throw new Error('股票目錄載入期間伺服器已切換');
            // Partial metadata is returned but retried next time.
            if (details.length >= new Set(catalog.map((stock) => stock.code).filter(Boolean)).size) {
                detailsCache = details;
                detailsCatalog = catalog;
                // Info cached before assembly keeps its original expiry.
                detailsExpiresAt = details.reduce((expiry, detail) => Math.min(
                    expiry, detailByCode.get(detail.code)?.expiresAt ?? Date.now(),
                ), Date.now() + CATALOG_TTL_MS);
            }
            return details;
        }).finally(() => {
            if (detailsLoading === request) detailsLoading = null;
        });
    detailsLoading = request;
    return request;
}

// 只有 ASCII 大寫、數字，以及 U+4E00..U+9FFF（排除「臺」U+81FA）是原鏈的 fixed point，可原樣回傳。
// 其餘字元（換行、control、空白、combining、相容字、surrogate 等）一律完整走原鏈。
// 不用 ^/$ 錨點，也不加 g/y/m flag，讓 test() 保持無狀態。
const nonFixedPointStockChar = /[^A-Z0-9\u4E00-\u81F9\u81FB-\u9FFF]/;
const taiVariant = /\u81FA/g;

export function normalizeStockSearchText(value: string): string {
    if (!nonFixedPointStockChar.test(value)) return value;
    return value.trim().normalize('NFKC').replace(taiVariant, '\u53F0').toUpperCase();
}

// substring match on name, prefix match on code — ranked so the actual
// stock beats its thousands of warrants (台積電 before 台積電XX購YY)
export function searchStocks(
    index: StockMeta[],
    query: string,
    limit = 8,
): StockMeta[] {
    const q = normalizeStockSearchText(query);
    if (!q) return [];
    const numericQuery = /^\d+$/.test(q);
    const scored: { s: StockMeta; code: string; score: number; rank: number; letterSuffix: boolean }[] = [];
    for (const s of index) {
        const code = normalizeStockSearchText(s.code);
        const name = s.name === s.code ? code : normalizeStockSearchText(s.name);
        const codeHit = code.startsWith(q);
        let nameHit = name.includes(q);
        let exact = code === q || name === q;
        if (!exact) s.aliases?.some(alias => {
            const normalized = alias === s.name ? name : alias === s.code ? code : normalizeStockSearchText(alias);
            if (normalized === q) {
                exact = true;
                nameHit = true;
                return true;
            }
            // A substring hit must not hide a later alias with the exact-match bonus.
            if (!nameHit) nameHit = normalized.includes(q);
            return false;
        });
        if (!codeHit && !nameHit) continue;
        let score = 0;
        if (exact) score -= 100;
        if (codeHit) score -= 10;
        else if (name.startsWith(q)) score -= 5;
        // plain 4-digit equities rank above warrants/ETNs (6-char codes)
        score += s.code.length === 4 || s.kind === 'ETF' ? 0 : 50;
        score += s.name.length; // shorter names first
        // Code identity and known ETF series outrank incidental name matches.
        const rank = code === q ? 0 : numericQuery && s.kind === 'ETF' && codeHit ? 1 : 2;
        scored.push({ s, code, score, rank, letterSuffix: rank === 1 && /^[A-Z]/.test(code.slice(q.length)) });
    }
    scored.sort((a, b) => a.rank - b.rank ||
        (a.rank === 1 ? Number(b.letterSuffix) - Number(a.letterSuffix) ||
            a.code.localeCompare(b.code) || a.s.exchange.localeCompare(b.s.exchange) : 0) || a.score - b.score);
    return scored.slice(0, limit).map((x) => x.s);
}

// distinct categories with member counts (for 類股/heatmap)
export function categoriesOf(
    index: StockMeta[],
): { category: string; count: number }[] {
    const m = new Map<string, number>();
    for (const s of index) {
        if (!s.category) continue;
        m.set(s.category, (m.get(s.category) ?? 0) + 1);
    }
    return [...m.entries()]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count);
}

// TWSE category code → readable label (shared by heatmap + leaderboard)
export const SECTOR_LABELS: Record<string, string> = {
    '24': '半導體',
    '25': '電腦週邊',
    '26': '光電',
    '27': '通信網路',
    '28': '電子零組件',
    '29': '電子通路',
    '30': '資訊服務',
    '31': '其他電子',
    '01': '水泥',
    '02': '食品',
    '03': '塑膠',
    '04': '紡織',
    '05': '電機',
    '06': '電器電纜',
    '08': '玻璃陶瓷',
    '09': '造紙',
    '10': '鋼鐵',
    '11': '橡膠',
    '12': '汽車',
    '14': '建材營造',
    '15': '航運',
    '16': '觀光',
    '17': '金融保險',
    '18': '貿易百貨',
    '20': '其他',
    '21': '化學',
    '22': '生技醫療',
    '23': '油電燃氣',
};

export function sectorLabel(category: string): string {
    return (
        SECTOR_LABELS[category] ??
        SECTOR_LABELS[category.padStart(2, '0')] ??
        category
    );
}

// TWSE industry index master code → the stock category it drills into, so the
// heatmap can show a sector-heat overview (which 類股 is hot today) and then
// drill into that sector's members (issue #2).
export const SECTOR_INDICES: {
    index: string;
    category: string;
    label: string;
}[] = [
    { index: 'IX0028', category: '24', label: '半導體' },
    { index: 'IX0029', category: '25', label: '電腦週邊' },
    { index: 'IX0030', category: '26', label: '光電' },
    { index: 'IX0031', category: '27', label: '通信網路' },
    { index: 'IX0032', category: '28', label: '電子零組件' },
    { index: 'IX0033', category: '29', label: '電子通路' },
    { index: 'IX0034', category: '30', label: '資訊服務' },
    { index: 'IX0035', category: '31', label: '其他電子' },
    { index: 'IX0039', category: '17', label: '金融保險' },
    { index: 'IX0037', category: '15', label: '航運' },
    { index: 'IX0026', category: '12', label: '汽車' },
    { index: 'IX0024', category: '10', label: '鋼鐵' },
    { index: 'IX0041', category: '23', label: '油電燃氣' },
    { index: 'IX0021', category: '22', label: '生技醫療' },
    { index: 'IX0036', category: '14', label: '建材營造' },
    { index: 'IX0017', category: '05', label: '電機機械' },
    { index: 'IX0012', category: '03', label: '塑膠' },
    { index: 'IX0011', category: '02', label: '食品' },
    { index: 'IX0016', category: '04', label: '紡織' },
    { index: 'IX0010', category: '01', label: '水泥' },
    { index: 'IX0038', category: '16', label: '觀光' },
    { index: 'IX0040', category: '18', label: '貿易百貨' },
    { index: 'IX0025', category: '11', label: '橡膠' },
    { index: 'IX0023', category: '09', label: '造紙' },
    { index: 'IX0018', category: '06', label: '電器電纜' },
    { index: 'IX0022', category: '08', label: '玻璃陶瓷' },
];

// the category code for a single stock code (for showing/jumping by sector)
export function categoryOf(
    index: StockMeta[],
    code: string,
): string | null {
    return index.find((s) => s.code === code)?.category ?? null;
}
