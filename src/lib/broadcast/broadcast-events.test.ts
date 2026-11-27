import { describe, expect, it } from 'vitest';
import type { DealReport, OrderEventReport, OrderReport } from '../order-report';
import { describeNoticeVoice, describeOrderVoice } from './broadcast-events';

function deal(over: Partial<DealReport> = {}): DealReport {
    return {
        kind: 'deal',
        market: 'stock',
        code: '2330',
        action: 'Buy',
        price: 1900,
        quantity: 1000,
        seqno: '1',
        ordno: 'A1',
        tradeId: 'T1',
        orderLot: 'Common',
        eventId: 'e1',
        raw: {},
        ...over,
    };
}

function order(over: Partial<OrderReport> = {}): OrderReport {
    return {
        kind: 'order',
        market: 'stock',
        opType: 'New',
        opCode: '00',
        opMsg: '',
        failed: false,
        code: '2330',
        name: '台積電',
        action: 'Buy',
        price: 1900,
        quantity: 1000,
        orderType: 'ROD',
        priceType: 'LMT',
        ocType: 'Auto',
        orderCond: 'Cash',
        orderLot: 'Common',
        id: 'o1',
        seqno: '1',
        ordno: 'A1',
        orderQuantity: 1000,
        cancelQuantity: 0,
        modifiedPrice: 0,
        eventId: 'e1',
        raw: {},
        ...over,
    };
}

describe('成交語音', () => {
    it('說出方向、代碼、數量與成交價', () => {
        expect(describeOrderVoice(deal())).toBe('買進 2330 1000 張 成交價 1900');
    });

    it('賣出用「賣出」而不是買進', () => {
        expect(describeOrderVoice(deal({ action: 'Sell' }))).toBe(
            '賣出 2330 1000 張 成交價 1900',
        );
    });

    it('期貨的單位是口', () => {
            expect(
                describeOrderVoice(deal({ market: 'futures', code: 'TXFR1' })),
            ).toBe('買進 TXFR1 1000 口 成交價 1900');
        });

        it('美股的單位是股', () => {
            // OrderMarket 在上游 rebase 後多了 'us'；美股沒有「張」，一律念股
            expect(
                describeOrderVoice(deal({ market: 'us', code: 'AAPL' })),
            ).toBe('買進 AAPL 1000 股 成交價 1900');
        });

    it('盤後零股的單位是股', () => {
        expect(
            describeOrderVoice(deal({ orderLot: 'Odd', quantity: 55 })),
        ).toBe('買進 2330 55 股 成交價 1900');
    });

    it('沒有代號就不播報', () => {
        expect(describeOrderVoice(deal({ code: '' }))).toBeNull();
    });

    it('小數價格不帶千分位', () => {
        expect(describeOrderVoice(deal({ price: 1900.5 }))).toBe(
            '買進 2330 1000 張 成交價 1900.5',
        );
    });
});

describe('委託語音', () => {
    it('新委託說出方向與內容', () => {
        expect(describeOrderVoice(order())).toBe('委託 買進 2330 1000 張 1900');
    });

    it('撤單', () => {
        expect(
            describeOrderVoice(order({ opType: 'Cancel', cancelQuantity: 1000 })),
        ).toBe('取消買進 2330 1000 張');
    });

    it('改價說出新價格', () => {
        expect(
            describeOrderVoice(
                order({ opType: 'UpdatePrice', modifiedPrice: 1950 }),
            ),
        ).toBe('改價買進 2330 1000 張 1950');
    });

    it('減量說出減掉的數量', () => {
        expect(
            describeOrderVoice(order({ opType: 'UpdateQty', cancelQuantity: 500 })),
        ).toBe('減量買進 2330 500 張');
    });

    it('失敗或被拒絕時只說失敗並提醒檢查', () => {
        expect(describeOrderVoice(order({ failed: true }))).toBe(
            '委託失敗 2330 買進，請檢查',
        );
        expect(describeOrderVoice(order({ opType: 'Reject' }))).toBe(
            '委託失敗 2330 買進，請檢查',
        );
    });
});

describe('通知語音', () => {
    it('有標題就會播報', () => {
        expect(
            describeNoticeVoice({ kind: 'info', title: '條件單觸發', body: '' }),
        ).toBe('條件單觸發');
    });

    it('短內容會一起念', () => {
        expect(
            describeNoticeVoice({
                kind: 'ok',
                title: '觸價下單成交',
                body: '2330 買進 1000 股',
            }),
        ).toBe('觸價下單成交，2330 買進 1000 股');
    });

    it('太長的內容只念標題（念起來會太吵）', () => {
        const long = 'x'.repeat(41);
        expect(
            describeNoticeVoice({ kind: 'info', title: '收盤前平倉', body: long }),
        ).toBe('收盤前平倉');
    });

    it('沒有標題就不播報', () => {
        expect(describeNoticeVoice({ kind: 'info', title: '  ', body: 'x' })).toBeNull();
    });
});
