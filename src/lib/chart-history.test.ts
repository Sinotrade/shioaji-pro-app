import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), us: vi.fn(), base: 'fixture' }));
vi.mock('./runtime', () => ({ getApiBase: () => mocks.base }));
vi.mock('./shioaji', () => ({ fetchKbars: mocks.fetch }));
const contract = { code: '2330', exchange: 'TSE', security_type: 'STK', target_code: null } as const;
beforeEach(() => { vi.resetModules(); mocks.fetch.mockReset().mockResolvedValue({ datetime: ['2026-09-01 09:01:00'], Close: [100] }); mocks.base = 'fixture'; });
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
    it('keeps failures and empty results for today cached past the live TTL (ADR 0002)', async () => {
        const { fetchChartHistory, LIVE_HISTORY_TTL_MS } = await import('./chart-history');
        const now = Date.parse('2026-11-19T15:00:00Z');
        const later = now + LIVE_HISTORY_TTL_MS + 20 * 60_000;
        // 403：重建不重打
        mocks.fetch.mockRejectedValueOnce(new Error('403'));
        await expect(fetchChartHistory(contract, '2026-11-15', '2026-11-20', undefined, now)).rejects.toThrow('403');
        await expect(fetchChartHistory(contract, '2026-11-15', '2026-11-20', undefined, later)).rejects.toThrow('403');
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
        // 空結果：同樣沿用
        mocks.fetch.mockResolvedValueOnce({ datetime: [], Close: [] });
        await fetchChartHistory(contract, '2026-11-16', '2026-11-20', undefined, now);
        await fetchChartHistory(contract, '2026-11-16', '2026-11-20', undefined, later);
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
    });
    it('treats only ranges reaching the market\'s own today as live', async () => {
        const { fetchChartHistory, LIVE_HISTORY_TTL_MS } = await import('./chart-history');
        const now = Date.parse('2026-11-19T15:00:00Z'); // 台北 11-19 23:00
        const later = now + LIVE_HISTORY_TTL_MS + 60_000;
        // 兩天前結束的範圍不會再長：不重抓
        await fetchChartHistory(contract, '2026-11-10', '2026-11-17', undefined, now);
        await fetchChartHistory(contract, '2026-11-10', '2026-11-17', undefined, later);
        // 昨天結束的也一樣
        await fetchChartHistory(contract, '2026-11-11', '2026-11-18', undefined, now);
        await fetchChartHistory(contract, '2026-11-11', '2026-11-18', undefined, later);
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
        // 台北已經 11-20 00:30：結束日 11-19 的範圍不再算當日
        const tpeNextDay = Date.parse('2026-11-19T16:30:00Z');
        await fetchChartHistory(contract, '2026-11-12', '2026-11-19', undefined, tpeNextDay);
        await fetchChartHistory(contract, '2026-11-12', '2026-11-19', undefined, tpeNextDay + LIVE_HISTORY_TTL_MS + 1);
        expect(mocks.fetch).toHaveBeenCalledTimes(3);
        // 含今天的照 TTL 重抓
        await fetchChartHistory(contract, '2026-11-13', '2026-11-20', undefined, tpeNextDay);
        await fetchChartHistory(contract, '2026-11-13', '2026-11-20', undefined, tpeNextDay + LIVE_HISTORY_TTL_MS + 1);
        expect(mocks.fetch).toHaveBeenCalledTimes(5);
    });
    it('keys US extended-hours history separately and passes the flag through', async () => {
        vi.doMock('./us/us-history', () => ({ fetchUsKbars: mocks.us }));
        const { fetchChartHistory } = await import('./chart-history');
        const us = { code: 'AAPL', exchange: 'NASDAQ', security_type: 'STK', region: 'US', target_code: null } as never;
        const bars = Object.assign([{ time: Date.UTC(2026, 10, 24, 4, 1) / 1000, open: 1, high: 1, low: 1, close: 1, volume: 1 }], { extendedHistory: true });
        mocks.us.mockResolvedValue(bars);
        const ext = await fetchChartHistory(us, '2026-11-20', '2026-11-24', { usExtended: true });
        expect(mocks.us).toHaveBeenLastCalledWith(us, '2026-11-20', '2026-11-24', { timeoutMs: undefined, extended: true });
        expect(ext.usExtendedHistory).toBe(true);
        expect(ext.datetime).toEqual(['2026-11-24T04:01:00']);
        mocks.us.mockResolvedValue([]);
        const reg = await fetchChartHistory(us, '2026-11-20', '2026-11-24');
        expect(mocks.us).toHaveBeenCalledTimes(2);
        expect(mocks.us).toHaveBeenLastCalledWith(us, '2026-11-20', '2026-11-24', { timeoutMs: undefined, extended: false });
        expect(reg.usExtendedHistory).toBeUndefined();
        // 台股忽略 usExtended（同一個快取鍵）
        await fetchChartHistory(contract, '2026-09-01', '2026-09-12');
        await fetchChartHistory(contract, '2026-09-01', '2026-09-12', { usExtended: true });
        expect(mocks.fetch).toHaveBeenCalledOnce();
        vi.doUnmock('./us/us-history');
    });
});
