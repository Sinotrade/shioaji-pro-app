// #204 K 線圖下單設定：正規化、各商品顯示的選項、按鈕／提示／摘要文字與送單參數
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    chartEffective, chartExitBlocked, chartModeHint, chartOrderChipLabel, chartOrderRows, chartOrderSummary, chartPlaceOptions, chartTriggerFields,
    loadChartOrderDefault, normalizeChartOrder, OCTYPES, saveChartOrderDefault,
} from './chart-order-settings';

beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
});

describe('chart order settings', () => {
    it('normalizes per market: odd lot is ROD-only and 1–999 shares, futures have no odd lot, stocks no 開平倉', () => {
        expect(normalizeChartOrder({ lot: 'IntradayOdd', orderType: 'IOC', qty: 1500 }, 'S')).toEqual({ qty: 999, lot: 'IntradayOdd', orderType: 'IOC', octype: 'Auto' });
        expect(normalizeChartOrder({ lot: 'IntradayOdd', octype: 'Cover', qty: 3 }, 'F')).toEqual({ qty: 3, lot: 'Common', orderType: 'ROD', octype: 'Cover' });
        expect(normalizeChartOrder({ octype: 'Cover', orderType: 'FOK', qty: 0 }, 'S')).toEqual({ qty: 1, lot: 'Common', orderType: 'FOK', octype: 'Auto' });
    });

    it('shows only the options that apply', () => {
        expect(chartOrderRows('S', 'Common')).toEqual({ unit: true, orderType: true, octype: false, credit: true });
        expect(chartOrderRows('S', 'IntradayOdd')).toEqual({ unit: true, orderType: false, octype: false, credit: true });
        expect(chartOrderRows('F', 'Common')).toEqual({ unit: false, orderType: true, octype: true, credit: false });
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

// 圖表下單的信用條件、現股當沖先賣、期貨當沖倉別（同下單面板與閃電）
describe('chart order credit and day-trade conditions', () => {
    it('keeps a stock credit per chart (also while odd lot suspends it); futures never carry one', () => {
        expect(normalizeChartOrder({ credit: { cond: 'MarginTrading', daytradeShort: false } }, 'S').credit).toEqual({ cond: 'MarginTrading', daytradeShort: false });
        expect(normalizeChartOrder({ lot: 'IntradayOdd', credit: { cond: 'ShortSelling', daytradeShort: false } }, 'S').credit).toEqual({ cond: 'ShortSelling', daytradeShort: false });
        // 當沖先賣只限現股
        expect(normalizeChartOrder({ credit: { cond: 'MarginTrading', daytradeShort: true } as never }, 'S').credit).toEqual({ cond: 'MarginTrading', daytradeShort: false });
        expect(normalizeChartOrder({ credit: { cond: 'Cash', daytradeShort: true } }, 'S').credit).toEqual({ cond: 'Cash', daytradeShort: true });
        // 現股（預設）不存
        expect(normalizeChartOrder({ credit: { cond: 'Cash', daytradeShort: false } }, 'S')).not.toHaveProperty('credit');
        expect(normalizeChartOrder({ credit: { cond: 'Bogus' } as never }, 'S')).not.toHaveProperty('credit');
        expect(normalizeChartOrder({ credit: { cond: 'MarginTrading', daytradeShort: false } }, 'F')).not.toHaveProperty('credit');
    });

    it('odd lot suspends the order type and credit without overwriting them; back to 張 restores both', () => {
        const odd = normalizeChartOrder({ lot: 'IntradayOdd', orderType: 'IOC', credit: { cond: 'MarginTrading', daytradeShort: false } }, 'S');
        expect(odd.orderType).toBe('IOC');
        expect(chartEffective(odd, 'S')).toEqual({ orderType: 'ROD', octype: undefined, credit: { cond: 'Cash', daytradeShort: false } });
        expect(chartPlaceOptions(odd, 'S')).toEqual({ orderLot: 'IntradayOdd' });
        const back = normalizeChartOrder({ ...odd, lot: 'Common' }, 'S');
        expect(chartEffective(back, 'S')).toEqual({ orderType: 'IOC', octype: undefined, credit: { cond: 'MarginTrading', daytradeShort: false } });
    });

    it('offers 當沖 among the futures 倉別 and sends it with orders and stops', () => {
        expect(OCTYPES.map(o => o.value)).toEqual(['Auto', 'New', 'Cover', 'DayTrade']);
        const dt = normalizeChartOrder({ octype: 'DayTrade' }, 'F');
        expect(dt.octype).toBe('DayTrade');
        expect(chartPlaceOptions(dt, 'F')).toEqual({ ocType: 'DayTrade' });
        expect(chartTriggerFields(dt, 'F')).toEqual({ octype: 'DayTrade' });
        expect(chartOrderChipLabel(dt, 'F')).toBe('1 口·當沖');
    });

    it('the chip shows a non-default condition: 1 張·融資, 現沖, 借豁; odd lots stay plain', () => {
        const s = (credit: object, extra: object = {}) => normalizeChartOrder({ credit, ...extra } as never, 'S');
        expect(chartOrderChipLabel(s({ cond: 'MarginTrading', daytradeShort: false }), 'S')).toBe('1 張·融資');
        expect(chartOrderChipLabel(s({ cond: 'ShortSelling', daytradeShort: false }, { qty: 2 }), 'S')).toBe('2 張·融券');
        expect(chartOrderChipLabel(s({ cond: 'SBLShortPriceExempt', daytradeShort: false }), 'S')).toBe('1 張·借豁');
        expect(chartOrderChipLabel(s({ cond: 'Cash', daytradeShort: true }), 'S')).toBe('1 張·現沖');
        expect(chartOrderChipLabel(s({ cond: 'MarginTrading', daytradeShort: false }, { lot: 'IntradayOdd', qty: 500 }), 'S')).toBe('500 股');
    });

    it('sends the credit condition with 點價 orders (整股 only)', () => {
        expect(chartPlaceOptions(normalizeChartOrder({ credit: { cond: 'MarginTrading', daytradeShort: false } }, 'S'), 'S'))
            .toEqual({ orderCond: 'MarginTrading' });
        expect(chartPlaceOptions(normalizeChartOrder({ credit: { cond: 'Cash', daytradeShort: true }, orderType: 'IOC' }, 'S'), 'S'))
            .toEqual({ orderType: 'IOC', daytradeShort: true });
        // 停損停利不帶信用條件（觸價單只送現股）
        expect(chartTriggerFields(normalizeChartOrder({ credit: { cond: 'MarginTrading', daytradeShort: false } }, 'S'), 'S')).toEqual({});
    });

    it('stop/take are off while a credit condition applies (they only send cash orders)', () => {
        expect(chartExitBlocked(normalizeChartOrder({ credit: { cond: 'MarginTrading', daytradeShort: false } }, 'S'), 'S')).toMatch(/停損停利.*現股/);
        expect(chartExitBlocked(normalizeChartOrder({ credit: { cond: 'Cash', daytradeShort: true } }, 'S'), 'S')).toMatch(/停損停利/);
        expect(chartExitBlocked(normalizeChartOrder({ lot: 'IntradayOdd', credit: { cond: 'MarginTrading', daytradeShort: false } }, 'S'), 'S')).toBeNull();
        expect(chartExitBlocked(normalizeChartOrder({}, 'S'), 'S')).toBeNull();
        expect(chartExitBlocked(normalizeChartOrder({ octype: 'DayTrade' }, 'F'), 'F')).toBeNull();
    });

    it('rows: the credit row shows for stocks (disabled while odd lot), never for futures', () => {
        expect(chartOrderRows('S', 'Common')).toMatchObject({ credit: true });
        expect(chartOrderRows('S', 'IntradayOdd')).toMatchObject({ credit: true });
        expect(chartOrderRows('F', 'Common')).toMatchObject({ credit: false });
    });

    it('summary and hint name the condition a click sends', () => {
        const margin = normalizeChartOrder({ qty: 2, credit: { cond: 'MarginTrading', daytradeShort: false } }, 'S');
        expect(chartOrderSummary(margin, 'S', '••••21')).toContain('融資');
        expect(chartModeHint('buy', margin, 'S')).toBe('點擊價位 → 融資限價買進 2 張');
        expect(chartModeHint('sell', margin, 'S')).toBe('點擊價位 → 融資限價賣出 2 張');
        const dt = normalizeChartOrder({ credit: { cond: 'Cash', daytradeShort: true } }, 'S');
        expect(chartModeHint('sell', dt, 'S')).toBe('點擊價位 → 現沖限價賣出 1 張');
        expect(chartModeHint('buy', dt, 'S')).toBe('點擊價位 → 限價買進 1 張');
        expect(chartOrderSummary(normalizeChartOrder({ ...dt, orderType: 'IOC' }, 'S'), 'S', '••••21')).toMatch(/^點價買以 IOC 限價現股買進、點價賣以 IOC 限價現沖賣出 1 張/);
        const short = normalizeChartOrder({ credit: { cond: 'ShortSelling', daytradeShort: false } }, 'S');
        expect(chartOrderSummary(short, 'S', '••••21')).toContain('點價買停用');
        expect(chartOrderSummary(normalizeChartOrder({ octype: 'DayTrade' }, 'F'), 'F', '••••07')).toContain('（當沖）');
    });
});
