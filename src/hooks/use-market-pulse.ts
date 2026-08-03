import { useEffect, useSyncExternalStore } from 'react';
import {
    getMarketPulseSnapshot,
    retainMarketPulseStreams,
    subscribeMarketPulse,
} from '../lib/market-pulse';

export function useMarketPulseSnapshot() {
    useEffect(retainMarketPulseStreams, []);
    return useSyncExternalStore(subscribeMarketPulse, getMarketPulseSnapshot);
}
