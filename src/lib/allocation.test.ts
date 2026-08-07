// src/lib/allocation.test.ts — 分倉整數拆分：總和守恆、餘數順序、0% 戶跳過

import { beforeEach, describe, expect, it } from 'vitest';
import {
    allocateByRatio,
    deleteAllocPreset,
    loadAllocPresets,
    saveAllocPreset,
} from './allocation';

// vitest runs in a node environment — minimal in-memory localStorage shim
if (typeof localStorage === 'undefined') {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
    };
}

describe('allocateByRatio', () => {
    it('splits evenly when ratios divide cleanly', () => {
        expect(allocateByRatio(10, [50, 50])).toEqual([5, 5]);
        expect(allocateByRatio(9, [1, 1, 1])).toEqual([3, 3, 3]);
    });

    it('conserves the total (sum of parts === total)', () => {
        const cases: [number, number[]][] = [
            [7, [33, 33, 34]],
            [1, [10, 20, 70]],
            [13, [1, 1, 1]],
            [100, [12.5, 37.5, 50]],
            [3, [99, 0.5, 0.5]],
            [17, [3, 7]],
        ];
        for (const [total, weights] of cases) {
            const out = allocateByRatio(total, weights);
            expect(out.reduce((s, q) => s + q, 0)).toBe(total);
            out.forEach((q) => {
                expect(Number.isInteger(q)).toBe(true);
                expect(q).toBeGreaterThanOrEqual(0);
            });
        }
    });

    it('gives remainder to the largest fractional part first', () => {
        // 10 × [45%, 35%, 20%] → 4.5 / 3.5 / 2.0 → floors 4/3/2, one left
        // over → largest fraction wins the tie by earlier index (0.5 vs 0.5)
        expect(allocateByRatio(10, [45, 35, 20])).toEqual([5, 3, 2]);
        // 7 × [1/3,1/3,1/3] → 2.33 each, remainder 1 → first account
        expect(allocateByRatio(7, [1, 1, 1])).toEqual([3, 2, 2]);
        // 11 × [60%, 30%, 10%] → 6.6/3.3/1.1 → 6/3/1 + 1 → fraction .6 wins
        expect(allocateByRatio(11, [60, 30, 10])).toEqual([7, 3, 1]);
    });

    it('skips 0% accounts entirely', () => {
        expect(allocateByRatio(5, [0, 100])).toEqual([0, 5]);
        expect(allocateByRatio(7, [50, 0, 50])).toEqual([4, 0, 3]);
        // zero-weight account must never receive remainder units
        const out = allocateByRatio(999, [1, 0, 1, 0]);
        expect(out[1]).toBe(0);
        expect(out[3]).toBe(0);
        expect(out.reduce((s, q) => s + q, 0)).toBe(999);
    });

    it('handles 1 unit across 3 accounts', () => {
        expect(allocateByRatio(1, [40, 30, 30])).toEqual([1, 0, 0]);
        // equal split: earliest account wins the single unit
        expect(allocateByRatio(1, [1, 1, 1])).toEqual([1, 0, 0]);
        expect(allocateByRatio(2, [1, 1, 1])).toEqual([1, 1, 0]);
    });

    it('is defensive about junk input', () => {
        expect(allocateByRatio(0, [50, 50])).toEqual([0, 0]);
        expect(allocateByRatio(-3, [50, 50])).toEqual([0, 0]);
        expect(allocateByRatio(2.5, [50, 50])).toEqual([0, 0]);
        expect(allocateByRatio(5, [])).toEqual([]);
        expect(allocateByRatio(5, [0, 0])).toEqual([0, 0]);
        expect(allocateByRatio(5, [NaN, 100])).toEqual([0, 5]);
        expect(allocateByRatio(5, [-10, 100])).toEqual([0, 5]);
    });

    it('does not need ratios to sum to 100', () => {
        expect(allocateByRatio(6, [2, 1])).toEqual([4, 2]);
        expect(allocateByRatio(6, [200, 100])).toEqual([4, 2]);
    });
});

describe('alloc presets (localStorage)', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('round-trips save → load → delete', () => {
        expect(loadAllocPresets()).toEqual([]);
        saveAllocPreset({ name: '主力七三', ratios: { 'F002000-123': 70, 'F002000-456': 30 } });
        expect(loadAllocPresets()).toHaveLength(1);
        expect(loadAllocPresets()[0]?.ratios['F002000-123']).toBe(70);
        // same name replaces
        saveAllocPreset({ name: '主力七三', ratios: { 'F002000-123': 60, 'F002000-456': 40 } });
        expect(loadAllocPresets()).toHaveLength(1);
        expect(loadAllocPresets()[0]?.ratios['F002000-123']).toBe(60);
        deleteAllocPreset('主力七三');
        expect(loadAllocPresets()).toEqual([]);
    });

    it('survives corrupted storage', () => {
        localStorage.setItem('sj-pro-alloc-presets', '{not json');
        expect(loadAllocPresets()).toEqual([]);
        localStorage.setItem('sj-pro-alloc-presets', '{"a":1}');
        expect(loadAllocPresets()).toEqual([]);
        localStorage.setItem(
            'sj-pro-alloc-presets',
            '[{"name":"x","ratios":{"k":1}},{"bad":true},null]',
        );
        expect(loadAllocPresets()).toEqual([{ name: 'x', ratios: { k: 1 } }]);
    });
});
