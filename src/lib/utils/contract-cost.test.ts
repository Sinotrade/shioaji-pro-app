import { describe, expect, it } from 'vitest';
import {
    resolvePriceShortcuts,
    stockOrderNotional,
    validShortcutPrice,
} from './contract-cost';

describe('stock order notional', () => {
    it('uses entered limit price times round-lot shares', () => {
        expect(stockOrderNotional(2385, 1, false)).toBe(2_385_000);
    });

    it('uses shares directly for odd-lot stock orders', () => {
        expect(stockOrderNotional(2385, 240, true)).toBe(572_400);
    });

    it('matches the limit-up shortcut example (2640 x 1 lot = 2,640,000)', () => {
        expect(stockOrderNotional(2640, 1, false)).toBe(2_640_000);
    });
});

describe('validShortcutPrice', () => {
    it('accepts a positive finite number', () => {
        expect(validShortcutPrice(2640)).toBe(2640);
    });

    it('rejects 0 — the backend uses 0 to mean "no verified value", never a real limit', () => {
        expect(validShortcutPrice(0)).toBeNull();
    });

    it('rejects negative, NaN, undefined and null', () => {
        expect(validShortcutPrice(-5)).toBeNull();
        expect(validShortcutPrice(NaN)).toBeNull();
        expect(validShortcutPrice(undefined)).toBeNull();
        expect(validShortcutPrice(null)).toBeNull();
    });
});

describe('resolvePriceShortcuts', () => {
    it('reads limit_up/limit_down from the contract and bid1/ask1 from bidask', () => {
        const result = resolvePriceShortcuts(
            { limit_up: 2615, limit_down: 2145 },
            { bid_price: ['2380', '2375'], ask_price: ['2385', '2390'] },
        );
        expect(result).toEqual({
            limitUp: 2615,
            limitDown: 2145,
            bid1: 2380,
            ask1: 2385,
        });
    });

    it('disables the upper/lower-limit shortcuts when KGI reports 0 (unavailable, e.g. an actively-managed ETF with no price limit)', () => {
        const result = resolvePriceShortcuts(
            { limit_up: 0, limit_down: 0 },
            { bid_price: ['9.87'], ask_price: ['9.88'] },
        );
        expect(result.limitUp).toBeNull();
        expect(result.limitDown).toBeNull();
        expect(result.bid1).toBe(9.87);
        expect(result.ask1).toBe(9.88);
    });

    it('disables bid1/ask1 when no bidask snapshot has streamed yet', () => {
        const result = resolvePriceShortcuts(
            { limit_up: 2615, limit_down: 2145 },
            undefined,
        );
        expect(result.bid1).toBeNull();
        expect(result.ask1).toBeNull();
    });

    it('never carries a previous symbol\'s values into the next call (no shared cache)', () => {
        const tsmc = resolvePriceShortcuts(
            { limit_up: 2615, limit_down: 2145 },
            { bid_price: ['2380'], ask_price: ['2385'] },
        );
        const mediatek = resolvePriceShortcuts(
            { limit_up: 4085, limit_down: 3345 },
            { bid_price: ['3820'], ask_price: ['3830'] },
        );
        expect(tsmc).toEqual({
            limitUp: 2615,
            limitDown: 2145,
            bid1: 2380,
            ask1: 2385,
        });
        expect(mediatek).toEqual({
            limitUp: 4085,
            limitDown: 3345,
            bid1: 3820,
            ask1: 3830,
        });
    });
});
