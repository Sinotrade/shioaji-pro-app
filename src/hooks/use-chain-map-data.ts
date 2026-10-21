// src/hooks/use-chain-map-data.ts — shioaji-data datasets for 產業鏈地圖.
//
// Themes decide whether the panel can render; edges, market, revenue and
// entities are optional parts that degrade on their own (no relations, no
// market-cap sizing, no revenue colouring, codes instead of names).
// Everything goes through the shared `companyData` reader, so files fetched
// for the company panel or the Agent tools are reused.

import { useCallback, useEffect, useState } from 'react';
import { companyData, companyDataErrorText, type DataMeta } from '../lib/company-data';
import type { Edge, Entity, MarketDaily, Theme } from '../lib/company-data/types';

export interface ChainMapData {
    themes: Theme[];
    themesMeta: DataMeta;
    edges: Edge[] | null;
    market: MarketDaily | null;
    revenue: Record<string, unknown> | null;
    entities: Entity[] | null;
    /** Datasets served from offline cache. */
    stale: boolean;
}

export type ChainMapDataState =
    | { phase: 'loading' }
    | { phase: 'error'; error: string }
    | ({ phase: 'ready' } & ChainMapData);

async function optional<T>(promise: Promise<{ data: T; meta: DataMeta }>) {
    try {
        return await promise;
    } catch {
        return null;
    }
}

export async function loadChainMapData(client = companyData): Promise<ChainMapData> {
    const [themes, edges, market, revenue, entities] = await Promise.all([
        client.getDataset('tw/themes'),
        optional(client.getDataset('tw/edges')),
        optional(client.getDataset('tw/market')),
        optional(client.getDataset('tw/revenue')),
        optional(client.getDataset('global/entities')),
    ]);
    return {
        themes: themes.data,
        themesMeta: themes.meta,
        edges: edges?.data ?? null,
        market: market?.data ?? null,
        revenue: revenue?.data ?? null,
        entities: entities?.data ?? null,
        stale: [themes, edges, market, revenue, entities].some((part) => part?.meta.stale),
    };
}

export function useChainMapData(): ChainMapDataState & { retry: () => void } {
    const [state, setState] = useState<ChainMapDataState>({ phase: 'loading' });
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        let alive = true;
        setState((prev) => (prev.phase === 'ready' ? prev : { phase: 'loading' }));
        loadChainMapData().then(
            (data) => alive && setState({ phase: 'ready', ...data }),
            (error) => alive && setState({ phase: 'error', error: companyDataErrorText(error) }),
        );
        return () => {
            alive = false;
        };
    }, [attempt]);
    const retry = useCallback(() => setAttempt((n) => n + 1), []);
    return { ...state, retry };
}
