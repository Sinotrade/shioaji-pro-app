// 持股 moved out of 產業鏈資金流向 into its own panel: a saved 持股 tab falls back to 排行.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readChainView } from './chain-map';

const KEY = 'sj-pro-chainmap-view';
let store: Map<string, string>;

describe('readChainView', () => {
    beforeEach(() => {
        store = new Map();
        vi.stubGlobal('localStorage', {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, v),
            removeItem: (k: string) => void store.delete(k),
        });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('turns the retired 持股 tab into 排行 and drops the stale value', () => {
        store.set(KEY, 'holdings');
        expect(readChainView()).toBe('rank');
        expect(store.has(KEY)).toBe(false);
    });

    it('keeps the remaining views', () => {
        for (const view of ['rank', 'rotation', 'heat'] as const) {
            store.set(KEY, view);
            expect(readChainView()).toBe(view);
            expect(store.get(KEY)).toBe(view);
        }
    });

    it('defaults to 排行 when nothing is saved or storage is unavailable', () => {
        expect(readChainView()).toBe('rank');
        vi.stubGlobal('localStorage', undefined);
        expect(readChainView()).toBe('rank');
    });
});
