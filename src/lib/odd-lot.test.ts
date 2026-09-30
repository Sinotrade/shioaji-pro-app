// 零股共用規則（#204）：條件組合、單位換算、風控與送出前的最後檢查
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('window', new EventTarget());
const store = new Map<string, string>();
vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
const api = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('./api', () => ({ apiPost: api.post, apiGet: vi.fn(), apiPut: vi.fn(), apiDelete: vi.fn() }));

const odd = await import('./odd-lot');
const { checkOrderAllowed, setRiskSettings } = await import('./risk');

afterEach(() => setRiskSettings({ enabled: false, maxQty: 0, locked: false }));

const lmt = { price_type: 'LMT', order_type: 'ROD' } as const;

describe('stockOrderProblem', () => {
    it('accepts cash odd-lot limit ROD orders of 1–999 shares, both sessions', () => {
        for (const lot of ['IntradayOdd', 'Odd'] as const) {
            expect(odd.stockOrderProblem({ ...lmt, quantity: 1, order_lot: lot })).toBeNull();
            expect(odd.stockOrderProblem({ ...lmt, quantity: 999, order_lot: lot, order_cond: 'Cash' })).toBeNull();
        }
    });
    it('blocks margin, short, SBL and day-trade with a plain explanation', () => {
        for (const cond of ['MarginTrading', 'ShortSelling', 'SBLShort', 'SBLShortPriceExempt']) {
            expect(odd.stockOrderProblem({ ...lmt, quantity: 100, order_lot: 'IntradayOdd', order_cond: cond })).toBe(odd.ODD_LOT_TEXT.cond);
        }
        expect(odd.stockOrderProblem({ ...lmt, quantity: 100, order_lot: 'Odd', daytrade_short: true })).toBe(odd.ODD_LOT_TEXT.daytrade);
    });
    it('blocks market, IOC/FOK and out-of-range share counts', () => {
        expect(odd.stockOrderProblem({ quantity: 100, order_lot: 'IntradayOdd', price_type: 'MKT', order_type: 'IOC' })).toBe(odd.ODD_LOT_TEXT.priceType);
        expect(odd.stockOrderProblem({ ...lmt, order_type: 'FOK', quantity: 100, order_lot: 'IntradayOdd' })).toBe(odd.ODD_LOT_TEXT.orderType);
        for (const q of [0, 1000, 1.5]) expect(odd.stockOrderProblem({ ...lmt, quantity: q, order_lot: 'IntradayOdd' })).toBe(odd.ODD_LOT_TEXT.quantity);
    });
    it('leaves whole-lot orders to the existing rules', () => {
        expect(odd.stockOrderProblem({ quantity: 5, order_lot: 'Common', price_type: 'MKT', order_type: 'IOC', order_cond: 'MarginTrading' })).toBeNull();
        expect(odd.stockOrderProblem({ quantity: 5 })).toBeNull();
    });
});

describe('units', () => {
    it('labels and converts lots and shares', () => {
        expect(odd.orderQtyUnit(false, 'IntradayOdd')).toBe('股');
        expect(odd.orderQtyUnit(false, 'Odd')).toBe('股');
        expect(odd.orderQtyUnit(false, 'Common')).toBe('張');
        expect(odd.orderQtyUnit(true, 'IntradayOdd')).toBe('口');
        expect(odd.lotLabel('IntradayOdd')).toBe('盤中零股');
        expect(odd.lotLabel('Odd')).toBe('盤後零股');
        expect(odd.sharesToUnits(1500, 'Common')).toBe(1);
        expect(odd.sharesToUnits(1500, 'IntradayOdd')).toBe(1500);
        expect(odd.unitsToShares(2, 'Common')).toBe(2000);
        expect(odd.riskLots(500, 'IntradayOdd')).toBe(0.5);
        expect(odd.clampLotQuantity(5000, 'IntradayOdd')).toBe(999);
        expect(odd.clampLotQuantity(0, 'Common')).toBe(1);
    });
    it('uses the price limit as the marketable limit price', () => {
        const c = { limit_up: 110, limit_down: 90 };
        expect(odd.oddLotMarketablePrice(c, 'Sell')).toBe(90);
        expect(odd.oddLotMarketablePrice(c, 'Buy')).toBe(110);
        expect(odd.oddLotMarketablePrice({ limit_up: 0 }, 'Buy')).toBeNull();
    });
});

describe('shared risk checks', () => {
    it('compares odd lots against the per-order cap in 張', () => {
        setRiskSettings({ enabled: true, maxQty: 1 });
        expect(checkOrderAllowed(999, 'IntradayOdd')).toBeNull();
        expect(checkOrderAllowed(2)).toBe('超過單筆上限 1（本筆 2）');
        setRiskSettings({ enabled: true, maxQty: 0.5 });
        expect(checkOrderAllowed(600, 'IntradayOdd')).toBe('超過單筆上限 0.5 張（本筆 600 股）');
    });
    it('the kill switch blocks odd lots too', () => {
        setRiskSettings({ locked: true });
        expect(checkOrderAllowed(1, 'IntradayOdd')).toContain('風控鎖');
    });
});

describe('placeStockOrder last check', () => {
    it('refuses an unsupported odd-lot combination before anything is sent', async () => {
        const { placeStockOrder } = await import('./shioaji');
        const contract = { code: '2330', security_type: 'STK', exchange: 'TSE' } as never;
        await expect(placeStockOrder(contract, { action: 'Buy', price: 1000, quantity: 100, price_type: 'LMT', order_type: 'ROD',
            order_lot: 'IntradayOdd', order_cond: 'MarginTrading' })).rejects.toMatchObject({ mutationNotStarted: true, message: odd.ODD_LOT_TEXT.cond });
        await expect(placeStockOrder(contract, { action: 'Sell', price: 0, quantity: 100, price_type: 'MKT', order_type: 'IOC',
            order_lot: 'Odd' })).rejects.toMatchObject({ mutationNotStarted: true, message: odd.ODD_LOT_TEXT.priceType });
        expect(api.post).not.toHaveBeenCalled();
    });
});
