import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    accounts: [] as unknown[],
    trades: vi.fn(), health: vi.fn(), positions: vi.fn(), apiGet: vi.fn(),
    onEvent: null as null | ((r: unknown) => void),
    onTick: null as null | ((t: { code: string; close: string; simtrade?: boolean; volume?: number }) => void),
    retained: [] as string[], released: [] as string[],
    streamStatus: 'down', statusListener: null as null | (() => void),
}));
vi.mock('../account-store', () => ({
    getAccountState: () => ({ accounts: m.accounts }),
    subscribeAccounts: () => () => undefined,
}));
vi.mock('../account-tradable', () => ({ canTrade: () => true }));
vi.mock('../stream', () => ({
    ensureStream: vi.fn(), getStreamStatus: () => m.streamStatus,
    onOrderEvent: (fn: (r: unknown) => void) => { m.onEvent = fn; return () => undefined; },
    onAnyTick: (fn: typeof m.onTick) => { m.onTick = fn; return () => undefined; },
    subscribeStatusStore: (fn: () => void) => { m.statusListener = fn; return () => undefined; },
}));
vi.mock('./us-api', () => ({ fetchUsTrades: m.trades, fetchUsTradeCacheHealth: m.health, fetchUsPositions: m.positions }));
vi.mock('../api', () => ({ apiGet: m.apiGet }));
vi.mock('../quote-ownership', () => ({
    retainQuote: (c: { code: string }) => { m.retained.push(c.code); return () => { m.released.push(c.code); }; },
}));
vi.mock('./us-contracts', () => ({
    getUsContractRecord: (code: string) => (code === 'NVDA' || code === 'AAPL' ? { code, exchange: 'NASDAQ' } : undefined),
    resolveUsContract: async (code: string) => ({ code, region: 'US', exchange: 'NASDAQ', security_type: 'STK' }),
}));

import fx from './__fixtures__/intl-order-events.json';
import { normalizeOrderEvent } from '../order-report';
import * as us from './us-trading-state';
import type { AccountedUsTrade } from '../types/us';
import type { Account } from '../types/portfolio';

const H: Account = { account_type: 'H', person_id: 'P', broker_id: '9A95', account_id: '0000001', signed: true, username: 'u' };
const S: Account = { ...H, account_type: 'S' };

function row(over: Partial<AccountedUsTrade['status']> = {}, order: Partial<AccountedUsTrade['order']> = {}): AccountedUsTrade {
    return {
        account: H,
        contract: { security_type: 'STK', exchange: 'NASDAQ', code: 'NVDA', region: 'US' },
        order: { id: '4cb2f7e1', seqno: '21157799', ordno: '00000022', action: 'Buy', price: '173.97', quantity: '200',
            price_type: 'LMT', time_in_force: 'DAY', trade_date: '20261118', ...order },
        status: { id: '4cb2f7e1', status: 'Submitted', status_code: '00', order_quantity: '200', deal_quantity: '0',
            cancel_quantity: '0', msg: '', deals: [], ...over },
    };
}

beforeEach(() => {
    m.accounts = [S, H];
    m.trades.mockReset(); m.health.mockReset(); m.positions.mockReset(); m.apiGet.mockReset();
    us.resetUsTradingStateForTest();
    // 固定在美東 2026-11-18 盤中，trade_date 篩選才不隨執行日期變
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 10, 18, 15, 0));
});
afterEach(() => { vi.useRealTimers(); });

describe('UpdateQty is idempotent (order_quantity sets the absolute state)', () => {
    it('does not double-deduct when the same reduction is applied twice', () => {
        const once = us.projectUsReport([row()], normalizeOrderEvent(fx.orderUpdateQty)!, H)!;
        const twice = us.projectUsReport(once, normalizeOrderEvent(fx.orderUpdateQty)!, H)!;
        expect(twice[0]!.status.cancel_quantity).toBe('50');
        expect(us.usRemaining(twice[0]!)).toBe('150');
    });

    it('refetches instead of guessing once the order has fills', () => {
        expect(us.projectUsReport([row({ deal_quantity: '10' })], normalizeOrderEvent(fx.orderUpdateQty)!, H)).toBeNull();
    });
});

describe('refresh boundaries', () => {
    it('re-applies reports received while the snapshot query was in flight', async () => {
        us.startUsTradingState();
        let resolve!: (rows: unknown[]) => void;
        m.trades.mockReturnValueOnce(new Promise(r => { resolve = r; }));
        m.health.mockResolvedValue({ state: 'Healthy', reasons: [] });
        const run = us.refreshUsAccount(H);
        // 查詢期間收到減量回報；快照是查詢開始時的（未減量）
        m.onEvent!(normalizeOrderEvent(fx.orderUpdateQty));
        resolve([row()]);
        await run;
        expect(us.getUsTradingState().trades[0]!.status.cancel_quantity).toBe('50');
    });

    it('runs one more query when a refresh is requested during one in flight', async () => {
        let resolve!: (rows: unknown[]) => void;
        m.trades.mockReturnValueOnce(new Promise(r => { resolve = r; })).mockResolvedValue([row({ status: 'Cancelled', cancel_quantity: '200' })]);
        const first = us.refreshUsAccount(H);
        const second = us.refreshUsAccount(H);
        const third = us.refreshUsAccount(H);
        expect(second).toBe(third);
        resolve([row()]);
        await first; await second;
        expect(m.trades).toHaveBeenCalledTimes(2);
        expect(us.getUsTradingState().trades[0]!.status.status).toBe('Cancelled');
    });
});

describe('snapshot adoption', () => {
    it('does not publish a regressed snapshot when buffered reports fail to apply', async () => {
        us.startUsTradingState();
        us.resetUsTradingStateForTest({ trades: [{ ...row({ status: 'PartFilled', deal_quantity: '5' }), account: H }] });
        let resolve!: (rows: unknown[]) => void;
        m.trades.mockReturnValueOnce(new Promise(r => { resolve = r; })).mockResolvedValue([row({ status: 'PartFilled', deal_quantity: '5' })]);
        const run = us.refreshUsAccount(H);
        // 對不上的逐筆成交（沒有 exchange_seq）→ 套不上
        m.onEvent!(normalizeOrderEvent(fx.dealMinimal));
        resolve([row()]); // 較舊的快照：成交 0
        await run;
        const t = us.getUsTradingState().trades[0]!;
        expect(t.status.deal_quantity).toBe('5');
        expect(t.status.status).toBe('PartFilled');
    });

    it('drops yesterday\'s DAY orders from a snapshot after the New York date rolls', async () => {
        m.trades.mockResolvedValue([row({}, { id: 'y', trade_date: '20261117' })]);
        await us.refreshUsAccount(H);
        expect(us.getUsTradingState().trades).toHaveLength(0);
    });
});

describe('New York day rollover', () => {
    it('computes the America/New_York date', () => {
        // 2026-11-18 03:00 UTC = 11/17 22:00 EST
        expect(us.nyDate(Date.UTC(2026, 10, 18, 3, 0))).toBe('20261117');
        expect(us.nyDate(Date.UTC(2026, 10, 18, 6, 0))).toBe('20261118');
    });

    it('drops rows from before the current New York trade date', () => {
        const old = row({}, { id: 'old', trade_date: '20261117' });
        const today = row({}, { id: 'new', trade_date: '20261118' });
        expect(us.dropBeforeNyDate([old, today], '20261118').map(t => t.order.id)).toEqual(['new']);
    });
});

describe('projectUsReport', () => {
    it('applies UpdateQty as this operation\'s reduction (cumulative cancel)', () => {
        const next = us.projectUsReport([row()], normalizeOrderEvent(fx.orderUpdateQty)!, H)!;
        expect(next[0]!.status.cancel_quantity).toBe('50');
        expect(us.usRemaining(next[0]!)).toBe('150');
        const cancelled = us.projectUsReport(next, normalizeOrderEvent(fx.orderCancel)!, H)!;
        expect(cancelled[0]!.status).toMatchObject({ status: 'Cancelled', cancel_quantity: '200', msg: '刪單成功' });
        expect(us.usIsWorking(cancelled[0]!)).toBe(false);
    });

    it('marks a rejected New as Failed with op_msg verbatim', () => {
        const r = row({}, { id: '9f00aa01', ordno: '' });
        const next = us.projectUsReport([r], normalizeOrderEvent(fx.orderNewFailed)!, H)!;
        expect(next[0]!.status).toMatchObject({ status: 'Failed', msg: 'REJECTED', status_code: '8' });
    });

    it('adds fractional fills, dedups by exchange_seq, and refetches on minimal/aggregate deals', () => {
        const deal = normalizeOrderEvent(fx.deal)!;
        const once = us.projectUsReport([row()], deal, H)!;
        expect(once[0]!.status).toMatchObject({ deal_quantity: '0.5', status: 'PartFilled' });
        expect(us.projectUsReport(once, deal, H)).toBe(once);
        // 沒有 exchange_seq：無法去重 → 交給重新查詢
        expect(us.projectUsReport(once, normalizeOrderEvent(fx.dealMinimal)!, H)).toBeNull();
        // 已有 update_status 的彙總成交（seq "1"、ts 0）→ 重新查詢
        const agg = row({ deal_quantity: '10', status: 'PartFilled', deals: [{ seq: '1', ts: 0, price: '173.9', quantity: '10' }] });
        expect(us.projectUsReport([agg], deal, H)).toBeNull();
    });

    it('returns null for an unknown order so the account is re-read', () => {
        expect(us.projectUsReport([], normalizeOrderEvent(fx.orderUpdateQty)!, H)).toBeNull();
    });
});

describe('H account re-sync', () => {
    it('reads trades with account_type H, drops expired DAY orders and shows the unhealthy hint', async () => {
        m.trades.mockResolvedValue([
            { ...row(), account: undefined },
            { ...row({}, { id: 'old', trade_date: '20261117' }), account: undefined },
        ]);
        m.health.mockResolvedValue({ state: 'Degraded', reasons: [{ event_type: 'IntlDeal', reason: 'SequenceGap' }] });
        await us.refreshUsTrades();
        expect(m.trades).toHaveBeenCalledTimes(1);
        expect(m.trades.mock.calls[0]![0]).toBe(H);
        const s = us.getUsTradingState();
        expect(s.trades.map(t => t.order.id)).toEqual(['4cb2f7e1']);
        expect(s.hint).toBe(us.US_DEAL_UNHEALTHY_HINT);
        m.health.mockResolvedValue({ state: 'Healthy', reasons: [] });
        await us.refreshUsTrades();
        expect(us.getUsTradingState().hint).toBeNull();
    });

    it('keeps the previous rows when the read fails', async () => {
        us.resetUsTradingStateForTest({ trades: [row()] });
        m.trades.mockRejectedValue(new Error('500'));
        await us.refreshUsTrades();
        expect(us.getUsTradingState().trades).toHaveLength(1);
        expect(us.getUsTradingState().error).toContain('美股委託查詢失敗');
    });
});

describe('US positions capability', () => {
    it('is unsupported without the intl-portfolio API', async () => {
        m.apiGet.mockResolvedValue({ paths: { '/api/v1/portfolio/position_unit': {} } });
        await us.refreshUsPositions();
        expect(us.getUsTradingState().positionsStatus).toBe('unsupported');
        expect(m.positions).not.toHaveBeenCalled();
    });

    it('rejects a Taiwan-shaped response even when the API is advertised', async () => {
        m.apiGet.mockResolvedValue({ paths: { '/api/v1/portfolio/list_dividends': {} } });
        m.positions.mockResolvedValue([{ id: 1, code: '2330', quantity: 1000, price: 600, last_price: 610, pnl: 10000, direction: 'Buy' }]);
        await us.refreshUsPositions();
        // 宣告了 API 但回應形狀不對：是錯誤（可重試），不是「不支援」
        expect(us.getUsTradingState().positionsStatus).toBe('error');
    });

    it('treats an unreadable OpenAPI as a transient error, not unsupported, and asks again', async () => {
        m.apiGet.mockRejectedValueOnce(new Error('fetch failed'));
        await us.refreshUsPositions();
        expect(us.getUsTradingState().positionsStatus).toBe('error');
        expect(us.getUsTradingState().positionsError).toContain('重試');
        m.apiGet.mockResolvedValue({ components: { schemas: { IntlPosition: {} } } });
        m.positions.mockResolvedValue([]);
        await us.refreshUsPositions();
        expect(us.getUsTradingState().positionsStatus).toBe('ready');
        // 每次成功查詢都換版本：SDK 會重新編 id，庫存明細快取不能沿用
        const v = us.getUsTradingState().positionsVersion;
        await us.refreshUsPositions();
        expect(us.getUsTradingState().positionsVersion).toBe(v + 1);
    });

    it('shows a failed positions read as an error', async () => {
        m.apiGet.mockResolvedValue({ paths: { '/api/v1/portfolio/list_dividends': {} } });
        m.positions.mockRejectedValue(new Error('503 busy'));
        await us.refreshUsPositions();
        expect(us.getUsTradingState().positionsStatus).toBe('error');
    });

    it('reads IntlPosition rows with null market fields', async () => {
        m.apiGet.mockResolvedValue({ components: { schemas: { IntlPosition: {} } } });
        m.positions.mockResolvedValue([{ id: 0, account_type: 'H', code: 'NVDA', direction: 'Buy', quantity: '10.5', price: '170.1',
            cost_basis: '1786.05', market_price: null, market_value: null, pnl: null, pnl_pct: null, currency: 'USD', base_currency: 'USD' }]);
        await us.refreshUsPositions();
        const s = us.getUsTradingState();
        expect(s.positionsStatus).toBe('ready');
        expect(s.positions[0]).toMatchObject({ code: 'NVDA', quantity: '10.5', market_price: null, account: H });
    });
});

describe('positions refresh after US deals', () => {
    const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(Date.UTC(2026, 10, 18, 15, 0));
        us.startUsTradingState();
        m.apiGet.mockResolvedValue({ components: { schemas: { IntlPosition: {} } } });
        m.trades.mockResolvedValue([row()]);
        m.health.mockResolvedValue({ state: 'Healthy', reasons: [] });
        us.resetUsTradingStateForTest({ trades: [row()] });
    });
    const position = (quantity: string) => ({ id: 0, code: 'NVDA', direction: 'Buy', quantity, price: '173.95', cost_basis: '1',
        market_price: null, market_value: null, pnl: null, pnl_pct: null, currency: 'USD' });

    it('re-reads positions 1.5 s after the last deal and once more at 5 s, coalescing a burst', async () => {
        // paper 伺服器成交後稍晚才更新庫存：第一次查到舊值，第二次才是新值
        m.positions.mockResolvedValueOnce([position('1')]).mockResolvedValue([position('1.5')]);
        m.onEvent!(normalizeOrderEvent(fx.deal));
        await vi.advanceTimersByTimeAsync(1000);
        m.onEvent!(normalizeOrderEvent({ ...fx.deal, data: { IntlDeal: { ...fx.deal.data.IntlDeal, exchange_seq: '107283172' } } }));
        await vi.advanceTimersByTimeAsync(1499);
        expect(m.positions).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await flush();
        expect(m.positions).toHaveBeenCalledTimes(1);
        expect(us.getUsTradingState().positions[0]!.quantity).toBe('1');
        await vi.advanceTimersByTimeAsync(3500);
        await flush();
        expect(m.positions).toHaveBeenCalledTimes(2);
        expect(us.getUsTradingState().positions[0]!.quantity).toBe('1.5');
        await vi.advanceTimersByTimeAsync(20_000);
        expect(m.positions).toHaveBeenCalledTimes(2);
    });

    it('does not re-read positions for order reports (new／cancel／reduce)', async () => {
        m.onEvent!(normalizeOrderEvent(fx.orderUpdateQty));
        await vi.advanceTimersByTimeAsync(10_000);
        expect(m.positions).not.toHaveBeenCalled();
    });

    it('skips the re-read when positions are unsupported', async () => {
        us.resetUsTradingStateForTest({ trades: [row()], positionsStatus: 'unsupported' });
        m.onEvent!(normalizeOrderEvent(fx.deal));
        await vi.advanceTimersByTimeAsync(10_000);
        expect(m.positions).not.toHaveBeenCalled();
    });

    it('publishes only the latest of overlapping positions reads', async () => {
        let slow!: (v: unknown) => void;
        m.positions.mockReturnValueOnce(new Promise(r => { slow = r; })).mockResolvedValue([position('2')]);
        const first = us.refreshUsPositions();
        await flush();
        await us.refreshUsPositions();
        slow([position('1')]);
        await first;
        expect(us.getUsTradingState().positions[0]!.quantity).toBe('2');
    });
});

describe('unhealthy hint lifecycle', () => {
    it('clears the hint when there are no H accounts', async () => {
        us.resetUsTradingStateForTest({ hint: us.US_DEAL_UNHEALTHY_HINT });
        m.accounts = [S];
        await us.refreshUsTrades();
        expect(us.getUsTradingState().hint).toBeNull();
    });

    it('keeps the hint after a failed reconciliation and clears it when a later account re-read succeeds', async () => {
        us.startUsTradingState();
        m.health.mockResolvedValue({ state: 'Healthy', reasons: [] });
        m.trades.mockResolvedValue([row()]);
        m.streamStatus = 'live'; m.statusListener!();
        m.streamStatus = 'down'; m.statusListener!();
        await us.refreshUsTrades();
        m.trades.mockRejectedValueOnce(new Error('503'));
        m.streamStatus = 'live'; m.statusListener!();
        await vi.waitFor(() => expect(us.getUsTradingState().error).toContain('美股委託查詢失敗'));
        expect(us.getUsTradingState().hint).toBe(us.US_DEAL_UNHEALTHY_HINT);
        // 之後單一帳戶重查成功（例如回報對不上觸發的重查）：所有帳戶都對帳過 → 依健康度清除
        await us.refreshUsAccount(H);
        await vi.waitFor(() => expect(us.getUsTradingState().hint).toBeNull());
        expect(us.getUsTradingState().error).toBeNull();
    });

    // 讓下一次 statusListener('live') 一定是「重連」（會亮提示並全部重查）
    const reconnect = () => {
        m.streamStatus = 'live'; m.statusListener!();
        m.streamStatus = 'down'; m.statusListener!();
        m.streamStatus = 'live'; m.statusListener!();
    };
    const settle = async () => { await vi.waitFor(() => expect(us.getUsTradingState().loading).toBe(false)); for (let i = 0; i < 20; i++) await Promise.resolve(); };

    it('does not let an older health check started before a newer warning clear it', async () => {
        us.startUsTradingState();
        m.trades.mockResolvedValue([row()]);
        m.health.mockResolvedValue({ state: 'Healthy', reasons: [] });
        m.streamStatus = 'live'; m.statusListener!();
        await us.refreshUsTrades(); await settle();
        // 第一次提示：全部重查失敗，H 仍待對帳
        m.trades.mockRejectedValueOnce(new Error('503'));
        m.streamStatus = 'down'; m.statusListener!();
        m.streamStatus = 'live'; m.statusListener!();
        await settle();
        expect(us.getUsTradingState().hint).toBe(us.US_DEAL_UNHEALTHY_HINT);
        // 單一帳戶恢復 → 開始一個很慢的健康度檢查（結果是提示前的 Healthy）
        let slow!: (v: unknown) => void;
        m.health.mockReturnValueOnce(new Promise(r => { slow = r; }));
        await us.refreshUsAccount(H);
        // 又一次重連：快取現在是 Degraded
        m.health.mockResolvedValue({ state: 'Degraded', reasons: [{ event_type: 'IntlDeal', reason: 'SequenceGap' }] });
        m.streamStatus = 'down'; m.statusListener!();
        m.streamStatus = 'live'; m.statusListener!();
        await settle();
        expect(us.getUsTradingState().hint).toBe(us.US_DEAL_UNHEALTHY_HINT);
        // 舊檢查晚到：不能清掉新的提示
        slow({ state: 'Healthy', reasons: [] });
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect(us.getUsTradingState().hint).toBe(us.US_DEAL_UNHEALTHY_HINT);
    });

    it('recomputes after a failed full refresh when single-account retries drained the pending set', async () => {
        const H2 = { ...H, account_id: '0000002' };
        m.accounts = [S, H, H2];
        us.startUsTradingState();
        m.health.mockResolvedValue({ state: 'Healthy', reasons: [] });
        m.trades.mockImplementation(() => Promise.resolve([]));
        m.streamStatus = 'live'; m.statusListener!();
        await us.refreshUsTrades(); await settle();
        // 重連：A（H）失敗、B（H2）還在查
        let releaseB!: (v: unknown) => void;
        let aFails = true;
        m.trades.mockImplementation((a: Account) => {
            if (a.account_id === H2.account_id) return new Promise(r => { releaseB = r; });
            if (aFails) { aFails = false; return Promise.reject(new Error('503')); }
            return Promise.resolve([]);
        });
        m.streamStatus = 'down'; m.statusListener!();
        m.streamStatus = 'live'; m.statusListener!();
        expect(us.getUsTradingState().hint).toBe(us.US_DEAL_UNHEALTHY_HINT);
        for (let i = 0; i < 10; i++) await Promise.resolve();
        // A 的單一帳戶重試在 B 完成前成功
        await us.refreshUsAccount(H);
        releaseB([]);
        await settle();
        // 全部重查走失敗分支，但兩個帳戶都已對帳 → 仍要依健康度清除
        await vi.waitFor(() => expect(us.getUsTradingState().hint).toBeNull());
        expect(m.trades.mock.calls.filter(c => (c[0] as Account).account_id === H.account_id).length).toBeGreaterThanOrEqual(2);
    });

    it('still shows the hint when the cache is degraded after reconciliation', async () => {
        us.startUsTradingState();
        m.trades.mockResolvedValue([row()]);
        m.health.mockResolvedValue({ state: 'Degraded', reasons: [{ event_type: 'IntlDeal', reason: 'SequenceGap' }] });
        m.streamStatus = 'live'; m.statusListener!();
        m.streamStatus = 'down'; m.statusListener!();
        m.streamStatus = 'live'; m.statusListener!();
        await us.refreshUsTrades();
        await vi.waitFor(() => expect(us.getUsTradingState().loading).toBe(false));
        expect(us.getUsTradingState().hint).toBe(us.US_DEAL_UNHEALTHY_HINT);
    });
});
