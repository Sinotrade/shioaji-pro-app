import { describe, expect, it } from 'vitest';
import { quickOrderBlockMessage } from './quick-order-support';
import type { BlockType } from './workspace';

describe('權證快速下單範圍', () => {
    it('閃電下單對權證開放', () => {
        expect(quickOrderBlockMessage('WRT', 'flash')).toBeNull();
    });

    it('整零價差：權證不得零股交易，維持擋下', () => {
        expect(quickOrderBlockMessage('WRT', 'oddspread')).toBe('權證不得零股交易，沒有整零價差；請使用閃電下單或下單面板');
    });

    it('網格：維持擋下', () => {
        expect(quickOrderBlockMessage('WRT', 'grid')).toBe('權證不支援網格下單，請使用閃電下單或下單面板');
    });

    it.each(['STK', 'FUT', 'OPT'] as const)('%s 保留既有快速下單行為', (securityType) => {
        for (const type of ['flash', 'grid', 'oddspread'] as const) {
            expect(quickOrderBlockMessage(securityType, type)).toBeNull();
        }
    });

    it('不擴張或關閉既有權證下單面板與行情分析', () => {
        for (const type of ['ticket', 'chart', 'intraday', 'depth', 'warrants'] satisfies BlockType[]) {
            expect(quickOrderBlockMessage('WRT', type)).toBeNull();
        }
        expect(quickOrderBlockMessage(undefined, 'flash')).toBeNull();
    });
});
