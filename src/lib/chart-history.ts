import { getApiBase } from './runtime';
import { fetchKbars } from './shioaji';
import type { ContractBase } from './types/contract';
import type { KBars } from './types/market';
import { researchBackgroundKey, researchBackgroundStore } from './research-background';
import { kbarsToCandles } from './utils/kbars';

let revision = 0;
// Shared across mounted charts: a manual refresh must not reuse another
// panel's earlier local counter value and return its old cached history.
export const nextChartHistoryRevision = () => ++revision;

const requests = new Map<string, { request: Promise<KBars>; backgroundKey: string; sourceRevision: number }>();
/** Presentation rebuilds reuse history, including failures. A manual revision
 * or a new date range explicitly permits another bounded fetchKbars attempt. */
export function fetchChartHistory(contract: ContractBase, start: string, end: string, opts?: { timeoutMs?: number; revision?: number }) {
    const key = JSON.stringify([getApiBase(), contract, start, end, opts?.revision ?? 0]);
    let cached = requests.get(key);
    if (!cached) {
        const backgroundKey = researchBackgroundKey(contract);
        const sourceRevision = researchBackgroundStore.nextRevision();
        const request = fetchKbars(contract, start, end, opts).then(kbars => {
            researchBackgroundStore.mergeMinutes(backgroundKey, kbarsToCandles(kbars), sourceRevision);
            return kbars;
        });
        cached = { request, backgroundKey, sourceRevision };
        requests.set(key, cached);
        if (requests.size > 100) requests.delete(requests.keys().next().value!);
    } else {
        // Memory background can be evicted after many symbol changes. Reuse
        // the completed request WITHOUT another broker call or a new revision
        // that could overwrite more recent live minutes.
        const { request, backgroundKey, sourceRevision } = cached;
        void request.then(kbars => researchBackgroundStore.mergeMinutes(backgroundKey,
            kbarsToCandles(kbars), sourceRevision)).catch(() => undefined);
    }
    return cached.request;
}
