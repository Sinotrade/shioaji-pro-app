// 美股帳務 API：請求形狀、回應正規化（decimal 字串、缺值 null）、尚未開放判斷
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ hQuery: vi.fn() }));
vi.mock('./us-api', () => ({ hQuery: m.hQuery }));

import * as api from './us-account-api';

const H = { account_type: 'H', person_id: 'P', broker_id: '9A95', account_id: '0000001', signed: true, username: 'u' };

beforeEach(() => { m.hQuery.mockReset(); });

describe('requests', () => {
    it('sends the SDK shapes (currency at account level, region US, detail ids unchanged)', async () => {
        m.hQuery.mockResolvedValue({ account_type: 'H', currency: 'USD', balance: '1000', buying_power: '800' });
        await api.fetchUsBalance(H);
        expect(m.hQuery).toHaveBeenLastCalledWith('/api/v1/portfolio/account_balance', H, { currency: 'USD' });
        m.hQuery.mockResolvedValue([]);
        await api.fetchUsSettlements(H);
        expect(m.hQuery).toHaveBeenLastCalledWith('/api/v1/portfolio/settlements', H);
        await api.fetchUsProfitLoss(H, '2026-10-19', '2026-11-18');
        expect(m.hQuery).toHaveBeenLastCalledWith('/api/v1/portfolio/profit_loss', H, { begin_date: '2026-10-19', end_date: '2026-11-18', region: 'US' });
        await api.fetchUsProfitLossDetail(H, 'H|20261117|AAPL|1');
        expect(m.hQuery).toHaveBeenLastCalledWith('/api/v1/portfolio/profit_loss_detail', H, { detail_id: 'H|20261117|AAPL|1' });
        await api.fetchUsDividends(H, '2026-10-19', '2026-11-18');
        expect(m.hQuery).toHaveBeenLastCalledWith('/api/v1/portfolio/list_dividends', H, { begin_date: '2026-10-19', end_date: '2026-11-18', region: 'US' });
        await api.fetchUsPositionDetail(H, 3);
        expect(m.hQuery).toHaveBeenLastCalledWith('/api/v1/portfolio/position_detail', H, { detail_id: 3, region: 'US' });
    });
});

describe('normalization', () => {
    it('computes the held amount as balance − buying_power in decimals', () => {
        const b = api.normalizeBalance({ account_type: 'H', currency: 'USD', balance: '10000.10', buying_power: 7500.05 })!;
        expect(b).toEqual({ account_type: 'H', currency: 'USD', balance: '10000.1', buying_power: '7500.05' });
        expect(api.usHeldAmount(b)).toBe('2500.05');
        expect(api.normalizeBalance({})).toBeNull();
    });

    it('accepts the old dividend `fee` field as withholding tax', () => {
        const [oldShape] = api.normalizeDividends([{ code: 'AAPL', pay_date: '2026-11-13', record_date: '2026-11-10', quantity: '10', gross_amount: '2.6', fee: '0.78', net_amount: '1.82', currency: 'USD', settlement_currency: 'USD' }]);
        expect(oldShape!.withholding_tax).toBe('0.78');
        const [newShape] = api.normalizeDividends([{ code: 'AAPL', pay_date: '2026-11-13', record_date: '2026-11-10', quantity: '10', gross_amount: '2.6', withholding_tax: '0.78', net_amount: '1.82', currency: 'USD', settlement_currency: 'USD' }]);
        expect(newShape!.withholding_tax).toBe('0.78');
    });

    it('keeps missing market data as null, never 0', () => {
        const [d] = api.normalizePositionDetail([{ code: 'AAPL', quantity: '5', original_quantity: '10', acquired_date: '2026-11-03', acquisition_type: 'Buy', price: '220', cost: '1100', market_price: null, settlement_currency: 'USD', currency: 'USD', base_currency: 'USD' }]);
        expect(d!.market_price).toBeNull();
        expect(d!.pnl).toBeNull();
        const [p] = api.normalizeProfitLossDetail([{ acquired_date: null, quantity: '5', price: '220', cost: '1100', fee: '1.5', tax: '0', other_fees: '0.02' }]);
        expect(p!.acquired_date).toBeNull();
    });

    it('sorts settlements by settlement date and keeps the sign of net_amount', () => {
        const rows = api.normalizeSettlements([
            { trade_date: '2026-11-17', settlement_date: '2026-11-18', net_amount: '-1100.5', currency: 'USD' },
            { trade_date: '2026-11-14', settlement_date: '2026-11-17', net_amount: 512.25, currency: 'USD' },
        ]);
        expect(rows.map(r => r.net_amount)).toEqual(['512.25', '-1100.5']);
    });
});

describe('unavailable service', () => {
    it('treats 503 (gtrade not deployed) and 404 (older SDK) as not yet open', () => {
        expect(api.isUsAccountUnavailable(Object.assign(new Error('503 Service Unavailable'), { status: 503 }))).toBe(true);
        expect(api.isUsAccountUnavailable('503 Service Unavailable')).toBe(true);
        expect(api.isUsAccountUnavailable(new Error('404 Not Found'))).toBe(true);
        expect(api.isUsAccountUnavailable(new Error('502 UPSTREAM_ERROR'))).toBe(false);
        expect(api.usAccountErrorText(new Error('503 x'))).toBe('美股帳務服務尚未開放');
        expect(api.usAccountErrorText(new Error('400 INVALID_CURRENCY'))).toBe('幣別不支援');
        expect(api.usAccountErrorText(new Error('502 UPSTREAM_ERROR timeout'))).toContain('暫時無法查詢');
    });
});
