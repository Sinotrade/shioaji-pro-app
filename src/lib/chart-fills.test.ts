import { beforeEach, describe, expect, it } from 'vitest';
import productionFutures from './fixtures/production-futures-reduced-order-fields-1.7.5.json';
import productionStock from './fixtures/production-stock-mutations-1.7.5.json';
import simulationFutures from './fixtures/native-simulation-mutations-1.7.5.json';
import simulationStock from './fixtures/native-simulation-stock-common-1.7.5.json';
import { chartFills, createProjectionCache, missingDeals, priceKey, projectChartFills, rolloverCodes, type FillRollover } from './chart-fills';
import { normalizeOrderEvent } from './order-report';
import { projectOrderReport, projectTradeDeal } from './order-projection';
import type { ContractBase } from './types/contract';
import type { Candle } from './types/market';
import type { AccountedTrade, Deal } from './types/order';
import type { Account } from './types/portfolio';

const account: Account = {
    account_type: 'S', broker_id: 'A', account_id: '1234567',
    person_id: '', signed: true, username: 'Test',
};
const futureAccount: Account = { ...account, account_type: 'F' };
const stock: ContractBase = { code: '2330', security_type: 'STK', exchange: 'TSE', target_code: null };
const future: ContractBase = { code: 'TXFJ6', security_type: 'FUT', exchange: 'TAIFEX', target_code: null };
// Live order reports say 'TIM' for futures/options; the contract type does not list it.
const TIM = 'TIM' as string as ContractBase['exchange'];
const unix = (date: string) => Date.parse(`${date}+08:00`) / 1000;
const wall = (date: string) => Date.parse(`${date}Z`) / 1000;
const bar = (date: string): Candle => ({ time: wall(date), open: 100, high: 110, low: 90, close: 105, volume: 1 });
const deal = (seq = '1', date = '2026-10-13T09:00:00', overrides: Partial<Deal> = {}): Deal => ({
    seq, price: 101, quantity: 1, ts: unix(date), ...overrides,
});
function trade(deals: Deal[] = [deal()], overrides: Partial<AccountedTrade> = {}): AccountedTrade {
    return {
        account, contract: stock,
        order: { id: 'order-1', seqno: 'seq-1', ordno: 'ord-1', action: 'Buy', price: 99, quantity: 10, order_lot: 'Common', account },
        status: { id: 'order-1', status: 'PartFilled', status_code: '00', order_quantity: 10,
            deal_quantity: 1, cancel_quantity: 0, modified_price: 0, msg: '', deals },
        ...overrides,
    };
}
function project(trades: readonly AccountedTrade[], overrides: Partial<Parameters<typeof chartFills>[0]> = {}) {
    return chartFills({ trades, contract: stock, account, bars: [bar('2026-10-13T09:05:00')], minutes: 5, dayOnly: false, ...overrides });
}

describe('chartFills', () => {
    it('uses actual partial and cancelled-order deals, preserving each fill price and quantity', () => {
        const partial = trade([deal('1'), deal('2', '2026-10-13T09:03:00', { price: 102, quantity: 2 })]);
        const cancelled = trade([deal('3', '2026-10-13T09:04:00', { price: 103, quantity: 3 })]);
        cancelled.order = { ...cancelled.order, id: 'order-2', action: 'Sell' };
        cancelled.status = { ...cancelled.status, status: 'Cancelled', deal_quantity: 3, cancel_quantity: 7 };
        const filledWithoutDeals = trade([]);
        filledWithoutDeals.status = { ...filledWithoutDeals.status, status: 'Filled', deal_quantity: 10 };
        // code 是成交合約代碼、account 是這筆成交所屬的範圍帳戶
        const own = { code: '2330', account };
        expect(project([partial, cancelled, filledWithoutDeals]).map(({ id: _id, ...fill }) => fill)).toEqual([
            { time: wall('2026-10-13T09:05:00'), ts: unix('2026-10-13T09:00:00'), action: 'Buy', price: 101, quantity: 1, unit: '張', ...own },
            { time: wall('2026-10-13T09:05:00'), ts: unix('2026-10-13T09:03:00'), action: 'Buy', price: 102, quantity: 2, unit: '張', ...own },
            { time: wall('2026-10-13T09:05:00'), ts: unix('2026-10-13T09:04:00'), action: 'Sell', price: 103, quantity: 3, unit: '張', ...own },
        ]);
    });

    it('isolates account type, broker and full account number and rejects contradictory or unknown owners', () => {
        const mine = trade();
        const owners = [
            { ...account, broker_id: 'B' },
            { ...account, account_type: 'F' },
            { ...account, account_id: '7654567' },
        ];
        const otherTrades = owners.map((owner, i) => trade([deal(`other-${i}`)], { account: owner, order: { ...mine.order, account: owner } }));
        const conflict = trade([deal('conflict')], { account, order: { ...mine.order, account: owners[0] } });
        const unknown = trade([deal('unknown')], { account: undefined, order: { ...mine.order, account: undefined } });
        const fallback = trade([deal('2')], { account: undefined });
        expect(project([mine, ...otherTrades, conflict, unknown, fallback])).toHaveLength(2);
        expect(project([mine], { account: undefined })).toEqual([]);
        expect(project([mine], { account: { ...account, broker_id: '' } })).toEqual([]);
    });

    it('requires exact security type, exchange and resolved contract code', () => {
        const contracts: ContractBase[] = [stock,
            { ...stock, code: '2317' }, { ...stock, exchange: 'OTC' }, { ...stock, security_type: 'WRT' }];
        const fills = project(contracts.map((contract, i) => trade([deal(String(i))], { contract })));
        expect(fills).toHaveLength(1);
        expect(fills[0]?.price).toBe(101);
    });

    it('resolves continuous aliases only through their current target and never crosses expiry months', () => {
        const continuous: ContractBase = { ...future, code: 'TXFR1', target_code: 'TXFJ6' };
        const contracts = [future, continuous, { ...continuous, target_code: 'TXFK6' }, { ...future, code: 'TXFK6' }, { ...continuous, target_code: null }];
        const rows = contracts.map((contract, i) => trade([deal(String(i))], {
            account: futureAccount, contract, order: { ...trade().order, account: futureAccount },
        }));
        expect(project(rows, { contract: continuous, account: futureAccount })).toHaveLength(2);
        expect(project(rows, { contract: future, account: futureAccount })).toHaveLength(2);
        expect(project(rows, { contract: { ...continuous, target_code: null }, account: futureAccount })).toEqual([]);
    });

    it('R2（次月連續）別名同樣只靠 target_code：未解析不配任何成交，解析後只配到那個月', () => {
        const alias: ContractBase = { ...future, code: 'TXFR2', target_code: 'TXFK6' };
        // an unresolved R2 row must not match an unresolved R2 chart just because the two codes are equal
        const rows = [future, { ...future, code: 'TXFK6' }, { ...future, code: 'TXFL6' }, { ...alias, target_code: null }].map((contract, i) => trade([deal(String(i))], {
            account: futureAccount, contract, order: { ...trade().order, id: `order-${i}`, account: futureAccount },
        }));
        expect(project(rows, { contract: { ...alias, target_code: null }, account: futureAccount })).toEqual([]);
        expect(project(rows, { contract: { ...alias, target_code: '' }, account: futureAccount })).toEqual([]);
        expect(project(rows, { contract: alias, account: futureAccount }).map(fill => fill.price)).toHaveLength(1);
        expect(project(rows.slice(0, 1), { contract: alias, account: futureAccount })).toEqual([]);
    });

    // 換月日委託清單同時有上個月份與本月份的成交：別名換月前指向 previous，cutoff 之後才指向現在的 target
    it.each([
        ['R1', 'TXFR1', 'TXFK6', 'TXFJ6', 'TXFL6'],
        ['R2', 'TXFR2', 'TXFL6', 'TXFK6', 'TXFJ6'],
    ])('換月（%s）：cutoff 前只顯示上一個月份、cutoff（含）之後只顯示現在的月份，其他月份都不顯示', (_name, code, target, previous, other) => {
        const cutoff = unix('2026-10-21T15:00:00');
        const chart: ContractBase = { ...future, code, target_code: target };
        const rows = ([
            [previous, '2026-10-21T09:01:00'], [target, '2026-10-21T09:02:00'], [other, '2026-10-21T09:03:00'],
            [target, '2026-10-21T15:00:00'], [previous, '2026-10-21T15:01:00'], [other, '2026-10-21T15:02:00'],
        ] as const).map(([month, date], i) => trade([deal('1', date)], {
            contract: { ...future, code: month }, account: futureAccount, order: { ...trade().order, id: `order-${i}`, account: futureAccount },
        }));
        const view = (rollover?: FillRollover | null) => project(rows, { contract: chart, account: futureAccount, rollover,
            bars: [bar('2026-10-21T09:05:00'), bar('2026-10-21T15:05:00')] }).map(fill => [JSON.parse(fill.id)[5], fill.ts]);
        // 成交 id 用成交本身的合約代碼
        expect(view({ previous, cutoff })).toEqual([[previous, unix('2026-10-21T09:01:00')], [target, unix('2026-10-21T15:00:00')]]);
        // 沒有 rollover：與舊版相同，只認現在的 target
        expect(view()).toEqual([[target, unix('2026-10-21T09:02:00')], [target, unix('2026-10-21T15:00:00')]]);
        expect(view(null)).toEqual(view());
    });

    it.each([
        [1, '2026-10-13T09:00:00', '2026-10-13T09:01:00'],
        [5, '2026-10-13T09:00:00', '2026-10-13T09:05:00'],
        [5, '2026-10-13T09:04:59.999', '2026-10-13T09:05:00'],
        [5, '2026-10-13T09:05:00', '2026-10-13T09:10:00'],
        [60, '2026-10-13T09:59:59', '2026-10-13T10:00:00'],
    ])('aligns %i minute fill at %s to its close-label-right bar', (minutes, date, label) => {
        const fills = project([trade([deal('1', date)])], { minutes, bars: [bar(label)] });
        expect(fills).toHaveLength(1);
        expect(fills[0]?.time).toBe(wall(label));
        expect(fills[0]?.ts).toBe(unix(date));
    });

    it('groups daily fills like the daily bars do: by the calendar day of the 1-minute close label', () => {
        // label 00:00 covers 23:59:00–23:59:59, so that minute belongs to the next day's bar (utils/kbars aggregate)
        const dates = ['2026-10-12T23:58:59.999', '2026-10-12T23:59:00', '2026-10-12T23:59:59.999', '2026-10-13T00:00:00', '2026-10-13T23:58:59'];
        const rows = [trade(dates.map((date, i) => deal(String(i), date)), {
            contract: future, account: futureAccount, order: { ...trade().order, account: futureAccount },
        })];
        const fills = project(rows, { contract: future, account: futureAccount, minutes: 1440,
            bars: [bar('2026-10-12T00:00:00'), bar('2026-10-13T00:00:00')] });
        expect(fills.map(fill => fill.time)).toEqual([
            wall('2026-10-12T00:00:00'), wall('2026-10-13T00:00:00'), wall('2026-10-13T00:00:00'),
            wall('2026-10-13T00:00:00'), wall('2026-10-13T00:00:00'),
        ]);
        expect(fills.map(fill => fill.ts)).toEqual(dates.map(unix));
    });

    it('excludes night and pre-open fills from day-only daily bars while retaining opening and closing prints', () => {
        const dates = ['00:30:00', '08:44:59', '08:45:00', '13:44:59', '13:45:00', '15:00:00', '21:30:00'];
        const rows = [trade(dates.map((time, i) => deal(String(i), `2026-10-13T${time}`)), {
            contract: future, account: futureAccount, order: { ...trade().order, account: futureAccount },
        })];
        const options = { contract: future, account: futureAccount, minutes: 1440, bars: [bar('2026-10-13T00:00:00')] };
        expect(project(rows, options)).toHaveLength(7);
        expect(project(rows, { ...options, dayOnly: true }).map(fill => fill.ts)).toEqual([
            unix('2026-10-13T08:45:00'), unix('2026-10-13T13:44:59'), unix('2026-10-13T13:45:00'),
        ]);
    });

    // Real kbars (checked against the sidecar for 2026-10-13): stocks end at 13:30, TXF day at 13:45, TXF night at 05:00.
    it.each([
        ['stock closing auction', stock, account, '2026-10-13T13:30:00.2', 1, '2026-10-13T13:30:00'],
        ['stock closing auction, exact second', stock, account, '2026-10-13T13:30:00', 5, '2026-10-13T13:30:00'],
        ['stock closing print within the grace window', stock, account, '2026-10-13T13:33:59', 15, '2026-10-13T13:30:00'],
        ['stock last minute, 60 minute bars', stock, account, '2026-10-13T13:30:00.9', 60, '2026-10-13T14:00:00'],
        ['futures day close', future, futureAccount, '2026-10-13T13:45:00.3', 1, '2026-10-13T13:45:00'],
        ['futures day close, 5 minute bars', future, futureAccount, '2026-10-13T13:45:00', 5, '2026-10-13T13:45:00'],
        ['futures night close', future, futureAccount, '2026-10-14T05:00:00.3', 1, '2026-10-14T05:00:00'],
        ['futures night close, daily bars', future, futureAccount, '2026-10-14T05:00:00.3', 1440, '2026-10-14T00:00:00'],
    ])('keeps the %s on the session\'s last bar', (_name, contract, owner, date, minutes, label) => {
        const rows = [trade([deal('1', date)], { contract, account: owner, order: { ...trade().order, account: owner } })];
        const fills = project(rows, { contract, account: owner, minutes, bars: [bar(label)] });
        expect(fills).toHaveLength(1);
        expect(fills[0]?.time).toBe(wall(label));
        expect(fills[0]?.ts).toBe(unix(date));
    });

    it('does not pull ordinary or after-hours fills onto the closing bar', () => {
        const at = (date: string, label: string, owner = account, contract = stock) => project(
            [trade([deal('1', date)], { contract, account: owner, order: { ...trade().order, account: owner } })],
            { contract, account: owner, minutes: 1, bars: [bar(label)] });
        expect(at('2026-10-13T13:29:30', '2026-10-13T13:30:00')).toHaveLength(1); // the normal 13:30 label
        expect(at('2026-10-13T13:34:30', '2026-10-13T13:30:00')).toEqual([]); // past the grace window
        expect(at('2026-10-13T14:30:00', '2026-10-13T13:30:00')).toEqual([]); // after-hours lots have no bar
        expect(at('2026-10-13T13:50:30', '2026-10-13T13:45:00', futureAccount, future)).toEqual([]);
        expect(at('2026-10-13T05:04:30', '2026-10-13T05:00:00', futureAccount, future)).toEqual([]);
    });

    // 匯率、黃金、原油：日盤 08:45–16:15、夜盤收 05:00，13:45 不是收盤（用 category 或 root 判斷）
    const rhf = { ...future, code: 'RHFJ6', category: 'RHF' } as ContractBase;
    const tgf = { ...future, code: 'TGFJ6', root: 'TGF' } as ContractBase;
    it.each([
        ['RHF 夜盤收盤', rhf, '2026-10-14T05:00:00.3', 1, '2026-10-14T05:00:00'],
        ['TGF 日盤收盤', tgf, '2026-10-13T16:15:00.3', 1, '2026-10-13T16:15:00'],
        ['TGF 日盤收盤、5 分 K', tgf, '2026-10-13T16:15:00.3', 5, '2026-10-13T16:15:00'],
        ['RHF 13:45:30 照常落在 13:46', rhf, '2026-10-13T13:45:30', 1, '2026-10-13T13:46:00'],
        ['TGF 13:45:30 照常落在 13:46', tgf, '2026-10-13T13:45:30', 1, '2026-10-13T13:46:00'],
    ])('長日盤商品：%s', (_name, contract, date, minutes, label) => {
        const rows = [trade([deal('1', date)], { contract, account: futureAccount, order: { ...trade().order, account: futureAccount } })];
        // 前一分鐘那根也在（長日盤 13:45、13:46 兩根都存在），落點不能靠「只有一根」碰巧對上
        const bars = [{ ...bar(label), time: wall(label) - 60 }, bar(label)];
        const fills = project(rows, { contract, account: futureAccount, minutes, bars });
        expect(fills).toHaveLength(1);
        expect(fills[0]?.time).toBe(wall(label));
        expect(fills[0]?.ts).toBe(unix(date));
    });

    it('長日盤商品：13:45 那根、收盤寬限之外的成交都不會被拉到收盤 K 棒', () => {
        const at = (contract: ContractBase, date: string, label: string) => project(
            [trade([deal('1', date)], { contract, account: futureAccount, order: { ...trade().order, account: futureAccount } })],
            { contract, account: futureAccount, minutes: 1, bars: [bar(label)] });
        expect(at(tgf, '2026-10-13T13:45:30', '2026-10-13T13:45:00')).toEqual([]);
        expect(at(rhf, '2026-10-13T16:19:30', '2026-10-13T16:15:00')).toEqual([]);
        expect(at(rhf, '2026-10-14T05:04:30', '2026-10-14T05:00:00')).toEqual([]);
        // 寬限內最後一刻
        expect(at(tgf, '2026-10-13T16:18:59', '2026-10-13T16:15:00')).toHaveLength(1);
        expect(at(rhf, '2026-10-14T05:03:59', '2026-10-14T05:00:00')).toHaveLength(1);
    });

    it('requires the exact loaded bar and never snaps fills into a gap or the nearest date', () => {
        const rows = [trade([deal('1', '2026-10-13T09:00:00'), deal('2', '2026-10-13T09:05:00'), deal('3', '2026-10-13T09:10:00')])];
        expect(project(rows, { bars: [bar('2026-10-13T09:10:00')] }).map(fill => fill.ts)).toEqual([unix('2026-10-13T09:05:00')]);
        expect(project(rows, { bars: [] })).toEqual([]);
        expect(project(rows, { minutes: 1440, bars: [bar('2026-10-12T00:00:00')] })).toEqual([]);
    });

    it('deduplicates repeated reports by account, order and deal sequence without conflating different orders', () => {
        const first = trade([deal(), deal()]);
        const second = trade([deal()], { order: { ...first.order, id: 'order-2' } });
        const fills = project([first, first, second]);
        expect(fills).toHaveLength(2);
        expect(new Set(fills.map(fill => fill.id)).size).toBe(2);
        const other = { ...account, broker_id: 'B' };
        const sameIdOtherAccount = trade([deal()], { account: other, order: { ...first.order, account: other } });
        expect(project([sameIdOtherAccount], { account: other })[0]?.id).not.toBe(fills[0]?.id);
    });

    it.each([
        ['Common', '張'], ['Fixing', '張'], ['BlockTrade', '張'], ['IntradayOdd', '股'], ['Odd', '股'],
    ])('preserves stock %s quantity in %s', (order_lot, unit) => {
        const row = trade([deal('1', '2026-10-13T09:00:00', { quantity: 7 })]);
        row.order.order_lot = order_lot;
        expect(project([row])[0]).toMatchObject({ quantity: 7, unit });
    });

    it.each(['FUT', 'OPT'] as const)('uses contracts for %s quantity', security_type => {
        const contract = { ...future, security_type };
        const row = trade([deal('1', '2026-10-13T09:00:00', { quantity: 2 })], {
            contract, account: futureAccount, order: { ...trade().order, account: futureAccount },
        });
        expect(project([row], { contract, account: futureAccount })[0]).toMatchObject({ quantity: 2, unit: '口' });
    });

    it('drops invalid fill fields and ambiguous order identities without poisoning valid fills', () => {
        const invalid: Partial<Deal>[] = [
            { seq: '' }, { seq: '  ' }, { price: 0 }, { price: -1 }, { price: NaN }, { price: Infinity },
            { quantity: 0 }, { quantity: -1 }, { quantity: NaN }, { quantity: Infinity }, { quantity: 1.5 },
            { ts: 0 }, { ts: -1 }, { ts: NaN }, { ts: Infinity },
        ];
        const row = trade([...invalid.map((value, i) => deal(String(i), '2026-10-13T09:00:00', value)), deal('valid')]);
        const noOrderId = trade([deal('another')], { order: { ...row.order, id: '' } });
        const unknownAction = trade([deal('another')], { order: { ...row.order, action: 'Unknown' as 'Buy' } });
        expect(project([row, noOrderId, unknownAction])).toHaveLength(1);
    });

    it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid minute interval %s', minutes => {
        expect(project([trade()], { minutes })).toEqual([]);
    });

    it.each(['FUT', 'OPT'] as const)('does not require the %s exchange to match, since live reports rewrite it (TIM vs TAIFEX)', security_type => {
        const chart = { ...future, security_type };
        const rows = ['TAIFEX', 'TIM', 'anything'].map((exchange, i) => trade([deal(String(i))], {
            contract: { ...chart, exchange: exchange as string as ContractBase['exchange'] }, account: futureAccount,
            order: { ...trade().order, id: `order-${i}`, account: futureAccount },
        }));
        expect(project(rows, { contract: chart, account: futureAccount })).toHaveLength(3);
        // the code still has to match; a stock keeps its exchange check
        expect(project([trade([deal()], { contract: { ...chart, code: 'TXFK6', exchange: TIM }, account: futureAccount,
            order: { ...trade().order, account: futureAccount } })], { contract: chart, account: futureAccount })).toEqual([]);
        expect(project([trade([deal()], { contract: { ...stock, exchange: TIM } })])).toEqual([]);
    });

    // Captured production events: futures contracts arrive as {code:'QEF', exchange:'TIM', full_code:'QEFI6'}.
    // Simulation fixtures all say TAIFEX, which is why only a real payload catches this.
    describe('real production futures reports (fixture, exchange TIM)', () => {
        const events = productionFutures as { state: string; data: Record<string, unknown> }[];
        const ids = { trade: 'fixture-1', seqno: 'fixture-2', ordno: 'fixture-3' };
        const owner: Account = { account_type: 'F', broker_id: 'fixture', account_id: 'fixture', person_id: '', signed: true, username: '' };
        const chart: ContractBase = { code: 'QEFI6', security_type: 'FUT', exchange: 'TAIFEX', target_code: null };
        const dealReport = (seq: string, date: string) => normalizeOrderEvent({ state: 'FuturesDeal', data: { FuturesDeal: {
            trade_id: ids.trade, seqno: ids.seqno, ordno: ids.ordno, exchange_seq: seq, broker_id: owner.broker_id, account_id: owner.account_id,
            action: 'Buy', code: 'QEF', full_code: 'QEFI6', price: 489, quantity: 1, ts: unix(date),
        } } })!;
        const view = (rows: AccountedTrade[]) => chartFills({ trades: rows, contract: chart, account: owner,
            bars: [bar('2026-09-10T09:01:00')], minutes: 1, dayOnly: false });
        const restRow = (): AccountedTrade => ({
            account: owner, contract: { code: 'QEFI6', security_type: 'FUT', exchange: 'TAIFEX', target_code: null },
            order: { id: ids.trade, seqno: ids.seqno, ordno: ids.ordno, action: 'Buy', price: 489, quantity: 2, account: owner },
            status: { id: ids.trade, status: 'Submitted', status_code: '00', order_quantity: 2, deal_quantity: 0,
                cancel_quantity: 0, modified_price: 0, msg: '', deals: [] },
        });

        it.each([['starting from the live order report', [] as AccountedTrade[]], ['starting from a REST row', [restRow()]]])('keeps the fill visible after the live order report and deal are projected, %s', (_name, start) => {
            const ack = normalizeOrderEvent(events[0])!;
            expect(ack.kind === 'order' && ack.opType).toBe('New');
            // 投影出來的列每一步成交數量都與明細一致，不會誤報缺成交
            const consistent = (rows: AccountedTrade[]) => expect(missingDeals({ trades: rows, contract: chart, account: owner })).toBe(false);
            let rows = projectOrderReport(start, ack, [owner])!;
            expect(rows[0]!.contract.exchange).toBe('TIM'); // the projection really does rewrite the contract
            consistent(rows);
            rows = projectTradeDeal(rows, dealReport('fill-1', '2026-09-10T09:00:30'))!;
            expect(view(rows).map(fill => [fill.price, fill.quantity, fill.unit, fill.action])).toEqual([[489, 1, '口', 'Buy']]);
            consistent(rows);
            // a later report for the same order rewrites the contract again; the fill must survive it
            rows = projectOrderReport(rows, normalizeOrderEvent(events[2])!, [owner])!;
            expect(rows[0]!.contract.exchange).toBe('TIM');
            expect(view(rows)).toHaveLength(1);
            consistent(rows);
            expect(view(projectTradeDeal(rows, dealReport('fill-2', '2026-09-10T09:00:40'))!)).toHaveLength(2);
            consistent(projectTradeDeal(rows, dealReport('fill-2', '2026-09-10T09:00:40'))!);
        });
    });

    // Captured events end to end (normalize → project → chartFills). Real Deal events exist only for the
    // simulation; the production stock deal below is built from the documented StockDeal fields.
    // Simulation futures New reports carry no full_code, so (as in the app) the row comes from the REST
    // response of the order that was placed, and the reports then update it.
    describe.each([
        ['simulation futures TXFI6 (TAIFEX), from the REST row', simulationFutures, 6, simulationFutures[7], 'F',
            { code: 'TXFI6', security_type: 'FUT', exchange: 'TAIFEX', target_code: null }, 45762, 1, '口'],
        ['simulation stock 3374 (OTC)', simulationStock, 0, simulationStock[1], 'S',
            { code: '3374', security_type: 'STK', exchange: 'OTC', target_code: null }, 424, 1, '張'],
        ['production stock 2890 (TSE), synthetic deal', productionStock, 1, { state: 'StockDeal', data: { StockDeal: {
            trade_id: 'fixture-5', seqno: 'fixture-6', ordno: 'fixture-7', exchange_seq: 'fill-1', action: 'Buy', code: '2890',
            order_cond: 'Cash', order_lot: 'Common', price: 42.8, quantity: 1, ts: 1789443210.5, broker_id: 'fixture', account_id: 'fixture' } } }, 'S',
            { code: '2890', security_type: 'STK', exchange: 'TSE', target_code: null }, 42.8, 1, '張'],
    ] as const)('%s', (_name, fixture, orderIndex, dealEvent, type, chart, price, quantity, unit) => {
        const owner: Account = { account_type: type, broker_id: 'fixture', account_id: 'fixture', person_id: '', signed: true, username: '' };
        it('shows the deal after the order report and the deal report are projected', () => {
            const order = normalizeOrderEvent(fixture[orderIndex] as never)!;
            const dealReport = normalizeOrderEvent(dealEvent as never)!;
            expect(order.kind).toBe('order');
            const placed: AccountedTrade[] = type === 'F' ? [{ account: owner, contract: chart as ContractBase,
                order: { id: 'fixture-5', seqno: 'fixture-5', ordno: 'fixture-6', action: 'Buy', price: 0, quantity: 1, account: owner },
                status: { id: 'fixture-5', status: 'Submitted', status_code: '00', order_quantity: 1, deal_quantity: 0, cancel_quantity: 0, modified_price: 0, msg: '', deals: [] } }] : [];
            const rows = projectTradeDeal(projectOrderReport(placed, order, [owner])!, dealReport)!;
            expect(rows).toHaveLength(1);
            expect(missingDeals({ trades: rows, contract: chart as ContractBase, account: owner })).toBe(false);
            const label = Math.floor((dealReport.ts! + 8 * 3600) / 60) * 60 + 60;
            const bars: Candle[] = [{ time: label, open: price, high: price, low: price, close: price, volume: 1 }];
            const fills = chartFills({ trades: rows, contract: chart as ContractBase, account: owner, bars, minutes: 1, dayOnly: false });
            expect(fills.map(fill => [fill.price, fill.quantity, fill.unit, fill.action, fill.time])).toEqual([[price, quantity, unit, 'Buy', label]]);
        });
    });

    it('同一根 K 棒內依成交時間排序，不受 order.id 或 deal.seq 的字串順序影響', () => {
        // 字母序刻意與時間序相反；真實 order.id、seq 是不透明字串
        const late = trade([deal('a', '2026-10-13T09:04:00')], { order: { ...trade().order, id: 'a-order' } });
        const early = trade([deal('z', '2026-10-13T09:01:00')], { order: { ...trade().order, id: 'z-order' } });
        expect(project([late, early]).map(fill => fill.ts)).toEqual([unix('2026-10-13T09:01:00'), unix('2026-10-13T09:04:00')]);
        expect(project([early, late]).map(fill => fill.ts)).toEqual([unix('2026-10-13T09:01:00'), unix('2026-10-13T09:04:00')]);
        // 同一秒時順序固定（不因輸入順序而變）
        const tie = (id: string) => trade([deal('1', '2026-10-13T09:02:00')], { order: { ...trade().order, id } });
        expect(project([tie('b'), tie('a')]).map(fill => fill.id)).toEqual(project([tie('a'), tie('b')]).map(fill => fill.id));
    });

    it('成交 id 含帳戶（類型、券商、帳號）、商品（類型、交易所、代碼）、委託與成交序號，任一不同就不同', () => {
        const idOf = (o: { owner?: Account; contract?: ContractBase; orderId?: string; seq?: string } = {}) => {
            const owner = o.owner ?? account;
            const contract = o.contract ?? stock;
            const row = trade([deal(o.seq ?? '1')], { contract, account: owner, order: { ...trade().order, id: o.orderId ?? 'order-1', account: owner } });
            const fills = project([row], { contract, account: owner });
            expect(fills).toHaveLength(1);
            return fills[0]!.id;
        };
        const ids = [
            idOf(),
            idOf({ owner: { ...account, account_type: 'F' } }), // 只有帳戶類型不同
            idOf({ owner: { ...account, broker_id: 'B' } }),
            idOf({ owner: { ...account, account_id: '7654321' } }),
            idOf({ contract: { ...stock, security_type: 'WRT' } }),
            idOf({ contract: { ...stock, exchange: 'OTC' } }),
            idOf({ contract: { ...stock, code: '2317' } }),
            idOf({ orderId: 'order-2' }),
            idOf({ seq: '2' }),
        ];
        expect(new Set(ids).size).toBe(ids.length);
        expect(idOf()).toBe(ids[0]); // 同樣的輸入得到同一個 id（重新計算不換 id）
    });

    it('委託列沒有 deals（缺漏或 null）時略過，不丟例外', () => {
        const missing = trade([deal('ok')]);
        const none = trade([], { order: { ...trade().order, id: 'order-2' } });
        (none.status as { deals?: Deal[] }).deals = undefined;
        const nul = trade([], { order: { ...trade().order, id: 'order-3' } });
        (nul.status as { deals?: Deal[] | null }).deals = null;
        expect(() => project([none, nul, missing])).not.toThrow();
        expect(project([none, nul, missing]).map(fill => fill.price)).toEqual([101]);
    });

    it('sorts fills chronologically without changing the input rows or bars', () => {
        const row = trade([deal('later', '2026-10-13T09:04:00'), deal('earlier')]);
        const rows = Object.freeze([row]);
        const bars = Object.freeze([bar('2026-10-13T09:05:00')]);
        expect(project(rows, { bars }).map(fill => fill.ts)).toEqual([unix('2026-10-13T09:00:00'), unix('2026-10-13T09:04:00')]);
        expect(row.status.deals.map(fill => fill.seq)).toEqual(['later', 'earlier']);
        expect(bars[0]?.time).toBe(wall('2026-10-13T09:05:00'));
    });
});

describe('projectChartFills：圖上沒有對應 K 棒的成交（unplaced）', () => {
    const projected = (trades: readonly AccountedTrade[], overrides: Partial<Parameters<typeof projectChartFills>[0]> = {}) =>
        projectChartFills({ trades, contract: stock, account, bars: [bar('2026-10-13T09:05:00')], minutes: 5, dayOnly: false, ...overrides });
    const futureTrade = (deals: Deal[], contract = future, id = 'order-1') =>
        trade(deals, { contract, account: futureAccount, order: { ...trade().order, id, account: futureAccount } });
    // 分 K 只到 13:30（真實形狀：當天收盤後沒有更晚的 K 棒）
    const closeBars = [bar('2026-10-13T13:29:00'), bar('2026-10-13T13:30:00')];

    it('盤後定價：分 K 沒有那根（unplaced，time 是本來該落的 label），日 K 落在當天那根', () => {
        const fixing = trade([deal('1', '2026-10-13T14:30:00', { price: 1000 })]);
        fixing.order.order_lot = 'Fixing';
        const minute = projected([fixing], { minutes: 1, bars: closeBars });
        expect(minute.fills).toEqual([]);
        expect(minute.unplaced.map(fill => [fill.time, fill.ts, fill.price, fill.unit])).toEqual([[wall('2026-10-13T14:31:00'), unix('2026-10-13T14:30:00'), 1000, '張']]);
        const daily = projected([fixing], { minutes: 1440, bars: [bar('2026-10-13T00:00:00')] });
        expect(daily.fills.map(fill => fill.time)).toEqual([wall('2026-10-13T00:00:00')]);
        expect(daily.unplaced).toEqual([]);
        expect(chartFills({ trades: [fixing], contract: stock, account, bars: closeBars, minutes: 1, dayOnly: false })).toEqual([]);
    });

    it('停牌或缺棒：早於最後一根、卻找不到 K 棒的成交列為 unplaced，不吸附到鄰近 K 棒', () => {
        const rows = [trade([deal('1', '2026-10-13T09:00:00'), deal('2', '2026-10-13T09:07:00'), deal('3', '2026-10-13T09:10:00')])];
        const { fills, unplaced } = projected(rows, { bars: [bar('2026-10-13T09:05:00'), bar('2026-10-13T09:15:00')] });
        expect(fills.map(fill => fill.ts)).toEqual([unix('2026-10-13T09:00:00'), unix('2026-10-13T09:10:00')]);
        expect(unplaced.map(fill => [fill.time, fill.ts])).toEqual([[wall('2026-10-13T09:10:00'), unix('2026-10-13T09:07:00')]]);
    });

    it('晚於最後一根、之後還會開出那根（股票盤中、期貨夜盤、日 K 的今天）：等待新棒，兩邊都不放', () => {
        // 股票盤中：即時 K 棒還沒開出來
        expect(projected([trade([deal('1', '2026-10-13T09:06:00')])])).toEqual({ fills: [], unplaced: [] });
        // 期貨夜盤沒有「盤後」：最後一根之後的成交一律等待
        const night = futureTrade([deal('1', '2026-10-13T21:05:30')]);
        expect(projected([night], { contract: future, account: futureAccount, minutes: 1, bars: [bar('2026-10-13T21:00:00')] }))
            .toEqual({ fills: [], unplaced: [] });
        // 同一筆夜盤成交若落在已載入範圍內的缺口，就是 unplaced
        expect(projected([night], { contract: future, account: futureAccount, minutes: 1,
            bars: [bar('2026-10-13T21:00:00'), bar('2026-10-13T21:10:00')] }).unplaced).toHaveLength(1);
        // 日 K：今天那根還沒出現時，盤後定價也是等待
        const fixing = trade([deal('1', '2026-10-13T14:30:00')]);
        expect(projected([fixing], { minutes: 1440, bars: [bar('2026-10-12T00:00:00')] })).toEqual({ fills: [], unplaced: [] });
    });

    it('不算 unplaced：僅日盤排除的夜盤、換月分界外、其他月份、欄位無效', () => {
        // 僅日盤：00:30 的夜盤成交早於最後一根，但被僅日盤濾掉，不是「找不到 K 棒」
        const sessions = futureTrade([deal('night', '2026-10-13T00:30:00'), deal('day', '2026-10-13T10:00:30')]);
        const dayBars = [bar('2026-10-13T09:00:00'), bar('2026-10-13T13:45:00')];
        const options = { contract: future, account: futureAccount, minutes: 1, bars: dayBars };
        expect(projected([sessions], { ...options, dayOnly: true }).unplaced.map(fill => fill.ts)).toEqual([unix('2026-10-13T10:00:30')]);
        expect(projected([sessions], options).unplaced.map(fill => fill.ts)).toEqual([unix('2026-10-13T00:30:00'), unix('2026-10-13T10:00:30')]);

        // 換月：cutoff 前只收上一個月份、之後只收現在的月份；code 是成交本身的月份
        const chart: ContractBase = { ...future, code: 'TXFR1', target_code: 'TXFK6' };
        const rollover = { previous: 'TXFJ6', cutoff: unix('2026-10-21T15:00:00') };
        const months = ([['TXFJ6', '2026-10-21T09:01:00'], ['TXFK6', '2026-10-21T09:02:00'], ['TXFL6', '2026-10-21T09:03:00'],
            ['TXFK6', '2026-10-21T15:02:00'], ['TXFJ6', '2026-10-21T15:03:00']] as const)
            .map(([code, date], i) => futureTrade([deal('1', date)], { ...future, code }, `order-${i}`));
        const rolled = projected(months, { contract: chart, account: futureAccount, rollover, minutes: 1,
            bars: [bar('2026-10-21T08:50:00'), bar('2026-10-21T16:00:00')] });
        expect(rolled.fills).toEqual([]);
        expect(rolled.unplaced.map(fill => [fill.code, fill.ts])).toEqual([['TXFJ6', unix('2026-10-21T09:01:00')], ['TXFK6', unix('2026-10-21T15:02:00')]]);

        // 欄位無效、沒有委託 id、方向不明：不進 unplaced
        const gapBars = [bar('2026-10-13T09:05:00'), bar('2026-10-13T09:30:00')];
        const invalid: Partial<Deal>[] = [{ seq: '' }, { price: 0 }, { quantity: 1.5 }, { quantity: 0 }, { ts: NaN }];
        const row = trade([...invalid.map((value, i) => deal(String(i), '2026-10-13T09:10:00', value)), deal('valid', '2026-10-13T09:10:00')]);
        const noOrderId = trade([deal('a', '2026-10-13T09:10:00')], { order: { ...row.order, id: '' } });
        const unknownAction = trade([deal('b', '2026-10-13T09:10:00')], { order: { ...row.order, action: 'Unknown' as 'Buy' } });
        expect(projected([row, noOrderId, unknownAction], { bars: gapBars }).unplaced.map(fill => fill.id)).toEqual([JSON.stringify(
            [account.account_type, account.broker_id, account.account_id, 'STK', 'TSE', '2330', 'order-1', 'valid'])]);
    });

    it('K 棒載入中（bars 為空）或週期不合法：fills、unplaced 都是空的', () => {
        const rows = [trade([deal('1', '2026-10-13T14:30:00'), deal('2', '2026-10-13T09:00:00')])];
        expect(projected(rows, { bars: [] })).toEqual({ fills: [], unplaced: [] });
        for (const minutes of [0, 1.5, NaN]) expect(projected(rows, { minutes, bars: closeBars })).toEqual({ fills: [], unplaced: [] });
        // 對照：K 棒到齊時兩筆都看得到
        expect(projected(rows, { minutes: 1, bars: [bar('2026-10-13T09:01:00'), ...closeBars] }))
            .toMatchObject({ fills: [{ ts: unix('2026-10-13T09:00:00') }], unplaced: [{ ts: unix('2026-10-13T14:30:00') }] });
    });

    it('重複回報只算一次，不會同時出現在 fills 與 unplaced', () => {
        const row = trade([deal('1', '2026-10-13T14:30:00'), deal('2', '2026-10-13T09:01:00')]);
        const { fills, unplaced } = projected([row, row, { ...row }], { minutes: 1, bars: [bar('2026-10-13T09:02:00'), ...closeBars] });
        expect(fills).toHaveLength(1);
        expect(unplaced).toHaveLength(1);
    });

    it('同價、同秒、不同 seq 的成交保留兩筆（不用時間＋價格去重）', () => {
        const row = trade([deal('1', '2026-10-13T09:01:00', { quantity: 2 }), deal('2', '2026-10-13T09:01:00', { quantity: 3 })]);
        const fills = project([row]);
        expect(fills.map(fill => [fill.time, fill.ts, fill.price, fill.quantity])).toEqual([
            [wall('2026-10-13T09:05:00'), unix('2026-10-13T09:01:00'), 101, 2],
            [wall('2026-10-13T09:05:00'), unix('2026-10-13T09:01:00'), 101, 3],
        ]);
        expect(new Set(fills.map(fill => fill.id)).size).toBe(2);
    });
});

describe('全部帳戶（accounts）', () => {
    const second: Account = { ...account, account_id: '7654321', username: 'Second' };
    const outsider: Account = { ...account, account_id: '1111111' };
    const owned = (owner: Account | undefined, seq = '1', orderOwner = owner) =>
        trade([deal(seq)], { account: owner, order: { ...trade().order, account: orderOwner } });
    const view = (trades: AccountedTrade[], scope: { account?: Account; accounts?: readonly Account[] }) =>
        projectChartFills({ trades, contract: stock, account: undefined, bars: [bar('2026-10-13T09:05:00')], minutes: 5, dayOnly: false, ...scope }).fills;

    it('範圍是各帳戶的聯集；同一個委託 id、同 seq 在不同帳戶各自保留，id 不衝突、account 是所屬帳戶', () => {
        const rows = [owned(account), owned(second), owned(outsider), owned(account, 'conflict', second), owned(undefined, 'unknown')];
        const fills = view(rows, { accounts: [account, second] });
        expect(fills.map(fill => fill.account)).toEqual([account, second]);
        expect(fills[0]!.account).toBe(account);
        expect(fills[1]!.account).toBe(second);
        expect(new Set(fills.map(fill => fill.id)).size).toBe(2);
        expect(fills.map(fill => JSON.parse(fill.id)[2])).toEqual([account.account_id, second.account_id]);
        // 單一帳戶模式的 id 與全部帳戶模式相同（切換範圍不換 id）
        expect(view(rows, { account }).map(fill => fill.id)).toEqual([fills[0]!.id]);
    });

    it('有 accounts 就取代 account：空陣列沒有範圍；沒有 accounts 才用 account；帳戶重複不會重複收', () => {
        const rows = [owned(account), owned(second)];
        expect(view(rows, { account, accounts: [second] }).map(fill => fill.account)).toEqual([second]);
        expect(view(rows, { account, accounts: [] })).toEqual([]);
        expect(view(rows, { account }).map(fill => fill.account)).toEqual([account]);
        expect(view(rows, {})).toEqual([]);
        expect(view(rows, { accounts: [account, account, second, { ...second }] })).toHaveLength(2);
    });

    it('missingDeals 涵蓋範圍內所有帳戶', () => {
        const broken = owned(second);
        broken.status = { ...broken.status, deal_quantity: 2 };
        const rows = [owned(account), broken];
        expect(missingDeals({ trades: rows, contract: stock, account })).toBe(false);
        expect(missingDeals({ trades: rows, contract: stock, account: undefined, accounts: [account] })).toBe(false);
        expect(missingDeals({ trades: rows, contract: stock, account: undefined, accounts: [account, second] })).toBe(true);
        expect(missingDeals({ trades: rows, contract: stock, account, accounts: [] })).toBe(false);
    });
});

describe('priceKey', () => {
    it('整數價格鍵：12.5 與 13 不同、浮點誤差不分組、與級距表無關', () => {
        expect(priceKey(12.5)).toBe('12500000');
        expect(priceKey(13)).toBe('13000000');
        expect(priceKey(0.1 + 0.2)).toBe(priceKey(0.3));
        expect(priceKey(46459)).toBe('46459000000');
        expect(priceKey(49.5)).not.toBe(priceKey(50));
    });

    it('超出安全整數或不是有限數時退回原值，單獨成組', () => {
        expect(priceKey(1e12)).toBe('p:1000000000000');
        expect(priceKey(Number.MAX_SAFE_INTEGER)).toBe(`p:${Number.MAX_SAFE_INTEGER}`);
        expect(priceKey(Infinity)).toBe('p:Infinity');
        expect(priceKey(NaN)).toBe('p:NaN');
        expect(priceKey(9_000_000)).toBe('9000000000000');
    });
});

describe('missingDeals', () => {
    const check =(trades: AccountedTrade[], overrides: Partial<Parameters<typeof missingDeals>[0]> = {}) =>
        missingDeals({ trades, contract: stock, account, ...overrides });
    // 成交數量 dq、各筆明細數量 quantities
    const row = (dq: number, quantities: number[], overrides: Partial<AccountedTrade> = {}) => {
        const result = trade(quantities.map((quantity, i) => deal(String(i), '2026-10-13T09:00:00', { quantity })), overrides);
        result.status = { ...result.status, deal_quantity: dq };
        return result;
    };
    const futureRow = (code: string, dq: number, quantities: number[]) => row(dq, quantities, {
        contract: { ...future, code }, account: futureAccount, order: { ...trade().order, account: futureAccount },
    });

    it('成交數量等於明細加總（整股、零股、期貨同單位；沒有成交）時回 false', () => {
        const odd = row(50, [20, 30], { order: { ...trade().order, id: 'order-2', order_lot: 'IntradayOdd' } });
        expect(check([row(1, [1]), odd, row(0, [], { order: { ...trade().order, id: 'order-3' } })])).toBe(false);
        expect(check([futureRow('TXFJ6', 2, [1, 1])], { contract: future, account: futureAccount })).toBe(false);
        expect(check([])).toBe(false);
    });

    it.each([
        ['明細少於成交數量（還沒讀齊）', 3, [1, 1]],
        ['明細多於成交數量', 1, [1, 1]],
        ['有成交數量但沒有明細', 1, []],
    ])('%s時回 true', (_name, dq, quantities) => {
        expect(check([row(1, [1]), row(dq, quantities, { order: { ...trade().order, id: 'order-2' } })])).toBe(true);
    });

    it('成交數量不是數字時無從比對，不算缺漏（不會因一筆欄位缺漏就把整張圖藏起來）', () => {
        for (const quantity of [undefined, null, '1', Number.NaN]) {
            const unknown = row(0, [1]);
            (unknown.status as { deal_quantity?: unknown }).deal_quantity = quantity;
            expect(check([unknown])).toBe(false);
        }
        expect(check([row(0, [1])])).toBe(true);
    });

    it('deals 不是陣列時當成沒有明細', () => {
        for (const deals of [undefined, null, {}, 'x']) {
            const filled = row(1, []);
            const empty = row(0, []);
            (filled.status as { deals?: unknown }).deals = deals;
            (empty.status as { deals?: unknown }).deals = deals;
            expect(check([filled])).toBe(true);
            expect(check([empty])).toBe(false);
        }
    });

    it('其他帳戶、市場、商品或未解析別名的委託不影響', () => {
        const other = { ...account, broker_id: 'B' };
        const rows = [
            row(2, [1], { account: other, order: { ...trade().order, account: other } }),
            row(2, [1], { account: undefined, order: { ...trade().order, account: undefined } }),
            row(2, [1], { contract: { ...stock, code: '2317' } }),
            row(2, [1], { contract: { ...stock, exchange: 'OTC' } }),
            row(2, [1], { contract: { ...stock, security_type: 'WRT' } }),
        ];
        expect(check(rows)).toBe(false);
        expect(check([...rows, row(2, [1])])).toBe(true);
        expect(check([row(2, [1])], { account: undefined })).toBe(false);
        expect(check([futureRow('TXFK6', 2, [1])], { contract: { ...future, code: 'TXFR1', target_code: null }, account: futureAccount })).toBe(false);
    });

    it('換月：有 rollover 時上一個月份的委託也納入，以整筆委託比對、不看 cutoff', () => {
        const chart: ContractBase = { ...future, code: 'TXFR1', target_code: 'TXFK6' };
        const rollover = { previous: 'TXFJ6', cutoff: unix('2026-10-21T15:00:00') };
        const options = { contract: chart, account: futureAccount };
        expect(check([futureRow('TXFJ6', 2, [1])], options)).toBe(false);
        expect(check([futureRow('TXFJ6', 2, [1])], { ...options, rollover })).toBe(true);
        expect(check([futureRow('TXFL6', 2, [1])], { ...options, rollover })).toBe(false);
        // 明細都在 cutoff 之前的本月份委託仍要對得上整筆數量
        expect(check([futureRow('TXFK6', 1, [1])], { ...options, rollover })).toBe(false);
        expect(check([futureRow('TXFK6', 2, [1])], { ...options, rollover })).toBe(true);
    });
});

describe('rolloverCodes', () => {
    const of = (code: string, target_code: string | null, security_type: ContractBase['security_type'] = 'FUT') =>
        rolloverCodes({ ...future, code, target_code, security_type });

    it.each([
        ['TXFR1', 'TXFK6', 'TXFJ6', 'TXFJ6'],
        ['TXFR2', 'TXFL6', 'TXFK6', 'TXFJ6'],
        ['MXFR1', 'MXFA7', 'MXFL6', 'MXFL6'],
        ['TXFR2', 'TXFA7', 'TXFL6', 'TXFK6'],
        ['TXFR2', 'TXFB7', 'TXFA7', 'TXFL6'],
        ['TMFR1', 'TMFA0', 'TMFL9', 'TMFL9'],
    ])('%s → %s：previous %s、near %s（跨年時年個位數減 1）', (code, target, previous, near) => {
        expect(of(code, target)).toEqual({ previous, near });
    });

    it('不是期貨連續月別名，或 target_code 不是「根代碼＋月份字母 A–L＋年個位數」時回 null', () => {
        expect(of('TXFK6', null)).toBeNull();
        expect(of('TXFK6', 'TXFK6')).toBeNull();
        expect(of('TXFR3', 'TXFK6')).toBeNull();
        expect(of('TXFR1', 'TXFK6', 'OPT')).toBeNull();
        expect(of('TXFR1', 'TXFK6', 'STK')).toBeNull();
        for (const target of [null, '', 'TXFM6', 'TXFK26', 'TXF202611', 'txfk6', 'K6'])
            expect(of('TXFR1', target)).toBeNull();
    });
});

describe('projectChartFills 每張委託的快取（盤中每筆回報只重算變動的委託）', () => {
    // 同一張圖的快取（每張圖自己一份）
    let cache = createProjectionCache();
    beforeEach(() => { cache = createProjectionCache(); });
    const project = (i: Parameters<typeof projectChartFills>[0]) => projectChartFills(i, cache);
    const bars = [bar('2026-10-13T09:05:00'), bar('2026-10-13T09:10:00')];
    const input = (trades: readonly AccountedTrade[], over: Partial<Parameters<typeof projectChartFills>[0]> = {}) =>
        ({ trades, contract: stock, account, bars, minutes: 5, dayOnly: false, ...over });
    it('同一個委託物件、同一情境沿用上次的成交物件；換成新的委託物件（多一筆成交）才重算那一張', () => {
        const a = trade([deal('1')]);
        const b = trade([deal('1', '2026-10-13T09:06:00', { price: 105 })], { order: { ...a.order, id: 'order-2' } });
        const first = project(input([a, b])).fills;
        const again = project(input([a, b])).fills;
        expect(again[0]).toBe(first[0]);
        expect(again[1]).toBe(first[1]);
        const b2 = { ...b, status: { ...b.status, deal_quantity: 2, deals: [...b.status.deals, deal('2', '2026-10-13T09:07:00', { price: 106 })] } };
        const next = project(input([a, b2])).fills;
        expect(next.map(f => f.price)).toEqual([101, 105, 106]);
        expect(next[0]).toBe(first[0]); // 沒變的那張沿用
    });
    it('情境改變就重算：K 棒原地多一根、週期、僅日盤、帳戶、合約；兩張圖輪流用也各自記住', () => {
        const a = trade([deal('1', '2026-10-13T09:11:00')]); // 落在 09:15 那根：一開始還沒有
        const grown = [...bars];
        expect(project(input([a], { bars: grown })).fills).toEqual([]);
        grown.push(bar('2026-10-13T09:15:00')); // 同一個陣列原地加新棒
        expect(project(input([a], { bars: grown })).fills.map(f => f.time)).toEqual([wall('2026-10-13T09:15:00')]);
        const one = project(input([a], { bars: grown, minutes: 1 })); // 1 分 K 沒有 09:12 那根
        expect(one.fills).toEqual([]);
        const five = project(input([a], { bars: grown })).fills;
        const fiveAgain = project(input([a], { bars: grown })).fills;
        expect(fiveAgain[0]).toBe(five[0]);
        expect(project(input([a], { bars: grown, account: { ...account, account_id: '7654321' } })).fills).toEqual([]);
        expect(project(input([a], { bars: grown, contract: { ...stock, code: '2317' } })).fills).toEqual([]);
    });
    it('同一張委託出現兩次（快取命中時也一樣）：重複的序號只收一次，不同序號都收', () => {
        const a = trade([deal('1'), deal('2', '2026-10-13T09:02:00')]);
        const copy = { ...a, status: { ...a.status, deals: [deal('2', '2026-10-13T09:02:00'), deal('3', '2026-10-13T09:03:00')] } };
        for (let i = 0; i < 2; i += 1) {
            expect(project(input([a, copy, a])).fills.map(f => JSON.parse(f.id).at(-1))).toEqual(['1', '2', '3']);
        }
    });
});
describe('完整性檢查與投影共用範圍篩選', () => {
    const bars = [bar('2026-10-13T09:05:00')];
    it('同一份輸入只篩選一次，換新棒也沿用範圍', () => {
        let reads = 0;
        const trades = new Proxy([trade()], {
            get(target, key, receiver) {
                if (key === '0') reads += 1;
                return Reflect.get(target, key, receiver);
            },
        });
        const input = { trades, contract: stock, account, bars, minutes: 5, dayOnly: false };
        const cache = createProjectionCache();
        expect(missingDeals(input, cache)).toBe(false);
        expect(projectChartFills(input, cache).fills).toHaveLength(1);
        expect(reads).toBe(1);
        projectChartFills({ ...input, bars: [...bars, bar('2026-10-13T09:10:00')] }, cache);
        expect(reads).toBe(1);
    });
    it('帳戶識別相同但物件與資料換了，重新篩選並與冷算相同', () => {
        let reads = 0;
        const trades = new Proxy([trade()], {
            get(target, key, receiver) {
                if (key === '0') reads += 1;
                return Reflect.get(target, key, receiver);
            },
        });
        const input = { trades, contract: stock, account, bars, minutes: 5, dayOnly: false };
        const cache = createProjectionCache();
        missingDeals(input, cache);
        projectChartFills(input, cache);
        const next = { ...input, account: { ...account, username: '更新後', signed: false } };
        expect(missingDeals(next, cache)).toBe(missingDeals(next));
        const actual = projectChartFills(next, cache);
        expect(reads).toBe(3); // 舊範圍、新範圍、冷算完整性各一趟
        expect(actual).toEqual(projectChartFills(next));
        expect(actual.fills[0]?.account).toBe(next.account);
    });
});
describe('projectChartFills 快取：彈出視窗的複本、新棒、只加成交', () => {
    // 同一張圖的快取（每張圖自己一份）
    let cache = createProjectionCache();
    beforeEach(() => { cache = createProjectionCache(); });
    const project = (i: Parameters<typeof projectChartFills>[0]) => projectChartFills(i, cache);
    const base = [bar('2026-10-13T09:05:00'), bar('2026-10-13T09:10:00')];
    const input = (trades: readonly AccountedTrade[], bars = base) => ({ trades, contract: stock, account, bars, minutes: 5, dayOnly: false });
    const two = () => {
        const a = trade([deal('1'), deal('2', '2026-10-13T09:06:00', { price: 104 })]);
        const b = trade([deal('1', '2026-10-13T09:07:00', { price: 105 })], { order: { ...a.order, id: 'order-2' } });
        return [a, b];
    };
    it('內容沒變的整份複本（彈出視窗每秒的鏡像）：交回同一個結果與同一批成交物件', () => {
        const trades = two();
        const first = project(input(trades));
        const clone = JSON.parse(JSON.stringify(trades)) as AccountedTrade[];
        const again = project(input(clone));
        expect(again).toBe(first);
        expect(again.fills[1]).toBe(first.fills[1]);
    });
    it('同一個 K 棒陣列原地多一根：原本的成交物件沿用，只有等到新棒的那筆是新的', () => {
        const grown = [...base];
        const late = trade([deal('9', '2026-10-13T09:12:00')], { order: { ...two()[0]!.order, id: 'order-9' } });
        const trades = [...two(), late];
        const before = project(input(trades, grown));
        expect(before.fills.map(f => f.price)).toEqual([101, 104, 105]); // 09:12 那筆在等新棒
        grown.push(bar('2026-10-13T09:15:00'));
        const after = project(input(trades, grown));
        expect(after.fills.map(f => f.price)).toEqual([101, 104, 105, 101]);
        expect(after.fills.slice(0, 3)).toEqual(before.fills); // 同樣的值
        after.fills.slice(0, 3).forEach((f, i) => expect(f).toBe(before.fills[i])); // 也是同一個物件
    });
    it('一張委託只往後加成交：舊的成交物件沿用；前面的成交內容變了就整張重算', () => {
        const [a, b] = two();
        const first = project(input([a!, b!])).fills;
        const grown = { ...a!, status: { ...a!.status, deal_quantity: 3, deals: [...a!.status.deals, deal('3', '2026-10-13T09:08:00', { price: 106 })] } };
        const next = project(input([grown, b!])).fills;
        expect(next.map(f => f.price)).toEqual([101, 104, 105, 106]);
        expect(next[0]).toBe(first[0]);
        expect(next[1]).toBe(first[1]);
        const edited = { ...a!, status: { ...a!.status, deals: [deal('1', '2026-10-13T09:00:00', { price: 99 }), a!.status.deals[1]!] } };
        const redo = project(input([edited, b!])).fills;
        expect(redo.map(f => f.price)).toEqual([99, 104, 105]);
        expect(redo[0]).not.toBe(first[0]);
    });
    it('換月分界、帳戶範圍、週期不同：不沿用彼此的結果', () => {
        const trades = two();
        const five = project(input(trades));
        const one = project({ ...input(trades), minutes: 1, bars: [bar('2026-10-13T09:01:00'), bar('2026-10-13T09:07:00')] });
        expect(one.fills.map(f => f.time)).toEqual([wall('2026-10-13T09:01:00'), wall('2026-10-13T09:07:00')]);
        expect(project(input(trades))).toBe(five);
        const other = { ...account, account_id: '7654321' };
        expect(project({ ...input(trades), account: other }).fills).toEqual([]);
        expect(project({ ...input(trades), rollover: { previous: 'X', cutoff: unix('2026-10-13T09:03:00') } }).fills.map(f => f.price)).toEqual([104, 105]);
    });
    it('同一筆成交的落點改變（即時 K 棒 → 重讀歷史後的收盤那根）：換成新的成交物件、時間跟著改', () => {
        // 13:30:05 的收盤撮合：即時分桶在 13:35，歷史 1 分 K 併入 13:30 那根
        const close = trade([deal('c', '2026-10-13T13:30:05')]);
        const live = project(input([close], [bar('2026-10-13T13:25:00'), bar('2026-10-13T13:35:00')])).fills;
        expect(live.map(f => f.time)).toEqual([wall('2026-10-13T13:35:00')]);
        const history = project(input([close], [bar('2026-10-13T13:25:00'), bar('2026-10-13T13:30:00'), bar('2026-10-13T13:35:00')])).fills;
        expect(history.map(f => f.time)).toEqual([wall('2026-10-13T13:30:00')]);
        expect(history[0]).not.toBe(live[0]);
    });
});

describe('同序號重複時的去重順序（跟逐筆版一樣：先判斷落點，還在等新棒的那筆不算數）', () => {
    let cache = createProjectionCache();
    beforeEach(() => { cache = createProjectionCache(); });
    const fut: ContractBase = { code: 'TXFJ6', security_type: 'FUT', exchange: 'TAIFEX', target_code: null };
    const fAccount: Account = { ...account, account_type: 'F' };
    const fTrade = (deals: Deal[]): AccountedTrade => ({
        account: fAccount, contract: fut,
        order: { id: 'o1', seqno: 's', ordno: 'n', action: 'Buy', price: 100, quantity: 5, account: fAccount },
        status: { id: 'o1', status: 'PartFilled', status_code: '00', order_quantity: 5, deal_quantity: deals.length, cancel_quantity: 0, modified_price: 0, msg: '', deals },
    });
    const run = (trades: AccountedTrade[]) => projectChartFills({ trades, contract: fut, account: fAccount, bars: [bar('2026-10-13T09:05:00')], minutes: 5, dayOnly: false }, cache);
    it('同一張委託裡同序號兩筆、第一筆還在等新棒：第二筆照樣畫', () => {
        const trades = [fTrade([deal('1', '2026-10-13T09:10:00'), deal('1', '2026-10-13T09:01:00')])];
        // 同一份跑兩次，再跑彈出視窗送來的整份複本
        for (const rows of [trades, trades, JSON.parse(JSON.stringify(trades)) as AccountedTrade[]])
            expect(run(rows).fills.map(f => f.ts)).toEqual([unix('2026-10-13T09:01:00')]);
    });
    it('同一張委託在 trades 出現兩次、第一份還在等新棒：第二份照樣畫；兩份都能畫時只畫一次', () => {
        for (const [first, expected] of [['09:10:00', '09:01:00'], ['09:02:00', '09:02:00']]) {
            cache = createProjectionCache();
            const trades = [fTrade([deal('1', `2026-10-13T${first}`)]), fTrade([deal('1', '2026-10-13T09:01:00')])];
            for (const rows of [trades, trades, JSON.parse(JSON.stringify(trades)) as AccountedTrade[]])
                expect(run(rows).fills.map(f => f.ts)).toEqual([unix(`2026-10-13T${expected}`)]);
        }
    });
});

describe('投影快取是每張圖自己一份', () => {
    const base = [bar('2026-10-13T09:05:00')];
    const input = (trades: readonly AccountedTrade[]) => ({ trades, contract: stock, account, bars: base, minutes: 5, dayOnly: false });
    it('別的圖（例如面板庫預覽傳空的 trades）不會蓋掉這張圖的快取；沒傳快取就每次重算', () => {
        const mine = createProjectionCache();
        const other = createProjectionCache();
        const trades = [trade([deal('1')])];
        const first = projectChartFills(input(trades), mine);
        expect(projectChartFills(input([]), other).fills).toEqual([]);
        expect(projectChartFills(input(trades), mine)).toBe(first);
        expect(projectChartFills(input(trades)).fills[0]).not.toBe(first.fills[0]);
    });
    it('一張圖最多記 3 個情境，最久沒用的先丟', () => {
        const cache = createProjectionCache();
        const trades = [trade([deal('1')])];
        const run = (minutes: number) => projectChartFills({ ...input(trades), bars: [bar('2026-10-13T09:00:00'), bar('2026-10-13T09:05:00')], minutes }, cache);
        const [a, b, c] = [run(1), run(5), run(15)];
        expect(a.fills.length + a.unplaced.length).toBe(1);
        expect(run(1)).toBe(a);
        run(60);
        expect(cache.contexts.size).toBe(3);
        expect(run(1)).toBe(a);
        expect(run(15)).toBe(c);
        expect(run(5)).not.toBe(b);
    });
});
