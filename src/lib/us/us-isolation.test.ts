// 美股回報不得進台股委託／持倉投影；台股下單路徑拒收美股合約
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fx from './__fixtures__/intl-order-events.json';
import { normalizeOrderEvent } from '../order-report';
import { projectOrderReport, projectTradeDeal } from '../order-projection';
import { positionFill } from '../portfolio-projection';
import type { Account } from '../types/portfolio';

const H: Account = { account_type: 'H', person_id: 'P', broker_id: '9A95', account_id: '0000001', signed: true, username: 'u' };

describe('Taiwan projections ignore US reports', () => {
    it('never projects IntlOrder / IntlDeal into Taiwan rows', () => {
        expect(projectOrderReport([], normalizeOrderEvent(fx.orderNew)!, [H])).toBeNull();
        expect(projectTradeDeal([], normalizeOrderEvent(fx.deal)!)).toBeNull();
        expect(positionFill(normalizeOrderEvent(fx.deal)!, [H], [])).toBeNull();
    });
});

const m = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('../api', () => ({ apiPost: m.post, apiGet: vi.fn(), apiPut: vi.fn(), apiDelete: vi.fn(), shouldProxyAgentHarnessMutation: () => false }));

describe('Taiwan order and quote paths refuse US contracts', () => {
    beforeEach(() => m.post.mockReset());
    const aapl = { code: 'AAPL', security_type: 'STK' as const, exchange: null, region: 'US' as const, target_code: null };

    it('placeStockOrder / placeFuturesOrder reject before any request', async () => {
        const { placeStockOrder, placeFuturesOrder } = await import('../shioaji');
        await expect(placeStockOrder(aapl, { action: 'Buy', price: 1, quantity: 1, price_type: 'LMT', order_type: 'ROD', custom_field: 'grid' }))
            .rejects.toMatchObject({ mutationNotStarted: true });
        await expect(placeFuturesOrder(aapl, { action: 'Buy', price: 1, quantity: 1, price_type: 'LMT', order_type: 'ROD' }))
            .rejects.toMatchObject({ mutationNotStarted: true });
        expect(m.post).not.toHaveBeenCalled();
    });

    it('does not snapshot or fetch K bars for US; quotes go through the US subscribe body', async () => {
        const { subscribeQuote, fetchSnapshots, fetchKbars } = await import('../shioaji');
        await expect(subscribeQuote(aapl, 'Quote')).rejects.toThrow('美股');
        await expect(subscribeQuote(aapl, 'Tick', { oddLot: true })).rejects.toThrow('美股');
        await expect(fetchSnapshots([aapl])).rejects.toThrow('美股');
        await expect(fetchKbars(aapl, '2026-11-01', '2026-11-18')).rejects.toThrow('美股');
        expect(m.post).not.toHaveBeenCalled();
        m.post.mockResolvedValue({ success: true, message: '' });
        await subscribeQuote({ ...aapl, exchange: 'NASDAQ' }, 'Tick');
        expect(m.post).toHaveBeenCalledWith('/api/v1/stream/subscribe', { security_type: 'STK', exchange: 'NASDAQ', code: 'AAPL', quote_type: 'Tick' });
    });
});
