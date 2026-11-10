import nativeMutations from './fixtures/native-simulation-mutations-1.7.5.json';
import { describe, expect, it } from 'vitest';
import { normalizeOrderEvent } from './order-report';
import { projectOrderReport, projectTradeDeal } from './order-projection';
import type { Account } from './types/portfolio';

const stock: Account = { account_type: 'S', broker_id: 'test', account_id: 'a', person_id: 'fixture', username: 'fixture', signed: true };
const future: Account = { ...stock, account_type: 'F' };
// Documented 1.7.5 externally tagged wire payload; values are synthetic.
function order(account = stock, op = 'New', overrides: Record<string, unknown> = {}, status: Record<string, unknown> = {}, contract: Record<string, unknown> = {}, opCode = '00') {
    const variant = account.account_type === 'S' ? 'StockOrder' : 'FuturesOrder';
    return normalizeOrderEvent({ state: variant, data: { [variant]: {
        operation: { op_type: op, op_code: opCode, op_msg: opCode === '00' ? '' : 'Rejected' },
        order: { id: 'trade-1', seqno: 'seq-1', ordno: 'ord-1', account, action: 'Buy', price: 100, quantity: 3, price_type: 'LMT', order_type: 'ROD', order_lot: 'Common', order_cond: 'Cash', oc_type: 'Auto', custom_field: 'grid', ...overrides },
        status: { exchange_ts: 1789200000, order_quantity: 3, cancel_quantity: 0, modified_price: 0, ...status },
        contract: { code: account.account_type === 'S' ? '2330' : 'TXF', full_code: account.account_type === 'F' ? 'TXFI6' : undefined, security_type: account.account_type === 'S' ? 'STK' : 'FUT', exchange: account.account_type === 'S' ? 'TSE' : 'TAIFEX', ...contract },
    } } })!;
}
function deal(account = stock, overrides: Record<string, unknown> = {}) {
    const variant = account.account_type === 'S' ? 'StockDeal' : 'FuturesDeal';
    return normalizeOrderEvent({ state: variant, data: { [variant]: {
        trade_id: 'trade-1', seqno: 'seq-1', ordno: 'ord-1', exchange_seq: 'fill-1', broker_id: account.broker_id, account_id: account.account_id,
        action: 'Buy', code: account.account_type === 'S' ? '2330' : 'TXF', full_code: account.account_type === 'F' ? 'TXFI6' : undefined,
        price: 101, quantity: 1, order_lot: 'Common', order_cond: 'Cash', ts: 1789200001, ...overrides,
    } } })!;
}

describe('wire order projection', () => {
    it.each([stock, future])('preserves partial fills, deduplicates and reaches Filled for $account_type', account => {
        const rows = projectOrderReport([], order(account), [account])!;
        const partial = projectTradeDeal(rows, deal(account))!;
        expect(partial[0]!.status).toMatchObject({ status: 'PartFilled', deal_quantity: 1 });
        expect(projectTradeDeal(partial, deal(account))).toBe(partial);
        const filled = projectTradeDeal(partial, deal(account, { exchange_seq: 'fill-2', quantity: 2 }))!;
        expect(filled[0]!.status).toMatchObject({ status: 'Filled', deal_quantity: 3 });
        expect(filled[0]!.status.deals).toHaveLength(2);
        expect(projectOrderReport(filled, order(account), [account])![0]!.status.deal_quantity).toBe(3);
    });
    it('requires an order baseline for deal-before-order, then accepts a replay', () => {
        expect(projectTradeDeal([], deal())).toBeNull();
        const rows = projectOrderReport([], order(), [stock])!;
        expect(projectTradeDeal(rows, deal())![0]!.status.deal_quantity).toBe(1);
    });
    it('isolates equal order IDs and exchange sequences across accounts', () => {
        const other = { ...stock, account_id: 'b' };
        let rows = projectOrderReport([], order(), [stock, other])!;
        rows = projectOrderReport(rows, order(other), [stock, other])!;
        rows = projectTradeDeal(rows, deal(other))!;
        expect(rows.map(t => t.status.deal_quantity)).toEqual([0, 1]);
        expect(projectTradeDeal(rows, deal({ ...stock, broker_id: 'other' }))).toBeNull();
    });
    it('does not erase working orders on rejected cancellation', () => {
        const rows = projectTradeDeal(projectOrderReport([], order(), [stock])!, deal())!;
        expect(projectOrderReport(rows, order(stock, 'Cancel', {}, { cancel_quantity: 2 }, {}, '99'), [stock])).toBe(rows);
        expect(projectOrderReport(rows, order(stock, 'Cancel', {}, { cancel_quantity: 2 }), [stock])![0]!.status).toMatchObject({ status: 'Cancelled', deal_quantity: 1, cancel_quantity: 2 });
    });
    it('retains market IOC, grid tag and futures full_code', () => {
        const rows = projectOrderReport([], order(future, 'New', { price: 0, price_type: 'MKT', order_type: 'IOC' }), [future])!;
        expect(rows[0]!.contract.code).toBe('TXFI6');
        expect(rows[0]!.order).toMatchObject({ price: 0, price_type: 'MKT', order_type: 'IOC', custom_field: 'grid', octype: 'Auto' });
        expect(projectOrderReport([], order(future, 'New', {}, {}, { full_code: undefined }), [future])).toBeNull();
    });
    it('rejects incomplete account identity, missing fill identity and overfill', () => {
        expect(projectOrderReport([], order(stock, 'New', { account: {} }), [stock])).toBeNull();
        const rows = projectOrderReport([], order(), [stock])!;
        expect(projectTradeDeal(rows, deal(stock, { exchange_seq: '' }))).toBeNull();
        expect(projectTradeDeal(rows, deal(stock, { quantity: 4 }))).toBeNull();
    });
    it('refuses a contradictory futures full_code rather than applying the fill to another contract', () => {
        const rows = projectOrderReport([], order(future), [future])!;
        expect(projectTradeDeal(rows, deal(future, { full_code: 'TXFJ6' }))).toBeNull();
    });
    it('does not turn a missing execution price into a zero-price fill', () => {
        const rows = projectOrderReport([], order(), [stock])!;
        expect(projectTradeDeal(rows, deal(stock, { price: undefined }))).toBeNull();
    });
});
it('accepts futures deal actual code when full_code is empty only against known canonical trade', () => {
    const rows = projectOrderReport([], order(future), [future])!;
    expect(projectTradeDeal(rows, deal(future, {full_code:'',code:'TXFI6'}))![0]!.status.deal_quantity).toBe(1);
    expect(projectTradeDeal(rows, deal(future, {full_code:'',code:'TXF'}))).toBeNull();
    expect(projectTradeDeal(rows, deal(future, {full_code:'',code:'TXFJ6'}))).toBeNull();
});

it('keeps the original Trade quantity through native price and quantity updates', () => {
    const account = { ...future, broker_id: 'fixture', account_id: 'fixture' };
    const [newEvent, priceEvent, qtyEvent] = nativeMutations.map(normalizeOrderEvent);
    const baseline = projectOrderReport([], order(account), [account])![0]!;
    const raw = nativeMutations[0]!.data.FuturesOrder!;
    const known = { ...baseline, contract: { ...baseline.contract, code: raw.contract.code },
        order: { ...baseline.order, id: raw.order.id, quantity: 2 },
        status: { ...baseline.status, order_quantity: 2 } };
    let rows = projectOrderReport([known], newEvent!, [account])!;
    rows = projectOrderReport(rows, priceEvent!, [account])!;
    expect(rows[0]!.status).toMatchObject({status:'Submitted', modified_price:44990, order_quantity:2});
    rows = projectOrderReport(rows, qtyEvent!, [account])!;
    expect(rows[0]!.status).toMatchObject({status:'Submitted', order_quantity:2, cancel_quantity:1, deal_quantity:0});
    expect(rows[0]!.order.quantity).toBe(2);
    expect(projectOrderReport(rows, qtyEvent!, [account])![0]!.status).toEqual(rows[0]!.status);
});
it.each([stock, future])('retains partial reduction, fills and cumulative cancellation for $account_type', account => {
    let rows = projectOrderReport([], order(account, 'New', {quantity:5}, {order_quantity:5}), [account])!;
    rows = projectOrderReport(rows, order(account, 'UpdateQty', {quantity:5}, {order_quantity:4,cancel_quantity:1}), [account])!;
    expect(rows[0]!.status).toMatchObject({status:'Submitted',order_quantity:5,cancel_quantity:1});
    rows = projectTradeDeal(rows, deal(account))!;
    expect(projectOrderReport(rows, order(account, 'UpdateQty', {quantity:5}, {order_quantity:3,cancel_quantity:1}), [account])).toBeNull();
    rows = projectOrderReport(rows, order(account, 'Cancel', {quantity:5}, {order_quantity:0,cancel_quantity:3}), [account])!;
    expect(rows[0]!.status).toMatchObject({status:'Cancelled',order_quantity:5,cancel_quantity:4,deal_quantity:1});
});

it('replays native reductions, final cancel and New/Cover fills without duplicate cancellation', () => {
    const account = { ...future, broker_id:'fixture', account_id:'fixture' };
    let rows: NonNullable<ReturnType<typeof projectOrderReport>> = [];
    for (const raw of nativeMutations) {
        const report = normalizeOrderEvent(raw)!;
        if (report.kind === 'order') {
            const body = raw.data.FuturesOrder!;
            if (!rows.some(t => t.order.id === report.id)) {
                // HTTP canonical contract baseline, as used by pending New replay.
                const baseline = projectOrderReport([], order(account), [account])![0]!;
                rows.push({...baseline, contract:{...baseline.contract,code:body.contract.code},
                    order:{...baseline.order,id:report.id,quantity:report.quantity},
                    status:{...baseline.status,order_quantity:report.quantity}});
            }
            rows = projectOrderReport(rows, report, [account])!;
            expect(rows).not.toBeNull();
            if (report.opType === 'Cancel') {
                const cancelled = rows.find(t => t.order.id === report.id)!;
                expect(cancelled.status).toMatchObject({status:'Cancelled',order_quantity:2,cancel_quantity:2});
                expect(projectOrderReport(rows, report, [account])).toBe(rows);
            }
        } else {
            rows = projectTradeDeal(rows, report)!;
            expect(rows).not.toBeNull();
            expect(rows.find(t => t.order.id === report.tradeId)!.status).toMatchObject({status:'Filled',deal_quantity:1});
            expect(projectTradeDeal(rows, report)).toBe(rows);
        }
    }
    expect(rows.filter(t => t.status.status === 'Filled').map(t => [t.order.action,t.order.octype])).toEqual([['Buy','New'],['Sell','Cover']]);
});

it('projects redacted production stock Cancel, New3, price change and reduction to two working lots', async () => {
    const { default: events } = await import('./fixtures/production-stock-mutations-1.7.5.json');
    const { remainingWorkingOrderQuantity } = await import('./working-order-quantity');
    const account = {...stock, broker_id:'fixture',account_id:'fixture'};
    const reports = events.map(normalizeOrderEvent);
    expect(reports.map(r => r?.kind === 'order' ? [r.opType,r.opCode] : null)).toEqual([
        ['Cancel','00'],['New','00'],['UpdatePrice','00'],['UpdateQty','00'],
    ]);
    const [cancel,newOrder,price,reduction] = reports;
    if (cancel?.kind !== 'order') throw new Error('Expected captured Cancel order');
    // The cancelled old order predates capture; establish its one-lot baseline explicitly.
    const baseline = projectOrderReport([],order(account,'New',{id:cancel!.id,quantity:1},
        {order_quantity:1},{code:cancel!.code}),[account])!;
    const cancelled = projectOrderReport(baseline,cancel!,[account])!;
    expect(cancelled[0]!.status).toMatchObject({status:'Cancelled',order_quantity:1,cancel_quantity:1});
    let rows = projectOrderReport(cancelled,newOrder!,[account])!;
    rows = projectOrderReport(rows,price!,[account])!;
    expect(rows[1]!.status.modified_price).toBe(42.5);
    rows = projectOrderReport(rows,reduction!,[account])!;
    expect(rows[1]!.order).toMatchObject({quantity:3,price:42.5});
    expect(rows[1]!.status).toMatchObject({status:'Submitted',order_quantity:3,cancel_quantity:1,deal_quantity:0});
    expect(remainingWorkingOrderQuantity(rows[1]!)).toBe(2);
    expect(rows[1]!.status.modified_price || rows[1]!.order.price).toBe(42.5);
    expect(projectOrderReport(rows,reduction!,[account])![1]!.status).toEqual(rows[1]!.status);
});

it('hydrates missing PendingSubmit identifiers from production futures New and isolates a rejected order', async () => {
    const { default: events } = await import('./fixtures/production-futures-identifiers-1.7.5.json');
    const account = {...future, broker_id:'fixture',account_id:'fixture'};
    const reports = events.map(normalizeOrderEvent);
    const [failed,accepted,cancelled] = reports;
    if (failed?.kind !== 'order' || accepted?.kind !== 'order' || cancelled?.kind !== 'order') throw new Error('Expected order wire');
    expect(failed.opCode).toBe('99Q9');
    expect(accepted.id).not.toBe(failed.id);
    const baseline = projectOrderReport([],order(account),[account])![0]!;
    // Explicit HTTP-like pending baseline: canonical contract known, broker
    // sequence/order numbers absent until the captured New acknowledgement.
    const pending = (index: number) => ({...baseline,
        contract:{...baseline.contract,code:events[index]!.data.FuturesOrder.contract.full_code || events[index]!.data.FuturesOrder.contract.code},
        order:{...baseline.order,id:reports[index]!.kind === 'order' ? reports[index]!.id : '',seqno:'',ordno:'',quantity:3},
        status:{...baseline.status,status:'PendingSubmit' as const,order_quantity:3}});
    let rows = projectOrderReport([pending(0),pending(1)],failed,[account])!;
    expect(rows[0]!.status.status).toBe('Failed');
    expect(rows[1]!.status.status).toBe('PendingSubmit');
    rows = projectOrderReport(rows,accepted,[account])!;
    expect(rows[1]!.order).toMatchObject({id:accepted.id,seqno:accepted.seqno,ordno:accepted.ordno});
    expect(accepted.seqno).not.toBe(''); expect(accepted.ordno).not.toBe('');
    expect(rows[1]!.status.status).toBe('Submitted');
    expect(cancelled).toMatchObject({opType:'Cancel',opCode:'00',orderQuantity:3,cancelQuantity:3,priceType:'CXL'});
    rows = projectOrderReport(rows,cancelled,[account])!;
    expect(rows[0]!.status.status).toBe('Failed');
    expect(rows[1]!.status).toMatchObject({status:'Cancelled',order_quantity:3,cancel_quantity:3});
});

it('preserves original futures quantity across native UPD/UPL/CXL order field changes', async () => {
    const { default: events } = await import('./fixtures/production-futures-reduced-order-fields-1.7.5.json');
    const { remainingWorkingOrderQuantity } = await import('./working-order-quantity');
    const account = {...future,broker_id:'fixture',account_id:'fixture'};
    const reports=events.map(normalizeOrderEvent);
    expect(reports.map(r=>r?.kind==='order'?[r.opType,r.quantity,r.orderQuantity,r.cancelQuantity,r.priceType]:null)).toEqual([
        ['New',2,2,0,'LMT'],['UpdateQty',1,1,1,'UPD'],['UpdatePrice',2,2,0,'UPL'],['Cancel',1,1,1,'CXL'],
    ]);
    let rows=projectOrderReport([],reports[0]!,[account])!;
    expect(rows[0]!.status).toMatchObject({status:'Submitted',order_quantity:2,cancel_quantity:0});
    rows=projectOrderReport(rows,reports[1]!,[account])!;
    expect(rows).not.toBeNull();
    expect(rows[0]!.order.quantity).toBe(2);
    expect(rows[0]!.status).toMatchObject({status:'Submitted',order_quantity:2,cancel_quantity:1});
    expect(remainingWorkingOrderQuantity(rows[0]!)).toBe(1);
    rows=projectOrderReport(rows,reports[2]!,[account])!;
    expect(rows[0]!.order.quantity).toBe(2);
    expect(rows[0]!.status).toMatchObject({status:'Submitted',order_quantity:2,cancel_quantity:1});
    expect(rows[0]!.status.modified_price || rows[0]!.order.price).toBe(490);
    expect(remainingWorkingOrderQuantity(rows[0]!)).toBe(1);
    rows=projectOrderReport(rows,reports[3]!,[account])!;
    expect(rows[0]!.order.quantity).toBe(2);
    expect(rows[0]!.status).toMatchObject({status:'Cancelled',order_quantity:2,cancel_quantity:2});
    expect(remainingWorkingOrderQuantity(rows[0]!)).toBe(0);
    expect(projectOrderReport(rows,reports[3]!,[account])).toBe(rows);
});

it('a background-engine futures New without full_code is projected with the engine\'s order code (QA 10/12 持倉暫未套用)', () => {
    const report = order(future, 'New', {}, {}, { full_code: undefined });
    expect(projectOrderReport([], report, [future])).toBeNull();
    const rows = projectOrderReport([], report, [future], 'TXFJ6')!;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.contract.code).toBe('TXFJ6');
    // only for a New: a later report of an unknown order is still refused
    expect(projectOrderReport([], order(future, 'Cancel', {}, {}, { full_code: undefined }), [future], 'TXFJ6')).toBeNull();
    // a full_code on the wire always wins over the hint
    expect(projectOrderReport([], order(future, 'New'), [future], 'MXFJ6')![0]!.contract.code).toBe('TXFI6');
});

// PR #400 review P1: 委託合計要靠 order_cond 判斷回補，不能把缺欄位當成現股
describe('stock order conditions on projected rows', () => {
    it('carries order_cond from a stock order report and never invents daytrade_short', () => {
        const rows = projectOrderReport([], order(stock, 'New', { order_cond: 'MarginTrading' }), [stock])!;
        expect(rows[0]!.order.order_cond).toBe('MarginTrading');
        expect(rows[0]!.order).not.toHaveProperty('daytrade_short');
        expect(projectOrderReport([], order(future), [future])![0]!.order).not.toHaveProperty('order_cond');
    });
    it('fills a missing order_cond from the stock deal report, keeping an existing one', () => {
        const rows = projectOrderReport([], order(), [stock])!;
        const bare = rows.map(t => ({ ...t, order: { ...t.order, order_cond: undefined } }));
        expect(projectTradeDeal(bare, deal(stock, { order_cond: 'MarginTrading' }))![0]!.order.order_cond).toBe('MarginTrading');
        expect(projectTradeDeal(rows, deal(stock, { order_cond: 'MarginTrading' }))![0]!.order.order_cond).toBe('Cash');
    });
});
