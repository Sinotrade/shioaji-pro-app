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
});
