// 美股名稱表與名稱搜尋：資料格式、中英文命中、排序、不該查的輸入
import { describe, expect, it } from 'vitest';
import table from '../data/us-names.json';
import { hasUsNameHit, searchUsNames } from './us-names';

describe('us-names.json', () => {
    const names = table.names as unknown as [string, string, string, number][];

    it('has well-formed unique rows', () => {
        expect(names.length).toBeGreaterThanOrEqual(500);
        const codes = names.map(([code]) => code);
        expect(new Set(codes).size).toBe(codes.length);
        for (const [code, en, zh, indexCount] of names) {
            expect(code).toMatch(/^[A-Z][A-Z0-9.-]{0,9}$/);
            expect(en.trim()).not.toBe('');
            expect(zh === '' || /[一-鿿]/.test(zh)).toBe(true);
            expect([1, 2, 3]).toContain(indexCount);
        }
    });

    it('has no duplicate Chinese names', () => {
        const zh = names.map(([, , name]) => name).filter(Boolean);
        expect(new Set(zh).size).toBe(zh.length);
    });

    it('records where the names came from', () => {
        expect(table.schemaVersion).toBe(1);
        expect(table.sources.length).toBeGreaterThan(0);
    });
});

describe('searchUsNames', () => {
    it('finds a company by English name, case-insensitively', () => {
        expect(searchUsNames('apple')).toEqual(['AAPL']);
        expect(searchUsNames('APPLE')).toEqual(['AAPL']);
        expect(searchUsNames('  nvidia ')).toEqual(['NVDA']);
    });

    it('finds a company by Chinese name, treating 臺 and 台 as the same', () => {
        expect(searchUsNames('蘋果')).toEqual(['AAPL']);
        expect(searchUsNames('輝達')).toEqual(['NVDA']);
        expect(searchUsNames('台積電')).toEqual(['TSM']);
        expect(searchUsNames('臺積電')).toEqual(['TSM']);
        expect(searchUsNames('谷歌')).toEqual(['GOOG', 'GOOGL']);
    });

    it('only matches the start of a Chinese name, so generic words do not pull in US stocks', () => {
        for (const query of ['科技', '半導體', '銀行', '金融', '公司', '集團', '能源', '醫療']) {
            expect(searchUsNames(query), query).toEqual([]);
        }
        expect(searchUsNames('谷歌')).toEqual(['GOOG', 'GOOGL']);
        expect(searchUsNames('臉書')).toEqual(['META']);
    });

    it('needs 3 characters or a full name for a Chinese prefix, because 2-character prefixes collide with Taiwan names', () => {
        // 這些兩字前綴台股、期貨、ETF 名稱也有（電子期貨、美國那斯達克100期貨、國際…、第一金…）
        for (const query of ['電子', '國際', '美國', '第一', '聯合', '標普', '台積', '應用', '摩根']) {
            expect(searchUsNames(query), query).toEqual([]);
        }
        // 三個字以上、或剛好是完整名稱就可以
        expect(searchUsNames('電子灣')).toEqual(['EBAY']);
        expect(searchUsNames('台積電')).toEqual(['TSM']);
        expect(searchUsNames('美國電')).toContain('AEP');
        for (const query of ['蘋果', '輝達', '微軟', '亞培', '強鹿', '迪爾']) expect(searchUsNames(query), query).toHaveLength(1);
    });

    it('can reach every company by its full Chinese or English name', () => {
        const names = table.names as unknown as [string, string, string, number][];
        for (const [code, en, zh] of names) {
            expect(searchUsNames(en, 600), `${code} ${en}`).toContain(code);
            for (const alias of zh ? zh.split('/') : []) {
                expect(searchUsNames(alias.trim().split(/\s+/)[0]!, 600), `${code} ${alias}`).toContain(code);
            }
        }
    });

    it('ignores spaces, punctuation and a trailing 公司 or 集團 in a Chinese query', () => {
        for (const query of ['蘋果公司', '蘋 果', '蘋果，', ' 蘋果 ']) expect(searchUsNames(query), query).toEqual(['AAPL']);
        expect(searchUsNames('新聞集團')).toEqual(['NWS', 'NWSA']);
        expect(searchUsNames('福斯公司')).toEqual(['FOX', 'FOXA']);
        expect(searchUsNames('集團')).toEqual([]);
    });

    it('keeps Taiwan names, and lets a company carry several names separated by "/"', () => {
        expect(searchUsNames('實耐寶')).toEqual(['SNA']);
        expect(searchUsNames('洛克威爾')).toEqual(['ROK']);
        expect(searchUsNames('電子灣')).toEqual(['EBAY']);
        // 強鹿、迪爾都是台灣平台用過的 Deere 譯名；大陸譯名不放
        expect(searchUsNames('強鹿')).toEqual(['DE']);
        expect(searchUsNames('迪爾')).toEqual(['DE']);
        expect(searchUsNames('約翰迪爾')).toEqual([]);
        expect(searchUsNames('世達')).toEqual([]);
    });

    it('matches any word of the name and ignores accents and punctuation', () => {
        expect(searchUsNames('disney')).toEqual(['DIS']);
        expect(searchUsNames('estee')).toEqual(['EL']);
        expect(searchUsNames('coca cola')).toContain('KO');
        expect(searchUsNames('berkshire')).toEqual(['BRK.B']);
    });

    it('ranks name-prefix before word-prefix, then by how many indexes hold the stock, then by name length', () => {
        // 名稱開頭是 Micro：MU、MCHP 三個指數都有（Micron 名稱較短在前），MSFT 兩個，MSTR 一個；
        // Advanced Micro Devices 只是單字開頭，排最後
        expect(searchUsNames('micro', 10)).toEqual(['MU', 'MCHP', 'MSFT', 'MSTR', 'AMD']);
    });

    it('filters with accept before cutting to the limit', () => {
        const without = new Set(['MU', 'MCHP', 'MSFT', 'MSTR']);
        expect(searchUsNames('micro', 4, code => !without.has(code))).toEqual(['AMD']);
        expect(searchUsNames('micro', 2, code => code !== 'MU')).toEqual(['MCHP', 'MSFT']);
    });

    it('finds names typed without the apostrophe, dot, hyphen or space', () => {
        const expected: Record<string, string> = {
            mcdonalds: 'MCD', lowes: 'LOW', moodys: 'MCO', oreilly: 'ORLY', dominos: 'DPZ', caseys: 'CASY',
            tmobile: 'TMUS', spglobal: 'SPGI', jbhunt: 'JBHT', 'mt bank': 'MTB', "lowe's": 'LOW', 't-mobile': 'TMUS',
        };
        for (const [query, code] of Object.entries(expected)) expect(searchUsNames(query), query).toEqual([code]);
    });

    it('ignores a trailing company suffix on either side', () => {
        for (const query of ['microsoft corp', 'Microsoft Corporation', 'tesla, inc.', 'Apple Inc', 'NVIDIA Corp', 'Netflix Inc', 'meta platforms inc', 'booking holdings']) {
            expect(searchUsNames(query, 1), query).toHaveLength(1);
        }
        expect(searchUsNames('microsoft corp')).toEqual(['MSFT']);
        expect(searchUsNames('netflix inc')).toEqual(['NFLX']);
    });

    it('matches names with spaces and ampersands', () => {
        expect(searchUsNames('johnson & johnson')).toEqual(['JNJ']);
        expect(searchUsNames('berkshire hathaway')).toEqual(['BRK.B']);
        expect(searchUsNames('coca cola')).toContain('KO');
    });

    it('respects the limit', () => {
        expect(searchUsNames('micro', 2)).toHaveLength(2);
    });

    it('does not search one-character, numeric or company-suffix input', () => {
        expect(searchUsNames('a')).toEqual([]);
        expect(searchUsNames('蘋')).toEqual([]);
        expect(searchUsNames('2330')).toEqual([]);
        expect(searchUsNames('inc')).toEqual([]);
        expect(searchUsNames('corporation')).toEqual([]);
        expect(searchUsNames('holdings')).toEqual([]);
        expect(searchUsNames('the')).toEqual([]);
        expect(searchUsNames('')).toEqual([]);
        expect(searchUsNames('   ')).toEqual([]);
    });

    it('returns nothing for names it does not know', () => {
        expect(searchUsNames('zzzzqqq')).toEqual([]);
        expect(searchUsNames('不存在的公司')).toEqual([]);
    });
});

describe('hasUsNameHit', () => {
    it('tells whether a query is worth loading the US catalog for', () => {
        expect(hasUsNameHit('蘋果')).toBe(true);
        expect(hasUsNameHit('apple')).toBe(true);
        expect(hasUsNameHit('2330')).toBe(false);
        expect(hasUsNameHit('鴻海')).toBe(false);
    });
});
