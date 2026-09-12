import { getApiBase } from './runtime';
import { fetchKbars } from './shioaji';
import type { ContractBase } from './types/contract';
import type { KBars } from './types/market';

let revision = 0;
// Shared across mounted charts: a manual refresh must not reuse another
// panel's earlier local counter value and return its old cached history.
export const nextChartHistoryRevision = () => ++revision;

const requests = new Map<string, Promise<KBars>>();
/** Presentation rebuilds reuse history, including failures. A manual revision
 * or a new date range explicitly permits another bounded fetchKbars attempt. */
export function fetchChartHistory(contract: ContractBase, start: string, end: string, opts?: { timeoutMs?: number; revision?: number }) {
    const key = JSON.stringify([getApiBase(), contract, start, end, opts?.revision ?? 0]);
    let request = requests.get(key);
    if (!request) {
        request = fetchKbars(contract, start, end, opts);
        requests.set(key, request);
        if (requests.size > 100) requests.delete(requests.keys().next().value!);
    }
    return request;
}
