// src/lib/option-window.test.ts — T 字訂閱窗的上限與遲滯（issue #371）

import { describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ fetchSnapshots: vi.fn() }));
vi.mock('./shioaji', () => api);

import {
    centeredRange,
    fetchChainSnapshots,
    INITIAL_SPAN,
    liveRangeFor,
    LIVE_BUFFER,
    LIVE_STRIKE_CAP,
    nextLiveRange,
    QUOTES_PER_STRIKE,
    SNAPSHOT_BATCH,
    scrollTopFor,
    visibleRange,
} from './option-window';
import type { ContractBase } from './types/contract';

const TOTAL = 120;

describe('budget', () => {
    it('stays at 96 subscriptions, 192 at the peak of a full swap', () => {
        expect(LIVE_STRIKE_CAP * QUOTES_PER_STRIKE).toBe(96);
        expect(LIVE_STRIKE_CAP * QUOTES_PER_STRIKE * 2).toBeLessThanOrEqual(200);
    });

    it('never exceeds the cap however tall the panel is', () => {
        for (const visible of [{ first: 0, last: 119 }, { first: 10, last: 70 }, { first: 90, last: 119 }]) {
            const r = liveRangeFor(visible, TOTAL);
            expect(r.last - r.first + 1).toBe(LIVE_STRIKE_CAP);
            expect(r.first).toBeGreaterThanOrEqual(0);
            expect(r.last).toBeLessThan(TOTAL);
        }
    });
});

describe('centeredRange', () => {
    it('matches the old fixed eight strikes around ATM', () => {
        expect(centeredRange(50, TOTAL)).toEqual({ first: 50 - INITIAL_SPAN, last: 50 + INITIAL_SPAN });
    });

    it('clips at both ends of the chain and handles an empty one', () => {
        expect(centeredRange(2, TOTAL)).toEqual({ first: 0, last: 10 });
        expect(centeredRange(119, TOTAL)).toEqual({ first: 111, last: 119 });
        expect(centeredRange(0, 0)).toEqual({ first: 0, last: -1 });
    });
});

describe('visibleRange', () => {
    it('accounts for the sticky header', () => {
        // 200px viewport, 40px header, 20px rows: 8 rows fit
        expect(visibleRange(0, 200, 40, 20, TOTAL)).toEqual({ first: 0, last: 7 });
        expect(visibleRange(100, 200, 40, 20, TOTAL)).toEqual({ first: 5, last: 12 });
    });

    it('counts a partly visible row and stops at the last row', () => {
        expect(visibleRange(110, 200, 40, 20, TOTAL)).toEqual({ first: 5, last: 13 });
        expect(visibleRange(99999, 200, 40, 20, TOTAL)).toEqual({ first: 119, last: 119 });
    });

    it('returns null while nothing can be measured', () => {
        expect(visibleRange(0, 0, 40, 20, TOTAL)).toBeNull(); // hidden panel
        expect(visibleRange(0, 200, 40, 0, TOTAL)).toBeNull();
        expect(visibleRange(0, 200, 40, 20, 0)).toBeNull();
    });
});

it('scrollTopFor puts the row in the middle of the area under the header', () => {
    const top = scrollTopFor(50, 200, 40, 20);
    const v = visibleRange(top, 200, 40, 20, TOTAL)!;
    expect((v.first + v.last) / 2).toBeCloseTo(50, 0);
    expect(scrollTopFor(0, 200, 40, 20)).toBe(0);
});

describe('nextLiveRange', () => {
    const start = centeredRange(50, TOTAL); // 42..58

    it('keeps the same object while the screen stays inside the window', () => {
        expect(nextLiveRange(start, { first: 45, last: 54 }, TOTAL)).toBe(start);
        expect(nextLiveRange(start, { first: 42, last: 51 }, TOTAL)).toBe(start);
        expect(nextLiveRange(start, { first: 49, last: 58 }, TOTAL)).toBe(start);
    });

    it('moves to screen plus buffer once the screen leaves the window', () => {
        expect(nextLiveRange(start, { first: 50, last: 59 }, TOTAL)).toEqual({ first: 50 - LIVE_BUFFER, last: 59 + LIVE_BUFFER });
    });

    it('does not bounce: a small scroll back after moving keeps the window', () => {
        const moved = nextLiveRange(start, { first: 50, last: 59 }, TOTAL);
        expect(nextLiveRange(moved, { first: 48, last: 57 }, TOTAL)).toBe(moved);
        expect(nextLiveRange(moved, { first: 52, last: 61 }, TOTAL)).toBe(moved);
    });

    it('swaps at most once per buffer step when stepping through the chain', () => {
        let range = start;
        let swaps = 0;
        for (let first = 45; first < 100; first += 1) {
            const next = nextLiveRange(range, { first, last: first + 9 }, TOTAL);
            if (next !== range) swaps += 1;
            range = next;
        }
        expect(swaps).toBeLessThanOrEqual(Math.ceil(55 / (LIVE_BUFFER + 1)));
    });

    it('applies a tolerance when the panel is taller than the cap', () => {
        const tall = { first: 20, last: 69 };
        const range = liveRangeFor(tall, TOTAL);
        expect(nextLiveRange(range, { first: 21, last: 70 }, TOTAL)).toBe(range);
        expect(nextLiveRange(range, { first: 20 + LIVE_BUFFER, last: 69 + LIVE_BUFFER }, TOTAL)).not.toBe(range);
    });
});

it('fetchChainSnapshots splits by the API batch limit and keeps every row', async () => {
    api.fetchSnapshots.mockImplementation(async (cs: ContractBase[]) => cs.map((c) => ({ code: c.code })));
    const contracts = Array.from({ length: SNAPSHOT_BATCH + 3 }, (_, i) => ({ code: `C${i}` })) as ContractBase[];
    const rows = await fetchChainSnapshots(contracts);
    expect(api.fetchSnapshots.mock.calls.map(([c]) => c.length)).toEqual([SNAPSHOT_BATCH, 3]);
    expect(rows).toHaveLength(SNAPSHOT_BATCH + 3);
});
