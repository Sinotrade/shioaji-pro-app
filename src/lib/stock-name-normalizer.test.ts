import { describe, expect, it } from 'vitest';
import { normalizeStockNames } from './stock-name-normalizer';

// Synthetic issuer data exercises schema handling, not current market listings.
const tse = (code = '2330', name = ' 合成簡稱 ', full = ' 合成股份有限公司 ', date = '1151017') => ({
    公司代號: code, 公司簡稱: name, 公司名稱: full, 出表日期: date,
});
const otc = (code = '3456') => ({ SecuritiesCompanyCode: code, CompanyAbbreviation: '合成上櫃', CompanyName: '合成上櫃公司', Date: '1151017' });
const day = '2026-10-17';

describe('ordinary issuer source field projection', () => {
    it('projects only names, identity and source date, preserving trimmed original text', () => {
        const result = normalizeStockNames([{ ...tse(), 公司簡稱: ' ＡＢＣ臺灣 ', 公司名稱: ' ＡＢＣ臺灣股份有限公司 ', 聯絡電話: 'DO NOT RETAIN', price: 999 }], 'TSE', day);
        expect(result).toEqual({ entries: [{ code: '2330', exchange: 'TSE', name: 'ＡＢＣ臺灣', aliases: ['ＡＢＣ臺灣股份有限公司'], sourceDate: day }],
            sourceDate: day, invalidRows: 0, conflictingCodes: 0 });
        expect(Object.isFrozen(result.entries[0])).toBe(true);
        expect(Object.isFrozen(result.entries[0]!.aliases)).toBe(true);
        expect(Object.isFrozen(result.entries)).toBe(true);
    });

    it.each(['OTC', 'OES'] as const)('accepts the verified English schema for %s', exchange => {
        expect(normalizeStockNames([otc()], exchange, day).entries[0]).toMatchObject({ exchange, code: '3456', name: '合成上櫃' });
    });

    it('filters ETF-like/other identities, discards malformed in-range rows and counts them', () => {
        const result = normalizeStockNames([tse(), tse('0050'), tse('0056'), tse('2330A'), tse('12345'), tse('4321', ''), tse('6543', 'bad\nname'), tse('8765', 'x'.repeat(201))], 'TSE', day);
        expect(result.entries.map(row => row.code)).toEqual(['2330']);
        expect(result.invalidRows).toBe(3);
    });

    it('drops only a conflicting code, even if a third duplicate agrees with its first name', () => {
        const result = normalizeStockNames([tse('2330', '甲'), tse('2330', '乙'), tse('2330', '甲'), tse('3456'), tse('3456')], 'TSE', day);
        expect(result.entries.map(row => row.code)).toEqual(['3456']);
        expect(result.conflictingCodes).toBe(1);
    });

    it.each([null, {}, [], [null], [{}], [{ 公司代號: '2330' }], [tse('0050')]])('rejects empty or invalid source schema %j', payload => {
        expect(() => normalizeStockNames(payload, 'TSE', day)).toThrow();
    });

    it.each(['1150230', '1150229', '1151301', '1150001', '0001017', '1151017\n', '1151019', 'not-date', ''])('rejects invalid or beyond tomorrow date %s for the source', date => {
        expect(() => normalizeStockNames([tse(), tse('3456', '甲', '甲公司', date)], 'TSE', day)).toThrow(/date/);
    });

    it('accepts ROC conversion, tomorrow and valid leap dates', () => {
        expect(normalizeStockNames([tse()], 'TSE', day).sourceDate).toBe(day);
        expect(normalizeStockNames([tse('2330', '甲', '甲公司', '1151018')], 'TSE', day).sourceDate).toBe('2026-10-18');
        expect(normalizeStockNames([tse('2330', '甲', '甲公司', '1130229')], 'TSE', day).sourceDate).toBe('2024-02-29');
    });

    it('accepts exactly 10% shrink but rejects more than 10%', () => {
        const rows = Array.from({ length: 10 }, (_, i) => tse(String(2300 + i)));
        expect(normalizeStockNames(rows.slice(0, 9), 'TSE', day, 10).entries).toHaveLength(9);
        expect(() => normalizeStockNames(rows.slice(0, 8), 'TSE', day, 10)).toThrow(/shrank/);
    });
});
