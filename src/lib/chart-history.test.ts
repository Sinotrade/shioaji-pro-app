import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), base: 'fixture' }));
vi.mock('./runtime', () => ({ getApiBase: () => mocks.base }));
vi.mock('./shioaji', () => ({ fetchKbars: mocks.fetch }));
const contract = { code: '2330', exchange: 'TSE', security_type: 'STK', target_code: null } as const;
beforeEach(() => { vi.resetModules(); mocks.fetch.mockReset().mockResolvedValue({
    datetime: ['2026-09-12T09:01:00'], Open: [100], High: [100], Low: [100], Close: [100], Volume: [1], Amount: [0],
}); mocks.base = 'fixture'; });
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

    it('rehydrates an evicted background from the same completed request without redownload', async () => {
        const { fetchChartHistory } = await import('./chart-history');
        const { researchBackgroundKey, researchBackgroundStore } = await import('./research-background');
        const a = fetchChartHistory(contract, '2026-09-01', '2026-09-12');
        await a;
        const key = researchBackgroundKey(contract);
        for (let i = 0; i < 24; i++) await fetchChartHistory({ ...contract, code: `stock-${i}` }, '2026-09-01', '2026-09-12');
        expect(researchBackgroundStore.get(key).minutes).toHaveLength(0);
        const b = fetchChartHistory(contract, '2026-09-01', '2026-09-12');
        expect(b).toBe(a); await b;
        expect(mocks.fetch).toHaveBeenCalledTimes(25);
        expect(researchBackgroundStore.get(key).minutes).toHaveLength(1);
        const live = { ...researchBackgroundStore.get(key).minutes[0]!, close: 103, high: 103, volume: 8 };
        researchBackgroundStore.mergeMinutes(key, [live]);
        await fetchChartHistory(contract, '2026-09-01', '2026-09-12');
        expect(researchBackgroundStore.get(key).minutes[0]).toEqual(live);
    });
});
