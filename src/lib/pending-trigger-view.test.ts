// src/lib/pending-trigger-view.test.ts — plain-language 待確認 wording (#144).

import { describe, expect, it } from 'vitest';
import { actionLabel, conditionLabel, contractLabel, distanceLabel, exitStyleLabel, kindLabel } from './pending-trigger-view';

describe('pending trigger wording', () => {
    it('names the contract with its month, or falls back to the code', () => {
        expect(contractLabel('TMFJ6', { name: '微型臺指期貨', delivery_month: '202610' })).toBe('微型臺指期貨 202610');
        expect(contractLabel('MXFJ6', { name: '小型臺指期貨 202610', delivery_month: '202610' })).toBe('小型臺指期貨 202610');
        expect(contractLabel('2330', { name: '台積電' })).toBe('台積電');
        expect(contractLabel('TMFJ6', undefined)).toBe('TMFJ6');
    });

    it('describes kind, action and condition', () => {
        expect(kindLabel({ kind: 'stop' })).toBe('停損');
        expect(kindLabel({ kind: 'take', bracketId: 'b1' })).toBe('括號單停利');
        expect(actionLabel({ action: 'Sell', quantity: 2 })).toBe('賣出 2 口');
        expect(actionLabel({ action: 'Buy', quantity: 3, account: { account_type: 'S', broker_id: 'b', account_id: 'a' } })).toBe('買進 3 張');
        // #204 盤中零股以股計，沒有市價單
        expect(actionLabel({ action: 'Sell', quantity: 300, orderLot: 'IntradayOdd', account: { account_type: 'S', broker_id: 'b', account_id: 'a' } })).toBe('賣出 300 股');
        expect(exitStyleLabel({ orderLot: 'IntradayOdd' })).toBe('零股漲跌停限價');
        expect(exitStyleLabel({})).toBe('市價');
        expect(conditionLabel({ condition: 'above', price: 48151 })).toBe('漲到 48,151 以上');
        expect(conditionLabel({ condition: 'below', price: 47800 })).toBe('跌到 47,800 以下');
    });

    it('says how far the price is past, or back on the other side', () => {
        expect(distanceLabel({ condition: 'above', price: 48151 }, 48169)).toEqual({ text: '已超過 18 點', past: true });
        expect(distanceLabel({ condition: 'below', price: 48000 }, 47850)).toEqual({ text: '已跌破 150 點', past: true });
        expect(distanceLabel({ condition: 'above', price: 48151 }, 48147)).toEqual({ text: '已回到觸發價下方 4 點', past: false });
        expect(distanceLabel({ condition: 'below', price: 48000 }, 48000)).toEqual({ text: '正好在觸發價', past: true });
        expect(distanceLabel({ condition: 'below', price: 245.5 }, 245.25).text).toBe('已跌破 0.25 點');
    });
});
