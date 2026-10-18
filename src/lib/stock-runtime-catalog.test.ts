import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ fetch: vi.fn(), native: false }));
vi.mock('./runtime', () => ({ get isTauri() { return mock.native; } }));
vi.mock('./public-metadata', () => ({ fetchPublicJson: mock.fetch }));
vi.mock('@tauri-apps/plugin-http', () => { throw new Error('Equity path must not import native HTTP'); });
const routes = {
    TSE: '/metadata/equity/tse-companies', OTC: '/metadata/equity/otc-companies', OES: '/metadata/equity/oes-companies',
};
function row(exchange: string, name = '合成簡稱', date = '1151017') {
    return exchange === 'TSE'
        ? { 公司代號: '2330', 公司簡稱: name, 公司名稱: `${name}股份有限公司`, 出表日期: date }
        : { SecuritiesCompanyCode: '3456', CompanyAbbreviation: name, CompanyName: `${name}股份有限公司`, Date: date };
}
const payload = (route: string, name?: string, date?: string) => [row(route === routes.TSE ? 'TSE' : route === routes.OTC ? 'OTC' : 'OES', name, date)];
function deferred<T>() {
    let resolve!: (value: T) => void;
    return { promise: new Promise<T>(finish => { resolve = finish; }), resolve };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
let store: typeof import('./stock-runtime-catalog');
beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime('2026-10-17T04:00:00Z');
    mock.native = false;
    mock.fetch.mockReset().mockImplementation(async route => payload(route));
    store = await import('./stock-runtime-catalog');
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('ordinary name runtime batch', () => {
    it('imports, reads and subscribes without IO; refresh returns void and shares one batch', async () => {
        const listener = vi.fn();
        const detach = store.subscribeEquityNames(listener);
        expect(store.getEquityNamesVersion()).toBe(0);
        expect(store.equityNameForLive('TSE', '2330')).toBeUndefined();
        expect(mock.fetch).not.toHaveBeenCalled();
        expect(store.ensureEquityNamesFresh()).toBeUndefined();
        store.ensureEquityNamesFresh();
        await flush();
        expect(mock.fetch.mock.calls.map(call => call[0])).toEqual(Object.values(routes));
        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.getEquityNamesVersion()).toBe(1);
        expect(store.equityNameForLive('TSE', '2330')).toEqual({ name: '合成簡稱', aliases: ['合成簡稱股份有限公司'] });
        expect(store.equityNameForLive('OTC', '2330')).toBeUndefined();
        expect(store.getEquityNamesStatus().phase).toBe('ready');
        expect(vi.getTimerCount()).toBe(0);
        detach();
    });

    it('publishes once only after the whole batch, then no version bump for identical content', async () => {
        const delayed = deferred<unknown>();
        mock.fetch.mockImplementation(route => route === routes.OES ? delayed.promise : Promise.resolve(payload(route)));
        const listener = vi.fn();
        store.subscribeEquityNames(listener);
        store.ensureEquityNamesFresh();
        await flush();
        expect(store.equityNameForLive('TSE', '2330')).toBeUndefined();
        delayed.resolve(payload(routes.OES));
        await flush();
        expect(listener).toHaveBeenCalledTimes(1);
        mock.fetch.mockImplementation(async route => payload(route));
        await vi.advanceTimersByTimeAsync(300_000);
        store.ensureEquityNamesFresh();
        await flush();
        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.getEquityNamesVersion()).toBe(1);
    });

    it('retains each failed source last-good while publishing the successful sources together', async () => {
        store.ensureEquityNamesFresh(); await flush();
        await vi.advanceTimersByTimeAsync(300_000);
        mock.fetch.mockImplementation(async route => {
            if (route === routes.OES) throw new Error('Synthetic OES unavailable');
            return payload(route, '合成新簡稱');
        });
        store.ensureEquityNamesFresh(); await flush();
        expect(store.equityNameForLive('TSE', '2330')?.name).toBe('合成新簡稱');
        expect(store.equityNameForLive('OTC', '3456')?.name).toBe('合成新簡稱');
        expect(store.equityNameForLive('OES', '3456')?.name).toBe('合成簡稱');
        const status = store.getEquityNamesStatus();
        expect(status.phase).toBe('error');
        expect(status.sources.find(source => source.exchange === 'OES')).toMatchObject({ count: 1, sourceDate: '2026-10-17', error: 'Synthetic OES unavailable' });
        expect(store.getEquityNamesVersion()).toBe(2);
    });

    it('TTL is five minutes, failed batch retries after 30 seconds, with no poller', async () => {
        mock.fetch.mockRejectedValue(new Error('Synthetic offline'));
        store.ensureEquityNamesFresh(); await flush();
        store.ensureEquityNamesFresh();
        await vi.advanceTimersByTimeAsync(29_999);
        store.ensureEquityNamesFresh();
        expect(mock.fetch).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(1);
        mock.fetch.mockImplementation(async route => payload(route));
        store.ensureEquityNamesFresh(); await flush();
        expect(mock.fetch).toHaveBeenCalledTimes(6);
        await vi.advanceTimersByTimeAsync(299_999);
        store.ensureEquityNamesFresh();
        expect(mock.fetch).toHaveBeenCalledTimes(6);
        await vi.advanceTimersByTimeAsync(1);
        store.ensureEquityNamesFresh(); await flush();
        expect(mock.fetch).toHaveBeenCalledTimes(9);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('day rollover invalidates an unfinished batch and late prior responses cannot publish', async () => {
        vi.setSystemTime('2026-10-17T15:59:59Z');
        const old = deferred<unknown>();
        mock.fetch.mockReturnValue(old.promise);
        store.ensureEquityNamesFresh(); await flush();
        const oldSignal = mock.fetch.mock.calls[0]![1].signal as AbortSignal;
        vi.setSystemTime('2026-10-17T16:00:00Z');
        mock.fetch.mockImplementation(async route => payload(route, '新日簡稱', '1151018'));
        store.ensureEquityNamesFresh(); await flush();
        expect(oldSignal.aborted).toBe(true);
        expect(store.equityNameForLive('TSE', '2330')?.name).toBe('新日簡稱');
        old.resolve(payload(routes.TSE, '舊日名稱'));
        await flush();
        expect(store.equityNameForLive('TSE', '2330')?.name).toBe('新日簡稱');
        expect(store.getEquityNamesVersion()).toBe(1);
    });

    it('rejects source date regression but imposes no arbitrary first-load staleness limit', async () => {
        mock.fetch.mockImplementation(async route => payload(route, '原簡稱', '1130229'));
        store.ensureEquityNamesFresh(); await flush();
        expect(store.equityNameForLive('TSE', '2330')?.name).toBe('原簡稱');
        await vi.advanceTimersByTimeAsync(300_000);
        mock.fetch.mockImplementation(async route => payload(route, '倒退名稱', '1130228'));
        store.ensureEquityNamesFresh(); await flush();
        expect(store.equityNameForLive('TSE', '2330')?.name).toBe('原簡稱');
        expect(store.getEquityNamesStatus().sources.every(source => source.error?.includes('older'))).toBe(true);
    });

    it('records cleanup and listener errors without blocking other subscribers', async () => {
        mock.fetch.mockImplementation(async (route, opts) => {
            opts.onCleanupError(new Error('Synthetic cleanup error'));
            return payload(route);
        });
        store.subscribeEquityNames(() => { throw new Error('Synthetic listener error'); });
        const listener = vi.fn();
        store.subscribeEquityNames(listener);
        store.ensureEquityNamesFresh(); await flush();
        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.getEquityNamesStatus()).toMatchObject({ phase: 'ready', cleanupError: 'Synthetic cleanup error', listenerError: 'Synthetic listener error' });
    });

    it('native is gated with zero requests, native imports or timers even on repeated reads', async () => {
        mock.native = true;
        store.ensureEquityNamesFresh();
        store.ensureEquityNamesFresh();
        await flush();
        expect(store.getEquityNamesStatus()).toMatchObject({ phase: 'gated' });
        expect(mock.fetch).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});
