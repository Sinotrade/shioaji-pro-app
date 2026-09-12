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
