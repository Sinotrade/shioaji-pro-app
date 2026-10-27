// 持股 moved out of 產業鏈資金流向 into its own panel: a saved 持股 tab falls back to 金流 (rank).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fallbackGroup, readChainView } from './chain-map';
import type { FlowRow } from './chain-ui';

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

    it('turns the retired 持股 tab into 金流 (rank) and drops the stale value', () => {
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

    it('defaults to 金流 (rank) when nothing is saved or storage is unavailable', () => {
        expect(readChainView()).toBe('rank');
        vi.stubGlobal('localStorage', undefined);
        expect(readChainView()).toBe('rank');
    });
});

describe('fallbackGroup', () => {
    const row = (id: string, codes: string[], total: number) => ({ theme: { id }, codes, flow: { total } }) as unknown as FlowRow;
    const rows = [row('a', ['2330'], 100), row('b', ['2454'], 300), row('c', ['2317'], 200)];

    it('keeps a listed selection', () => {
        expect(fallbackGroup(rows, 'c', null)).toBeNull();
    });

    it("prefers the followed stock's group, else the largest by turnover", () => {
        expect(fallbackGroup(rows, 'x', '2317')).toBe('c');
        expect(fallbackGroup(rows, 'x', '9999')).toBe('b');
        expect(fallbackGroup(rows, 'x', null)).toBe('b');
        expect(fallbackGroup([], 'x', null)).toBeNull();
    });
});
