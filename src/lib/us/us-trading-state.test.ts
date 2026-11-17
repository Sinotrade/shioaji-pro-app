import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    accounts: [] as unknown[],
    trades: vi.fn(), health: vi.fn(), positions: vi.fn(), apiGet: vi.fn(),
}));
vi.mock('../account-store', () => ({
    getAccountState: () => ({ accounts: m.accounts }),
    subscribeAccounts: () => () => undefined,
}));
vi.mock('../account-tradable', () => ({ canTrade: () => true }));
vi.mock('../stream', () => ({
    ensureStream: vi.fn(), getStreamStatus: () => 'down', onOrderEvent: () => () => undefined, subscribeStatusStore: () => () => undefined,
}));
vi.mock('./us-api', () => ({ fetchUsTrades: m.trades, fetchUsTradeCacheHealth: m.health, fetchUsPositions: m.positions }));
vi.mock('../api', () => ({ apiGet: m.apiGet }));

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
        expect(us.getUsTradingState().positionsStatus).toBe('unsupported');
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
