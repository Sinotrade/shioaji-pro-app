import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const names = vi.hoisted(() => ({
    etf: 0, equity: 0, etfListeners: new Set<() => void>(), equityListeners: new Set<() => void>(),
    etfRefresh: vi.fn(), equityRefresh: vi.fn(),
}));
vi.mock('../lib/etf-runtime-catalog', () => ({
    getEtfNamesVersion: () => names.etf,
    subscribeEtfNames: (listener: () => void) => {
        names.etfListeners.add(listener); return () => { names.etfListeners.delete(listener); };
    },
    refreshEtfNames: names.etfRefresh,
}));
vi.mock('../lib/stock-runtime-catalog', () => ({
    getEquityNamesVersion: () => names.equity,
    subscribeEquityNames: (listener: () => void) => {
        names.equityListeners.add(listener); return () => { names.equityListeners.delete(listener); };
    },
    ensureEquityNamesFresh: names.equityRefresh,
}));
beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks();
    names.etf = 0; names.equity = 0;
    names.etfListeners.clear(); names.equityListeners.clear();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => vi.unstubAllGlobals());

it('shares a stable primitive snapshot for both name stores, performs no IO and detaches both subscriptions', async () => {
    const { createElement } = await import('react');
    const { create, act } = await import('react-test-renderer');
    const { useProductNamesVersion } = await import('./use-product-names-version');
    let renders = 0;
    function Probe() { renders++; return createElement('span', null, useProductNamesVersion()); }
    let view: import('react-test-renderer').ReactTestRenderer | undefined;
    try {
        await act(async () => { view = create(createElement(Probe)); });
        expect(view!.root.findByType('span').children).toEqual(['0:0']);
        expect(names.etfListeners.size).toBe(1);
        expect(names.equityListeners.size).toBe(1);
        await act(async () => { names.equity++; for (const listener of names.equityListeners) listener(); });
        expect(view!.root.findByType('span').children).toEqual(['0:1']);
        await act(async () => { names.etf++; for (const listener of names.etfListeners) listener(); });
        expect(view!.root.findByType('span').children).toEqual(['1:1']);
        const before = renders;
        await act(async () => { for (const listener of names.equityListeners) listener(); });
        expect(renders).toBe(before);
        expect(names.etfRefresh).not.toHaveBeenCalled();
        expect(names.equityRefresh).not.toHaveBeenCalled();
    } finally {
        if (view) await act(async () => view!.unmount());
    }
    expect(names.etfListeners.size).toBe(0);
    expect(names.equityListeners.size).toBe(0);
});
