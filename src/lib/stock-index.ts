// src/lib/stock-index.ts — Contract V2 stock catalog and optional typed info.
// The bulk /api/v1/data/contracts?security_type=STK response already carries
// the full normalized row (name, category, ...) for every symbol — see
// BrokerContractsQueryResponse in src/lib/broker/types.ts — so one call
// populates the whole catalog's name+category. loadStockDetails()/
// loadStockIndex() used to re-fetch each symbol individually
// (fetchContractInfo per code) even for the entire STK universe (1000+
// requests); that N+1 fan-out is gone — the per-code cache below is now
// primed straight from the bulk catalog, and per-code fetchContractInfo is
// only a fallback for a code that genuinely isn't in the bulk catalog.

import { fetchContractInfo, fetchContracts } from './kgi';

export interface StockMeta {
    code: string;
    name: string;
    category: string;
    exchange: string;
    day_trade?: string;
}

let catalogCache: StockMeta[] | null = null;
let catalogLoading: Promise<StockMeta[]> | null = null;
const detailByCode = new Map<string, StockMeta>();
const detailLoadingByCode = new Map<string, Promise<StockMeta | null>>();

// The bulk STK catalog is a real KGI-native round trip the FIRST time it's
// requested each session (kgisuperpy's own Data.contract() cache is empty
// until then), and every native KGI call in the backend is serialized onto
// one dedicated worker thread (backend/kgi_bridge/clients.py's
// _native_executor — required for TradeCom DLL thread-safety). If a
// secondary panel (heatmap, scanner category tags) fires this on mount at
// the same time as the watchlist/positions/order-ticket's own startup
// calls, it can win that single-threaded queue and delay the primary
// trading UI. Deferring the FIRST call to the browser's idle slot (falls
// back to a short timeout where requestIdleCallback isn't available) lets
// the critical-path requests reach the backend first without meaningfully
// slowing the secondary panel — it was already a multi-second fetch.
function whenIdle(): Promise<void> {
    return new Promise((resolve) => {
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(() => resolve(), { timeout: 1500 });
        } else {
            setTimeout(resolve, 300);
        }
    });
}

export function loadStockCatalog(): Promise<StockMeta[]> {
    if (catalogCache) return Promise.resolve(catalogCache);
    if (catalogLoading) return catalogLoading;
    catalogLoading = whenIdle()
        .then(() => fetchContracts('STK'))
        .then((res) => {
            const rows = res.contracts
                .filter((c) => c.code)
                .map((c) => ({
                    code: c.code,
                    name: c.name || c.code,
                    category: c.category ?? '',
                    exchange: c.exchange ?? '',
                    day_trade: c.day_trade,
                }));
            for (const row of rows) detailByCode.set(row.code, row);
            catalogCache = rows;
            return catalogCache;
        })
        .catch((e) => {
            catalogLoading = null;
            throw e;
        });
    return catalogLoading;
}

export async function loadStockDetails(codes: string[]): Promise<StockMeta[]> {
    const unique = [...new Set(codes.filter(Boolean))];
    // Prime detailByCode from the bulk catalog first so a caller asking
    // for the whole catalog (loadStockIndex) or a scanner-result subset
    // hits the already-cached rows instead of one request per symbol.
    if (!catalogCache) {
        await loadStockCatalog().catch(() => undefined);
    }
    const load = (code: string) => {
        const cached = detailByCode.get(code);
        if (cached) return Promise.resolve(cached);
        const pending = detailLoadingByCode.get(code);
        if (pending) return pending;
        const request = fetchContractInfo(code, 'STK')
            .then((info) => {
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
            .finally(() => detailLoadingByCode.delete(code));
        detailLoadingByCode.set(code, request);
        return request;
    };
    const rows = await Promise.all(unique.map(load));
    return rows.filter(
        (detail): detail is StockMeta => detail !== null,
    );
}

export function loadStockIndex(): Promise<StockMeta[]> {
    return loadStockCatalog();
}

// substring match on name, prefix match on code — ranked so the actual
// stock beats its thousands of warrants (台積電 before 台積電XX購YY)
export function searchStocks(
    index: StockMeta[],
    query: string,
    limit = 8,
): StockMeta[] {
    const q = query.trim().toUpperCase();
    if (!q) return [];
    const scored: { s: StockMeta; score: number }[] = [];
    for (const s of index) {
        const name = s.name.toUpperCase();
        const codeHit = s.code.startsWith(q);
        const nameHit = name.includes(q);
        if (!codeHit && !nameHit) continue;
        let score = 0;
        if (s.code === q || name === q) score -= 100; // exact
        if (codeHit) score -= 10;
        else if (name.startsWith(q)) score -= 5;
        // plain 4-digit equities rank above warrants/ETNs (6-char codes)
        score += s.code.length === 4 ? 0 : 50;
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

