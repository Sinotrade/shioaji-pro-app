import { describe, expect, it } from 'vitest';
import { normalizeOrderEvent } from './order-report';
import { applyPositionFill, markPosition, positionFill, type PositionFill } from './portfolio-projection';
import type { Account, AccountedPosition } from './types/portfolio';

const account: Account = { account_type: 'S', broker_id: 'test', account_id: 'a', person_id: '', signed: true, username: '' };
const base: AccountedPosition = { id: 1, code: '2330', direction: 'Buy', quantity: 1000, price: 100, last_price: 110, pnl: 9900, yd_quantity: 1000, cond: 'Cash', account };
const fill: PositionFill = { key: 'fill', tradeId: 'order', account, code: '2330', action: 'Buy', quantity: 100, price: 120, ts: 1789000000, condition: 'Cash', openClose: '', daytradeShort: false };

describe('position projection', () => {
    it('projects a confirmed cash day-trade short immediately and covers it with later cash buys', () => {
        const short = { ...fill, action: 'Sell' as const, daytradeShort: true, quantity: 2000 };
        const opened = applyPositionFill([], short, 1)!;
        expect(opened).toEqual([expect.objectContaining({ direction: 'Sell', quantity: 2000, cond: 'Cash' })]);
        const partial = applyPositionFill(opened, { ...fill, quantity: 1000 }, 1)!;
        expect(partial[0]).toMatchObject({ direction: 'Sell', quantity: 1000 });
        expect(applyPositionFill(partial, { ...fill, quantity: 1000 }, 1)).toEqual([]);
    });
    it('keeps owned cash shares when a confirmed day short opens, then covers before adding longs', () => {
        const short = { ...fill, action: 'Sell' as const, daytradeShort: true, quantity: 2000 };
        const rows = applyPositionFill([base], short, 1)!;
        expect(rows).toEqual([base, expect.objectContaining({ direction: 'Sell', quantity: 2000 })]);
        const partial = applyPositionFill(rows, { ...fill, quantity: 1000 }, 1)!;
        expect(partial.map(p => [p.direction, p.quantity])).toEqual([['Buy', 1000], ['Sell', 1000]]);
        const covered = applyPositionFill(partial, { ...fill, quantity: 1500 }, 1)!;
        expect(covered).toEqual([expect.objectContaining({ direction: 'Buy', quantity: 1500, cond: 'Cash' })]);
    });
    it.each(['MarginTrading', 'ShortSelling'])('opens and partially closes only the %s book', condition => {
        const opening = { ...fill, condition, action: condition === 'MarginTrading' ? 'Buy' as const : 'Sell' as const, quantity: 2000 };
        const opened = applyPositionFill([base], opening, 1)!;
        expect(opened[0]).toBe(base);
        expect(opened[1]).toMatchObject({ cond: condition, direction: opening.action, quantity: 2000, yd_quantity: 0 });
        const closing = { ...opening, action: opening.action === 'Buy' ? 'Sell' as const : 'Buy' as const, quantity: 1000 };
        const partial = applyPositionFill(opened, closing, 1)!;
        expect(partial[0]).toBe(base);
        expect(partial[1]).toMatchObject({ quantity: 1000, price: 120 });
        expect(applyPositionFill(partial, closing, 1)).toEqual([base]);
        expect(applyPositionFill(partial, { ...closing, quantity: 1001 }, 1)).toBeNull();
    });
    it('uses the same recorded day-short classification as flash totals, scoped by account and broker reference', async () => {
        const { noteStockOrderConditions, resetStockOrderConditionsForTest } = await import('./stock-order-conditions');
        resetStockOrderConditionsForTest();
        noteStockOrderConditions(account, { seqno: 'seq', ordno: 'ord' }, { order_cond: 'Cash', daytrade_short: true });
        const raw = { trade_id: 's', seqno: 'seq', ordno: 'ord', exchange_seq: 'f', broker_id: 'test', account_id: 'a', code: '2330',
            action: 'Sell', price: 100, quantity: 1, order_lot: 'Common', order_cond: 'Cash', ts: fill.ts };
        const parse = (b: object, accounts = [account]) => positionFill(normalizeOrderEvent({ state: 'StockDeal', data: { StockDeal: b } })!, accounts, []);
        expect(parse(raw)).toMatchObject({ daytradeShort: true, quantity: 1000 });
        expect(parse({ ...raw, ordno: 'other' })?.daytradeShort).toBeUndefined();
        expect(parse({ ...raw, account_id: 'b' }, [{ ...account, account_id: 'b' }])?.daytradeShort).toBeUndefined();
        expect(parse({ ...raw, subaccount: 'child' })).toBeNull();
        resetStockOrderConditionsForTest();
    });
    it('marks current value without discarding broker baseline adjustments', () => {
        expect(markPosition(base, 112, 1)).toMatchObject({ last_price: 112, pnl: 11900 });
        expect(markPosition({ ...base, direction: 'Sell' }, 112, 1).pnl).toBe(7900);
    });
    it('uses explicit futures multiplier and ignores invalid quotes', () => {
        expect(markPosition({ ...base, quantity: 2 }, 111, 200).pnl).toBe(10300);
        expect(markPosition(base, NaN, 1)).toBe(base);
        expect(markPosition(base, 0, 1)).toBe(base);
        expect(markPosition(base, 112, 0)).toBe(base);
    });
    it('adds shares at weighted cost and retains existing mark-to-market', () => {
        const p = applyPositionFill([base], fill, 1, 120)![0]!;
        expect(p.quantity).toBe(1100);
        expect(p.price).toBeCloseTo(101.8181818);
        expect(p.pnl).toBe(19900);
        expect(p.last_price).toBe(120);
        expect('yd_quantity' in p && p.yd_quantity).toBe(1000);
    });
    // #85 B-4: a fill is not a quote. The newest known tick stays the mark.
    it('keeps the latest known market price instead of rewinding to the fill price', () => {
        // Row already marked by a tick at 110; a Buy fills at 120 → the new
        // shares are marked at 110 (−1000), last_price stays 110.
        expect(applyPositionFill([base], fill, 1)![0]).toMatchObject({ quantity: 1100, last_price: 110, pnl: 8900 });
        // A newer tick passed in wins over the row's older mark.
        expect(applyPositionFill([base], fill, 1, 115)![0]).toMatchObject({ last_price: 115, pnl: 14900 - 500 });
        const f: Account = { ...account, account_type: 'F' };
        const buy: PositionFill = { ...fill, account: f, code: 'TXFJ6', quantity: 1, price: 48520, openClose: 'New' };
        // New row: tick known → marked at it; none known → fill price.
        expect(applyPositionFill([], buy, 200, 48530)![0]).toMatchObject({ last_price: 48530, pnl: 2000 });
        expect(applyPositionFill([], buy, 200)![0]).toMatchObject({ last_price: 48520, pnl: 0 });
        // This account's own row of the contract carries a usable mark …
        const own: AccountedPosition = { id: 5, code: 'TXFJ6', direction: 'Sell', quantity: 1, price: 48500,
            last_price: 48510, pnl: -2000, account: f };
        expect(applyPositionFill([own], buy, 200)![1]).toMatchObject({ last_price: 48510, pnl: -2000 });
        // … another account's row may be older and is never borrowed (review P1).
        const other: AccountedPosition = { ...own, last_price: 48400, account: { ...f, account_id: 'b' } };
        expect(applyPositionFill([other], buy, 200)![1]).toMatchObject({ last_price: 48520, pnl: 0 });
        // Neither is an existing holding re-marked from another account.
        const mine: AccountedPosition = { ...own, direction: 'Buy', price: 48520, last_price: 48530, pnl: 2000 };
        expect(applyPositionFill([other, mine], buy, 200)![1]).toMatchObject({ quantity: 2, last_price: 48530, pnl: 4000 });
    });
    it('reduces or removes only the matching account holding', () => {
        const other = { ...base, account: { ...account, account_id: 'b' } };
        expect(applyPositionFill([base, other], { ...fill, action: 'Sell', quantity: 1000 }, 1)).toEqual([other]);
        expect(applyPositionFill([base], { ...fill, action: 'Sell', quantity: 100 }, 1)![0]!.quantity).toBe(900);
    });
    it('does not invent short cash holdings or choose among ambiguous lots', () => {
        expect(applyPositionFill([base], { ...fill, action: 'Sell', quantity: 1001 }, 1)).toBeNull();
        expect(applyPositionFill([base, { ...base, id: 2 }], fill, 1)).toBeNull();
    });
    it('handles explicit new/cover and net auto futures without guessing hedged auto', () => {
        const a = { ...account, account_type: 'F' };
        const p = { ...base, account: a, quantity: 2 };
        const f = { ...fill, account: a, action: 'Sell' as const, quantity: 3, openClose: 'Auto' };
        expect(applyPositionFill([p], f, 200)).toEqual([expect.objectContaining({ direction: 'Sell', quantity: 1, price: 120 })]);
        expect(applyPositionFill([p], { ...f, openClose: 'Cover' }, 200)).toBeNull();
        expect(applyPositionFill([p], { ...f, openClose: 'New' }, 200)).toHaveLength(2);
        expect(applyPositionFill([p, { ...p, direction: 'Sell' }], f, 200)).toBeNull();
    });
    it.each(['Buy', 'Sell'] as const)('closes futures lots FIFO through %s New and Cover (#85)', direction => {
        const owner: Account = { ...account, account_type: 'F' };
        const sign = direction === 'Buy' ? 1 : -1;
        const holding: AccountedPosition = { id: 10, code: 'TXFI6', account: owner,
            direction, quantity: 2, price: 100, last_price: 110, pnl: sign * 4000 };
        const other: AccountedPosition = { ...holding, id: 11, account: { ...owner, account_id: 'other' } };
        const addition: PositionFill = { ...fill, account: owner, code: holding.code,
            action: direction, quantity: 2, price: 120, condition: '', openClose: 'New' };
        const added = applyPositionFill([holding, other], addition, 200, 120)!;
        // Four contracts, two lots (2 @100, 2 @120); at 120 the P&L is ±8000.
        expect(added[0]).toMatchObject({ quantity: 4, price: 110, last_price: 120, pnl: sign * 8000,
            lots: [{ price: 100, quantity: 2 }, { price: 120, quantity: 2 }] });
        expect(added[1]).toBe(other);
        const marked = markPosition(added[0]!, 125, 200);
        expect(marked.pnl).toBe(sign * 12000);
        const cover: PositionFill = { ...addition, key: 'cover-1', tradeId: 'cover',
            action: direction === 'Buy' ? 'Sell' : 'Buy', quantity: 1, price: 125, openClose: 'Cover' };
        const partial = applyPositionFill([marked, other], cover, 200, 125)!;
        // The oldest lot (@100) closes: 1 @100 + 2 @120 remain, cost 340/3.
        expect(partial[0]).toMatchObject({ direction, quantity: 3, last_price: 125, pnl: sign * 7000,
            lots: [{ price: 100, quantity: 1 }, { price: 120, quantity: 2 }] });
        expect(partial[0]!.price).toBeCloseTo(340 / 3);
        // The 2 @100 lot came from an aggregate snapshot row: its split is unknown.
        expect(partial[0]).toHaveProperty('costUncertain', true);
        expect(partial[1]).toBe(other);
        const moved = markPosition(partial[0]!, 123, 200);
        expect(moved.pnl).toBe(sign * 5800);
        const second = applyPositionFill([moved, other], { ...cover, key: 'cover-2', price: 123 }, 200, 123)!;
        expect(second[0]).toMatchObject({ quantity: 2, price: 120, pnl: sign * 1200 });
        expect(second[0]).toHaveProperty('lots', [{ price: 120, quantity: 2 }]);
        // The aggregate lot is gone; the rest are this session's own fills.
        expect(second[0]).not.toHaveProperty('costUncertain');
        const closed = applyPositionFill([second[0]!, other], { ...cover, key: 'cover-rest', quantity: 2, price: 123 }, 200)!;
        expect(closed).toEqual([other]);
        expect(closed[0]).toBe(other);
    });
    it('matches the broker on the live-QA reproduction: long 48520 + 48525, close 1', () => {
        const owner: Account = { ...account, account_type: 'F' };
        const buy: PositionFill = { ...fill, account: owner, code: 'TXFJ6', quantity: 1, price: 48520, openClose: 'New' };
        let rows = applyPositionFill([], buy, 200)!;
        rows = applyPositionFill(rows, { ...buy, key: 'b2', price: 48525 }, 200, 48525)!;
        rows = applyPositionFill(rows, { ...buy, key: 's1', action: 'Sell', price: 48523, openClose: 'Cover' }, 200, 48523)!;
        // Broker position_unit: 1 @48525, −400 (was 1 @48522.5, +100 weighted).
        expect(rows).toEqual([expect.objectContaining({ direction: 'Buy', quantity: 1, price: 48525, last_price: 48523, pnl: -400 })]);
    });
    it('a multi-contract lot opened by one fill this session closes exactly (review P2)', () => {
        const owner: Account = { ...account, account_type: 'F' };
        const buy: PositionFill = { ...fill, account: owner, code: 'TXFJ6', quantity: 2, price: 100, openClose: 'New' };
        let rows = applyPositionFill([], buy, 200)!;
        expect(rows[0]).toHaveProperty('lots', [{ price: 100, quantity: 2 }]);
        rows = applyPositionFill(rows, { ...buy, key: 'b2', quantity: 1, price: 120 }, 200, 120)!;
        rows = applyPositionFill(rows, { ...buy, key: 's1', action: 'Sell', quantity: 1, price: 110, openClose: 'Cover' }, 200, 110)!;
        expect(rows[0]).toMatchObject({ quantity: 2, price: 110, lots: [{ price: 100, quantity: 1 }, { price: 120, quantity: 1 }] });
        expect(rows[0]).not.toHaveProperty('costUncertain');
    });
    it('reverses an Auto futures fill: closes every lot, remainder opens at the fill price', () => {
        const owner: Account = { ...account, account_type: 'F' };
        const long: AccountedPosition = { id: 1, code: 'TXFJ6', direction: 'Buy', quantity: 2, price: 48522.5, last_price: 48530,
            pnl: 3000, account: owner, lots: [{ price: 48520, quantity: 1 }, { price: 48525, quantity: 1 }] };
        const sell: PositionFill = { ...fill, account: owner, code: 'TXFJ6', action: 'Sell', quantity: 3, price: 48530, openClose: 'Auto' };
        expect(applyPositionFill([long], sell, 200, 48530)).toEqual([expect.objectContaining({
            direction: 'Sell', quantity: 1, price: 48530, last_price: 48530, pnl: 0 })]);
        // Partial Auto close keeps the newest lot, like Cover.
        expect(applyPositionFill([long], { ...sell, quantity: 1 }, 200, 48530)).toEqual([expect.objectContaining({
            direction: 'Buy', quantity: 1, price: 48525, pnl: 1000 })]);
    });
    it('closes options FIFO with the option multiplier', () => {
        const owner: Account = { ...account, account_type: 'F' };
        const buy: PositionFill = { ...fill, account: owner, code: 'TXO23000J6', quantity: 1, price: 100, openClose: 'New' };
        let rows = applyPositionFill([], buy, 50)!;
        rows = applyPositionFill(rows, { ...buy, key: 'b2', price: 80 }, 50, 80)!;
        rows = applyPositionFill(rows, { ...buy, key: 's1', action: 'Sell', price: 90, openClose: 'Cover' }, 50, 90)!;
        expect(rows).toEqual([expect.objectContaining({ quantity: 1, price: 80, last_price: 90, pnl: 500 })]);
    });
    it('keeps broker P&L adjustments of a snapshot futures row proportionally on a FIFO close', () => {
        const owner: Account = { ...account, account_type: 'F' };
        // Snapshot row: no lot detail; P&L carries +100 the lots do not explain.
        const row: AccountedPosition = { id: 1, code: 'TXFJ6', direction: 'Buy', quantity: 2, price: 100, last_price: 110, pnl: 4100, account: owner };
        const cover: PositionFill = { ...fill, account: owner, code: 'TXFJ6', action: 'Sell', quantity: 1, price: 110, openClose: 'Cover' };
        expect(applyPositionFill([row], cover, 200)![0]).toMatchObject({ quantity: 1, price: 100, pnl: 2050, costUncertain: true });
    });
    // #85 third review: the snapshot's P&L adjustment belongs to the snapshot
    // lot, not to contracts opened later in-session.
    it('keeps a snapshot P&L adjustment on the snapshot lot only', () => {
        const owner: Account = { ...account, account_type: 'F' };
        const row: AccountedPosition = { id: 1, code: 'TXFJ6', direction: 'Buy', quantity: 2, price: 100, last_price: 110, pnl: 4100, account: owner };
        const add: PositionFill = { ...fill, account: owner, code: 'TXFJ6', quantity: 1, price: 110, openClose: 'New' };
        const [added] = applyPositionFill([row], add, 200, 110)!;
        expect(added).toMatchObject({ quantity: 3, pnl: 4100 });
        const cover: PositionFill = { ...add, key: 'c', action: 'Sell', openClose: 'Cover' };
        // Half the snapshot lot closes: half its +100 adjustment remains.
        const [half] = applyPositionFill([added!], { ...cover, quantity: 1 }, 200, 110)!;
        expect(half).toMatchObject({ quantity: 2, pnl: 2050 });
        // The whole snapshot lot closes: the in-session lot has no adjustment.
        const [rest] = applyPositionFill([added!], { ...cover, quantity: 2 }, 200, 110)!;
        expect(rest).toMatchObject({ quantity: 1, price: 110, pnl: 0 });
        expect(rest).not.toHaveProperty('costUncertain');
    });
    // #85 review P1-1: buys 100 and 120 reported as one row 2 @110. FIFO would
    // leave 1 @120; the row cannot know that, so it must not look confident.
    it('flags a partial close of an aggregate snapshot row instead of a confident cost', () => {
        const owner: Account = { ...account, account_type: 'F' };
        const row: AccountedPosition = { id: 1, code: 'TXFJ6', direction: 'Buy', quantity: 2, price: 110, last_price: 110, pnl: 0, account: owner };
        const cover: PositionFill = { ...fill, account: owner, code: 'TXFJ6', action: 'Sell', quantity: 1, price: 110, openClose: 'Cover' };
        const [p] = applyPositionFill([row], cover, 200)!;
        expect(p).toMatchObject({ quantity: 1, price: 110, costUncertain: true });
        // Flag stays on while the aggregate remains, also through a new add.
        const [added] = applyPositionFill([p!], { ...cover, key: 'b', action: 'Buy', openClose: 'New', price: 115 }, 200)!;
        expect(added).toMatchObject({ quantity: 2, costUncertain: true });
        // Not uncertain: a single-contract row, a full close, or known lots.
        expect(applyPositionFill([{ ...row, quantity: 1 }], cover, 200)).toEqual([]);
        expect(applyPositionFill([row], { ...cover, quantity: 2 }, 200)).toEqual([]);
        const lots = [{ price: 100, quantity: 1 }, { price: 120, quantity: 1 }];
        expect(applyPositionFill([{ ...row, lots }], cover, 200)![0]).toMatchObject({ quantity: 1, price: 120, pnl: -2000 });
        expect(applyPositionFill([{ ...row, lots }], cover, 200)![0]).not.toHaveProperty('costUncertain');
    });
    it('retains stock average cost and remaining unrealized PnL after partial and full sale', () => {
        // Synthetic unit data: excludes fees and realized PnL, which are not computed here.
        const first = applyPositionFill([], { ...fill, quantity: 1000, price: 412.5 }, 1)![0]!;
        const added = applyPositionFill([first], { ...fill, key: 'buy-2', quantity: 1000, price: 411 }, 1, 411)![0]!;
        expect(added).toMatchObject({ quantity: 2000, price: 411.75, last_price: 411, pnl: -1500 });
        const marked = markPosition(added, 409.5, 1);
        expect(marked.pnl).toBe(-4500);
        const other = { ...marked, account: { ...account, account_id: 'other' } };
        const sell: PositionFill = { ...fill, key: 'sell-1', action: 'Sell', quantity: 1000, price: 409.5 };
        // Stocks keep the broker's weighted average cost (平均成本) on a partial sale.
        const partial = applyPositionFill([marked, other], sell, 1)!;
        expect(partial[0]).toMatchObject({ quantity: 1000, price: 411.75, last_price: 409.5, pnl: -2250 });
        expect(partial[1]).toBe(other);
        const moved = markPosition(partial[0]!, 410, 1);
        expect(moved.pnl).toBe(-1750);
        const closed = applyPositionFill([moved, other], { ...sell, key: 'sell-rest', price: 410 }, 1)!;
        expect(closed).toEqual([other]);
        expect(closed[0]).toBe(other);
    });
    it('requires account and fill identity; normalizes lots to shares', () => {
        const body = { trade_id: 'order', exchange_seq: 'fill-1', broker_id: 'test', account_id: 'a', code: '2330', action: 'Buy', price: 120, quantity: 1, order_lot: 'Common', order_cond: 'Cash', ts: fill.ts };
        const parse = (b: object) => positionFill(normalizeOrderEvent({ state: 'StockDeal', data: { StockDeal: b } })!, [account], []);
        expect(parse(body)?.quantity).toBe(1000);
        expect(parse({ ...body, order_lot: 'IntradayOdd' })?.quantity).toBe(1);
        expect(parse({ ...body, account_id: '' })).toBeNull();
        expect(parse({ ...body, exchange_seq: '' })).toBeNull();
        expect(parse({ ...body, order_cond: 'MarginTrading' })?.condition).toBe('MarginTrading');
        expect(parse({ ...body, order_cond: 'Netting' })).toBeNull();
        expect(parse({ ...body, quantity: 0 })).toBeNull();
    });
});

it('projects native Common Buy1 as 1000 shares while retaining the stock order lot', async () => {
    const { default: rawEvents } = await import('./fixtures/native-simulation-stock-common-1.7.5.json');
    const { projectOrderReport, projectTradeDeal } = await import('./order-projection');
    const fixtureAccount = {...account, broker_id:'fixture', account_id:'fixture'};
    const reports = rawEvents.map(normalizeOrderEvent);
    const newBuy = reports.find(r => r?.kind === 'order' && r.opType === 'New' && r.action === 'Buy')!;
    const buyDeal = reports.find(r => r?.kind === 'deal' && r.action === 'Buy')!;
    expect(newBuy).toMatchObject({orderLot:'Common',quantity:1,priceType:'MKT',orderType:'IOC'});
    expect(buyDeal).toMatchObject({orderLot:'Common',quantity:1,price:424});
    const trades = projectOrderReport([], newBuy, [fixtureAccount])!;
    expect(projectTradeDeal(trades,buyDeal)![0]!.status).toMatchObject({status:'Filled',deal_quantity:1});
    const projectedFill = positionFill(buyDeal,[fixtureAccount],trades)!;
    expect(projectedFill.quantity).toBe(1000);
    expect(applyPositionFill([],projectedFill,1)![0]).toMatchObject({quantity:1000,price:424});
    const exitOrder = reports.find(r => r?.kind === 'order' && r.opType === 'New' && r.action === 'Sell')!;
    // Native Flash flatten captured the 2000-share holding, despite quantity input 1.
    // This checks the request report only; it does not claim a Sell fill or Odd QA.
    expect(exitOrder).toMatchObject({orderLot:'Common',quantity:2});
});

it('replays the native two-part Common Sell fill from an explicit 2000-share baseline', async () => {
    const { default: rawEvents } = await import('./fixtures/native-simulation-stock-common-1.7.5.json');
    const { projectOrderReport, projectTradeDeal } = await import('./order-projection');
    const fixtureAccount = {...account, broker_id:'fixture', account_id:'fixture'};
    const reports = rawEvents.map(normalizeOrderEvent);
    const sellOrder = reports.find(r => r?.kind === 'order' && r.action === 'Sell')!;
    const sells = reports.filter(r => r?.kind === 'deal' && r.action === 'Sell');
    expect(sells).toHaveLength(2);
    let trades = projectOrderReport([],sellOrder,[fixtureAccount])!;
    // First Buy was not captured; this is an explicit pre-Sell holding baseline,
    // not a fabricated wire event or a claim that the fixture contains both Buys.
    let positions: AccountedPosition[] = [{...base,account:fixtureAccount,code:sellOrder.code,quantity:2000,price:424,last_price:424,pnl:0,yd_quantity:0}];
    for (const [index,report] of sells.entries()) {
        expect(report).toMatchObject({quantity:1,orderLot:'Common',price:424});
        const next = projectTradeDeal(trades,report!)!;
        expect(next[0]!.status).toMatchObject({status:index===0?'PartFilled':'Filled',deal_quantity:index+1});
        expect(projectTradeDeal(next,report!)).toBe(next);
        const projected = positionFill(report!,[fixtureAccount],trades)!;
        // This fixture's Sell is the app's ordinary flatten (known request
        // condition); the callback itself cannot prove daytrade_short=false.
        positions = applyPositionFill(positions,{ ...projected, daytradeShort: false },1)!;
        expect(positions.reduce((sum,p)=>sum+p.quantity,0)).toBe(index===0?1000:0);
        trades=next;
    }
    expect(positions).toEqual([]);
});
