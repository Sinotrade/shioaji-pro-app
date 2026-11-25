// #409：同一筆權證委託在權證合約表載入前回 STK、載入後回 WRT（SDK 1.8.0）。
// 委託列、成交、持倉投影都以委託 ID／代碼對單，不能因為 security_type 變了
// 被當成兩筆或對不到委託。
import { describe, expect, it } from 'vitest';
import { contractMarket, isWarrantContract } from './contract-market';
import { normalizeOrderEvent } from './order-report';
import { projectOrderReport, projectTradeDeal } from './order-projection';
import { positionFill } from './portfolio-projection';
import type { Account } from './types/portfolio';

const stock: Account = { account_type: 'S', broker_id: 'test', account_id: 'a', person_id: 'fixture', username: 'fixture', signed: true };
const WARRANT = '03001P';

function order(op: string, securityType: 'STK' | 'WRT', status: Record<string, unknown> = {}) {
    return normalizeOrderEvent({ state: 'StockOrder', data: { StockOrder: {
        operation: { op_type: op, op_code: '00', op_msg: '' },
        order: { id: 'w-1', seqno: 'seq-1', ordno: 'ord-1', account: stock, action: 'Buy', price: 1.5, quantity: 3, price_type: 'LMT', order_type: 'ROD', order_lot: 'Common', order_cond: 'Cash' },
        status: { exchange_ts: 1789200000, order_quantity: 3, cancel_quantity: 0, modified_price: 0, ...status },
        contract: { code: WARRANT, security_type: securityType, exchange: 'TSE' },
    } } })!;
}
function deal(seq: string, quantity = 1) {
    return normalizeOrderEvent({ state: 'StockDeal', data: { StockDeal: {
        trade_id: 'w-1', seqno: 'seq-1', ordno: 'ord-1', exchange_seq: seq, broker_id: stock.broker_id, account_id: stock.account_id,
        action: 'Buy', code: WARRANT, price: 1.5, quantity, order_lot: 'Common', order_cond: 'Cash', ts: 1789200001,
    } } })!;
}

describe('warrant reported as STK before the WRT table loads and WRT after', () => {
    it('keeps one order row and its fills across the type change (STK then WRT)', () => {
        let rows = projectOrderReport([], order('New', 'STK'), [stock])!;
        rows = projectTradeDeal(rows, deal('fill-1'))!;
        rows = projectOrderReport(rows, order('Cancel', 'WRT', { cancel_quantity: 2 }), [stock])!;
        expect(rows).toHaveLength(1);
        expect(rows[0]!.status).toMatchObject({ status: 'Cancelled', deal_quantity: 1, cancel_quantity: 2 });
        expect(rows[0]!.contract).toMatchObject({ code: WARRANT, security_type: 'WRT' });
    });
    it('keeps one order row when a WRT row later meets an STK report (sidecar restarted)', () => {
        let rows = projectOrderReport([], order('New', 'WRT'), [stock])!;
        rows = projectTradeDeal(rows, deal('fill-1'))!;
        rows = projectTradeDeal(rows, deal('fill-2', 2))!;
        expect(rows).toHaveLength(1);
        expect(rows[0]!.status).toMatchObject({ status: 'Filled', deal_quantity: 3 });
        expect(projectOrderReport(rows, order('New', 'STK'), [stock])).toHaveLength(1);
    });
    it('projects the same position fill whichever type the trade row carries', () => {
        const stk = projectOrderReport([], order('New', 'STK'), [stock])!;
        const wrt = projectOrderReport([], order('New', 'WRT'), [stock])!;
        const a = positionFill(deal('fill-1'), [stock], stk)!;
        const b = positionFill(deal('fill-1'), [stock], wrt)!;
        expect(a).toEqual(b);
        expect(a).toMatchObject({ code: WARRANT, quantity: 1000 });
    });
    it('routes both types to the securities market and recognizes both as a warrant', () => {
        expect(contractMarket('STK')).toBe('S');
        expect(contractMarket('WRT')).toBe('S');
        expect(isWarrantContract({ security_type: 'STK', code: WARRANT })).toBe(true);
        expect(isWarrantContract({ security_type: 'WRT', code: WARRANT })).toBe(true);
    });
});
