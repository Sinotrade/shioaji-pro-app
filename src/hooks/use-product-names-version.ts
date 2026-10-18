import { useSyncExternalStore } from 'react';
import { getEtfNamesVersion, subscribeEtfNames } from '../lib/etf-runtime-catalog';
import { getEquityNamesVersion, subscribeEquityNames } from '../lib/stock-runtime-catalog';

function snapshot(): string { return `${getEtfNamesVersion()}:${getEquityNamesVersion()}`; }
function subscribe(listener: () => void): () => void {
    const detachEtf = subscribeEtfNames(listener);
    const detachEquity = subscribeEquityNames(listener);
    return () => { detachEtf(); detachEquity(); };
}

// Stable primitive snapshot; subscriptions never start requests.
export function useProductNamesVersion(): string {
    return useSyncExternalStore(subscribe, snapshot, snapshot);
}
