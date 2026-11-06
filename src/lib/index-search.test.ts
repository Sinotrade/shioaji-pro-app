import { describe, expect, it } from 'vitest';
import { INDEX_SEARCH_ENTRIES, indexSearchSuggestions } from './index-search';

describe('已驗證指數的名稱搜尋', () => {
    it.each(['櫃買', '櫃買指數', 'ix0043', 'OTC'])('%s 優先回傳 OTC 的櫃買指數', query => {
        expect(indexSearchSuggestions(query)[0]).toMatchObject({
            code: 'IX0043', name: '櫃買指數', security_type: 'IND', exchange: 'OTC',
        });
    });

    it.each([
        ['加權', 'IX0001'], ['半導體', 'IX0028'], ['未含金融', 'IX0007'], ['未含電子', 'IX0008'],
    ])('%s 保留正確的上市指數', (query, code) => {
        expect(indexSearchSuggestions(query)).toContainEqual(expect.objectContaining({ code, exchange: 'TSE' }));
    });

    it('櫃買類股不誤用上市類股代碼或交易所', () => {
        expect(indexSearchSuggestions('櫃買半導體')).toEqual([
            expect.objectContaining({ code: 'IX0053', exchange: 'OTC' }),
        ]);
    });

    it.each(['臺指選擇權波動率', '台指選擇權波動率', 'taiwanvix', 'VIX'])('%s 正確保留 TAIFEX 指數身分', query => {
        expect(indexSearchSuggestions(query)[0]).toMatchObject({ code: 'TAIWANVIX', exchange: 'TAIFEX' });
    });

    it.each([['ＶＩＸ', 'TAIWANVIX'], ['ｉｘ００４３', 'IX0043'], ['櫃買　', 'IX0043']])('全形 %s 與股票搜尋同樣正規化', (query, code) => {
        expect(indexSearchSuggestions(query)[0]?.code).toBe(code);
    });

    it('保留既有上市指數舊代碼的正規化，不將股票 2330 當成指數', () => {
        expect(indexSearchSuggestions('036')[0]?.code).toBe('IX0028');
        expect(indexSearchSuggestions('2330')).toEqual([]);
    });

    it('空白與不匹配的字串不回傳任意指數，清單沒有重複代碼', () => {
        expect(indexSearchSuggestions('   ')).toEqual([]);
        expect(indexSearchSuggestions('不存在的指數')).toEqual([]);
        expect(new Set(INDEX_SEARCH_ENTRIES.map(entry => entry.code)).size).toBe(INDEX_SEARCH_ENTRIES.length);
    });
});
