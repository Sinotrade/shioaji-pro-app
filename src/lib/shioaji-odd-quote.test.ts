// #204 盤中零股行情訂閱：intraday_odd 送到 server，並以獨立 key 登記重播
import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ post: vi.fn(), register: vi.fn(), unregister: vi.fn() }));
vi.mock('./api', () => ({ apiPost: m.post, apiGet: vi.fn(), apiPut: vi.fn(), apiDelete: vi.fn() }));
vi.mock('./stream', () => ({ registerSubscription: m.register, unregisterSubscription: m.unregister,
    registerSubscriptionRaw: vi.fn(), registerCapabilitySubscription: vi.fn(), unregisterCapabilitySubscription: vi.fn() }));
import { subscribeQuote, unsubscribeQuote } from './shioaji';

const contract = { code: '2330', security_type: 'STK' as const, exchange: 'TSE' as const, target_code: null };
beforeEach(() => { vi.clearAllMocks(); m.post.mockResolvedValue({ success: true }); });

it('subscribes and unsubscribes the odd-lot feed with intraday_odd and its own registry entry', async () => {
    await subscribeQuote(contract, 'BidAsk', { oddLot: true });
    expect(m.post.mock.calls[0]![0]).toBe('/api/v1/stream/subscribe');
    expect(m.post.mock.calls[0]![1]).toMatchObject({ code: '2330', quote_type: 'BidAsk', intraday_odd: true });
    expect(m.register.mock.calls[0]![0]).toMatchObject({ intraday_odd: true });
    await unsubscribeQuote(contract, 'BidAsk', { oddLot: true });
    expect(m.post.mock.calls[1]![1]).toMatchObject({ quote_type: 'BidAsk', intraday_odd: true });
    expect(m.unregister).toHaveBeenCalledWith('2330', 'BidAsk', true);
});

it('keeps regular-lot subscriptions at intraday_odd false', async () => {
    await subscribeQuote(contract, 'Tick');
    await unsubscribeQuote(contract, 'Tick');
    expect(m.post.mock.calls.map(c => (c[1] as { intraday_odd: boolean }).intraday_odd)).toEqual([false, false]);
    expect(m.unregister).toHaveBeenCalledWith('2330', 'Tick', false);
});
