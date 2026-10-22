// 產業鏈資金流向 and 持股族群 open together: the shared feed hook builds the
// same overview K-bar batches, the capability registry ref-counts them, so the
// second panel sends no K-bar subscribe and no snapshot request; closing one
// keeps the subscription, closing both releases it.
// 持股族群's 族群 grouping retains the index_components group metrics (amount,
// weighted change) of 上市 and 上櫃; 產業全景 holds the same streams for its
// selected index, so only the other index is added. Holdings outside every
// chain/theme get their own small drill K-bar batch: no other panel has them.
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Theme } from '../lib/company-data/types';

const m = vi.hoisted(() => ({
    post: vi.fn(async (path: string, body?: unknown): Promise<unknown> => {
        void body;
        if (path.startsWith('/api/v1/data/snapshots')) return [];
        if (path.startsWith('/api/v1/data/index_components')) return { entries: [] };
        return { success: true, message: '' };
    }),
}));
vi.mock('../lib/api', () => ({ apiPost: m.post, apiGet: vi.fn(), apiPut: vi.fn(), apiDelete: vi.fn() }));
vi.mock('../lib/stream', () => ({
    registerSubscription: vi.fn(),
    unregisterSubscription: vi.fn(),
    registerSubscriptionRaw: vi.fn(),
    registerCapabilitySubscription: vi.fn(),
    unregisterCapabilitySubscription: vi.fn(),
    onStreamEvent: () => () => undefined,
    onAnyTick: () => () => undefined,
    ensureStream: () => undefined,
    streamConnectionEpoch: () => 0,
}));

const themes: Theme[] = [
    {
        id: 'chain.a',
        name: 'A',
        kind: 'chain',
        stages: [{ id: 's', name: 'S', tier: 'midstream' }],
        members: [
            { id: 'tw.2330', stage: 's' },
            { id: 'tw.2317', stage: 's' },
        ],
    } as unknown as Theme,
    {
        id: 'theme.b',
        name: 'B',
        kind: 'theme',
        stages: [{ id: 's', name: 'S', tier: 'midstream' }],
        members: [
            { id: 'tw.2317', stage: 's' },
            { id: 'tw.2454', stage: 's' },
        ],
    } as unknown as Theme,
];
vi.mock('../hooks/use-chain-map-data', () => ({
    useChainMapData: () => ({
        phase: 'ready',
        themes,
        themesMeta: { asOf: '2026-10-22', stale: false },
        edges: null,
        market: null,
        entities: null,
        stale: false,
        retry: () => undefined,
    }),
}));

import { chainFlowSeedIdle, chainFlowStatus, resetChainFlowForTest } from '../lib/chain-flow-feed';
import { retainIndexComponents } from '../lib/index-components';
import { GM_AMOUNT, GM_WPERF, IC_INDICES, useIcSectorFlow } from '../lib/sector-flow-ic';
import { useChainFeed } from './chain-feed';

/** 產業鏈資金流向's subscriptions. */
function Panel() {
    useChainFeed();
    return null;
}

/** 持股族群's subscriptions: the shared feed plus the 族群 group metrics. */
function HoldingsPanel() {
    useChainFeed();
    useIcSectorFlow(true);
    return null;
}

const calls = (prefix: string) => m.post.mock.calls.filter(([path]) => path.startsWith(prefix));
const flush = async () => {
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await chainFlowSeedIdle();
};

describe('useChainFeed shared by two panels', () => {
    let chain: ReactTestRenderer | null = null;
    let holdings: ReactTestRenderer | null = null;
    beforeEach(() => {
        resetChainFlowForTest();
        m.post.mockClear();
        vi.stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} });
    });
    afterEach(() => {
        act(() => chain?.unmount());
        act(() => holdings?.unmount());
        chain = holdings = null;
        vi.unstubAllGlobals();
    });

    it('adds no K-bar subscribe or snapshot request when the second panel opens', async () => {
        act(() => {
            chain = create(createElement(Panel));
        });
        await flush();
        const subscribes = calls('/api/v1/stream/subscribe/kbars').length;
        const snapshots = calls('/api/v1/data/snapshots').length;
        expect(subscribes).toBe(1);
        expect(snapshots).toBe(1);
        expect(chainFlowStatus()).toMatchObject({ kbarCodes: 3, batches: 1, subscribed: 1 });

        act(() => {
            holdings = create(createElement(Panel));
        });
        await flush();
        expect(calls('/api/v1/stream/subscribe/kbars')).toHaveLength(subscribes);
        expect(calls('/api/v1/data/snapshots')).toHaveLength(snapshots);
        // the status line counts the shared subscription once, not per panel
        expect(chainFlowStatus()).toMatchObject({ kbarCodes: 3, batches: 1, subscribed: 1 });

        // closing one keeps the shared subscription
        act(() => chain!.unmount());
        chain = null;
        await flush();
        expect(calls('/api/v1/stream/unsubscribe/kbars')).toHaveLength(0);

        // closing the last one releases it
        act(() => holdings!.unmount());
        holdings = null;
        await flush();
        expect(calls('/api/v1/stream/unsubscribe/kbars')).toHaveLength(1);
    });

    it('shares the group metrics of 產業全景 for its index and adds only the other index', async () => {
        // 產業全景 subscribes the group metrics of its selected index only (上市 here)
        const heatmap = [GM_AMOUNT, GM_WPERF].map((p) => retainIndexComponents(IC_INDICES.IX0001, p));
        await flush();
        const subscribes = () => calls('/api/v1/stream/subscribe/index_components');
        const unsubscribes = () => calls('/api/v1/stream/unsubscribe/index_components');
        const bootstraps = () => calls('/api/v1/data/index_components');
        const indexOf = (call: unknown[]) => JSON.stringify(call[1]).includes('IX0043') ? 'IX0043' : 'IX0001';
        expect(subscribes().map(indexOf)).toEqual(['IX0001', 'IX0001']);
        expect(bootstraps().map(indexOf)).toEqual(['IX0001']);

        // 持股族群 covers 上市 and 上櫃 holdings: 上市 rides the retained streams,
        // 上櫃 is the only addition (two subscribes and its first bootstrap)
        act(() => {
            holdings = create(createElement(HoldingsPanel));
        });
        await flush();
        expect(subscribes().map(indexOf)).toEqual(['IX0001', 'IX0001', 'IX0043', 'IX0043']);
        expect(bootstraps().map(indexOf)).toEqual(['IX0001', 'IX0043']);

        // closing 持股族群 releases only what it added
        act(() => holdings!.unmount());
        holdings = null;
        await flush();
        expect(unsubscribes().map(indexOf)).toEqual(['IX0043', 'IX0043']);
        heatmap.forEach((release) => release());
        await flush();
        expect(unsubscribes().map(indexOf)).toEqual(['IX0043', 'IX0043', 'IX0001', 'IX0001']);
    });
});
