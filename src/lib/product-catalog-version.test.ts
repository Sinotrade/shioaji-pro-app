import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ base: 'fixture-a' }));
vi.mock('./runtime', () => ({ getApiBase: () => m.base }));
vi.mock('./utils/date', () => ({
    todayStr: () => new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10),
}));

const cleanups: Array<() => void> = [];
beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T06:00:00Z'));
    m.base = 'fixture-a';
    vi.stubGlobal('window', new EventTarget());
});
afterEach(() => {
    cleanups.splice(0).forEach(cleanup => cleanup());
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('product catalog version store', () => {
    it('isolates failing subscribers and keeps their failure observable without starving later subscribers', async () => {
        const { subscribeProductCatalog, invalidateProductCatalog, getProductCatalogListenerError } = await import('./product-catalog-version');
        const next = vi.fn();
        const fail = subscribeProductCatalog(() => { throw new Error('Synthetic catalog subscriber failure'); });
        cleanups.push(fail, subscribeProductCatalog(next));
        expect(() => invalidateProductCatalog({ region: 'TW', base_changed: true, info_changed: false })).not.toThrow();
        expect(next).toHaveBeenCalledOnce();
        expect(getProductCatalogListenerError()).toBe('Synthetic catalog subscriber failure');
        fail();
        invalidateProductCatalog({ region: 'TW', base_changed: false, info_changed: true });
        expect(next).toHaveBeenCalledTimes(2);
        expect(getProductCatalogListenerError()).toBeNull();
    });
    it('keeps snapshots stable and sends no notifications for unchanged reads or environment events', async () => {
        const { getProductCatalogVersion, subscribeProductCatalog } = await import('./product-catalog-version');
        const listener = vi.fn();
        cleanups.push(subscribeProductCatalog(listener));
        const first = getProductCatalogVersion();
        for (let i = 0; i < 20; i++) expect(getProductCatalogVersion()).toBe(first);
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new Event('sj-pro-api-base-changed'));
        await Promise.resolve();
        expect(listener).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(1);
    });

    it('invalidates only Taiwan Base or Info metadata without depending on stream imports', async () => {
        const { getProductCatalogVersion, subscribeProductCatalog, invalidateProductCatalog } = await import('./product-catalog-version');
        const listener = vi.fn();
        cleanups.push(subscribeProductCatalog(listener));
        const first = getProductCatalogVersion();
        invalidateProductCatalog({ region: 'US', base_changed: true, info_changed: true });
        invalidateProductCatalog({ region: 'TW', base_changed: false, info_changed: false });
        expect(getProductCatalogVersion()).toBe(first);
        expect(listener).not.toHaveBeenCalled();
        invalidateProductCatalog({ region: 'TW', base_changed: true, info_changed: false });
        expect(getProductCatalogVersion()).toBe(first + 1);
        invalidateProductCatalog({ region: 'TW', base_changed: false, info_changed: true });
        expect(getProductCatalogVersion()).toBe(first + 2);
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('tracks A→B→A runtime events even when no snapshot is read during B', async () => {
        const { getProductCatalogVersion, subscribeProductCatalog } = await import('./product-catalog-version');
        const listener = vi.fn();
        cleanups.push(subscribeProductCatalog(listener));
        const first = getProductCatalogVersion();
        m.base = 'fixture-b';
        window.dispatchEvent(new Event('sj-pro-api-base-changed'));
        m.base = 'fixture-a';
        window.dispatchEvent(new Event('sj-pro-api-base-changed'));
        expect(getProductCatalogVersion()).toBe(first + 2);
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('defers a context change discovered by getSnapshot rather than notifying during render', async () => {
        const { getProductCatalogVersion, subscribeProductCatalog } = await import('./product-catalog-version');
        const listener = vi.fn();
        cleanups.push(subscribeProductCatalog(listener));
        const first = getProductCatalogVersion();
        m.base = 'fixture-b';
        expect(getProductCatalogVersion()).toBe(first + 1);
        expect(listener).not.toHaveBeenCalled();
        expect(getProductCatalogVersion()).toBe(first + 1);
        await Promise.resolve();
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('notifies already-mounted consumers at Taiwan midnight using one timer', async () => {
        vi.setSystemTime(new Date('2026-10-17T15:59:59.990Z'));
        const { getProductCatalogVersion, subscribeProductCatalog } = await import('./product-catalog-version');
        const firstListener = vi.fn();
        const secondListener = vi.fn();
        cleanups.push(subscribeProductCatalog(firstListener), subscribeProductCatalog(secondListener));
        const first = getProductCatalogVersion();
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(9);
        expect(firstListener).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(getProductCatalogVersion()).toBe(first + 1);
        expect(firstListener).toHaveBeenCalledTimes(1);
        expect(secondListener).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(1);
    });

    it('checks a missed day change on focus and ignores unrelated storage writes', async () => {
        const { getProductCatalogVersion, subscribeProductCatalog } = await import('./product-catalog-version');
        const listener = vi.fn();
        cleanups.push(subscribeProductCatalog(listener));
        const first = getProductCatalogVersion();
        vi.setSystemTime(new Date('2026-10-18T06:00:00Z'));
        window.dispatchEvent(Object.assign(new Event('storage'), { key: 'unrelated' }));
        expect(listener).not.toHaveBeenCalled();
        window.dispatchEvent(new Event('focus'));
        expect(getProductCatalogVersion()).toBe(first + 1);
        expect(listener).toHaveBeenCalledTimes(1);
        m.base = 'fixture-b';
        window.dispatchEvent(Object.assign(new Event('storage'), { key: 'sj-pro-api-port' }));
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('does not create browser listeners or periodic timers during SSR', async () => {
        vi.stubGlobal('window', undefined);
        const { getProductCatalogVersion, subscribeProductCatalog } = await import('./product-catalog-version');
        cleanups.push(subscribeProductCatalog(vi.fn()));
        const first = getProductCatalogVersion();
        expect(vi.getTimerCount()).toBe(0);
        vi.setSystemTime(new Date('2026-10-18T06:00:00Z'));
        expect(getProductCatalogVersion()).toBe(first + 1);
        await Promise.resolve();
        expect(vi.getTimerCount()).toBe(0);
    });
});
