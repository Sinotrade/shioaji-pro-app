import { describe, expect, it } from 'vitest';

import {
    assertExplicitOrderContract,
    assertFreshOrderQuote,
    assertKnownOrderEnvironment,
    assertProductionOrderIntent,
    assertProductionRiskConfigured,
    assertTradingStreamLive,
    assertUsableOrderQuote,
    assertValidOrderQuantity,
} from './order-safety';
import type { ContractBase } from './types/contract';

const contract = (code: string): ContractBase => ({
    code,
    security_type: 'FUT',
    exchange: 'TAIFEX',
    target_code: code.endsWith('R1') ? 'TXFJ6' : null,
});

describe('order safety preflight', () => {
    it.each([true, false])('accepts an explicit broker environment: %s', (simulation) => {
        expect(assertKnownOrderEnvironment({ simulation })).toBe(simulation);
    });

    it.each([undefined, null, 'false', 0])('rejects an unknown broker environment: %s', (simulation) => {
        expect(() => assertKnownOrderEnvironment({ simulation })).toThrow(
            '無法確認交易環境',
        );
    });

    it('accepts an explicit futures month', () => {
        expect(() => assertExplicitOrderContract(contract('TXFJ6'))).not.toThrow();
    });

    it.each(['TXFR1', 'TXFR2'])('rejects continuous futures aliases even with a target code: %s', (code) => {
        expect(() => assertExplicitOrderContract(contract(code))).toThrow(
            '下單必須使用明確月份契約',
        );
    });

    it('requires a live trading stream', () => {
        expect(() => assertTradingStreamLive('live')).not.toThrow();
        expect(() => assertTradingStreamLive('connecting')).toThrow('非 LIVE');
        expect(() => assertTradingStreamLive('down')).toThrow('非 LIVE');
    });

    it('requires a bounded risk profile only in production', () => {
        const unsafe = {
            enabled: false,
            maxQty: 0,
            maxDailyLoss: 0,
            confirmManualOrders: false,
        };
        expect(() => assertProductionRiskConfigured(true, unsafe)).not.toThrow();
        expect(() => assertProductionRiskConfigured(false, unsafe)).toThrow(
            '正式交易前必須啟用風控',
        );
        expect(() => assertProductionRiskConfigured(false, {
            enabled: true,
            maxQty: 1,
            maxDailyLoss: 5_000,
            confirmManualOrders: true,
        })).not.toThrow();
        expect(() => assertProductionRiskConfigured(false, {
            enabled: true,
            maxQty: 2,
            maxDailyLoss: 5_000,
            confirmManualOrders: true,
        })).toThrow();
        expect(() => assertProductionRiskConfigured(false, {
            enabled: true,
            maxQty: 1,
            maxDailyLoss: 5_001,
            confirmManualOrders: true,
        })).toThrow();
    });

    it('allows only explicitly manual orders in conservative production', () => {
        expect(() => assertProductionOrderIntent(false, 'manual')).not.toThrow();
        expect(() => assertProductionOrderIntent(true, 'automation')).not.toThrow();
        expect(() => assertProductionOrderIntent(false, 'automation')).toThrow('僅允許');
        expect(() => assertProductionOrderIntent(false, 'agent')).toThrow('僅允許');
        expect(() => assertProductionOrderIntent(false)).toThrow('僅允許');
    });

    it.each([0, -1, 1.5, Number.NaN])('rejects invalid order quantities: %s', (quantity) => {
        expect(() => assertValidOrderQuantity(quantity)).toThrow('正整數');
    });

    it('requires a quote received within fifteen seconds', () => {
        expect(() => assertFreshOrderQuote(90_000, 100_000)).not.toThrow();
        expect(() => assertFreshOrderQuote(85_000, 100_000)).not.toThrow();
        expect(() => assertFreshOrderQuote(84_999, 100_000)).toThrow('15 秒內');
        expect(() => assertFreshOrderQuote(undefined, 100_000)).toThrow('15 秒內');
        expect(() => assertFreshOrderQuote(100_001, 100_000)).toThrow('15 秒內');
    });

    it('requires the executable book side for market orders', () => {
        const fresh = 100_000;
        expect(() => assertUsableOrderQuote({
            updatedAt: fresh,
            bidask: { bid_price: ['45900'], ask_price: ['45904'] },
        }, 'Buy', 'MKT', fresh)).not.toThrow();
        expect(() => assertUsableOrderQuote({
            updatedAt: fresh,
            bidask: { bid_price: ['45900'], ask_price: [] },
        }, 'Buy', 'MKT', fresh)).toThrow('賣一');
        expect(() => assertUsableOrderQuote({
            updatedAt: fresh,
            bidask: { bid_price: [], ask_price: ['45904'] },
        }, 'Sell', 'MKP', fresh)).toThrow('買一');
    });

    it('requires at least one valid live price for limit orders', () => {
        const fresh = 100_000;
        expect(() => assertUsableOrderQuote({
            updatedAt: fresh,
            tick: { close: '45902' },
        }, 'Buy', 'LMT', fresh)).not.toThrow();
        expect(() => assertUsableOrderQuote({
            updatedAt: fresh,
            tick: { close: '' },
            bidask: { bid_price: [], ask_price: [] },
        }, 'Buy', 'LMT', fresh)).toThrow('沒有有效');
    });
});
