// #204 K 線圖下單設定：正規化、各商品顯示的選項、按鈕／提示／摘要文字與送單參數
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    chartModeHint, chartOrderChipLabel, chartOrderRows, chartOrderSummary, chartPlaceOptions, chartTriggerFields,
    loadChartOrderDefault, normalizeChartOrder, saveChartOrderDefault,
} from './chart-order-settings';

beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
});

describe('chart order settings', () => {
    it('normalizes per market: odd lot is ROD-only and 1–999 shares, futures have no odd lot, stocks no 開平倉', () => {
        expect(normalizeChartOrder({ lot: 'IntradayOdd', orderType: 'IOC', qty: 1500 }, 'S')).toEqual({ qty: 999, lot: 'IntradayOdd', orderType: 'ROD', octype: 'Auto' });
        expect(normalizeChartOrder({ lot: 'IntradayOdd', octype: 'Cover', qty: 3 }, 'F')).toEqual({ qty: 3, lot: 'Common', orderType: 'ROD', octype: 'Cover' });
        expect(normalizeChartOrder({ octype: 'Cover', orderType: 'FOK', qty: 0 }, 'S')).toEqual({ qty: 1, lot: 'Common', orderType: 'FOK', octype: 'Auto' });
    });

    it('shows only the options that apply', () => {
        expect(chartOrderRows('S', 'Common')).toEqual({ unit: true, orderType: true, octype: false });
        expect(chartOrderRows('S', 'IntradayOdd')).toEqual({ unit: true, orderType: false, octype: false });
        expect(chartOrderRows('F', 'Common')).toEqual({ unit: false, orderType: true, octype: true });
    });

    it('labels the chip with quantity and unit only; the unit tells the lot', () => {
        expect(chartOrderChipLabel(normalizeChartOrder({ qty: 500, lot: 'IntradayOdd' }, 'S'), 'S')).toBe('500 股');
        expect(chartOrderChipLabel(normalizeChartOrder({ qty: 1 }, 'S'), 'S')).toBe('1 張');
        expect(chartOrderChipLabel(normalizeChartOrder({ qty: 2 }, 'F'), 'F')).toBe('2 口');
    });

    it('summarises in one sentence exactly what a click sends', () => {
        const odd = normalizeChartOrder({ qty: 500, lot: 'IntradayOdd' }, 'S');
        expect(chartOrderSummary(odd, 'S', '••••21')).toBe('點價買／賣以 ROD 限價送出 500 股盤中零股，帳號 ••••21；停損停利觸發後以漲跌停價送零股限價 ROD。零股只能現股、ROD 限價。');
        const lot = normalizeChartOrder({ qty: 2, orderType: 'IOC' }, 'S');
        expect(chartOrderSummary(lot, 'S', '跟隨主畫面 ••••21')).toBe('點價買／賣以 IOC 限價送出 2 張，帳號 跟隨主畫面 ••••21；停損停利觸發後以市價送出。');
        const fut = normalizeChartOrder({ qty: 1, octype: 'Cover', orderType: 'FOK' }, 'F');
        expect(chartOrderSummary(fut, 'F', '••••07')).toBe('點價買／賣以 FOK 限價送出 1 口（平倉），帳號 ••••07；停損停利觸發後以市價送出（平倉）。');
    });

    it('hints the armed click in the chip unit', () => {
        const odd = normalizeChartOrder({ qty: 500, lot: 'IntradayOdd' }, 'S');
        expect(chartModeHint('buy', odd, 'S')).toBe('點擊價位 → 限價買進 500 股');
        expect(chartModeHint('sell', normalizeChartOrder({ qty: 3, orderType: 'IOC' }, 'F'), 'F')).toBe('點擊價位 → 限價賣出 IOC 3 口');
        expect(chartModeHint('stop', odd, 'S')).toContain('漲跌停價');
    });

    it('maps to the order and trigger parameters that are actually sent', () => {
        expect(chartPlaceOptions(normalizeChartOrder({ lot: 'IntradayOdd' }, 'S'), 'S')).toEqual({ orderLot: 'IntradayOdd' });
        expect(chartPlaceOptions(normalizeChartOrder({ orderType: 'IOC' }, 'S'), 'S')).toEqual({ orderType: 'IOC' });
        expect(chartPlaceOptions(normalizeChartOrder({ octype: 'New', orderType: 'FOK' }, 'F'), 'F')).toEqual({ orderType: 'FOK', ocType: 'New' });
        expect(chartTriggerFields(normalizeChartOrder({ lot: 'IntradayOdd' }, 'S'), 'S')).toEqual({ orderLot: 'IntradayOdd' });
        expect(chartTriggerFields(normalizeChartOrder({ octype: 'Cover' }, 'F'), 'F')).toEqual({ octype: 'Cover' });
        expect(chartTriggerFields(normalizeChartOrder({}, 'S'), 'S')).toEqual({});
    });

    it('saves a default per instrument class without the account', () => {
        saveChartOrderDefault('S', normalizeChartOrder({ qty: 500, lot: 'IntradayOdd', accountKey: 'S:x:y' }, 'S'));
        expect(loadChartOrderDefault('S')).toEqual({ qty: 500, lot: 'IntradayOdd', orderType: 'ROD', octype: 'Auto' });
        expect(loadChartOrderDefault('F')).toEqual({ qty: 1, lot: 'Common', orderType: 'ROD', octype: 'Auto' });
    });
});
