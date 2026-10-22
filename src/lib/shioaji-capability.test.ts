// capability subscriptions: a teardown that cannot reach the server must not
// leave a replay entry behind (reconnect would resubscribe with no consumer)
import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ post: vi.fn(), register: vi.fn(), unregister: vi.fn() }));
vi.mock('./api', () => ({ apiPost: m.post, apiGet: vi.fn(), apiPut: vi.fn(), apiDelete: vi.fn() }));
vi.mock('./stream', () => ({
    registerSubscription: vi.fn(),
    unregisterSubscription: vi.fn(),
    registerSubscriptionRaw: vi.fn(),
    registerCapabilitySubscription: m.register,
    unregisterCapabilitySubscription: m.unregister,
}));
import { subscribeKbars, unsubscribeKbars } from './shioaji';

const contracts = [{ code: '2330', security_type: 'STK' as const, exchange: 'TSE' as const, target_code: null }];

beforeEach(() => {
    vi.clearAllMocks();
});

it('drops the replay entry when the last unsubscribe fails', async () => {
    m.post.mockResolvedValueOnce({ success: true });
    await subscribeKbars('t1', contracts);
    expect(m.register).toHaveBeenCalledWith('kbars:t1', 'kbars', expect.anything());
    m.post.mockRejectedValueOnce(new Error('Failed to fetch'));
    await expect(unsubscribeKbars('t1', contracts)).rejects.toThrow('Failed to fetch');
    expect(m.unregister).toHaveBeenCalledWith('kbars:t1');
    // the ref is gone too: the next subscribe really posts again
    m.post.mockResolvedValueOnce({ success: true });
    await subscribeKbars('t1', contracts);
    expect(m.post).toHaveBeenCalledTimes(3);
});

it('drops the replay entry when the server rejects the unsubscribe', async () => {
    m.post.mockResolvedValueOnce({ success: true });
    await subscribeKbars('t2', contracts);
    m.post.mockResolvedValueOnce({ success: false, message: 'not connected' });
    await expect(unsubscribeKbars('t2', contracts)).rejects.toThrow('not connected');
    expect(m.unregister).toHaveBeenCalledWith('kbars:t2');
});

it('forgets the key without a request when the last release has no stock left to drop', async () => {
    m.post.mockResolvedValue({ success: true });
    await subscribeKbars('t4', contracts);
    // every stock is still fed under another key (overlapping drill batches)
    await unsubscribeKbars('t4', []);
    expect(m.post).toHaveBeenCalledTimes(1);
    expect(m.unregister).toHaveBeenCalledWith('kbars:t4');
});

it('keeps the subscription while another consumer holds it', async () => {
    m.post.mockResolvedValue({ success: true });
    await subscribeKbars('t3', contracts);
    await subscribeKbars('t3', contracts);
    await unsubscribeKbars('t3', contracts);
    expect(m.unregister).not.toHaveBeenCalled();
    expect(m.post).toHaveBeenCalledTimes(1);
});
