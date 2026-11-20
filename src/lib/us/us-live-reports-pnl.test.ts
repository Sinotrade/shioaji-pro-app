// 美股委託隨主動回報（IntlOrder／IntlDeal）即時更新、庫存隨即時成交重算未實現損益。
// 對照台股：order-projection（New 回報建列、成交累加）與 trading-state（onAnyTick → markPosition）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    accounts: [] as unknown[],
    trades: vi.fn(), health: vi.fn(), positions: vi.fn(), apiGet: vi.fn(),
    onEvent: null as null | ((r: unknown) => void),
    onTick: null as null | ((t: { code: string; close: string; simtrade?: boolean }) => void),
    retained: [] as string[], released: [] as string[],
    accountsListener: null as null | (() => void), place: vi.fn(),
    base: 'http://a', resolve: null as null | ((code: string) => Promise<unknown>),
}));
vi.mock('../runtime', async original => ({ ...await original<object>(), getApiBase: () => m.base }));
vi.mock('../account-store', () => ({
    getAccountState: () => ({ accounts: m.accounts }),
    subscribeAccounts: (fn: () => void) => { m.accountsListener = fn; return () => undefined; },
}));
vi.mock('../risk', () => ({ checkUsOrderAllowed: () => null }));
vi.mock('../account-tradable', () => ({ canTrade: () => true }));
vi.mock('../stream', () => ({
    ensureStream: vi.fn(), getStreamStatus: () => 'down',
    onOrderEvent: (fn: (r: unknown) => void) => { m.onEvent = fn; return () => undefined; },
    onAnyTick: (fn: typeof m.onTick) => { m.onTick = fn; return () => undefined; },
    subscribeStatusStore: () => () => undefined,
}));
vi.mock('./us-api', () => ({ fetchUsTrades: m.trades, fetchUsTradeCacheHealth: m.health, fetchUsPositions: m.positions,
    placeUsOrder: m.place, cancelUsOrder: vi.fn(), reduceUsOrderQty: vi.fn(), usErrorText: (e: unknown) => String(e) }));
vi.mock('../api', () => ({ apiGet: m.apiGet }));
vi.mock('../quote-ownership', () => ({
    retainQuote: (c: { code: string }) => { m.retained.push(c.code); return () => { m.released.push(c.code); }; },
}));
vi.mock('./us-contracts', () => ({
    getUsContractRecord: (code: string) => (['NVDA', 'AAPL', 'SNDL'].includes(code) ? { code, exchange: 'NASDAQ' } : undefined),
    resolveUsContract: (code: string) => m.resolve ? m.resolve(code) : Promise.resolve({ code, region: 'US', exchange: 'NASDAQ', security_type: 'STK' }),
}));

import fx from './__fixtures__/intl-order-events.json';
import { normalizeOrderEvent } from '../order-report';
import * as us from './us-trading-state';
import { decDivRound } from './decimal';
import { placeReplacement, priceChangeProblem, US_EXCHANGE_PENDING } from './us-order-actions';
import type { Account } from '../types/portfolio';
import type { IntlPosition, UsTrade } from '../types/us';

const H: Account = { account_type: 'H', person_id: 'P', broker_id: '9A95', account_id: '0000001', signed: true, username: 'u' };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

type Wire = typeof fx.orderNew;
/** IntlOrder 回報（以 fixture 為底，覆寫 operation／order／status） */
function order(eventSeq: number, op: Partial<Wire['data']['IntlOrder']['operation']>,
    o: Partial<Wire['data']['IntlOrder']['order']> = {}, st: Record<string, unknown> = {}) {
    const base = fx.orderNew.data.IntlOrder;
    return normalizeOrderEvent({ state: 'IntlOrder', data: { IntlOrder: { ...base,
        event_id: `v1:IO:T:1:${eventSeq}`,
        operation: { ...base.operation, ...op }, order: { ...base.order, ...o }, status: { ...base.status, ...st } } } })!;
}
/** IntlDeal 回報 */
function deal(eventSeq: number, exchangeSeq: string, price: string, quantity: string, tradeId = '4cb2f7e1') {
    return normalizeOrderEvent({ state: 'IntlDeal', data: { IntlDeal: { ...fx.deal.data.IntlDeal,
        event_id: `v1:ID:T:1:${eventSeq}`, trade_id: tradeId, exchange_seq: exchangeSeq, price, quantity } } })!;
}
const trades = () => us.getUsTradingState().trades;

beforeEach(() => {
    m.accounts = [H];
    m.place.mockReset();
    m.base = 'http://a'; m.resolve = null;
    m.trades.mockReset(); m.health.mockReset(); m.positions.mockReset(); m.apiGet.mockReset();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(Date.UTC(2026, 10, 18, 15, 0));
    us.startUsTradingState();
    us.resetUsTradingStateForTest();
    m.retained.length = 0; m.released.length = 0;
    m.trades.mockResolvedValue([]);
    m.health.mockResolvedValue({ state: 'Healthy', reasons: [] });
});
afterEach(() => { vi.useRealTimers(); });

describe('US order panel follows pushed reports (no re-read)', () => {
    it('creates the row from a New report that arrives before the order response', async () => {
        m.onEvent!(order(1, {}));
        await vi.advanceTimersByTimeAsync(2000);
        expect(m.trades).not.toHaveBeenCalled();
        expect(trades()).toHaveLength(1);
        expect(trades()[0]).toMatchObject({
            account: H,
            contract: { code: 'NVDA', exchange: 'NASDAQ', region: 'US', currency: 'USD' },
            order: { id: '4cb2f7e1', action: 'Buy', price: '173.97', quantity: '200', price_type: 'LMT', time_in_force: 'DAY', session: 'Regular' },
            status: { status: 'Submitted', order_quantity: '200', deal_quantity: '0', cancel_quantity: '0', deals: [] },
        });
        expect(us.usRemaining(trades()[0]!)).toBe('200');
    });

    it('partial fill → full fill: quantities and average price follow the deals in exact decimals', async () => {
        m.onEvent!(order(1, {}, { quantity: '15', price: '174' }, { order_quantity: '15' }));
        m.onEvent!(deal(1, '9002', '174.00', '5'));
        expect(trades()[0]!.status).toMatchObject({ status: 'PartFilled', deal_quantity: '5', avg_price: '174' });
        expect(us.usRemaining(trades()[0]!)).toBe('10');
        m.onEvent!(deal(2, '9001', '173.95', '10'));
        // SDK cache.rs 同一組成交：均價 173.966667（6 位小數、遠離 0 四捨五入）
        expect(trades()[0]!.status).toMatchObject({ status: 'Filled', deal_quantity: '15', avg_price: '173.966667' });
        expect(us.usIsWorking(trades()[0]!)).toBe(false);
        await vi.advanceTimersByTimeAsync(1000);
        expect(m.trades).not.toHaveBeenCalled();
    });

    it('sub-penny and fractional fills keep every digit', () => {
        m.onEvent!(order(1, {}, { quantity: '4', price: '0.1235' }, { order_quantity: '4' }));
        m.onEvent!(deal(1, 'a1', '0.1234', '3'));
        m.onEvent!(deal(2, 'a2', '0.1235', '0.5'));
        const t = trades()[0]!;
        expect(t.status.deal_quantity).toBe('3.5');
        expect(t.status.deals.map(d => [d.price, d.quantity])).toEqual([['0.1234', '3'], ['0.1235', '0.5']]);
        // (0.3702 + 0.06175) ÷ 3.5 = 0.43195 ÷ 3.5 = 0.12341428… → 0.123414
        expect(t.status.avg_price).toBe('0.123414');
        expect(us.usRemaining(t)).toBe('0.5');
    });

    it('reduce then cancel ends Cancelled from reports alone', async () => {
        m.onEvent!(order(1, {}));
        m.onEvent!(normalizeOrderEvent(fx.orderUpdateQty));
        expect(trades()[0]!.status).toMatchObject({ status: 'Submitted', cancel_quantity: '50' });
        m.onEvent!(normalizeOrderEvent(fx.orderCancel));
        expect(trades()[0]!.status).toMatchObject({ status: 'Cancelled', cancel_quantity: '200', msg: '刪單成功' });
        await vi.advanceTimersByTimeAsync(1000);
        expect(m.trades).not.toHaveBeenCalled();
    });

    it('partial fill then cancel: the rest is cancelled, fills stay', () => {
        m.onEvent!(order(1, {}, { quantity: '10' }, { order_quantity: '10' }));
        m.onEvent!(deal(1, 's1', '173.95', '4'));
        m.onEvent!(order(2, { op_type: 'Cancel', op_msg: '刪單成功' }, { quantity: '10' }, { cancel_quantity: '6', order_quantity: '0' }));
        expect(trades()[0]!.status).toMatchObject({ status: 'Cancelled', deal_quantity: '4', cancel_quantity: '6' });
    });

    it('a rejected New with quantity becomes a Failed row carrying op_msg verbatim', async () => {
        m.onEvent!(order(1, { op_code: '8', op_msg: 'REJECTED' }, { id: '9f00aa01', ordno: '' }, { id: '9f00aa01' }));
        expect(trades()[0]!.status).toMatchObject({ status: 'Failed', msg: 'REJECTED', status_code: '8' });
        await vi.advanceTimersByTimeAsync(1000);
        expect(m.trades).not.toHaveBeenCalled();
    });

    it('a rejected New without quantity (SDK fixture) is re-read instead of guessed', async () => {
        m.onEvent!(normalizeOrderEvent(fx.orderNewFailed));
        expect(trades()).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(400);
        expect(m.trades).toHaveBeenCalledTimes(1);
    });

    it('duplicate deals (same exchange_seq) are counted once', () => {
        m.onEvent!(order(1, {}));
        m.onEvent!(deal(1, 'dup', '173.95', '1'));
        m.onEvent!(deal(2, 'dup', '173.95', '1')); // 不同 event_id、同一筆交易所成交
        expect(trades()[0]!.status.deal_quantity).toBe('1');
    });

    it('out of order: a deal before its New report triggers one re-read; a stale reduction does not undo a cancel', async () => {
        m.onEvent!(deal(1, 'early', '173.95', '1'));
        await vi.advanceTimersByTimeAsync(400);
        expect(m.trades).toHaveBeenCalledTimes(1);
        us.resetUsTradingStateForTest();
        m.onEvent!(order(10, {}));
        m.onEvent!(normalizeOrderEvent(fx.orderUpdateQty));
        m.onEvent!(normalizeOrderEvent(fx.orderCancel));
        m.onEvent!(normalizeOrderEvent({ ...fx.orderUpdateQty, data: { IntlOrder: { ...fx.orderUpdateQty.data.IntlOrder, event_id: 'v1:IO:T:1:99' } } }));
        expect(trades()[0]!.status).toMatchObject({ status: 'Cancelled', cancel_quantity: '200' });
    });

    it('the later order response fills missing fields without blanking report values', () => {
        m.onEvent!(order(1, {}));
        const response: UsTrade = {
            contract: { security_type: 'STK', exchange: 'NASDAQ', code: 'NVDA', region: 'US' },
            order: { id: '4cb2f7e1', seqno: '21157799', ordno: '', action: 'Buy', price: '173.97', quantity: '200', trade_date: '20261118' },
            status: { id: '4cb2f7e1', status: 'PendingSubmit', status_code: '', order_quantity: '200', deal_quantity: '0', cancel_quantity: '0', msg: '', deals: [] },
        };
        us.observeUsTrade(response, H);
        expect(trades()).toHaveLength(1);
        expect(trades()[0]!.order).toMatchObject({ ordno: '00000022', trade_date: '20261118', price_type: 'LMT' });
        expect(trades()[0]!.status.status).toBe('Submitted');
    });
});

describe('usAveragePrice matches SDK intl::average_price', () => {
    it('rounds half away from zero at 6 places and trims zeros', () => {
        expect(us.usAveragePrice([{ seq: '1', ts: 0, price: '1', quantity: '3' }, { seq: '2', ts: 0, price: '2', quantity: '3' }])).toBe('1.5');
        expect(us.usAveragePrice([{ seq: '1', ts: 0, price: '0.0000005', quantity: '1' }])).toBe('0.000001');
        expect(us.usAveragePrice([])).toBeNull();
    });
    it('decDivRound is exact for negatives too', () => {
        expect(decDivRound('-1', '3', 2)).toBe('-0.33');
        expect(decDivRound('-0.005', '1', 2)).toBe('-0.01');
        expect(decDivRound('1', '0', 2)).toBeNull();
    });
});

describe('US positions: unrealized P&L from live trades', () => {
    const pos = (over: Partial<IntlPosition> = {}): IntlPosition => ({ id: 0, account_type: 'H', code: 'AAPL', direction: 'Buy',
        quantity: '10.5', price: '180.1234', cost_basis: '1891.2957', market_price: '190.5', market_value: '2000.25',
        pnl: '108.9543', pnl_pct: '5.76', currency: 'USD', base_currency: 'USD', ...over });

    it('uses the SDK formula: value = price × qty, pnl = value − cost_basis, pct = pnl ÷ cost × 100 (2 dp)', () => {
        // SDK intl.rs fixture 的同一組數字：重算結果與後端一致
        expect(us.markUsPosition(pos(), '190.5')).toEqual(pos());
        expect(us.markUsPosition(pos(), '200')).toMatchObject({ market_price: '200', market_value: '2100', pnl: '208.7043', pnl_pct: '11.03' });
        // 模擬環境實際資料：1 股、成本 352.83、市價 352.45 → -0.38（-0.11%）
        expect(us.markUsPosition(pos({ quantity: '1', price: '352.83', cost_basis: '352.83' }), '352.45'))
            .toMatchObject({ market_value: '352.45', pnl: '-0.38', pnl_pct: '-0.11' });
    });

    it('stays exact where floats drift (price < $1, sub-penny, fractional shares)', () => {
        // 浮點：0.1 × 3.3 − 0.3 = 0.030000000000000027
        expect(us.markUsPosition(pos({ quantity: '0.1', cost_basis: '0.3' }), '3.3')).toMatchObject({ market_value: '0.33', pnl: '0.03', pnl_pct: '10' });
        expect(us.markUsPosition(pos({ code: 'SNDL', quantity: '0.5', cost_basis: '0.06' }), '0.1234'))
            .toMatchObject({ market_price: '0.1234', market_value: '0.0617', pnl: '0.0017', pnl_pct: '2.83' });
    });

    it('falls back to average price × qty without cost_basis, and ignores bad prices', () => {
        expect(us.markUsPosition(pos({ cost_basis: undefined, price: '10', quantity: '2' }), '11')).toMatchObject({ pnl: '2', pnl_pct: '10' });
        const p = pos();
        expect(us.markUsPosition(p, '0')).toBe(p);
        expect(us.markUsPosition(p, 'abc')).toBe(p);
    });

    it('a US tick re-marks only the matching holding; TW ticks and simtrade are ignored', async () => {
        m.apiGet.mockResolvedValue({ components: { schemas: { IntlPosition: {} } } });
        m.positions.mockResolvedValue([pos(), pos({ id: 1, code: 'NVDA', quantity: '2', cost_basis: '300', market_price: '150', market_value: '300', pnl: '0', pnl_pct: '0' })]);
        await us.refreshUsPositions();
        await flush();
        expect(m.retained.sort()).toEqual(['AAPL', 'NVDA']);
        const version = us.getUsTradingState().positionsVersion;
        m.onTick!({ code: 'US:AAPL', close: '200' });
        m.onTick!({ code: 'AAPL', close: '1' }); // 不是美股連動 key
        m.onTick!({ code: 'US:AAPL', close: '1', simtrade: true });
        const [aapl, nvda] = us.getUsTradingState().positions;
        expect(aapl).toMatchObject({ market_price: '200', pnl: '208.7043', pnl_pct: '11.03' });
        expect(nvda).toMatchObject({ market_price: '150', pnl: '0' });
        // 庫存明細快取依 positionsVersion：即時重算不換版本
        expect(us.getUsTradingState().positionsVersion).toBe(version);
    });

    it('a positions re-read keeps a fresh live price (≤ 60 s) over the backend reference', async () => {
        m.apiGet.mockResolvedValue({ components: { schemas: { IntlPosition: {} } } });
        m.positions.mockResolvedValue([pos()]);
        await us.refreshUsPositions();
        m.onTick!({ code: 'US:AAPL', close: '200' });
        await us.refreshUsPositions();
        expect(us.getUsTradingState().positions[0]).toMatchObject({ market_price: '200', pnl: '208.7043' });
        vi.advanceTimersByTime(60_001);
        await us.refreshUsPositions();
        expect(us.getUsTradingState().positions[0]).toMatchObject({ market_price: '190.5', pnl: '108.9543' });
    });

    it('releases the quote when the holding is gone', async () => {
        m.apiGet.mockResolvedValue({ components: { schemas: { IntlPosition: {} } } });
        m.positions.mockResolvedValueOnce([pos()]).mockResolvedValue([]);
        await us.refreshUsPositions();
        await flush();
        expect(m.retained).toEqual(['AAPL']);
        await us.refreshUsPositions();
        expect(m.released).toEqual(['AAPL']);
    });
});

describe('review fixes (PR #432)', () => {
    it('a report-built row without a known exchange cannot start a reprice until the exchange is resolved', async () => {
        // 合約清單沒有 ZZZZ：回報建立的列 exchange 是 null
        m.onEvent!(order(1, {}, {}, {}));
        const raw = { ...fx.orderNew.data.IntlOrder, event_id: 'v1:IO:T:1:50', order: { ...fx.orderNew.data.IntlOrder.order, id: 'z1' },
            status: { ...fx.orderNew.data.IntlOrder.status, id: 'z1' }, contract: { ...fx.orderNew.data.IntlOrder.contract, code: 'ZZZZ' } };
        const report = normalizeOrderEvent({ state: 'IntlOrder', data: { IntlOrder: raw } })!;
        const built = us.projectUsReport([], report, H)!;
        expect(built[0]!.contract.exchange).toBeNull();
        expect(priceChangeProblem(built[0]!, '170')).toBe(US_EXCHANGE_PENDING);
        // 重下前沒有交易所：不送單
        await expect(placeReplacement(built[0]!, { action: 'Buy', price: '170', quantity: 1, price_type: 'LMT', time_in_force: 'DAY' }, (() => true) as never))
            .rejects.toThrow(US_EXCHANGE_PENDING);
        expect(m.place).not.toHaveBeenCalled();
        // 經 store 收到同一筆回報：查到交易所後補上，改價檢查放行
        m.onEvent!(report);
        await flush();
        const row = trades().find(t => t.order.id === 'z1')!;
        expect(row.contract.exchange).toBe('NASDAQ');
        expect(priceChangeProblem(built[0]!, '170')).toBeNull();
    });

    it('a stale snapshot adopted under keepMonotonic keeps the average price of the deals it keeps', async () => {
        const base = { account: H, contract: { security_type: 'STK', exchange: 'NASDAQ', code: 'NVDA', region: 'US' },
            order: { id: '4cb2f7e1', seqno: '21157799', ordno: '00000022', action: 'Buy' as const, price: '180', quantity: '10', trade_date: '20261118' } };
        us.resetUsTradingStateForTest({ trades: [{ ...base, status: { id: '4cb2f7e1', status: 'PartFilled', status_code: '00', order_quantity: '10',
            deal_quantity: '3', cancel_quantity: '0', msg: '', avg_price: '173', deals: [{ seq: 's1', ts: 1, price: '173', quantity: '3' }] } }] });
        let resolve!: (rows: unknown[]) => void;
        m.trades.mockReturnValueOnce(new Promise(r => { resolve = r; }));
        const run = us.refreshUsAccount(H);
        m.onEvent!(deal(1, 's2', '180', '2'));
        expect(trades()[0]!.status).toMatchObject({ deal_quantity: '5', avg_price: '175.8' });
        // 較舊的快照：update_status 的彙總成交（seq "1"、ts 0）3 股 @173
        resolve([{ contract: base.contract, order: base.order, status: { id: '4cb2f7e1', status: 'PartFilled', status_code: '00', order_quantity: '10',
            deal_quantity: '3', cancel_quantity: '0', msg: '', avg_price: '173', deals: [{ seq: '1', ts: 0, price: '173', quantity: '3' }] } }]);
        await run;
        expect(trades()[0]!.status).toMatchObject({ deal_quantity: '5', avg_price: '175.8' });
        expect(trades()[0]!.status.deals).toHaveLength(2);
    });

    it('an H account change drops the old account\'s positions and orders and releases their quotes', async () => {
        m.apiGet.mockResolvedValue({ components: { schemas: { IntlPosition: {} } } });
        m.positions.mockResolvedValue([{ id: 0, account_type: 'H', code: 'AAPL', direction: 'Buy', quantity: '1', price: '352.83', cost_basis: '352.83',
            market_price: '352.45', market_value: '352.45', pnl: '-0.38', pnl_pct: '-0.11', currency: 'USD', base_currency: 'USD' }]);
        await us.refreshUsPositions();
        m.onEvent!(order(1, {}));
        await flush();
        expect(m.retained).toEqual(['AAPL']);
        expect(trades()).toHaveLength(1);
        // H 帳戶被移除（或換成另一個 H）：舊帳戶的庫存、委託、行情訂閱立即清掉
        const H2: Account = { ...H, account_id: '0000002' };
        m.accounts = [H2];
        m.positions.mockReturnValue(new Promise(() => undefined)); // 新帳戶的庫存還在查
        m.accountsListener!();
        expect(us.getUsTradingState().positions).toEqual([]);
        expect(trades()).toEqual([]);
        expect(m.released).toEqual(['AAPL']);
        // 新帳戶的庫存會重查
        await flush();
        expect(m.positions).toHaveBeenCalledWith(H2);
    });
});

describe('review fixes round 2 (PR #432)', () => {
    const xyz = (id: string, seq: number) => normalizeOrderEvent({ state: 'IntlOrder', data: { IntlOrder: { ...fx.orderNew.data.IntlOrder,
        event_id: `v1:IO:T:2:${seq}`, order: { ...fx.orderNew.data.IntlOrder.order, id }, status: { ...fx.orderNew.data.IntlOrder.status, id },
        contract: { ...fx.orderNew.data.IntlOrder.contract, code: 'XYZ' } } } })!;

    it('a pending exchange lookup on server A does not block the same symbol on server B', async () => {
        let resolveA!: (v: unknown) => void;
        m.resolve = () => new Promise(r => { resolveA = r; });
        m.onEvent!(xyz('a1', 1)); // 伺服器 A：XYZ 查詢中
        m.base = 'http://b';
        m.resolve = (code) => Promise.resolve({ code, region: 'US', exchange: 'NYSE', security_type: 'STK' });
        m.onEvent!(xyz('b1', 2)); // 伺服器 B 的同代碼列
        resolveA({ code: 'XYZ', region: 'US', exchange: 'NASDAQ', security_type: 'STK' }); // A 的結果作廢
        await flush();
        expect(trades().find(t => t.order.id === 'b1')!.contract.exchange).toBe('NYSE');
    });

    it('an order response for an account that was removed is not adopted, and later re-reads do not keep it', async () => {
        const H2: Account = { ...H, account_id: '0000002' };
        m.accounts = [H2];
        m.accountsListener!();
        const response: UsTrade = {
            contract: { security_type: 'STK', exchange: 'NASDAQ', code: 'NVDA', region: 'US' },
            order: { id: 'late1', seqno: '1', ordno: '1', action: 'Buy', price: '173', quantity: '5', trade_date: '20261118' },
            status: { id: 'late1', status: 'Submitted', status_code: '00', order_quantity: '5', deal_quantity: '0', cancel_quantity: '5', msg: '', deals: [] },
        };
        us.observeUsTrade(response, H); // 減量／刪單回應晚到，H 已移除
        expect(trades()).toEqual([]);
        // 帳戶移除前就開始的 H 查詢晚到：也不採用
        await us.refreshUsAccount(H2);
        m.trades.mockResolvedValueOnce([response]);
        await us.refreshUsAccount(H);
        expect(trades().some(t => t.account.account_id === H.account_id)).toBe(false);
    });
});
