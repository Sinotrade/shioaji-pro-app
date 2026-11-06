import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeStockSearchText, searchStocks, type StockMeta } from './stock-index';

const catalog = [
    { code: '2330', name: '台積電', category: '', exchange: 'TSE' },
    { code: 'TSMC', name: '臺積電相關商品', category: '', exchange: 'TSE' },
    { code: '1301', name: '台塑', category: '', exchange: 'TSE' },
];
const stock = (code: string, name: string, fields: Partial<StockMeta> = {}): StockMeta => ({ code, name, category: '', exchange: 'TSE', ...fields });
const expectReferences = (actual: StockMeta[], expected: StockMeta[]) => {
    expect(actual).toHaveLength(expected.length);
    actual.forEach((row, index) => expect(row).toBe(expected[index]));
};
afterEach(() => vi.restoreAllMocks());

describe('normalizeStockSearchText 無 cache fixed-point fast path', () => {
    const legacy = (v: string) => v.trim().normalize('NFKC').replace(/\u81FA/g, '\u53F0').toUpperCase();
    const isFixed = (c: number) =>
        (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x4e00 && c <= 0x9fff && c !== 0x81fa);
    // 若 StockMeta 欄位或 searchStocks 參數順序與此不同，只調整這兩個 adapter。
    const meta = (code: string, name: string, aliases: string[] = []): StockMeta => ({ code, name, aliases, category: '', exchange: 'TSE' });
    const search = (rows: StockMeta[], query: string) => searchStocks(rows, query);
    const codes = (list: StockMeta[]) => list.map((row) => row.code);
    const traced = (inputs: string[]) => {
        const spy = vi.spyOn(String.prototype, 'normalize');
        try {
            return inputs.map((input) => {
                const before = spy.mock.calls.length;
                const out = normalizeStockSearchText(input);
                return { input, out, calls: spy.mock.calls.length - before };
            });
        } finally {
            spy.mockRestore();
        }
    };

    it('允許的 ASCII 與 20991 個基本漢字（排除臺）逐字及多字皆等於舊鏈，且 normalize 零次', () => {
        const singles: string[] = [];
        for (let c = 0; c <= 0xffff; c++) if (isFixed(c)) singles.push(String.fromCharCode(c));
        expect(singles.length).toBe(36 + 20991);
        const inputs = [...singles, singles.join(''), [...singles].reverse().join('')];
        for (let i = 0; i < singles.length; i += 97) inputs.push(singles.slice(i, i + 97).join(''));
        const results = traced(inputs);
        const bad = results.filter(({ input, out }) => legacy(input) !== input || out !== input);
        expect(bad.slice(0, 10).map(({ input }) => input.slice(0, 8))).toEqual([]);
        expect(results.reduce((sum, { calls }) => sum + calls, 0)).toBe(0);
    });

    it('全部 BMP code unit 以 A+c+Z 對照舊鏈，且只有允許字元跳過 normalize', () => {
        const inputs = Array.from({ length: 0x10000 }, (_, c) => `A${String.fromCharCode(c)}Z`);
        const bad = traced(inputs).flatMap(({ input, out, calls }) => {
            const c = input.charCodeAt(1);
            return out !== legacy(input) || calls !== (isFixed(c) ? 0 : 1) ? [c.toString(16)] : [];
        });
        expect(bad.slice(0, 10)).toEqual([]);
    }, 30000);

    it('臺、末尾換行、control、NBSP、FEFF、全形、連字、ß、combining、相容漢字與非 BMP 皆精準走原鏈', () => {
        const cases: Array<[string, string]> = [
            ['臺積電', '台積電'], ['2330\n', '2330'], ['\t2330\r\n', '2330'], ['A\u0000B\u0007', 'A\u0000B\u0007'],
            ['\u00A0台積電\u00A0', '台積電'], ['台\u00A0積', '台 積'], ['\uFEFF2330', '2330'],
            ['２３３０', '2330'], ['ｔｓｍｃ', 'TSMC'], ['Ａ\u3000Ｂ', 'A B'], ['\uFB01\uFB03', 'FIFFI'],
            ['Straße', 'STRASSE'], ['e\u0301', '\u00C9'], ['A\u030A', '\u00C5'], ['台\u0301', '台\u0301'],
            ['\uF900', '\u8C48'], ['\u2F00\u2F08', '\u4E00\u4EBA'], ['\u{2F800}', '\u4E3D'],
            ['台\u{20000}2330', '台\u{20000}2330'], ['\u{1D400}\u{1D41B}', 'AB'],
        ];
        const results = traced(cases.map(([input]) => input));
        expect(results.map(({ out, calls }) => [out, calls])).toEqual(cases.map(([, want]) => [want, 1]));
        expect(cases.map(([input]) => legacy(input))).toEqual(cases.map(([, want]) => want));
    });

    it('raw name.length 同分 tie 與回傳原 refs 不因 fast/fallback 路徑而改變', () => {
        const fast = [meta('2330', '台積電'), meta('2331', '台積電 '), meta('2332', '台積電子'), meta('2454', '聯發科')];
        const slow = [meta('2330', '臺積電'), meta('2331', '臺積電\u3000'), meta('2332', '臺積電子'), meta('2454', '聯發科')];
        const a = search(fast, '台積');
        const b = search(slow, ' 臺積\n');
        expect(codes(a)).toEqual(expect.arrayContaining(['2330', '2331', '2332']));
        expect(codes(b)).toEqual(codes(a));
        expect(a.every((row) => fast.includes(row)) && b.every((row) => slow.includes(row))).toBe(true);
        const tie = (list: StockMeta[]) => codes(list).filter((code) => code === '2330' || code === '2331');
        expect(tie(search([...slow].reverse(), '台積'))).toEqual(tie(b));
        const ties = [meta('3001', '台甲'), meta('3002', '台乙')];
        expect(search(ties, '台')).toEqual(ties);
        expect(search([...ties].reverse(), '台')).toEqual([...ties].reverse());
    });

    it('暖機後原地同長替換 name/alias，以及 reverse/splice，結果立即更新且舊名稱消失', () => {
        const firstAliases = ['丙丁'];
        const rows = [meta('9901', '甲乙', firstAliases), meta('9902', '戊己', ['庚辛'])];
        const first = rows[0]!;
        expect(search(rows, '甲乙')).toContain(first);
        for (const q of ['丙丁', '戊己', '庚辛']) search(rows, q);
        first.name = '壬癸';
        firstAliases[0] = '子丑';
        expect(search(rows, '甲乙')).not.toContain(first);
        expect(search(rows, '丙丁')).not.toContain(first);
        expect(search(rows, '壬癸')).toContain(first);
        expect(search(rows, '子丑')).toContain(first);
        rows.reverse();
        expect(codes(search(rows, '壬癸'))).toEqual(['9901']);
        rows.splice(0, 1);
        expect(search(rows, '戊己')).toEqual([]);
        expect(search(rows, '庚辛')).toEqual([]);
        rows.splice(1, 0, meta('9903', '臺北'));
        expect(codes(search(rows, '台北'))).toEqual(['9903']);
        expect(search(rows, '壬癸')).toEqual([first]);
    });

    it('不留 cache：重複的非 fixed-point 字串每次都正常 fallback，query 不被保留，空 query 回傳 []', () => {
        const inputs = Array.from({ length: 3 }, () => ['ｔｓｍｃ', '臺積電', '2330\n']).flat();
        expect(traced(inputs).map(({ out, calls }) => [out, calls])).toEqual(
            Array.from({ length: 3 }, () => [['TSMC', 1], ['台積電', 1], ['2330', 1]]).flat(),
        );
        const rows = [meta('9901', '甲乙'), meta('9902', '戊己')];
        expect(codes(search(rows, '甲乙'))).toEqual(['9901']);
        expect(codes(search(rows, '戊己'))).toEqual(['9902']);
        expect(search(rows, '')).toEqual([]);
        expect(search(rows, ' \u3000\n')).toEqual([]);
    });
});

describe('stock name search normalization', () => {
    it('treats 台 and 臺 alike without changing displayed official names', () => {
        expect(searchStocks(catalog, '臺積電').map((row) => row.code)).toEqual(['2330', 'TSMC']);
        expect(searchStocks(catalog, '台積電')[1]?.name).toBe('臺積電相關商品');
    });
    it('keeps exact code/name priority and case-insensitive code matching', () => {
        expect(searchStocks(catalog, '2330')[0]?.code).toBe('2330');
        expect(searchStocks(catalog, 'tsmc')[0]?.code).toBe('TSMC');
        expect(searchStocks(catalog, '台')[0]?.name).toBe('台塑');
    });
});

describe('搜尋工作量保持有界，不建立跨搜尋快取', () => {
    it('主代碼或主名稱已完全命中時，不再正規化無關 aliases', () => {
        const normalize = vi.spyOn(String.prototype, 'normalize');
        const row = stock('2330', '台積電', { aliases: ['無關的冗餘別名'] });
        expectReferences(searchStocks([row], '2330'), [row]);
        expectReferences(searchStocks([row], '台積電'), [row]);
        expect(normalize.mock.contexts.map(String)).not.toContain('無關的冗餘別名');
    });

    it('同列相同的 name/code/alias 字串只正規化一次', () => {
        const normalize = vi.spyOn(String.prototype, 'normalize');
        const row = stock(' AbC ', ' AbC ', { aliases: [' AbC '] });
        expectReferences(searchStocks([row], 'B'), [row]);
        expect(normalize.mock.contexts.map(String).filter(value => value === 'AbC')).toHaveLength(1);
    });

    it('ETF comparator 使用該次搜尋已正規化的代碼', () => {
        const normalize = vi.spyOn(String.prototype, 'normalize');
        const a = stock('００９８１Ａ', '較長的基金名稱', { kind: 'ETF' });
        const b = stock('００９８１Ｂ', '短名', { kind: 'ETF' });
        expectReferences(searchStocks([b, a], '00981'), [a, b]);
        for (const code of ['００９８１Ａ', '００９８１Ｂ']) {
            expect(normalize.mock.contexts.map(String).filter(value => value === code)).toHaveLength(1);
        }
    });

    it('已是大寫英數的 query/name/code/alias 不需重新轉換', () => {
        const normalize = vi.spyOn(String.prototype, 'normalize');
        const trim = vi.spyOn(String.prototype, 'trim');
        const row = stock('ABC', 'ABC', { aliases: ['ALIAS'] });
        expectReferences(searchStocks([row], 'B'), [row]);
        expect(normalize).not.toHaveBeenCalled();
        for (const value of ['ABC', 'ALIAS', 'B']) expect(trim.mock.contexts.map(String)).not.toContain(value);
    });
});

describe('只有 canonical ASCII 可略過原正規化鏈', () => {
    it.each([
        [' \tABC\r\n', 'abc'],
        ['ABC\n', 'abc'],
        ['A\u0000B', 'a\u0000b'],
        ['\u000bA\u000c', 'a'],
        ['\u00a0Ａ\uFEFF', 'a'],
        ['ﬁ', 'fi'],
        ['ﬃ', 'ffi'],
        ['e\u0301', 'É'],
        ['ß', 'ss'],
        ['臺灣', '台灣'],
        ['Ｓ＆Ｐ５００', 's&p500'],
        ['A\u00a0B', 'a b'],
        ['Ａ\u0301', 'Á'],
    ])('原字串 %j 的名稱與 alias 都保留既有比對語意', (raw, query) => {
        const primary = stock('1111', raw);
        const alias = stock('2222', '顯示名稱', { aliases: [raw] });
        expectReferences(searchStocks([primary], query), [primary]);
        expectReferences(searchStocks([alias], query), [alias]);
        expect(primary.name).toBe(raw);
        expect(alias.aliases).toEqual([raw]);
    });
});

describe('惰性 alias 比對保留完整計分與原字串長度', () => {
    it('contains 後仍查後方 exact，重複 exact 的 -100 只計一次', () => {
        const alias = stock('1111', '較長名', { aliases: ['台積電股份有限公司', '台積電', '台積電'] });
        const exact = stock('2222', '台積電');
        const prefix = stock('3333', '台積電甲');
        expectReferences(searchStocks([prefix, alias, exact], '台積電'), [exact, alias, prefix]);
    });

    it('code prefix 命中後，alias 的 exact bonus 仍有效', () => {
        const alias = stock('2331', '長名稱'.repeat(15), { aliases: ['含233的別名', '233'] });
        const prefix = stock('2332', '短');
        expectReferences(searchStocks([prefix, alias], '233'), [alias, prefix]);
    });

    it('alias prefix 不會取得只有主名稱 prefix 才有的 -5', () => {
        const alias = stock('1111', '雙字', { aliases: ['台積電相關商品'] });
        const primary = stock('2222', '台積公司長');
        expectReferences(searchStocks([alias, primary], '台積'), [primary, alias]);
    });

    it('正規化相同的全形／空白名稱仍以 raw name.length 計分', () => {
        const padded = stock('1111', ' Ａ ');
        const plain = stock('2222', 'A');
        expectReferences(searchStocks([padded, plain], 'Ａ'), [plain, padded]);
        const expanded = stock('3333', 'ß');
        const ascii = stock('4444', 'SS');
        expectReferences(searchStocks([ascii, expanded], 'ss'), [expanded, ascii]);
    });

    it('raw code.length 而非正規化代碼長度決定四碼加分', () => {
        const padded = stock(' 1234 ', '同名');
        const plain = stock('1234', '同名');
        expectReferences(searchStocks([padded, plain], '123'), [plain, padded]);
    });
});

describe('任意 mutable index 的每次呼叫都讀取目前內容', () => {
    it.each([
        ['name', (row: StockMeta) => { row.name = '新名稱'; }, '新名稱'],
        ['code', (row: StockMeta) => { row.code = 'NEW1'; }, 'new1'],
        ['same-length alias replacement', (row: StockMeta) => { row.aliases![0] = '新別名'; }, '新別名'],
        ['alias push', (row: StockMeta) => { row.aliases!.push('新增別名'); }, '新增別名'],
        ['alias splice', (row: StockMeta) => { row.aliases!.splice(0, 1, '替換別名'); }, '替換別名'],
        ['replace aliases array', (row: StockMeta) => { row.aliases = ['另一別名']; }, '另一別名'],
    ] as const)('%s 修改不會命中舊正規化內容', (_label, mutate, query) => {
        const row = stock('OLD1', '舊名稱', { aliases: ['舊別名'] });
        const index = [row];
        for (let indexCall = 0; indexCall < 3; indexCall++) searchStocks(index, query);
        mutate(row);
        expectReferences(searchStocks(index, query), [row]);
    });

    it('刪除 aliases 後不再匹配先前別名', () => {
        const row = stock('1111', '主名稱', { aliases: ['舊別名'] });
        const index = [row];
        expectReferences(searchStocks(index, '舊別名'), [row]);
        delete row.aliases;
        expectReferences(searchStocks(index, '舊別名'), []);
    });

    it('alias 原地刪除產生的空槽仍遵循既有 Array 比對語意', () => {
        const row = stock('1111', '主名稱', { aliases: ['舊別名', '目前別名'] });
        const index = [row];
        expectReferences(searchStocks(index, '舊別名'), [row]);
        delete row.aliases![0];
        expectReferences(searchStocks(index, '舊別名'), []);
        expectReferences(searchStocks(index, '目前別名'), [row]);
    });

    it('kind 與 exchange 的原地修改立即改變既有 ETF 排序', () => {
        const series = stock('00981B', '基金名稱較長');
        const exactName = stock('1111', '00981');
        const index = [exactName, series];
        expectReferences(searchStocks(index, '00981'), [exactName, series]);
        series.kind = 'ETF';
        expectReferences(searchStocks(index, '00981'), [series, exactName]);
        const other = stock('00981B', '基金名稱較長', { kind: 'ETF', exchange: 'OTC' });
        index.push(other);
        expectReferences(searchStocks(index, '00981'), [other, series, exactName]);
        series.exchange = 'AAA';
        expectReferences(searchStocks(index, '00981'), [series, other, exactName]);
    });

    it('同分保持目前 index 順序，reverse/splice 後逐位回傳目前原物件', () => {
        const a = stock('1111', '同名');
        const b = stock('2222', '同名');
        const c = stock('3333', '同名');
        const index = [a, b];
        expectReferences(searchStocks(index, '同名'), [a, b]);
        index.reverse();
        expectReferences(searchStocks(index, '同名'), [b, a]);
        index.splice(0, 1, c);
        expectReferences(searchStocks(index, '同名'), [c, a]);
    });

    it('不寫入凍結的 index/rows/aliases，並保留既有 slice limit 語意', () => {
        const rows = [stock('1111', '同名', { aliases: ['臺灣'] }), stock('2222', '同名')];
        Object.freeze(rows[0]!.aliases);
        rows.forEach(Object.freeze);
        Object.freeze(rows);
        expectReferences(searchStocks(rows, '同名', -1), [rows[0]!]);
        expectReferences(searchStocks(rows, '同名', 1.5), [rows[0]!]);
        expectReferences(searchStocks(rows, '同名', Number.NaN), []);
        expectReferences(searchStocks(rows, '同名', Infinity), rows);
        expectReferences(searchStocks(rows, '臺灣'), [rows[0]!]);
    });
});
