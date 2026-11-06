// 開盤前今日成交值全 0：不能等成交值出現才選族群，否則清單無選取、右側卻顯示預設成分股。
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Theme } from '../lib/company-data/types';

const m = vi.hoisted(() => ({
    snapshots: [] as unknown[],
    selected: [] as string[],
    cards: null as Map<string, { code: string; subIndustry: string }> | null,
    gate: null as Promise<void> | null,
    store: new Map<string, string>(),
}));
vi.mock('../lib/api', () => ({
    apiPost: vi.fn(async (path: string) => {
        if (!path.startsWith('/api/v1/data/snapshots')) return { success: true, message: '' };
        await m.gate;
        return m.snapshots;
    }),
    apiGet: vi.fn(),
    apiPut: vi.fn(),
    apiDelete: vi.fn(),
}));
vi.mock('../lib/stream', () => ({
    registerCapabilitySubscription: vi.fn(),
    unregisterCapabilitySubscription: vi.fn(),
    onStreamEvent: () => () => undefined,
    onAnyTick: () => () => undefined,
    ensureStream: () => undefined,
    streamConnectionEpoch: () => 0,
}));
vi.mock('../lib/company-cards', () => ({ useCards: () => ({ cards: m.cards, error: null, retry: () => undefined }) }));
vi.mock('./chain-rank', () => ({
    FlowRank: ({ selectedId }: { selectedId: string }) => {
        m.selected.push(selectedId);
        return null;
    },
}));

const group = (id: string, kind: string, codes: string[]) =>
    ({
        id,
        name: id,
        kind,
        stages: [{ id: 's', name: 'S', tier: 'midstream' }],
        members: codes.map((c) => ({ id: `tw.${c}`, stage: 's' })),
    }) as unknown as Theme;
// the default selection (a theme) is outside the 產業鏈 list
const themes = [group('theme.ai_server', 'theme', ['2330']), group('chain.a', 'chain', ['2317']), group('chain.b', 'chain', ['2454'])];
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
import { ChainMap } from './chain-map';

const flush = async () => {
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { await chainFlowSeedIdle(); });
};

describe('ChainMap selection before the open', () => {
    let view: ReactTestRenderer | null = null;
    beforeEach(() => {
        resetChainFlowForTest();
        m.selected.length = 0;
        m.store.clear();
        m.snapshots = [];
        m.cards = null;
        m.gate = null;
        vi.stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} });
        vi.stubGlobal('localStorage', {
            getItem: (k: string) => m.store.get(k) ?? null,
            setItem: (k: string, v: string) => void m.store.set(k, v),
            removeItem: (k: string) => void m.store.delete(k),
        });
    });
    afterEach(() => {
        act(() => view?.unmount());
        view = null;
        vi.unstubAllGlobals();
    });

    it('selects a listed group although every turnover stays 0', async () => {
        act(() => {
            view = create(createElement(ChainMap, { view: 'rank', kind: 'chain' }));
        });
        await flush();
        expect(m.selected.at(-1)).toBe('chain.a');
        expect(m.store.get('sj-pro-chainmap-theme')).toBe('chain.a');
    });

    it('waits for 細產業 snapshots that start after the overview seed finished', async () => {
        const row = (code: string, total_amount: number) => ({ code, close: 100, change_price: 1, total_amount, datetime: new Date().toISOString().replace('T', ' ') });
        const card = (code: string, subIndustry: string) => [code, { code, subIndustry }] as const;
        const small = ['6101', '6102', '6103', '6104'];
        const large = ['6201', '6202', '6203', '6204'];
        m.cards = new Map([...small.map((c) => card(c, 'small')), ...large.map((c) => card(c, 'large'))]);
        act(() => {
            view = create(createElement(ChainMap, { view: 'rank', kind: 'chain' }));
        });
        await flush();

        let open!: () => void;
        m.gate = new Promise((r) => { open = r; });
        m.snapshots = [...small.map((c) => row(c, 1e6)), ...large.map((c) => row(c, 9e6))];
        act(() => {
            view!.update(createElement(ChainMap, { view: 'rank', kind: 'industry' }));
        });
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
        // snapshots still out: the first group must not be taken for the largest
        expect(m.store.get('sj-pro-chainmap-theme')).toBe('chain.a');

        open();
        await flush();
        expect(m.selected.at(-1)).toBe('industry.large');
    });

    it('waits for the snapshots, so a session with turnover still selects the largest group', async () => {
        const row = (code: string, total_amount: number) => ({ code, close: 100, change_price: 1, total_amount, datetime: new Date().toISOString().replace('T', ' ') });
        m.snapshots = [row('2317', 1e6), row('2454', 9e6)];
        act(() => {
            view = create(createElement(ChainMap, { view: 'rank', kind: 'chain' }));
        });
        await flush();
        expect(m.selected.at(-1)).toBe('chain.b');
    });
});
