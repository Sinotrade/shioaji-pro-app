import { getApiBase } from './runtime';
import { fetchKbars } from './shioaji';
import type { ContractBase } from './types/contract';
import type { KBars } from './types/market';

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
