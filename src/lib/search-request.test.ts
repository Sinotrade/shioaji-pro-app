import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchRequestCache } from './search-request';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure; });
    return { promise, resolve, reject };
}

// Attach failure handling immediately, including requests deliberately left pending.
function outcome<T>(promise: Promise<T>) {
    return promise.then(value => ({ value }), error => ({ error: error as Error }));
}

const cleanups: Array<() => void> = [];
function cache<T = string>(options: Partial<{ ttlMs: number; limit: number; deadlineMs: number }> = {}) {
    const result = new SearchRequestCache<T>({ ttlMs: 1000, limit: 16, deadlineMs: 1200, ...options });
    cleanups.push(() => result.clear());
    return result;
}
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T00:00:00+08:00'));
});
afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
});

describe('SearchRequestCache 共享與結果快取', () => {
    it('同 key pending 僅呼叫一個來源，回傳同一份完整物件', async () => {
        const requests = cache<{ code: string; target_code: string }>();
        const source = deferred<{ code: string; target_code: string }>();
        const load = vi.fn(() => source.promise);
        const first = requests.read('CDFR1', load);
        const second = requests.read('CDFR1', load);
        const value = { code: 'CDFR1', target_code: 'CDFJ6' };
        expect(load).toHaveBeenCalledTimes(1);
        source.resolve(value);
        expect(await first).toBe(value);
        expect(await second).toBe(value);
        expect(await requests.read('CDFR1', load)).toBe(value);
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('ttlMs=0 僅共用 pending，完成後立即可重新請求', async () => {
        const requests = cache({ ttlMs: 0 });
        const source = deferred<string>();
        const load = vi.fn().mockReturnValueOnce(source.promise).mockResolvedValue('fresh');
        const first = requests.read('same', load);
        const second = requests.read('same', load);
        source.resolve('shared');
        expect(await Promise.all([first, second])).toEqual(['shared', 'shared']);
        expect(await requests.read('same', load)).toBe('fresh');
        expect(load).toHaveBeenCalledTimes(2);
    });

    it('TTL 從成功完成起算，期限邊界會重新載入', async () => {
        const requests = cache({ ttlMs: 100 });
        const source = deferred<string>();
        const load = vi.fn().mockReturnValueOnce(source.promise).mockResolvedValue('fresh');
        const pending = requests.read('same', load);
        await vi.advanceTimersByTimeAsync(50);
        source.resolve('first');
        await pending;
        await vi.advanceTimersByTimeAsync(99);
        expect(await requests.read('same', load)).toBe('first');
        await vi.advanceTimersByTimeAsync(1);
        expect(await requests.read('same', load)).toBe('fresh');
        expect(load).toHaveBeenCalledTimes(2);
    });

    it('成功結果遵循 LRU 上限，讀取會更新最近使用順序', async () => {
        const requests = cache({ limit: 2 });
        const loadA = vi.fn().mockResolvedValue('A');
        const loadB = vi.fn().mockResolvedValue('B');
        await requests.read('A', loadA);
        await requests.read('B', loadB);
        await requests.read('A', loadA);
        await requests.read('C', () => Promise.resolve('C'));
        expect(await requests.read('A', loadA)).toBe('A');
        expect(loadA).toHaveBeenCalledTimes(1);
        await requests.read('B', loadB);
        expect(loadB).toHaveBeenCalledTimes(2);
    });

    it('失敗與同步 throw 不快取，也不逐出成功結果', async () => {
        const requests = cache({ limit: 1 });
        const stable = vi.fn().mockResolvedValue('stable');
        await requests.read('stable', stable);
        const load = vi.fn<() => Promise<string>>()
            .mockRejectedValueOnce(new Error('temporary'))
            .mockImplementationOnce(() => { throw new Error('sync'); })
            .mockResolvedValueOnce('recovered');
        await expect(requests.read('retry', load)).rejects.toThrow('temporary');
        await expect(requests.read('retry', load)).rejects.toThrow('sync');
        await requests.read('stable', stable);
        expect(stable).toHaveBeenCalledTimes(1);
        expect(await requests.read('retry', load)).toBe('recovered');
        expect(load).toHaveBeenCalledTimes(3);
    });

    it('pending 可超過成功 LRU 上限，不取消仍有人等待的有效查詢', async () => {
        const requests = cache({ limit: 1 });
        const sources = [deferred<string>(), deferred<string>(), deferred<string>()];
        const signals: AbortSignal[] = [];
        const pending = sources.map((source, index) => requests.read(String(index), signal => {
            signals.push(signal);
            return source.promise;
        }));
        expect(signals).toHaveLength(3);
        expect(signals.every(signal => !signal.aborted)).toBe(true);
        sources.forEach((source, index) => source.resolve(String(index)));
        expect(await Promise.all(pending)).toEqual(['0', '1', '2']);
    });
});

describe('SearchRequestCache reader 取消隔離', () => {
    it('已取消 signal 不啟動請求，連成功快取也不回傳', async () => {
        const requests = cache();
        const controller = new AbortController();
        controller.abort();
        const load = vi.fn().mockResolvedValue('value');
        await expect(requests.read('first', load, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
        expect(load).not.toHaveBeenCalled();
        await requests.read('cached', load);
        await expect(requests.read('cached', load, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('兩個搜尋入口共用同 key，取消一方不影響另一方與來源', async () => {
        const requests = cache();
        const source = deferred<string>();
        let sourceSignal!: AbortSignal;
        const load = vi.fn((signal: AbortSignal) => { sourceSignal = signal; return source.promise; });
        const palette = new AbortController();
        const watchlist = new AbortController();
        const first = outcome(requests.read('2330', load, palette.signal));
        const second = requests.read('2330', load, watchlist.signal);
        palette.abort();
        expect(sourceSignal.aborted).toBe(false);
        expect(await first).toMatchObject({ error: { name: 'AbortError' } });
        source.resolve('shared');
        expect(await second).toBe('shared');
        watchlist.abort();
        expect(sourceSignal.aborted).toBe(false);
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('最後 reader 取消會同步 abort 並逐出，舊成功不能填入同 key 新快取', async () => {
        const requests = cache();
        const old = deferred<string>();
        const current = deferred<string>();
        let oldSignal!: AbortSignal;
        const controller = new AbortController();
        const first = outcome(requests.read('same', signal => { oldSignal = signal; return old.promise; }, controller.signal));
        controller.abort();
        expect(oldSignal.aborted).toBe(true);
        const load = vi.fn(() => current.promise);
        const retry = requests.read('same', load);
        expect(load).toHaveBeenCalledTimes(1);
        old.resolve('stale');
        await flush();
        const sharedRetry = requests.read('same', load);
        expect(load).toHaveBeenCalledTimes(1);
        current.resolve('fresh');
        expect(await Promise.all([retry, sharedRetry])).toEqual(['fresh', 'fresh']);
        expect(await requests.read('same', load)).toBe('fresh');
        expect(await first).toMatchObject({ error: { name: 'AbortError' } });
    });

    it('舊來源晚失敗不能刪除同 key 的新 pending', async () => {
        const requests = cache();
        const old = deferred<string>();
        const current = deferred<string>();
        const controller = new AbortController();
        const first = outcome(requests.read('same', () => old.promise, controller.signal));
        controller.abort();
        const load = vi.fn(() => current.promise);
        const retry = requests.read('same', load);
        old.reject(new Error('late failure'));
        await flush();
        const shared = requests.read('same', load);
        current.resolve('fresh');
        expect(await Promise.all([retry, shared])).toEqual(['fresh', 'fresh']);
        expect(load).toHaveBeenCalledTimes(1);
        expect(await first).toMatchObject({ error: { name: 'AbortError' } });
    });
});

describe('SearchRequestCache deadline 與 clear', () => {
    it('逾時拒絕全部 reader、abort 來源，忽略 signal 的晚回不快取並可重試', async () => {
        const requests = cache({ deadlineMs: 100 });
        const old = deferred<string>();
        let sourceSignal!: AbortSignal;
        const first = outcome(requests.read('same', signal => { sourceSignal = signal; return old.promise; }));
        const second = outcome(requests.read('same', () => old.promise));
        await vi.advanceTimersByTimeAsync(100);
        expect(sourceSignal.aborted).toBe(true);
        expect(await first).toMatchObject({ error: { message: expect.stringContaining('逾時') } });
        expect(await second).toMatchObject({ error: { message: expect.stringContaining('逾時') } });
        old.resolve('late');
        await flush();
        const load = vi.fn().mockResolvedValue('retry');
        expect(await requests.read('same', load)).toBe('retry');
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('後加入的 reader 共用原 deadline，不延長卡住來源的等待時間', async () => {
        const requests = cache({ deadlineMs: 100 });
        const source = deferred<string>();
        const first = outcome(requests.read('same', () => source.promise));
        await vi.advanceTimersByTimeAsync(90);
        const second = outcome(requests.read('same', () => source.promise));
        await vi.advanceTimersByTimeAsync(10);
        expect(await first).toMatchObject({ error: { message: expect.stringContaining('逾時') } });
        expect(await second).toMatchObject({ error: { message: expect.stringContaining('逾時') } });
    });

    it('deadline 已過而 timer 尚未執行時，來源晚成功仍視為逾時', async () => {
        const requests = cache({ deadlineMs: 100 });
        const source = deferred<string>();
        const pending = outcome(requests.read('same', () => source.promise));
        vi.setSystemTime(Date.now() + 101);
        source.resolve('late');
        expect(await pending).toMatchObject({ error: { message: expect.stringContaining('逾時') } });
        expect(await requests.read('same', () => Promise.resolve('fresh'))).toBe('fresh');
    });

    it('clear 拒絕所有 pending、abort 來源、移除成功快取，且晚回不能覆寫新值', async () => {
        const requests = cache();
        const stable = vi.fn().mockResolvedValue('stable');
        await requests.read('cached', stable);
        const old = deferred<string>();
        let sourceSignal!: AbortSignal;
        const first = outcome(requests.read('same', signal => { sourceSignal = signal; return old.promise; }));
        const second = outcome(requests.read('same', () => old.promise));
        requests.clear();
        expect(sourceSignal.aborted).toBe(true);
        expect(await first).toMatchObject({ error: { name: 'AbortError' } });
        expect(await second).toMatchObject({ error: { name: 'AbortError' } });
        await requests.read('cached', stable);
        expect(stable).toHaveBeenCalledTimes(2);
        expect(await requests.read('same', () => Promise.resolve('fresh'))).toBe('fresh');
        old.resolve('late');
        await flush();
        expect(await requests.read('same', () => Promise.resolve('wrong'))).toBe('fresh');
    });

    it('clear 先移除全部排隊工作，不因釋放 slot 而啟動待清理來源', async () => {
        const requests = cache();
        const load = vi.fn(() => new Promise<string>(() => undefined));
        const pending = Array.from({ length: 8 }, (_, index) => outcome(requests.read(String(index), load)));
        expect(load).toHaveBeenCalledTimes(4);
        requests.clear();
        expect(load).toHaveBeenCalledTimes(4);
        for (const result of await Promise.all(pending)) expect(result).toMatchObject({ error: { name: 'AbortError' } });
    });

    it('clear 的來源 abort listener 可開新同 key 請求，不會被舊 entry 刪除', async () => {
        const requests = cache();
        let reentrant!: Promise<string>;
        const fresh = deferred<string>();
        const loadFresh = vi.fn(() => fresh.promise);
        const old = outcome(requests.read('same', signal => {
            signal.addEventListener('abort', () => { reentrant = requests.read('same', loadFresh); }, { once: true });
            return new Promise<string>(() => undefined);
        }));
        requests.clear();
        const shared = requests.read('same', loadFresh);
        fresh.resolve('fresh');
        expect(await Promise.all([reentrant, shared])).toEqual(['fresh', 'fresh']);
        expect(loadFresh).toHaveBeenCalledTimes(1);
        expect(await old).toMatchObject({ error: { name: 'AbortError' } });
    });
});

describe('SearchRequestCache 搜尋專用四路 FIFO', () => {
    it('不同 cache instance 共用四路上限，依排隊順序啟動', async () => {
        const first = cache();
        const second = cache();
        const sources = Array.from({ length: 7 }, () => deferred<string>());
        const started: number[] = [];
        let active = 0;
        let maxActive = 0;
        const pending = sources.map((source, index) => (index % 2 ? first : second).read(String(index), () => {
            started.push(index);
            active++;
            maxActive = Math.max(maxActive, active);
            return source.promise.finally(() => { active--; });
        }));
        expect(started).toEqual([0, 1, 2, 3]);
        sources[1]!.resolve('1');
        await flush();
        expect(started).toEqual([0, 1, 2, 3, 4]);
        sources[0]!.resolve('0');
        await flush();
        expect(started).toEqual([0, 1, 2, 3, 4, 5]);
        sources[2]!.resolve('2');
        await flush();
        expect(started).toEqual([0, 1, 2, 3, 4, 5, 6]);
        sources.forEach((source, index) => source.resolve(String(index)));
        expect(await Promise.all(pending)).toEqual(['0', '1', '2', '3', '4', '5', '6']);
        expect(maxActive).toBe(4);
    });

    it('排隊中的最後 reader 取消就移除，不啟動來源，也不阻擋下一筆', async () => {
        const requests = cache();
        const blockers = Array.from({ length: 4 }, () => deferred<string>());
        const active = blockers.map((source, index) => requests.read(String(index), () => source.promise));
        const controller = new AbortController();
        const cancelledLoad = vi.fn().mockResolvedValue('cancelled');
        const cancelled = outcome(requests.read('cancelled', cancelledLoad, controller.signal));
        const nextLoad = vi.fn().mockResolvedValue('next');
        const next = requests.read('next', nextLoad);
        controller.abort();
        expect(cancelledLoad).not.toHaveBeenCalled();
        blockers[0]!.resolve('0');
        await flush();
        expect(await next).toBe('next');
        expect(nextLoad).toHaveBeenCalledTimes(1);
        expect(cancelledLoad).not.toHaveBeenCalled();
        blockers.forEach((source, index) => source.resolve(String(index)));
        await Promise.all(active);
        expect(await cancelled).toMatchObject({ error: { name: 'AbortError' } });
    });

    it('排隊中的一位 reader 取消，另一位仍能在取得 slot 後完成', async () => {
        const requests = cache();
        const blockers = Array.from({ length: 4 }, () => deferred<string>());
        const active = blockers.map((source, index) => requests.read(String(index), () => source.promise));
        const controller = new AbortController();
        const load = vi.fn().mockResolvedValue('shared');
        const cancelled = outcome(requests.read('queued', load, controller.signal));
        const valid = requests.read('queued', load);
        controller.abort();
        expect(load).not.toHaveBeenCalled();
        blockers[0]!.resolve('0');
        await flush();
        expect(await valid).toBe('shared');
        expect(load).toHaveBeenCalledTimes(1);
        expect(await cancelled).toMatchObject({ error: { name: 'AbortError' } });
        blockers.forEach((source, index) => source.resolve(String(index)));
        await Promise.all(active);
    });

    it('排隊時間計入 deadline，到期未取得 slot 不可啟動來源', async () => {
        const blockers = cache({ deadlineMs: 1000 });
        const pending = Array.from({ length: 4 }, (_, index) => outcome(blockers.read(String(index), () => new Promise<string>(() => undefined))));
        const requests = cache({ deadlineMs: 100 });
        const load = vi.fn().mockResolvedValue('too late');
        const queued = outcome(requests.read('queued', load));
        await vi.advanceTimersByTimeAsync(100);
        expect(await queued).toMatchObject({ error: { message: expect.stringContaining('逾時') } });
        blockers.clear();
        await Promise.all(pending);
        expect(load).not.toHaveBeenCalled();
    });

    it('同時到期的來源釋放 slot 時，不能啟動已過 deadline 的排隊工作', async () => {
        const requests = cache({ deadlineMs: 100 });
        const load = vi.fn(() => new Promise<string>(() => undefined));
        const pending = Array.from({ length: 8 }, (_, index) => outcome(requests.read(String(index), load)));
        await vi.advanceTimersByTimeAsync(100);
        for (const result of await Promise.all(pending)) expect(result).toMatchObject({ error: { message: expect.stringContaining('逾時') } });
        expect(load).toHaveBeenCalledTimes(4);
    });

    it('底層忽略 abort 時，取消仍釋放有效 slot 並讓下一筆開始', async () => {
        const requests = cache();
        const controllers = Array.from({ length: 4 }, () => new AbortController());
        const pending = controllers.map((controller, index) => outcome(requests.read(String(index), () => new Promise<string>(() => undefined), controller.signal)));
        const load = vi.fn().mockResolvedValue('next');
        const next = requests.read('next', load);
        expect(load).not.toHaveBeenCalled();
        controllers[0]!.abort();
        expect(load).toHaveBeenCalledTimes(1);
        expect(await next).toBe('next');
        controllers.forEach(controller => controller.abort());
        for (const result of await Promise.all(pending)) expect(result).toMatchObject({ error: { name: 'AbortError' } });
    });

    it('底層忽略 abort 時，逾時仍釋放有效 slot 讓未到期的排隊來源開始', async () => {
        const blockers = cache({ deadlineMs: 100 });
        const old = Array.from({ length: 4 }, (_, index) => outcome(blockers.read(String(index), () => new Promise<string>(() => undefined))));
        const requests = cache({ deadlineMs: 1000 });
        const load = vi.fn().mockResolvedValue('next');
        const next = requests.read('next', load);
        expect(load).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(100);
        expect(await next).toBe('next');
        expect(load).toHaveBeenCalledTimes(1);
        for (const result of await Promise.all(old)) expect(result).toMatchObject({ error: { message: expect.stringContaining('逾時') } });
    });

    it('不同 cache 的 clear 不取消另一個入口仍有效的排隊請求', async () => {
        const first = cache();
        const second = cache();
        const old = Array.from({ length: 4 }, (_, index) => outcome(first.read(String(index), () => new Promise<string>(() => undefined))));
        const load = vi.fn((signal: AbortSignal) => {
            expect(signal.aborted).toBe(false);
            return Promise.resolve('second');
        });
        const valid = second.read('valid', load);
        first.clear();
        expect(await valid).toBe('second');
        expect(load).toHaveBeenCalledTimes(1);
        await Promise.all(old);
    });
});
