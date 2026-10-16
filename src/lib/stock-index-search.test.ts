import { describe, expect, it } from 'vitest';
import { searchStocks } from './stock-index';

const catalog = [
    { code: '2330', name: '台積電', category: '', exchange: 'TSE' },
    { code: 'TSMC', name: '臺積電相關商品', category: '', exchange: 'TSE' },
    { code: '1301', name: '台塑', category: '', exchange: 'TSE' },
];

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
