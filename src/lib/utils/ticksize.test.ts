// 個股期跳動級距回歸（issue #38：閃電下單階梯只出整數價位）—
// tick_rule=tw_stock_fut_price_band 的期貨要照現股級距跳 0.5 等。

import { describe, expect, it } from 'vitest';
import type { ContractBase, ContractInfo } from '../types/contract';
import { roundToTick, stepPrice, tickSizeFor } from './ticksize';

// issue #38 的實際合約資料（聯電期貨 202609）
const ccfi6 = {
    exchange: 'TAIFEX',
    code: 'CCFI6',
    security_type: 'FUT',
    target_code: null,
    tick: 0.5,
    tick_rule: 'tw_stock_fut_price_band',
    underlying_kind: 'S',
    spec_kind: 'stock_fut',
    underlying_code: '2303',
} as ContractBase & Partial<ContractInfo>;

const txf = {
    exchange: 'TAIFEX',
    code: 'TXFI6',
    security_type: 'FUT',
    target_code: null,
    tick: 1,
    underlying_kind: 'I',
} as ContractBase & Partial<ContractInfo>;

describe('tickSizeFor — futures', () => {
    it('個股期 tick_rule=tw_stock_fut_price_band 走現股級距', () => {
        expect(tickSizeFor(ccfi6, 130)).toBe(0.5); // 100–500 band
        expect(tickSizeFor(ccfi6, 99)).toBe(0.1);
        expect(tickSizeFor(ccfi6, 45)).toBe(0.05);
        expect(tickSizeFor(ccfi6, 600)).toBe(1);
        expect(tickSizeFor(ccfi6, 1200)).toBe(5);
    });

    it('指數期維持 1 點', () => {
        expect(tickSizeFor(txf, 24000)).toBe(1);
    });

    it('缺 tick_rule 的舊資料用 underlying_kind=S 判別個股期', () => {
        const legacy = { ...ccfi6, tick_rule: undefined, tick: undefined };
        expect(tickSizeFor(legacy, 130)).toBe(0.5);
    });

    it('缺 tick_rule 也缺 underlying_kind 時 spec_kind=stock_fut 同樣判別', () => {
        const legacy = {
            ...ccfi6,
            tick_rule: undefined,
            tick: undefined,
            underlying_kind: undefined,
        };
        expect(tickSizeFor(legacy, 130)).toBe(0.5);
    });

    it('server tick 為字串時照樣可用（1.7.x 數值字串化容錯）', () => {
        const stringTick = {
            ...txf,
            code: 'ZFFR1',
            underlying_kind: undefined,
            tick: '0.25' as unknown as number,
        };
        expect(tickSizeFor(stringTick, 300)).toBe(0.25);
    });

    it('ETF 期不套現股級距，用 server 提供的 tick', () => {
        const etfFut = {
            ...ccfi6,
            code: 'NYFR1',
            tick_rule: undefined,
            spec_kind: 'etf_fut',
            underlying_code: '0050',
            tick: 0.05,
        };
        expect(tickSizeFor(etfFut, 60)).toBe(0.05);
    });

    it('沒有任何 metadata 的期貨 fallback 到 1 點', () => {
        const bare: ContractBase = {
            exchange: 'TAIFEX',
            code: 'TXFI6',
            security_type: 'FUT',
            target_code: null,
        };
        expect(tickSizeFor(bare, 24000)).toBe(1);
    });
});

describe('stepPrice / roundToTick — 個股期', () => {
    it('階梯以 0.5 遞增（issue #38 預期行為）', () => {
        expect(stepPrice(ccfi6, 118, 1)).toBe(118.5);
        expect(stepPrice(ccfi6, 118.5, 1)).toBe(119);
        expect(stepPrice(ccfi6, 118, -1)).toBe(117.5);
    });

    it('跨 100 元級距邊界換 tick', () => {
        expect(stepPrice(ccfi6, 99.9, 1)).toBe(100);
        expect(stepPrice(ccfi6, 100, 1)).toBe(100.5);
        expect(stepPrice(ccfi6, 100, -1)).toBe(99.9);
    });

    it('roundToTick 對齊 0.5 級距', () => {
        expect(roundToTick(ccfi6, 130.3)).toBe(130.5);
        expect(roundToTick(ccfi6, 130.2)).toBe(130);
    });
});

describe('現股 / ETF 級距不受影響', () => {
    const stk = {
        exchange: 'TSE',
        code: '2330',
        security_type: 'STK',
        target_code: null,
    } as ContractBase;
    const etf = { ...stk, code: '0050' };

    it('現股級距照舊', () => {
        expect(tickSizeFor(stk, 1200)).toBe(5);
        expect(tickSizeFor(stk, 95)).toBe(0.1);
    });

    it('ETF 級距照舊', () => {
        expect(tickSizeFor(etf, 45)).toBe(0.01);
        expect(tickSizeFor(etf, 60)).toBe(0.05);
    });
});
