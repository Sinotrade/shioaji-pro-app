import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    fetch: vi.fn(), version: 0, listeners: new Set<() => void>(),
}));
vi.mock('./shioaji', () => ({
    fetchContracts: mocks.fetch,
    fetchContractInfo: vi.fn(), fetchWarrantUnderlyings: vi.fn(),
    normalizeContractCode: (code: string) => code,
}));
vi.mock('./product-catalog-version', () => ({
    getProductCatalogVersion: () => mocks.version,
    subscribeProductCatalog: (listener: () => void) => {
        mocks.listeners.add(listener);
        return () => mocks.listeners.delete(listener);
    },
}));

const base = (code = 'IX0043', exchange = 'OTC', region = 'TW', security_type = 'IND') =>
    ({ code, exchange, region, security_type, target_code: null });
const result = (...contracts: ReturnType<typeof base>[]) => ({ contracts, total: contracts.length, region: 'TW', security_type: 'IND' });

function invalidate() {
    mocks.version++;
    for (const listener of mocks.listeners) listener();
}

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    mocks.version = 0;
    mocks.listeners.clear();
    mocks.fetch.mockReset().mockResolvedValue(result(base()));
});
afterEach(() => { vi.useRealTimers(); });

describe('指數名稱的動態 Base 身分檢查', () => {
    it('沒有本機名稱候選時不讀取目錄，保留上層直接代碼通路', async () => {
        const { loadIndexSuggestions } = await import('./index-catalog');
        expect(await loadIndexSuggestions('NEWINDEX')).toEqual([]);
        expect(await loadIndexSuggestions('不存在的名稱')).toEqual([]);
        expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('必須同 region、security_type、exchange 與 code 才回傳中文名稱', async () => {
        const { loadIndexSuggestions } = await import('./index-catalog');
        mocks.fetch.mockResolvedValue(result(
            base('IX0043', 'TSE'), base('IX0043', 'OTC', 'US'),
            base('IX0043', 'OTC', 'TW', 'STK'), base('IX0053', 'OTC'),
        ));
        expect(await loadIndexSuggestions('櫃買')).toEqual([
            expect.objectContaining({ code: 'IX0053', name: '櫃買半導體類指數', security_type: 'IND', exchange: 'OTC' }),
        ]);
        expect(mocks.fetch).toHaveBeenCalledWith('IND', undefined, undefined, { signal: expect.any(AbortSignal) });
    });

    it('成功的空目錄不回傳已失效的靜態名稱', async () => {
        mocks.fetch.mockResolvedValue(result());
        const { loadIndexSuggestions } = await import('./index-catalog');
        expect(await loadIndexSuggestions('櫃買')).toEqual([]);
    });

    it('Base 省略 optional region 時採批次 envelope，明確外國身分仍排除', async () => {
        const { loadIndexSuggestions } = await import('./index-catalog');
        mocks.fetch.mockResolvedValue({ ...result(), contracts: [{ ...base(), region: undefined }] });
        expect(await loadIndexSuggestions('櫃買')).toHaveLength(1);
        invalidate();
        mocks.fetch.mockResolvedValue({ ...result(), region: 'US', contracts: [{ ...base(), region: undefined }] });
        expect(await loadIndexSuggestions('櫃買')).toEqual([]);
    });

    it('不同 query 共用成功來源 60 秒，期限到才重讀', async () => {
        const { loadIndexSuggestions } = await import('./index-catalog');
        await loadIndexSuggestions('櫃買');
        await vi.advanceTimersByTimeAsync(59_999);
        await loadIndexSuggestions('半導體');
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await loadIndexSuggestions('櫃買');
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
    });

    it('同來源合併請求，取消一個 reader 不取消其他 reader', async () => {
        let complete!: (value: ReturnType<typeof result>) => void;
        mocks.fetch.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
        const { loadIndexSuggestions } = await import('./index-catalog');
        const controller = new AbortController();
        const first = loadIndexSuggestions('櫃買', { signal: controller.signal });
        const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
        const second = loadIndexSuggestions('IX0043');
        controller.abort();
        await rejected;
        expect(mocks.fetch.mock.calls[0]![3].signal.aborted).toBe(false);
        complete(result(base()));
        expect(await second).toHaveLength(1);
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
    });

    it('最後一個 reader 取消會中止來源，已取消的 reader 不發請求', async () => {
        mocks.fetch.mockImplementation(() => new Promise(() => undefined));
        const { loadIndexSuggestions } = await import('./index-catalog');
        const controller = new AbortController();
        const request = loadIndexSuggestions('櫃買', { signal: controller.signal });
        const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
        controller.abort();
        await rejected;
        expect(mocks.fetch.mock.calls[0]![3].signal.aborted).toBe(true);
        await expect(loadIndexSuggestions('櫃買', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
    });

    it('來源超過 1200 ms reject，且不快取失敗', async () => {
        mocks.fetch.mockImplementationOnce(() => new Promise(() => undefined));
        const { loadIndexSuggestions } = await import('./index-catalog');
        const request = loadIndexSuggestions('櫃買');
        const rejected = expect(request).rejects.toThrow('逾時');
        await vi.advanceTimersByTimeAsync(1200);
        await rejected;
        expect(mocks.fetch.mock.calls[0]![3].signal.aborted).toBe(true);
        expect(await loadIndexSuggestions('櫃買')).toHaveLength(1);
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
    });

    it('來源失敗 reject 而非成功空結果，下次可重試', async () => {
        mocks.fetch.mockRejectedValueOnce(new Error('離線'));
        const { loadIndexSuggestions } = await import('./index-catalog');
        await expect(loadIndexSuggestions('櫃買')).rejects.toThrow('離線');
        expect(await loadIndexSuggestions('櫃買')).toHaveLength(1);
    });

    it('新版本立即清除成功快取', async () => {
        const { loadIndexSuggestions } = await import('./index-catalog');
        expect(await loadIndexSuggestions('櫃買')).toHaveLength(1);
        invalidate();
        mocks.fetch.mockResolvedValue(result());
        expect(await loadIndexSuggestions('櫃買')).toEqual([]);
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
    });

    it('A→B→A 舊請求不可覆蓋新結果，忽略 abort 的來源也不例外', async () => {
        let completeOld!: (value: ReturnType<typeof result>) => void;
        mocks.fetch.mockImplementationOnce(() => new Promise(resolve => { completeOld = resolve; }));
        const { loadIndexSuggestions } = await import('./index-catalog');
        const old = loadIndexSuggestions('櫃買');
        const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
        invalidate();
        invalidate();
        await rejected;
        mocks.fetch.mockResolvedValue(result());
        expect(await loadIndexSuggestions('櫃買')).toEqual([]);
        completeOld(result(base()));
        await Promise.resolve();
        expect(await loadIndexSuggestions('櫃買')).toEqual([]);
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
    });

    it('讀取期間 getter 發現新版本也會拒絕舊結果', async () => {
        let complete!: (value: ReturnType<typeof result>) => void;
        mocks.fetch.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
        const { loadIndexSuggestions } = await import('./index-catalog');
        const request = loadIndexSuggestions('櫃買');
        mocks.version++;
        complete(result(base()));
        await expect(request).rejects.toThrow('商品目錄已更新');
    });

    it('搜尋佇列滿載時跨面板指數來源仍立即開始', async () => {
        const { SearchRequestCache } = await import('./search-request');
        const occupied = new SearchRequestCache({ ttlMs: 0, limit: 1, deadlineMs: 2000 });
        const pending = Array.from({ length: 4 }, (_, index) => occupied.read(String(index), () => new Promise(() => undefined)).catch(() => undefined));
        const { loadIndexSuggestions } = await import('./index-catalog');
        expect(await loadIndexSuggestions('櫃買')).toHaveLength(1);
        expect(mocks.fetch).toHaveBeenCalledOnce();
        occupied.clear();
        await Promise.all(pending);
    });
});
