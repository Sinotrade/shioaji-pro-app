import { normalizeContractCode } from './shioaji';
import { normalizeStockSearchText, SECTOR_INDICES } from './stock-index';
import type { Exchange } from './types/contract';

interface IndexSearchEntry {
    code: string;
    name: string;
    exchange: Exclude<Exchange, null>;
    aliases?: readonly string[];
}

// 1.7.8 的批次 IND 目錄沒有名稱。保留既有上市類股，另外列入實查確認的商品，
// 不把熱圖分類表誤當成全部指數，也不在每次輸入時逐筆抓取整個商品檔。
export const INDEX_SEARCH_ENTRIES: readonly IndexSearchEntry[] = [
    { code: 'IX0001', name: '發行量加權股價指數', exchange: 'TSE', aliases: ['加權', '大盤', '台灣加權', 'TSE'] },
    ...SECTOR_INDICES.map(index => ({
        code: index.index, name: `${index.label}類指數`, exchange: 'TSE' as const,
    })),
    { code: 'IX0043', name: '櫃買指數', exchange: 'OTC', aliases: ['櫃買', 'OTC'] },
    { code: 'IX0044', name: '櫃買紡纖類指數', exchange: 'OTC' },
    { code: 'IX0045', name: '櫃買機械類指數', exchange: 'OTC' },
    { code: 'IX0048', name: '櫃買營建類指數', exchange: 'OTC' },
    { code: 'IX0053', name: '櫃買半導體類指數', exchange: 'OTC' },
    { code: 'IX0056', name: '櫃買通信網路類指數', exchange: 'OTC' },
    { code: 'IX0058', name: '櫃買電子通路類指數', exchange: 'OTC' },
    { code: 'IX0059', name: '櫃買資訊服務類指數', exchange: 'OTC' },
    { code: 'IX0007', name: '未含金融指數', exchange: 'TSE' },
    { code: 'IX0008', name: '未含電子指數', exchange: 'TSE' },
    { code: 'TAIWANVIX', name: '臺指選擇權波動率指數', exchange: 'TAIFEX', aliases: ['VIX'] },
];

export function indexSearchSuggestions(query: string) {
    const needle = normalizeStockSearchText(query);
    if (!needle) return [];
    const canonical = normalizeContractCode(needle, 'IND');
    const score = (entry: IndexSearchEntry) => {
        const names = [entry.name, ...(entry.aliases ?? [])].map(normalizeStockSearchText);
        if (entry.code === canonical || names.includes(needle)) return 0;
        if (entry.code.startsWith(canonical) || names.some(name => name.startsWith(needle))) return 1;
        return names.some(name => name.includes(needle)) ? 2 : Infinity;
    };
    return INDEX_SEARCH_ENTRIES.map(entry => ({ entry, score: score(entry) }))
        .filter(row => Number.isFinite(row.score))
        .sort((a, b) => a.score - b.score)
        .map(({ entry }) => ({
            code: entry.code,
            name: entry.name,
            security_type: 'IND' as const,
            exchange: entry.exchange,
            detail: '指數',
        }));
}
