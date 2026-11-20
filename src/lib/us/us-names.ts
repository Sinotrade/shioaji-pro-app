// src/lib/us/us-names.ts — 美股名稱搜尋（用公司英文名、中文名找代碼）
//
// 美股清單（us-contracts.ts）只有代碼與交易所，SDK 沒有名稱表，名稱要逐檔查 info，
// 所以這裡內建一份熱門美股名稱表（標普 500、那斯達克 100、費城半導體成分股，
// 加上人工挑選的熱門 ETF 與 ADR，見 data/us-names.json）。只做「名稱 → 代碼」的比對；命中的代碼要在美股清單內才會
// 變成建議（product-search.ts），顯示名稱仍照舊由 info 補。
// sidecar 之後若在清單帶上 name，這份表可以整個移除。

import table from '../data/us-names.json';
import { normalizeStockSearchText } from '../stock-index';

interface NameRow {
    code: string;
    /** 英文比對鍵：去重音、大寫、標點換空白、去掉結尾的公司後綴 */
    en: string;
    /** 同一把鍵拿掉所有空白與標點（McDonald's、T-Mobile、S&P Global 連著打也找得到） */
    enCompact: string;
    /** 中文名（臺／台同形、去空白標點）；表中用「/」分隔多個名稱；沒有通行譯名的是空陣列 */
    zh: { key: string; name: string }[];
    indexCount: number;
    enLength: number;
}

const MIN_QUERY_LENGTH = 2;
// 中文名稱開頭相同時至少要打到 3 個字，除非剛好是完整名稱（蘋果、輝達、谷歌）。
// 兩個字的前綴多半是泛用詞（電子、國際、美國、第一、聯合），台股、期貨名稱也有，
// 會讓美股列擠進一般的台股搜尋、還多載入一次美股清單。
const MIN_ZH_PREFIX_LENGTH = 3;
const CJK = /[一-鿿]/;
// 結尾的公司後綴：查詢與名稱表兩邊都去掉，Microsoft Corp、Apple Inc 才找得到
const SUFFIX_WORDS = new Set(['INC', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'COMPANIES', 'LTD', 'LIMITED', 'PLC', 'LLC', 'HOLDINGS', 'GROUP']);
// 連接詞：單獨輸入沒有鑑別力，不查
const STOP_WORDS = new Set(['THE', 'OF', 'AND', 'CLASS']);

function enKey(text: string): string {
    const words = text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase()
        .replace(/['’`]/g, '').replace(/[^A-Z0-9]+/g, ' ').trim().split(' ');
    while (words.length && SUFFIX_WORDS.has(words[words.length - 1]!)) words.pop();
    return words.join(' ');
}
const compact = (key: string) => key.replace(/ /g, '');

function zhKey(text: string): string {
    return normalizeStockSearchText(text).replace(/[\s,.、，。·・]+/g, '');
}
const stripZhSuffix = (key: string) => key.replace(/(公司|集團)$/, '');

let rows: NameRow[] | undefined;
function nameRows(): NameRow[] {
    rows ??= (table.names as [string, string, string, number][]).map(([code, en, zh, indexCount]) => {
        const key = enKey(en);
        const aliases = zh ? zh.split('/').map(alias => ({ key: zhKey(alias), name: stripZhSuffix(zhKey(alias.trim().split(/\s+/)[0]!)) })) : [];
        return { code, en: key, enCompact: compact(key), zh: aliases, indexCount, enLength: en.length };
    });
    return rows;
}

/**
 * 依名稱找美股代碼，由最相關到最不相關：名稱開頭相同、英文任一單字開頭相同。
 * 中文只比對名稱開頭，且至少 3 個字或剛好是完整名稱（「科技」「電子」「美國」這類泛用詞
 * 不會把美股帶進台股搜尋）。
 * 同一級以成分指數數量多、名稱短者優先。至少 2 個字元；純數字（台股代碼）與公司後綴不查。
 * accept 在截成 limit 筆之前先過濾（呼叫端用它剔除不在美股清單內的代碼）。
 */
export function searchUsNames(query: string, limit = 4, accept?: (code: string) => boolean): string[] {
    const text = query.trim();
    if (text.length < MIN_QUERY_LENGTH || /^\d+$/.test(text)) return [];
    const zh = CJK.test(text);
    // 中文查詢結尾的「公司」「集團」不算（蘋果公司 → 蘋果）
    const key = zh ? stripZhSuffix(zhKey(text)) : enKey(text);
    if (key.length < MIN_QUERY_LENGTH || (!zh && STOP_WORDS.has(key))) return [];
    const flat = zh ? '' : compact(key);
    const hits: [number, NameRow][] = [];
    for (const row of nameRows()) {
        if (accept && !accept(row.code)) continue;
        let rank = -1;
        if (zh) {
            if (row.zh.some(alias => alias.key.startsWith(key) && (key.length >= MIN_ZH_PREFIX_LENGTH || alias.name === key))) rank = 0;
        } else if (row.en.startsWith(key) || (flat.length >= MIN_QUERY_LENGTH && row.enCompact.startsWith(flat))) rank = 0;
        else if (` ${row.en}`.includes(` ${key}`)) rank = 1;
        if (rank >= 0) hits.push([rank, row]);
    }
    return hits
        .sort(([ra, a], [rb, b]) => ra - rb || b.indexCount - a.indexCount || a.enLength - b.enLength || (a.code < b.code ? -1 : 1))
        .slice(0, limit)
        .map(([, row]) => row.code);
}

/** 這個輸入有沒有命中名稱表（用來決定要不要去載入美股清單） */
export function hasUsNameHit(query: string): boolean {
    return searchUsNames(query, 1).length > 0;
}
