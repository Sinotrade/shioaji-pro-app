import { describe, expect, it } from 'vitest';
import { quickOrderBlockMessage } from './quick-order-support';
import type { BlockType } from './workspace';

describe('權證快速下單隔離', () => {
    it.each(['flash', 'grid', 'oddspread'] as const)('%s 不讓權證走既有快速交易路徑', (type) => {
        expect(quickOrderBlockMessage('WRT', type)).toBe('權證不支援快速下單，請使用下單面板');
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
