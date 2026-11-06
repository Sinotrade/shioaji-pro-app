import { getEtfNamesVersion, subscribeEtfNames } from './etf-runtime-catalog';
import { getEquityNamesVersion, subscribeEquityNames } from './stock-runtime-catalog';

// A string, not a sum: an HMR reset of one source must not look like an old value.
export function getProductNamesVersion(): string {
    return `${getEtfNamesVersion()}:${getEquityNamesVersion()}`;
}

export function subscribeProductNames(listener: () => void): () => void {
    const detachEtf = subscribeEtfNames(listener);
    const detachEquity = subscribeEquityNames(listener);
    return () => { detachEtf(); detachEquity(); };
}
