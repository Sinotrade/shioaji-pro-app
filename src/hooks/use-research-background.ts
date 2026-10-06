import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { readCachedDailyCandles } from '../lib/daily-candles';
import { researchBackgroundKey, researchBackgroundStore } from '../lib/research-background';
import type { ContractBase } from '../lib/types/contract';

/** Reuse memory/IDB only. Mounting this hook never requests history. */
export function useResearchBackground(contract: ContractBase, enabled: boolean) {
    const key = researchBackgroundKey(contract);
    const access = useMemo(() => ({
        subscribe: (listener: () => void) => enabled ? researchBackgroundStore.subscribe(key, listener) : () => {},
        snapshot: () => researchBackgroundStore.get(key),
    }), [key, enabled]);
    const background = useSyncExternalStore(access.subscribe, access.snapshot, access.snapshot);
    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        void readCachedDailyCandles(contract).then(daily => {
            // Hydration is lower priority than a live cache refresh already
            // in flight. A missing IDB set must not erase a newer memory set.
            if (!cancelled && daily.length) researchBackgroundStore.replaceDaily(key, daily, 0);
        });
        return () => { cancelled = true; };
    }, [key, enabled]);
    return background;
}
