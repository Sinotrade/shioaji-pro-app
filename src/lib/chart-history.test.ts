import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), base: 'fixture' }));
vi.mock('./runtime', () => ({ getApiBase: () => mocks.base }));
vi.mock('./shioaji', () => ({ fetchKbars: mocks.fetch }));
const contract = { code: '2330', exchange: 'TSE', security_type: 'STK', target_code: null } as const;
beforeEach(() => { vi.resetModules(); mocks.fetch.mockReset().mockResolvedValue({ Close: [100] }); mocks.base = 'fixture'; });
describe('chart history request sharing', () => {
    it('shares concurrent and completed requests across presentation rebuilds', async () => {
        const { fetchChartHistory } = await import('./chart-history');
        const a = fetchChartHistory(contract, '2026-09-01', '2026-09-12');
        const b = fetchChartHistory({ ...contract }, '2026-09-01', '2026-09-12', { timeoutMs: 5000 });
        expect(a).toBe(b); await a;
        await fetchChartHistory({ ...contract }, '2026-09-01', '2026-09-12');
        expect(mocks.fetch).toHaveBeenCalledOnce();
    });
    it('gives separate panels fresh revisions instead of reusing local counter 1', async () => {
        const { fetchChartHistory, nextChartHistoryRevision } = await import('./chart-history');
        const first = nextChartHistoryRevision();
        await fetchChartHistory(contract, '2026-09-01', '2026-09-12', { revision: first });
        const second = nextChartHistoryRevision();
        await fetchChartHistory(contract, '2026-09-01', '2026-09-12', { revision: second });
        expect(first).not.toBe(second);
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
        await fetchChartHistory(contract, '2026-09-01', '2026-09-12', { revision: second });
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
    });
    it('caches failures but allows an explicit manual revision, date or server change', async () => {
        const { fetchChartHistory } = await import('./chart-history');
        mocks.fetch.mockRejectedValueOnce(new Error('offline'));
        await expect(fetchChartHistory(contract, '2026-09-01', '2026-09-12')).rejects.toThrow('offline');
        await expect(fetchChartHistory(contract, '2026-09-01', '2026-09-12')).rejects.toThrow('offline');
        expect(mocks.fetch).toHaveBeenCalledOnce();
        await fetchChartHistory(contract, '2026-09-01', '2026-09-12', { revision: 1 });
        await fetchChartHistory(contract, '2026-09-01', '2026-09-13');
        mocks.base = 'other'; await fetchChartHistory(contract, '2026-09-01', '2026-09-13');
        expect(mocks.fetch).toHaveBeenCalledTimes(4);
    });
    it('refetches a range that reaches today after the live TTL, keeps past ranges forever', async () => {
        const { fetchChartHistory, LIVE_HISTORY_TTL_MS } = await import('./chart-history');
        const now = Date.parse('2026-11-19T15:00:00Z');
        // A → B → A 二十分鐘後：當日範圍要重抓，否則中間的成交變缺口
        await fetchChartHistory(contract, '2026-11-15', '2026-11-20', undefined, now);
        await fetchChartHistory(contract, '2026-11-15', '2026-11-20', undefined, now + LIVE_HISTORY_TTL_MS - 1);
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
        await fetchChartHistory(contract, '2026-11-15', '2026-11-20', undefined, now + 20 * 60_000);
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
        // 純過去的範圍不會再變
        await fetchChartHistory(contract, '2026-09-01', '2026-09-12', undefined, now);
        await fetchChartHistory(contract, '2026-09-01', '2026-09-12', undefined, now + 24 * 3600_000);
        expect(mocks.fetch).toHaveBeenCalledTimes(3);
    });
});
