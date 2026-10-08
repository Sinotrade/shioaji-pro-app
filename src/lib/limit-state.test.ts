// src/lib/limit-state.test.ts — 漲跌停判斷（自選清單／報價看板／走勢共用）

import { describe, expect, it } from 'vitest';
import type { ContractInfo } from './types/contract';
import { limitStateOf } from './limit-state';

function c(over: Partial<ContractInfo>): ContractInfo {
    return {
        exchange: 'TSE',
        code: '2330',
        security_type: 'STK',
        target_code: null,
        name: 'x',
        currency: 'TWD',
        limit_up: 1100,
        limit_down: 900,
        reference: 1000,
        day_trade: 'Yes',
        update_date: '',
        category: '',
        margin_trading_balance: 0,
        short_selling_balance: 0,
        ...over,
    } as ContractInfo;
}

describe('limitStateOf', () => {
    it('成交價等於漲停價 → up', () => {
        expect(limitStateOf(c({}), 1100)).toBe('up');
    });

    it('成交價等於跌停價 → down', () => {
        expect(limitStateOf(c({}), 900)).toBe('down');
    });

    it('一般價位 → null', () => {
        expect(limitStateOf(c({}), 1000)).toBeNull();
        // 漲停前一檔（tick 5）不算
        expect(limitStateOf(c({}), 1095)).toBeNull();
        expect(limitStateOf(c({}), 905)).toBeNull();
    });

    it('浮點誤差：0.1 級距累加出的 33.300000000000004 仍判定漲停', () => {
        const k = c({ code: '2002', limit_up: 33.3, limit_down: 27.3, reference: 30.3 });
        expect(limitStateOf(k, 0.1 * 333)).toBe('up');
        expect(limitStateOf(k, 33.29999999)).toBe('up');
        expect(limitStateOf(k, 27.300000000000004)).toBe('down');
        // 漲停前一檔 33.25（級距 0.05）不得被誤判
        expect(limitStateOf(k, 33.25)).toBeNull();
    });

    it('級距交界：漲停 10 元時 9.99（下方級距 0.01）不算漲停', () => {
        const k = c({ code: '1101', limit_up: 10, limit_down: 8.2, reference: 9.1 });
        expect(limitStateOf(k, 9.99)).toBeNull();
        expect(limitStateOf(k, 10)).toBe('up');
    });

    it('指數沒有漲跌停', () => {
        const k = c({ code: '001', security_type: 'IND', exchange: 'TSE', limit_up: 0, limit_down: 0 });
        expect(limitStateOf(k, 20000)).toBeNull();
        // 即使資料帶了數字也不亮
        expect(limitStateOf(c({ security_type: 'IND' }), 1100)).toBeNull();
    });

    it('興櫃沒有漲跌停', () => {
        expect(limitStateOf(c({ exchange: 'OES' }), 1100)).toBeNull();
    });

    it('缺漲跌停價或價格無效 → null', () => {
        expect(limitStateOf(c({ limit_up: 0, limit_down: 0 }), 1000)).toBeNull();
        expect(limitStateOf(c({}), undefined)).toBeNull();
        expect(limitStateOf(c({}), Number.NaN)).toBeNull();
        expect(limitStateOf(c({}), 0)).toBeNull();
    });

    it('期貨用合約 tick 判斷', () => {
        const k = c({
            code: 'TXFJ6',
            exchange: 'TAIFEX',
            security_type: 'FUT',
            limit_up: 24200,
            limit_down: 19800,
            reference: 22000,
            tick: 1,
        });
        expect(limitStateOf(k, 24200)).toBe('up');
        expect(limitStateOf(k, 24199)).toBeNull();
        expect(limitStateOf(k, 19800)).toBe('down');
    });

    it('期權級距表未載入（tick 退回參考價級距 0.05）時，跌停前一檔 9.91 不誤判', () => {
        const k = c({
            code: 'CDFJ6',
            exchange: 'TAIFEX',
            security_type: 'FUT',
            limit_up: 12.1,
            limit_down: 9.9,
            reference: 11,
            tick: 0.05,
            tick_rule: 'qa_unloaded_rule',
            underlying_kind: 'S',
        });
        expect(limitStateOf(k, 9.91)).toBeNull();
        expect(limitStateOf(k, 9.9)).toBe('down');
        expect(limitStateOf(k, 12.05)).toBeNull();
        expect(limitStateOf(k, 12.1)).toBe('up');
    });
});
