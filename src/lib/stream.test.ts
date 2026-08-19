import { afterEach, describe, expect, it } from 'vitest';
import { __streamTest } from './stream';

describe('KGI stream quote store', () => {
    afterEach(() => __streamTest.reset());

    it('stores bid/ask SSE events for quote subscribers', () => {
        __streamTest.handleBidAsk(
            JSON.stringify({
                code: '2330',
                date: '2026-08-18',
                time: '09:01:00',
                bid_price: ['100', '99.5'],
                bid_volume: [10, 8],
                ask_price: ['100.5', '101'],
                ask_volume: [7, 5],
            }),
        );

        const quote = __streamTest.getQuote('2330');
        expect(quote?.bidask?.bid_price).toEqual(['100', '99.5']);
        expect(quote?.bidask?.ask_volume).toEqual([7, 5]);
    });

    it('merges partial tick callbacks without losing previous change/reference fields', () => {
        __streamTest.handleTick(
            JSON.stringify({
                code: '2330',
                date: '2026-08-18',
                time: '09:01:00',
                open: '1000',
                high: '1005',
                low: '995',
                close: '1000',
                volume: 1,
                total_volume: 10,
                tick_type: 0,
                price_chg: '5',
            }),
        );
        __streamTest.handleTick(
            JSON.stringify({
                code: '2330',
                date: '2026-08-18',
                time: '09:01:01',
                close: '1002',
                volume: 1,
                total_volume: 11,
                tick_type: 0,
            }),
        );

        const quote = __streamTest.getQuote('2330');
        expect(quote?.tick).toMatchObject({
            close: '1002',
            open: '1000',
            high: '1005',
            low: '995',
            price_chg: '5',
        });
    });

    it('merges partial bid/ask callbacks without clearing the opposite side', () => {
        __streamTest.handleBidAsk(
            JSON.stringify({
                code: '2330',
                date: '2026-08-18',
                time: '09:01:00',
                bid_price: ['100', '99.5'],
                bid_volume: [10, 8],
                ask_price: ['100.5', '101'],
                ask_volume: [7, 5],
            }),
        );
        __streamTest.handleBidAsk(
            JSON.stringify({
                code: '2330',
                date: '2026-08-18',
                time: '09:01:01',
                bid_price: ['100.5', '100'],
                bid_volume: [3, 9],
            }),
        );

        const quote = __streamTest.getQuote('2330');
        expect(quote?.bidask?.bid_price).toEqual(['100.5', '100']);
        expect(quote?.bidask?.ask_price).toEqual(['100.5', '101']);
        expect(quote?.bidask?.ask_volume).toEqual([7, 5]);
    });

    it('stores live KBar SSE events for chart subscribers', () => {
        __streamTest.handleKBar(
            JSON.stringify({
                symbol: '2330',
                datetime: '20260818090200',
                timeframe: 5,
                open: 100,
                high: 101,
                low: 99,
                close: 100.5,
                volume: 12,
            }),
        );

        const quote = __streamTest.getQuote('2330');
        expect(quote?.kbar).toMatchObject({
            code: '2330',
            date: '2026-08-18',
            time: '09:02:00',
            timeframe: 5,
            close: '100.5',
            volume: 12,
        });
    });

    it('stores weighted-index SSE events for the header market bar', () => {
        __streamTest.handleIndexQuote(
            JSON.stringify({
                code: 'IX0001',
                exchange: 'TSE',
                Date: '2026-08-18',
                Time: '13:30:00',
                Reference: '23800',
                Open: '23900',
                High: '24050',
                Low: '23880',
                Close: '24000',
            }),
        );

        const quote = __streamTest.getQuote('IX0001');
        expect(quote?.index).toMatchObject({
            code: 'IX0001',
            reference: '23800',
            close: '24000',
            open: '23900',
        });
    });

    it('merges partial weighted-index callbacks without clearing reference', () => {
        __streamTest.handleIndexQuote(
            JSON.stringify({
                code: 'IX0001',
                exchange: 'TSE',
                Date: '2026-08-18',
                Time: '13:30:00',
                Reference: '23800',
                Open: '23900',
                High: '24050',
                Low: '23880',
                Close: '24000',
            }),
        );
        __streamTest.handleIndexQuote(
            JSON.stringify({
                code: 'IX0001',
                exchange: 'TSE',
                Date: '2026-08-18',
                Time: '13:30:01',
                Close: '24010',
            }),
        );

        const quote = __streamTest.getQuote('IX0001');
        expect(quote?.index).toMatchObject({
            close: '24010',
            reference: '23800',
            open: '23900',
            high: '24050',
            low: '23880',
        });
    });
});
