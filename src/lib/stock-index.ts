// src/lib/stock-index.ts — all stock contracts loaded once for name
// search (找代碼不用背) and category/sector grouping.

import { apiPost } from './api';

export interface StockMeta {
    code: string;
    name: string;
    category: string;
    exchange: string;
    day_trade?: string;
}

let cache: StockMeta[] | null = null;
let loading: Promise<StockMeta[]> | null = null;

export function loadStockIndex(): Promise<StockMeta[]> {
    if (cache) return Promise.resolve(cache);
    if (loading) return loading;
    loading = apiPost<{ contracts: StockMeta[] }>('/api/v1/data/contracts', {
        security_type: 'STK',
        page: -1,
    })
        .then((res) => {
            cache = res.contracts.filter((c) => c.code && c.name);
            return cache;
        })
        .catch((e) => {
            loading = null; // allow retry
            throw e;
        });
    return loading;
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
    return SECTOR_LABELS[category] ?? category;
}

// TWSE industry index (IND) code → the stock category it drills into, so the
// heatmap can show a sector-heat overview (which 類股 is hot today) and then
// drill into that sector's members (issue #2).
export const SECTOR_INDICES: {
    index: string;
    category: string;
    label: string;
}[] = [
    { index: '036', category: '24', label: '半導體' },
    { index: '037', category: '25', label: '電腦週邊' },
    { index: '038', category: '26', label: '光電' },
    { index: '039', category: '27', label: '通信網路' },
    { index: '040', category: '28', label: '電子零組件' },
    { index: '041', category: '29', label: '電子通路' },
    { index: '042', category: '30', label: '資訊服務' },
    { index: '043', category: '31', label: '其他電子' },
    { index: '031', category: '17', label: '金融保險' },
    { index: '029', category: '15', label: '航運' },
    { index: '026', category: '12', label: '汽車' },
    { index: '024', category: '10', label: '鋼鐵' },
    { index: '035', category: '23', label: '油電燃氣' },
    { index: '021', category: '22', label: '生技化學' },
    { index: '028', category: '14', label: '建材營造' },
    { index: '019', category: '05', label: '電機機械' },
    { index: '017', category: '03', label: '塑膠' },
    { index: '016', category: '02', label: '食品' },
    { index: '018', category: '04', label: '紡織' },
    { index: '015', category: '01', label: '水泥' },
    { index: '030', category: '16', label: '觀光' },
    { index: '032', category: '18', label: '貿易百貨' },
    { index: '025', category: '11', label: '橡膠' },
    { index: '023', category: '09', label: '造紙' },
    { index: '020', category: '06', label: '電器電纜' },
    { index: '022', category: '08', label: '玻璃陶瓷' },
];

// the category code for a single stock code (for showing/jumping by sector)
export function categoryOf(
    index: StockMeta[],
    code: string,
): string | null {
    return index.find((s) => s.code === code)?.category ?? null;
}
