// 產業鏈資金流向 and 持股族群 open together: the shared feed hook builds the
// same K-bar batches, the capability registry ref-counts them, so the second
// panel sends no subscribe and no snapshot request; closing one keeps the
// subscription, closing both releases it.
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Theme } from '../lib/company-data/types';

const m = vi.hoisted(() => ({
    post: vi.fn(async (path: string, body?: unknown): Promise<unknown> => {
        void body;
        return path.startsWith('/api/v1/data/snapshots') ? [] : { success: true, message: '' };
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

import { chainFlowSeedIdle, resetChainFlowForTest } from '../lib/chain-flow-feed';
import { useChainFeed } from './chain-feed';

function Panel() {
    useChainFeed();
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

        act(() => {
            holdings = create(createElement(Panel));
        });
        await flush();
        expect(calls('/api/v1/stream/subscribe/kbars')).toHaveLength(subscribes);
        expect(calls('/api/v1/data/snapshots')).toHaveLength(snapshots);

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
});
