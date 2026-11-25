// #409：SDK 1.8.0 起權證在委託成交查詢標 WRT，前提是 sidecar 已載入權證合約表 —
// 每個 sidecar 第一次查證券帳戶委託成交前先載一次（contracts v2 沒有 preload 端點，
// 查一筆權證清單就會載入整張表）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    get: vi.fn(), post: vi.fn(), base: 'http://127.0.0.1:21393', info: { version: '1.8.0' } as unknown,
    listeners: new Set<() => void>(),
}));
vi.mock('./api', async (orig) => ({ ...(await orig<object>()), apiGet: m.get, apiPost: m.post }));
vi.mock('./runtime', async (orig) => ({ ...(await orig<object>()), getApiBase: () => m.base }));
vi.mock('./server-info-store', async (orig) => ({
    ...(await orig<object>()),
    knownServerInfo: () => m.info,
    subscribeServerInfo: (l: () => void) => { m.listeners.add(l); return () => m.listeners.delete(l); },
}));
vi.mock('./account-query', () => ({
    createAccountQuery: () => ({
        assertCurrent: () => {},
        read: (_t: string, sel: { broker_id: string; account_id: string } | undefined, fn: (a: unknown) => Promise<unknown>) =>
            fn({ broker_id: sel?.broker_id ?? 'b', account_id: sel?.account_id ?? 'a' }),
    }),
}));

import { ensureWarrantContracts, resetWarrantPreloadForTest, WARRANT_PRELOAD_PATH, WARRANT_PRELOAD_WAIT_MS, warrantContractsReady } from './warrant-preload';
import { fetchTrades } from './shioaji';

beforeEach(() => {
    m.get.mockReset().mockResolvedValue({ contracts: [], total: 54340 });
    m.post.mockReset().mockResolvedValue([]);
    m.base = 'http://127.0.0.1:21393';
    m.info = { version: '1.8.0' };
});
afterEach(() => { resetWarrantPreloadForTest(); vi.useRealTimers(); });

describe('warrant contract preload', () => {
    it('loads once per sidecar with a one-row WRT list query', async () => {
        await Promise.all([ensureWarrantContracts(), ensureWarrantContracts()]);
        await ensureWarrantContracts();
        expect(m.get).toHaveBeenCalledTimes(1);
        expect(m.get.mock.calls[0]![0]).toBe(WARRANT_PRELOAD_PATH);
        expect(WARRANT_PRELOAD_PATH).toContain('security_type=WRT');
        expect(warrantContractsReady()).toBe(true);
        m.base = 'http://127.0.0.1:21391';
        expect(warrantContractsReady()).toBe(false);
        await ensureWarrantContracts();
        expect(m.get).toHaveBeenCalledTimes(2);
    });
    it('reloads after the sidecar goes away (info cleared)', async () => {
        await ensureWarrantContracts();
        m.info = undefined;
        m.listeners.forEach(l => l());
        m.info = { version: '1.8.0' };
        expect(warrantContractsReady()).toBe(false);
        await ensureWarrantContracts();
        expect(m.get).toHaveBeenCalledTimes(2);
    });
    it('never blocks on failure and retries next time', async () => {
        m.get.mockRejectedValueOnce(new Error('500'));
        await expect(ensureWarrantContracts()).resolves.toBeUndefined();
        expect(warrantContractsReady()).toBe(false);
        await ensureWarrantContracts();
        expect(m.get).toHaveBeenCalledTimes(2);
        expect(warrantContractsReady()).toBe(true);
    });
    it('stops waiting after the cap while the load continues', async () => {
        vi.useFakeTimers();
        m.get.mockReturnValueOnce(new Promise(() => {}));
        const p = ensureWarrantContracts();
        await vi.advanceTimersByTimeAsync(WARRANT_PRELOAD_WAIT_MS);
        await expect(p).resolves.toBeUndefined();
    });
});

describe('fetchTrades waits for the warrant table on securities accounts', () => {
    it('S: preload GET before the first /order/trades, then dispatches directly', async () => {
        const order: string[] = [];
        m.get.mockImplementation(async () => { order.push('preload'); return {}; });
        m.post.mockImplementation(async (path: string) => { order.push(path); return []; });
        await fetchTrades('S', { broker_id: 'b', account_id: 'a' }, { refresh: true });
        await fetchTrades('S', { broker_id: 'b', account_id: 'a' }, { refresh: true });
        expect(order).toEqual(['preload', '/api/v1/order/trades', '/api/v1/order/trades']);
    });
    it('F and H accounts do not preload warrants', async () => {
        await fetchTrades('F', { broker_id: 'b', account_id: 'f' });
        await fetchTrades('H', { broker_id: 'b', account_id: 'h' });
        expect(m.get).not.toHaveBeenCalled();
        expect(m.post).toHaveBeenCalledTimes(2);
    });
    it('a failed preload still runs the trades query', async () => {
        m.get.mockRejectedValueOnce(new Error('404'));
        await expect(fetchTrades('S', { broker_id: 'b', account_id: 'a' })).resolves.toEqual([]);
        expect(m.post).toHaveBeenCalledWith('/api/v1/order/trades', expect.objectContaining({ account_type: 'S' }), expect.anything());
    });
});
