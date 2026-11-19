// 真實 wire 形狀的端到端：REST 讀回的成交列、SSE 委託回報序列 → 投影 → chartFills 的 K 棒落點與價格
import { describe, expect, it } from 'vitest';
import { chartFills } from './chart-fills';
import { normalizeOrderEvent } from './order-report';
import { projectOrderReport, projectTradeDeal } from './order-projection';
import { aggregate, kbarsToCandles } from './utils/kbars';
import type { ContractBase } from './types/contract';
import type { AccountedTrade } from './types/order';
import type { Account } from './types/portfolio';

const owner: Account = { account_type: 'F', broker_id: 'F002000', account_id: 'fixture', person_id: '', signed: true, username: '' };
// 圖表開的是連續月 TXFR1（近月 = TXFJ6）；REST 列的 monthly 合約 target_code 是空字串
const chart: ContractBase = { security_type: 'FUT', exchange: 'TAIFEX', code: 'TXFR1', target_code: 'TXFJ6' } as ContractBase;
const unix = (d: string) => Date.parse(`${d}+08:00`) / 1000;
// 1 分 K（close-label-right）15:01–17:00，再用真正的 aggregate 組成 N 分 K
function barsFor(minutes: number) {
    const datetime: string[] = [];
    for (let t = Date.parse('2026-10-14T15:01:00Z'); t <= Date.parse('2026-10-14T17:00:00Z'); t += 60_000) datetime.push(new Date(t).toISOString().slice(0, 19).replace('T', ' '));
    const n = datetime.length;
    return aggregate(kbarsToCandles({ datetime, Open: Array(n).fill(1), High: Array(n).fill(1), Low: Array(n).fill(1), Close: Array(n).fill(1), Volume: Array(n).fill(1) } as never), minutes);
}
const label = (time: number) => new Date(time * 1000).toISOString().slice(11, 16);
const view = (rows: AccountedTrade[], minutes: number, contract = chart) =>
    chartFills({ trades: rows, contract, account: owner, bars: barsFor(minutes), minutes, dayOnly: false }).map(f => `${label(f.time)} ${f.action} ${f.price}x${f.quantity}`);

// REST /order/trades 的 Filled 列，逐字取自 2026-10-14 模擬環境 sidecar 1.7.8（帳號換成測試值）：
// 沒有 order_datetime、monthly 合約 target_code 為空字串、deal.seq 是 '000001'。
// 五筆是當天 15:34–15:55 的成交；時間戳與價格都是回傳原值，不是估計。
const filled = (id: string, ordno: string, action: 'Buy' | 'Sell', lmt: number, priceType: string, orderTs: number, modTs: number, modified: number, dealTs: number, dealPrice: number): AccountedTrade => ({
    account: owner,
    contract: { security_type: 'FUT', region: 'TW', exchange: 'TAIFEX', code: 'TXFJ6', target_code: '' } as never,
    order: { id, seqno: id, ordno, action, price: lmt, quantity: 1, order_type: 'ROD', price_type: priceType, custom_field: '', account: owner, ca: '', octype: 'Auto' } as never,
    status: { id, status: 'Filled', status_code: '00', web_id: '', order_ts: orderTs, msg: '', modified_ts: modTs, modified_price: modified, order_quantity: 1, deal_quantity: 1, cancel_quantity: 0,
        deals: [{ seq: '000001', price: dealPrice, quantity: 1, ts: dealTs }] } as never,
});
const real = [
    filled('002D68', '168A9B', 'Buy', 48818, 'LMT', 1791963263.451933, 1791963264.136927, 0, 1791963264.143537, 48817),   // 15:34:24.144
    filled('002E54', '168B87', 'Buy', 48800, 'LMT', 1791964285.306992, 1791964323.136271, 48881, 1791964323.142407, 48853), // 15:52:03.142（改價 48881 不是成交價）
    filled('002E6B', '168B9E', 'Sell', 48855, 'LMT', 1791964434.968593, 1791964465.137278, 0, 1791964465.155124, 48856),  // 15:54:25.155
    filled('002E7E', '168BB1', 'Buy', 48935, 'LMT', 1791964480.603366, 1791964481.010364, 0, 1791964481.015506, 48866),   // 15:54:41.016
    filled('002E96', '168BC9', 'Sell', 0, 'MKT', 1791964545.390731, 1791964545.405124, 0, 1791964545.410153, 48879),        // 15:55:45.410（市價單）
];

describe('REST 讀回的真實成交列落在正確的 K 棒與價格（圖表合約 TXFR1 → TXFJ6）', () => {
    it('成交時間確實是台北 15:34:24 … 15:55:45', () => {
        expect(real.map(t => new Date(t.status.deals[0]!.ts * 1000 + 8 * 3600_000).toISOString().slice(11, 19)))
            .toEqual(['15:34:24', '15:52:03', '15:54:25', '15:54:41', '15:55:45']);
    });
    it.each([
        [1, ['15:35 Buy 48817x1', '15:53 Buy 48853x1', '15:55 Sell 48856x1', '15:55 Buy 48866x1', '15:56 Sell 48879x1']],
        [5, ['15:35 Buy 48817x1', '15:55 Buy 48853x1', '15:55 Sell 48856x1', '15:55 Buy 48866x1', '16:00 Sell 48879x1']],
        [60, ['16:00 Buy 48817x1', '16:00 Buy 48853x1', '16:00 Sell 48856x1', '16:00 Buy 48866x1', '16:00 Sell 48879x1']],
        [1440, ['00:00 Buy 48817x1', '00:00 Buy 48853x1', '00:00 Sell 48856x1', '00:00 Buy 48866x1', '00:00 Sell 48879x1']],
    ])('%i 分 K', (minutes, expected) => {
        expect(view(real, minutes)).toEqual(expected);
    });
    it('價格只取 deal.price（不是委託價或改價），其他月份與未解析的別名沒有標記，只看日盤時夜盤成交不出現', () => {
        expect(view(real, 1).join()).not.toMatch(/48881|48800|48818/);
        expect(view(real, 5, { ...chart, code: 'TXFK6', target_code: '' })).toEqual([]);
        expect(view(real, 5, { ...chart, code: 'TXFR2', target_code: 'TXFK6' })).toEqual([]);
        expect(view(real, 5, { ...chart, target_code: '' })).toEqual([]);
        for (const minutes of [1, 5, 60, 1440])
            expect(chartFills({ trades: real, contract: chart, account: owner, bars: barsFor(minutes), minutes, dayOnly: true })).toEqual([]);
    });
});

// SSE 序列。模擬環境的 New 沒有 full_code（列由 HTTP 回應提供，repo 內有 1.7.5／1.7.6 的真實樣本）；
// 正式環境的 New 帶 code:'TXF'、full_code:'TXFJ6'、exchange:'TIM'（真實樣本）。注意：repo 內沒有正式環境 Deal 的真實 payload，
// 下面 prod 的 Deal 形狀（code 'TXF'、帶 full_code）是依文件欄位與 1.7.6 模擬樣本推得，只證明投影與圖上落點，不證明 wire 相容。
describe.each(['sim', 'prod'] as const)('SSE 序列（%s）：New → UpdatePrice → 部分成交 → 再成交 → Cancel', env => {
    const contractBody = env === 'sim'
        ? { security_type: 'FUT', code: 'TXFJ6', exchange: 'TAIFEX', delivery_month: '', full_code: '' }
        : { security_type: 'FUT', code: 'TXF', exchange: 'TIM', delivery_month: '202610', full_code: 'TXFJ6' };
    const order = (op: string, o: { qty?: number; cancel?: number; orderQty?: number; price?: number; mod?: number; ts: string }) => normalizeOrderEvent({ state: 'FuturesOrder', data: { FuturesOrder: {
        operation: { op_type: op, op_code: '00', op_msg: '' },
        order: { id: 'S1', seqno: 'S1', ordno: '168B87', account: owner, action: 'Buy', price: o.price ?? 48800, quantity: o.qty ?? 3, order_type: 'ROD', price_type: 'LMT', market_type: 'Day', oc_type: 'Auto', subaccount: '', combo: false },
        status: { id: 'S1', exchange_ts: unix(o.ts), modified_price: o.mod ?? 0, cancel_quantity: o.cancel ?? 0, order_quantity: o.orderQty ?? o.qty ?? 3, web_id: 'Z' },
        contract: contractBody } } })!;
    const deal = (seq: string, price: number, date: string) => normalizeOrderEvent({ state: 'FuturesDeal', data: { FuturesDeal: {
        trade_id: 'S1', seqno: 'S1', ordno: '168B87', exchange_seq: seq, action: 'Buy', code: env === 'sim' ? 'TXFJ6' : 'TXF', full_code: env === 'sim' ? '' : 'TXFJ6',
        price, quantity: 1, ts: unix(date), broker_id: owner.broker_id, account_id: owner.account_id } } })!;
    // 模擬環境：HTTP 下單回應（PendingSubmit，沒有成交）提供 canonical 合約 TXFJ6
    const baseline: AccountedTrade[] = env === 'sim' ? [{ account: owner,
        contract: { security_type: 'FUT', region: 'TW', exchange: 'TAIFEX', code: 'TXFJ6', target_code: '' } as never,
        order: { id: 'S1', seqno: 'S1', ordno: '168B87', action: 'Buy', price: 48800, quantity: 3, order_type: 'ROD', price_type: 'LMT', custom_field: '', account: owner, ca: '', octype: 'Auto' } as never,
        status: { id: 'S1', status: 'PendingSubmit', status_code: '', web_id: '', order_ts: 0, msg: '', modified_ts: 0, modified_price: 0, order_quantity: 0, deal_quantity: 0, cancel_quantity: 0, deals: [] } as never }] : [];
    it('每一步圖上的標記', () => {
        const step = (rows: AccountedTrade[], report: ReturnType<typeof order> | ReturnType<typeof deal>) => {
            const next = report.kind === 'order' ? projectOrderReport(rows, report, [owner]) : projectTradeDeal(rows, report);
            expect(next).not.toBeNull();
            return next!;
        };
        let rows = step(baseline, order('New', { ts: '2026-10-14T15:52:00' }));
        expect(view(rows, 1)).toEqual([]);
        rows = step(rows, order('UpdatePrice', { price: 48881, mod: 48881, ts: '2026-10-14T15:52:01' }));
        expect(rows[0]!.status.modified_price).toBe(48881);
        expect(view(rows, 1)).toEqual([]);                                   // 改價不是成交
        rows = step(rows, deal('000001', 48853, '2026-10-14T15:52:03.142'));
        expect(rows[0]!.status.status).toBe('PartFilled');
        expect(view(rows, 5)).toEqual(['15:55 Buy 48853x1']);
        expect(projectTradeDeal(rows, deal('000001', 48853, '2026-10-14T15:52:03.142'))).toBe(rows); // 重複回報不重複畫
        rows = step(rows, deal('000002', 48860, '2026-10-14T15:55:45.410'));
        expect(view(rows, 5)).toEqual(['15:55 Buy 48853x1', '16:00 Buy 48860x1']);
        rows = step(rows, order('Cancel', { qty: 1, cancel: 1, orderQty: 0, ts: '2026-10-14T15:56:00' }));
        expect(rows[0]!.status).toMatchObject({ status: 'Cancelled', deal_quantity: 2, cancel_quantity: 1 });
        expect(view(rows, 1)).toEqual(['15:53 Buy 48853x1', '15:56 Buy 48860x1']);   // 撤掉的餘量不影響已成交的標記
        expect(view(rows, 5, { ...chart, code: 'TXFK6', target_code: '' })).toEqual([]);  // 月份隔離
    });
});
