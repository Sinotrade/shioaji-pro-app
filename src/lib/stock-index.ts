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
import { etfNameFor } from './etf-catalog';

export interface StockMeta {
    code: string;
    name: string;
    category: string;
    exchange: string;
    day_trade?: string;
    kind?: 'ETF';
    aliases?: string[];
}

interface CatalogSource<T> { request: Promise<T>; expiresAt: number }
const baseCache = new Map<string, CatalogSource<Awaited<ReturnType<typeof fetchContracts>>>>();
const namesCache = new Map<string, CatalogSource<Awaited<ReturnType<typeof fetchWarrantUnderlyings>>>>();
const CATALOG_TTL_MS = 60_000;
const CATALOG_DEADLINE_MS = 1000;
let activeSourceScope = '';
let catalogGeneration = 0;
let detailsCache: StockMeta[] | null = null;
let detailsLoading: Promise<StockMeta[]> | null = null;
let detailsScope = '';
const detailByCode = new Map<string, StockMeta>();
const detailLoadingByCode = new Map<string, Promise<StockMeta | null>>();

const catalogScope = () => JSON.stringify([getApiBase(), todayStr()]);
const detailContext = () => JSON.stringify([catalogScope(), catalogGeneration]);

function ensureSourceScope() {
    const scope = catalogScope();
    if (scope !== activeSourceScope) {
        activeSourceScope = scope;
        catalogGeneration += 1;
        baseCache.clear();
        namesCache.clear();
    }
    return scope;
}

function loadSource<T>(cache: Map<string, CatalogSource<T>>, scope: string, load: () => Promise<T>): Promise<T> {
    const cached = cache.get(scope);
    if (cached && cached.expiresAt > Date.now()) return cached.request;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('股票目錄來源回應逾時')), CATALOG_DEADLINE_MS);
    });
    const entry: CatalogSource<T> = { request: Promise.resolve().then(load), expiresAt: Infinity };
    entry.request = Promise.race([entry.request, deadline]).then(value => {
        if (catalogScope() !== scope || cache.get(scope) !== entry) throw new Error('股票目錄載入期間伺服器已切換');
        entry.expiresAt = Date.now() + CATALOG_TTL_MS;
        return value;
    }).catch(error => {
        if (cache.get(scope) === entry) cache.delete(scope);
        throw error;
    }).finally(() => clearTimeout(timer));
    cache.set(scope, entry);
    while (cache.size > 2) cache.delete(cache.keys().next().value!);
    return entry.request;
}

export async function loadStockCatalog(): Promise<StockMeta[]> {
    const scope = ensureSourceScope();
    const generation = catalogGeneration;
    const [res, underlyings] = await Promise.all([
        loadSource(baseCache, scope, () => fetchContracts('STK')),
        // Optional names may fail without hiding supported Base identities.
        // Failure is not cached: the next search retries names, not Base.
        loadSource(namesCache, scope, fetchWarrantUnderlyings).catch(() => []),
    ]);
    if (catalogScope() !== scope || catalogGeneration !== generation) throw new Error('股票目錄載入期間伺服器已切換');
    const names = new Map(underlyings.filter(row => row.name).map(row => [row.underlying_code, row.name!]));
    return res.contracts.filter(c => c.code).map(c => {
        const exchange = c.exchange ?? '';
        const etf = etfNameFor(c.code, exchange);
        return {
            code: c.code,
            name: names.get(c.code) ?? etf?.name ?? c.code,
            category: '',
            exchange,
            ...(etf ? { kind: 'ETF' as const, aliases: [...new Set([etf.name, ...(etf.aliases ?? [])])] } : {}),
        };
    });
}

function ensureDetailsScope() {
    ensureSourceScope();
    const scope = detailContext();
    if (scope !== detailsScope) {
        detailsScope = scope;
        detailsCache = null;
        detailsLoading = null;
        detailByCode.clear();
        detailLoadingByCode.clear();
    }
    return scope;
}

export async function loadStockDetails(codes: string[]): Promise<StockMeta[]> {
    const scope = ensureDetailsScope();
    const unique = [...new Set(codes.filter(Boolean))];
    const load = (code: string) => {
        const cached = detailByCode.get(code);
        if (cached) return Promise.resolve(cached);
        const pending = detailLoadingByCode.get(code);
        if (pending) return pending;
        const request = fetchContractInfo(code, 'STK')
            .then((info) => {
                if (detailContext() !== scope) return null;
                const detail: StockMeta = {
                    code: info.code,
                    name: info.name,
                    category: info.category,
                    exchange: info.exchange ?? '',
                    day_trade: info.day_trade,
                };
                detailByCode.set(code, detail);
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
    if (detailsCache) return Promise.resolve(detailsCache);
    if (detailsLoading) return detailsLoading;
    const request = loadStockCatalog()
        .then(async (catalog) => {
            if (detailContext() !== scope) throw new Error('股票目錄載入期間伺服器已切換');
            const details = await loadStockDetails(catalog.map((stock) => stock.code));
            if (detailContext() !== scope) throw new Error('股票目錄載入期間伺服器已切換');
            // Partial metadata is returned but retried next time.
            if (details.length >= new Set(catalog.map((stock) => stock.code).filter(Boolean)).size) detailsCache = details;
            return details;
        }).finally(() => {
            if (detailsLoading === request) detailsLoading = null;
        });
    detailsLoading = request;
    return request;
}

// substring match on name, prefix match on code — ranked so the actual
// stock beats its thousands of warrants (台積電 before 台積電XX購YY)
export function searchStocks(
    index: StockMeta[],
    query: string,
    limit = 8,
): StockMeta[] {
    const normalize = (value: string) => value.trim().normalize('NFKC').replace(/臺/g, '台').toUpperCase();
    const q = normalize(query);
    if (!q) return [];
    const scored: { s: StockMeta; score: number }[] = [];
    for (const s of index) {
        const name = normalize(s.name);
        const aliases = (s.aliases ?? []).map(normalize);
        const code = normalize(s.code);
        const codeHit = code.startsWith(q);
        const nameHit = name.includes(q) || aliases.some(alias => alias.includes(q));
        if (!codeHit && !nameHit) continue;
        let score = 0;
        if (code === q || name === q || aliases.includes(q)) score -= 100; // exact
        if (codeHit) score -= 10;
        else if (name.startsWith(q)) score -= 5;
        // plain 4-digit equities rank above warrants/ETNs (6-char codes)
        score += s.code.length === 4 || s.kind === 'ETF' ? 0 : 50;
        score += s.name.length; // shorter names first
        scored.push({ s, score });
    }
    scored.sort((a, b) => a.score - b.score);
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
