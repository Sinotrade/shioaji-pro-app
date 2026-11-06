import { useSyncExternalStore } from 'react';
import { getProductNamesVersion, subscribeProductNames } from '../lib/product-names-version';

// Stable primitive snapshot; subscriptions never start requests.
export function useProductNamesVersion(): string {
    return useSyncExternalStore(subscribeProductNames, getProductNamesVersion, getProductNamesVersion);
}
