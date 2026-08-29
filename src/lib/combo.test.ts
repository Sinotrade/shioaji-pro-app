// src/lib/combo.test.ts — managed 組合單 canonical 規則（issue #32）
// 對照 shioaji 1.7.3 skill COMBO_ORDERS.md 的官方表格逐項驗證

import { describe, expect, it } from 'vitest';
import {
    comboCoefs,
    comboMonthsLabel,
    deriveOptionShape,
    legActionsFor,
    orderFuturesLegs,
    syntheticComboQuote,
} from './combo';
import type { ContractInfo } from './types/contract';

const opt = (
    code: string,
    strike: number,
    right: 'C' | 'P',
    month = '202609',
): ContractInfo =>
    ({
        code,
        name: code,
        security_type: 'OPT',
        exchange: 'TAIFEX',
        target_code: null,
        category: 'TXO',
        strike_price: strike,
        option_right: right,
        delivery_month: month,
    }) as unknown as ContractInfo;

const fut = (code: string, month: string): ContractInfo =>
    ({
        code,
        name: code,
        security_type: 'FUT',
        exchange: 'TAIFEX',
        target_code: null,
        category: 'TXF',
        delivery_month: month,
    }) as unknown as ContractInfo;

describe('legActionsFor — 官方買賣方向表', () => {
    it('差額型：買進＝賣第一腳買第二腳（跨月/價差/轉逆）', () => {
        for (const t of [
            'TimeSpread',
            'WeeklyTimeSpread',
            'PriceSpread',
            'ConversionReversal',
        ] as const) {
            expect(legActionsFor(t, 'Buy')).toEqual(['Sell', 'Buy']);
            expect(legActionsFor(t, 'Sell')).toEqual(['Buy', 'Sell']);
        }
    });
    it('和額型：跨式/勒式兩腳同向', () => {
        for (const t of ['Straddle', 'Strangle'] as const) {
            expect(legActionsFor(t, 'Buy')).toEqual(['Buy', 'Buy']);
            expect(legActionsFor(t, 'Sell')).toEqual(['Sell', 'Sell']);
        }
    });
});

describe('deriveOptionShape — canonical 腳序與型別', () => {
    it('垂直價差 Call：高履約在前，反序自動換', () => {
        const lo = opt('TXO21000I6', 21000, 'C');
        const hi = opt('TXO21500I6', 21500, 'C');
        const s = deriveOptionShape(lo, hi);
        expect(s.comboType).toBe('PriceSpread');
        expect(s.swapped).toBe(true);
        expect(s.legs.map((l) => l.code)).toEqual(['TXO21500I6', 'TXO21000I6']);
    });
    it('垂直價差 Put：低履約在前', () => {
        const lo = opt('TXO21000U6', 21000, 'P');
        const hi = opt('TXO21500U6', 21500, 'P');
        const s = deriveOptionShape(lo, hi);
        expect(s.comboType).toBe('PriceSpread');
        expect(s.swapped).toBe(false);
        expect(s.legs.map((l) => l.code)).toEqual(['TXO21000U6', 'TXO21500U6']);
    });
    it('同履約 C+P 曖昧（跨式 vs 轉逆），Call 在前', () => {
        const p = opt('TXO21800U6', 21800, 'P');
        const c = opt('TXO21800I6', 21800, 'C');
        const s = deriveOptionShape(p, c);
        expect(s.comboType).toBeNull();
        expect(s.ambiguous).toEqual(['Straddle', 'ConversionReversal']);
        expect(s.legs[0]!.code).toBe('TXO21800I6');
        expect(s.swapped).toBe(true);
    });
    it('不同履約 C+P ＝ 勒式，Call 在前', () => {
        const c = opt('TXO22000I6', 22000, 'C');
        const p = opt('TXO21000U6', 21000, 'P');
        const s = deriveOptionShape(c, p);
        expect(s.comboType).toBe('Strangle');
        expect(s.swapped).toBe(false);
    });
    it('跨月同履約同權利 ＝ 時間價差，近月在前', () => {
        const far = opt('TXO21800J6', 21800, 'C', '202610');
        const near = opt('TXO21800I6', 21800, 'C', '202609');
        const s = deriveOptionShape(far, near);
        expect(s.comboType).toBe('TimeSpread');
        expect(s.legs.map((l) => l.delivery_month)).toEqual([
            '202609',
            '202610',
        ]);
    });
    it('同月不同週（週選）＝時間價差，依 delivery_date 排近先遠後', () => {
        // 只比 delivery_month 會誤判成「兩腳完全相同」— QA round 6 MEDIUM
        const week4 = {
            ...opt('TX421800I6', 21800, 'C', '202609'),
            delivery_date: '2026/09/23',
        } as ContractInfo;
        const monthly = {
            ...opt('TXO21800I6', 21800, 'C', '202609'),
            delivery_date: '2026/09/16',
        } as ContractInfo;
        const s = deriveOptionShape(week4, monthly);
        expect(s.error).toBeNull();
        expect(s.comboType).toBe('TimeSpread');
        expect(s.swapped).toBe(true);
        expect(s.legs.map((l) => l.code)).toEqual(['TXO21800I6', 'TX421800I6']);
    });
    it('跨月但履約價不同 → 不合法', () => {
        const a = opt('TXO21000I6', 21000, 'C', '202609');
        const b = opt('TXO21800J6', 21800, 'C', '202610');
        expect(deriveOptionShape(a, b).error).toBeTruthy();
    });
    it('完全相同的腳 → 不合法', () => {
        const a = opt('TXO21800I6', 21800, 'C');
        expect(deriveOptionShape(a, { ...a }).error).toBeTruthy();
    });
});

describe('comboMonthsLabel — 月份碼轉人話', () => {
    it('標準組合 code 轉近/遠月標籤', () => {
        expect(comboMonthsLabel('TXFI6/J6')).toBe('9月/10月');
        expect(comboMonthsLabel('TXFL6/C7')).toBe('12月/3月');
        // 跨變體完整第二段（週/月期貨）
        expect(comboMonthsLabel('MX4G6/MXFH6')).toBe('7月/8月');
    });
    it('非組合格式回 null', () => {
        expect(comboMonthsLabel('TXFI6')).toBeNull();
        expect(comboMonthsLabel('XX/YY')).toBeNull();
    });
});

describe('orderFuturesLegs — 近月在前', () => {
    it('反序自動換', () => {
        const near = fut('TXFI6', '202609');
        const far = fut('TXFJ6', '202610');
        expect(orderFuturesLegs(far, near)).toEqual({
            legs: [near, far],
            swapped: true,
        });
        expect(orderFuturesLegs(near, far).swapped).toBe(false);
    });
});

describe('syntheticComboQuote — canonical 淨價軸', () => {
    it('時間價差＝遠−近：bid = 遠bid−近ask', () => {
        // 官方例：combo bid = far.bid − near.ask; ask = far.ask − near.bid
        const near = { bid: 22000, ask: 22002 };
        const far = { bid: 22150, ask: 22153 };
        const q = syntheticComboQuote('TimeSpread', [near, far]);
        expect(q).toEqual({ bid: 148, ask: 153 });
    });
    it('跨式＝C+P：兩腳 bid 相加／ask 相加', () => {
        const c = { bid: 100, ask: 102 };
        const p = { bid: 80, ask: 81 };
        expect(syntheticComboQuote('Straddle', [c, p])).toEqual({
            bid: 180,
            ask: 183,
        });
    });
    it('轉逆＝P−C（可為負）', () => {
        const c = { bid: 100, ask: 102 };
        const p = { bid: 80, ask: 81 };
        expect(syntheticComboQuote('ConversionReversal', [c, p])).toEqual({
            bid: -22,
            ask: -19,
        });
    });
    it('缺任一腳報價回 null', () => {
        expect(
            syntheticComboQuote('TimeSpread', [null, { bid: 1, ask: 2 }]),
        ).toBeNull();
    });
    it('係數：差額型 [−1,+1]、和額型 [+1,+1]', () => {
        expect(comboCoefs('PriceSpread')).toEqual([-1, 1]);
        expect(comboCoefs('Strangle')).toEqual([1, 1]);
    });
});
