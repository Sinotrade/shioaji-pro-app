// FUT/OPT 級距回歸（issue #38 系列）— 級距以 server tick-bands 為權威：
// 個股期 500–2500 元跳 1、2500 以上才跳 5（非現股表的 1000 分界），
// TXO 權利金 50–500 點跳 1。bands 未載入時 fallback contract.tick。

import { beforeEach, describe, expect, it } from 'vitest';
import { clearTickBands, setTickBands } from '../tick-bands';
import type { ContractBase, ContractInfo } from '../types/contract';
import { roundToTick, stepPrice, tickSizeFor } from './ticksize';

// server 實際回應（/data/contracts/tick-bands/tw_stock_fut_price_band）
const STOCK_FUT_BANDS = [
    { min: 0, max: 10, tick: 0.01 },
    { min: 10, max: 50, tick: 0.05 },
    { min: 50, max: 100, tick: 0.1 },
    { min: 100, max: 500, tick: 0.5 },
    { min: 500, max: 2500, tick: 1 },
    { min: 2500, max: null, tick: 5 },
];

// server 實際回應（tw_txo_premium_band）
const TXO_BANDS = [
    { min: 0, max: 10, tick: 0.1 },
    { min: 10, max: 50, tick: 0.5 },
    { min: 50, max: 500, tick: 1 },
    { min: 500, max: 1000, tick: 5 },
    { min: 1000, max: null, tick: 10 },
];

// issue #38 的實際合約資料（聯電期貨 202609）
const ccfi6 = {
    exchange: 'TAIFEX',
    code: 'CCFI6',
    security_type: 'FUT',
    target_code: null,
    tick: 0.5,
    tick_rule: 'tw_stock_fut_price_band',
    underlying_kind: 'S',
} as ContractBase & Partial<ContractInfo>;

const txf = {
    exchange: 'TAIFEX',
    code: 'TXFI6',
    security_type: 'FUT',
    target_code: null,
    tick: 1,
    underlying_kind: 'I',
} as ContractBase & Partial<ContractInfo>;

const txo = {
    exchange: 'TAIFEX',
    code: 'TXO21800I6',
    security_type: 'OPT',
    target_code: null,
    tick: 10,
    tick_rule: 'tw_txo_premium_band',
} as ContractBase & Partial<ContractInfo>;

beforeEach(() => {
    clearTickBands();
    setTickBands('tw_stock_fut_price_band', STOCK_FUT_BANDS);
    setTickBands('tw_txo_premium_band', TXO_BANDS);
});

describe('tickSizeFor — 個股期 tick-bands', () => {
    it('各級距帶照 server 表（含 2500 分界，非現股表的 1000）', () => {
        expect(tickSizeFor(ccfi6, 5)).toBe(0.01);
        expect(tickSizeFor(ccfi6, 45)).toBe(0.05);
        expect(tickSizeFor(ccfi6, 99)).toBe(0.1);
        expect(tickSizeFor(ccfi6, 130)).toBe(0.5);
        expect(tickSizeFor(ccfi6, 600)).toBe(1);
        expect(tickSizeFor(ccfi6, 1200)).toBe(1); // 現股表在此是 5 — 個股期是 1
        expect(tickSizeFor(ccfi6, 2400)).toBe(1);
        expect(tickSizeFor(ccfi6, 2600)).toBe(5);
    });

    it('bands 未載入 fallback 到 server 給的 tick', () => {
        clearTickBands();
        expect(tickSizeFor(ccfi6, 130)).toBe(0.5);
    });

    it('server tick 為字串時照樣可用（1.7.x 數值字串化容錯）', () => {
        clearTickBands();
        const stringTick = {
            ...ccfi6,
            tick: '0.5' as unknown as number,
        };
        expect(tickSizeFor(stringTick, 130)).toBe(0.5);
    });

    it('無任何 metadata 的舊資料：underlying_kind=S 用現股表、其餘 1 點', () => {
        clearTickBands();
        const legacy = { ...ccfi6, tick_rule: undefined, tick: undefined };
        expect(tickSizeFor(legacy, 130)).toBe(0.5);
        const bare: ContractBase = {
            exchange: 'TAIFEX',
            code: 'TXFI6',
            security_type: 'FUT',
            target_code: null,
        };
        expect(tickSizeFor(bare, 24000)).toBe(1);
    });
});

describe('tickSizeFor — 指數期與選擇權', () => {
    it('fixed basis 指數期吃 tick=1', () => {
        expect(tickSizeFor(txf, 24000)).toBe(1);
    });

    it('TXO premium band 照 server 表（修正舊寫死的 >=10→1）', () => {
        expect(tickSizeFor(txo, 5)).toBe(0.1);
        expect(tickSizeFor(txo, 30)).toBe(0.5); // 舊邏輯錯給 1
        expect(tickSizeFor(txo, 200)).toBe(1);
        expect(tickSizeFor(txo, 600)).toBe(5);
        expect(tickSizeFor(txo, 1500)).toBe(10);
    });

    it('OPT 無 metadata 舊資料維持舊 fallback', () => {
        clearTickBands();
        const legacyOpt = { ...txo, tick_rule: undefined, tick: undefined };
        expect(tickSizeFor(legacyOpt, 30)).toBe(1);
        expect(tickSizeFor(legacyOpt, 5)).toBe(0.1);
    });
});

describe('stepPrice / roundToTick — 個股期', () => {
    it('階梯以 0.5 遞增（issue #38 預期行為）', () => {
        expect(stepPrice(ccfi6, 118, 1)).toBe(118.5);
        expect(stepPrice(ccfi6, 118.5, 1)).toBe(119);
        expect(stepPrice(ccfi6, 118, -1)).toBe(117.5);
    });

    it('跨級距邊界換 tick（100 與 2500 分界）', () => {
        expect(stepPrice(ccfi6, 99.9, 1)).toBe(100);
        expect(stepPrice(ccfi6, 100, 1)).toBe(100.5);
        expect(stepPrice(ccfi6, 100, -1)).toBe(99.9);
        expect(stepPrice(ccfi6, 2499, 1)).toBe(2500);
        expect(stepPrice(ccfi6, 2500, 1)).toBe(2505);
        expect(stepPrice(ccfi6, 2500, -1)).toBe(2499);
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

    it('現股級距照舊（現股 1000 以上跳 5）', () => {
        expect(tickSizeFor(stk, 1200)).toBe(5);
        expect(tickSizeFor(stk, 95)).toBe(0.1);
    });

    it('ETF 級距照舊', () => {
        expect(tickSizeFor(etf, 45)).toBe(0.01);
        expect(tickSizeFor(etf, 60)).toBe(0.05);
    });
});
