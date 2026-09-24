import { describe, expect, it } from 'vitest';
import { collectFills, fifoPosition, type FifoFill } from './futures-fifo';
import type { Action, Deal, Trade } from './types/order';

const trade = (id: string, action: Action, deals: Deal[], code = 'MXFI6', target: string | null = null, status = 'Filled'): Trade => ({
    contract: { code, target_code: target } as Trade['contract'],
    order: { id, seqno: id, ordno: id, action, price: 0, quantity: deals.reduce((s, d) => s + d.quantity, 0) },
    status: { id, status, status_code: '', order_quantity: 0, deal_quantity: 0, cancel_quantity: 0, modified_price: 0, msg: '', deals },
}) as Trade;
const deal = (seq: string, price: number, quantity: number, ts: number): Deal => ({ seq, price, quantity, ts });
const row = (direction: Action, quantity: number, price: number, last_price: number) => ({ direction, quantity, price, last_price });
const fill = (key: string, action: Action, price: number, quantity: number, ts: number): FifoFill => ({ key, action, price, quantity, ts });

describe('collectFills', () => {
    it('keeps the exact contract, resolves continuous aliases and sorts by fill time', () => {
        const fills = collectFills([
            trade('b', 'Buy', [deal('3', 45513, 1, 30)], 'MXFR1', 'MXFI6'),
            trade('a', 'Sell', [deal('1', 45546, 1, 10), deal('2', 45559, 1, 20)]),
            trade('x', 'Buy', [deal('9', 45000, 1, 5)], 'MXFJ6'),
        ], 'MXFI6');
        expect(fills?.map(f => [f.key, f.action, f.price])).toEqual([
            ['a:1', 'Sell', 45546], ['a:2', 'Sell', 45559], ['b:3', 'Buy', 45513],
        ]);
    });

    it('counts a deal seen in both the snapshot and a live report once', () => {
        const snapshot = trade('a', 'Sell', [deal('1', 100, 1, 10)], 'MXFI6', null, 'PartFilled');
        const live = trade('a', 'Sell', [deal('1', 100, 1, 10), deal('2', 101, 1, 11), deal('2', 101, 1, 11)]);
        expect(collectFills([snapshot, live], 'MXFI6')?.map(f => f.key)).toEqual(['a:1', 'a:2']);
    });

    it('refuses a fill without a finite time instead of sorting it first', () => {
        expect(collectFills([trade('a', 'Sell', [deal('1', 100, 1, Number.NaN)])], 'MXFI6')).toBeNull();
        expect(collectFills([trade('a', 'Sell', [{ seq: '1', price: 100, quantity: 1 } as Deal])], 'MXFI6')).toBeNull();
    });

    it('breaks same-time ties by exchange seq and refuses ties it cannot order', () => {
        const bySeq = collectFills([
            trade('b', 'Sell', [deal('000012', 45559, 1, 10)]), trade('a', 'Sell', [deal('000011', 45546, 1, 10)]),
        ], 'MXFI6');
        expect(bySeq?.map(f => f.price)).toEqual([45546, 45559]);
        expect(collectFills([
            trade('b', 'Sell', [deal('x2', 45559, 1, 10)]), trade('a', 'Sell', [deal('x1', 45546, 1, 10)]),
        ], 'MXFI6')).toBeNull();
        // Same side and price: order does not change the result.
        expect(collectFills([
            trade('b', 'Sell', [deal('x2', 45546, 1, 10)]), trade('a', 'Sell', [deal('x1', 45546, 1, 10)]),
        ], 'MXFI6')).toHaveLength(2);
    });

    it('refuses when a spread/combo fill touches this contract under another code', () => {
        const own = trade('a', 'Sell', [deal('1', 45546, 1, 1)]);
        expect(collectFills([own, trade('s', 'Buy', [deal('2', 30, 1, 2)], 'MXFI6/J6')], 'MXFI6')).toBeNull();
        expect(collectFills([own, trade('s', 'Buy', [deal('2', 30, 1, 2)], 'MX4I6/MXFI6')], 'MXFI6')).toBeNull();
        // a combo on other months, or one without fills, does not matter
        expect(collectFills([own, trade('s', 'Buy', [deal('2', 30, 1, 2)], 'MXFJ6/K6')], 'MXFI6')).toHaveLength(1);
        expect(collectFills([own, trade('s', 'Buy', [], 'MXFI6/J6', null, 'Submitted')], 'MXFI6')).toHaveLength(1);
    });

    it('ignores empty deals but refuses a fill it cannot identify', () => {
        expect(collectFills([trade('a', 'Buy', [deal('1', 100, 0, 1)], 'MXFI6', null, 'Cancelled')], 'MXFI6')).toEqual([]);
        expect(collectFills([trade('a', 'Buy', [deal('', 100, 1, 1)])], 'MXFI6')).toBeNull();
    });
});

describe('fifoPosition', () => {
    it('matches eLeader on the reported case: 空 1 @ 45559, +1350', () => {
        // Broker rows are not netted intra-session: Sell 2 @ 45552.5 and Buy 1 @ 45513.
        const rows = [row('Sell', 2, 45552.5, 45532), row('Buy', 1, 45513, 45532)];
        const fills = [fill('a:1', 'Sell', 45546, 1, 10), fill('a:2', 'Sell', 45559, 1, 20), fill('b:3', 'Buy', 45513, 1, 30)];
        expect(fifoPosition(rows, fills, 50)).toEqual({
            net: -1, avg: 45559, pnl: 1350, lots: [{ action: 'Sell', price: 45559, quantity: 1 }], seeded: false,
        });
    });

    it('also works on rows the live projection already netted at the average', () => {
        // applyPositionFill closes the buy against the Sell 2 @ 45552.5 row.
        const fills = [fill('a:1', 'Sell', 45546, 1, 10), fill('a:2', 'Sell', 45559, 1, 20), fill('b:3', 'Buy', 45513, 1, 30)];
        expect(fifoPosition([row('Sell', 1, 45552.5, 45532)], fills, 50)).toMatchObject({ net: -1, avg: 45559, pnl: 1350, seeded: false });
    });

    it('a missing fill is indistinguishable from a carried lot, so the result is marked seeded', () => {
        // Sell @45559 not loaded: the rows' extra sell is seeded as a prior-session lot.
        const rows = [row('Sell', 2, 45552.5, 45532), row('Buy', 1, 45513, 45532)];
        const r = fifoPosition(rows, [fill('a:1', 'Sell', 45546, 1, 10), fill('b:3', 'Buy', 45513, 1, 30)], 50);
        expect(r?.seeded).toBe(true);
    });

    it('seeds lots carried from earlier sessions as the oldest, at the rows\' remaining cost', () => {
        // Carried long 2 @ 100; today buy 1 @ 110 then sell 1 @ 120 closes a carried lot.
        const rows = [row('Buy', 2, 100, 115), row('Buy', 1, 110, 115), row('Sell', 1, 120, 115)];
        const fills = [fill('a:1', 'Buy', 110, 1, 1), fill('b:1', 'Sell', 120, 1, 2)];
        expect(fifoPosition(rows, fills, 50)).toEqual({
            net: 2, avg: 105, pnl: 1000,
            lots: [{ action: 'Buy', price: 100, quantity: 1 }, { action: 'Buy', price: 110, quantity: 1 }], seeded: true,
        });
    });

    it('works from partial fills of a later-cancelled order', () => {
        const fills = collectFills([
            trade('a', 'Sell', [deal('1', 100, 1, 1), deal('2', 101, 1, 2)], 'MXFI6', null, 'Cancelled'),
            trade('b', 'Buy', [deal('1', 99, 1, 3)]),
        ], 'MXFI6')!;
        const r = fifoPosition([row('Sell', 2, 100.5, 98), row('Buy', 1, 99, 98)], fills, 10);
        expect(r).toMatchObject({ net: -1, avg: 101, pnl: 30 });
    });

    it('reverses through zero: the remainder of a larger fill opens the other side', () => {
        const rows = [row('Sell', 2, 100, 95), row('Buy', 3, 90, 95)];
        const fills = [fill('a:1', 'Sell', 100, 2, 1), fill('b:1', 'Buy', 90, 3, 2)];
        expect(fifoPosition(rows, fills, 10)).toEqual({
            net: 1, avg: 90, pnl: 50, lots: [{ action: 'Buy', price: 90, quantity: 1 }], seeded: false,
        });
    });

    it('rounds P&L to whole dollars', () => {
        const rows = [row('Sell', 3, 45568.33, 45532), row('Buy', 1, 45513, 45532)];
        const fills = [fill('a', 'Sell', 45546, 1, 1), fill('b', 'Sell', 45559, 1, 2), fill('c', 'Sell', 45600, 1, 3), fill('d', 'Buy', 45513, 1, 4)];
        expect(fifoPosition(rows, fills, 50)).toMatchObject({ net: -2, avg: 45579.5, pnl: 4750 });
        expect(fifoPosition([row('Buy', 2, 100.1, 100.4), row('Sell', 1, 100.2, 100.4)],
            [fill('a', 'Buy', 100, 1, 1), fill('b', 'Buy', 100.2, 1, 2), fill('c', 'Sell', 100.2, 1, 3)], 3)).toMatchObject({ pnl: 1 });
    });

    it('returns null when rows and fills disagree so the caller can fall back', () => {
        const rows = [row('Sell', 2, 45552.5, 45532), row('Buy', 1, 45513, 45532)];
        // more buys filled than the rows hold
        expect(fifoPosition(rows, [fill('a', 'Buy', 45513, 2, 1)], 50)).toBeNull();
        // no fills at all: both sides would have to be carried
        expect(fifoPosition(rows, [], 50)).toBeNull();
        // a buy/sell pair missing: rows hold more of each side than today filled
        expect(fifoPosition([row('Sell', 2, 45552.5, 45532), row('Buy', 2, 45520, 45532)],
            [fill('a', 'Sell', 45546, 1, 1), fill('b', 'Buy', 45513, 1, 2)], 50)).toBeNull();
        // carried lots on netted rows cannot be priced
        expect(fifoPosition([row('Buy', 2, 103.33, 115)], [fill('a', 'Buy', 110, 1, 1), fill('b', 'Sell', 120, 1, 2)], 50)).toBeNull();
        // unknown multiplier
        expect(fifoPosition(rows, [fill('a', 'Sell', 45546, 1, 1), fill('b', 'Sell', 45559, 1, 2), fill('c', 'Buy', 45513, 1, 3)], 0)).toBeNull();
    });
});
